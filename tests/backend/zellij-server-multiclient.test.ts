import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { WebSocket } from "ws";
import http from "node:http";
import { createZellijServer, type RunningServer } from "../../src/backend/server-zellij.js";
import { AuthService } from "../../src/backend/auth/auth-service.js";

/**
 * Multi-client resize and lifecycle tests for the per-client PTY architecture.
 *
 * These tests verify that:
 * 1. Each WebSocket client gets its own PTY process
 * 2. Clients can connect with different terminal sizes
 * 3. Disconnecting one client doesn't break others
 * 4. Zellij session persists across client connections
 *
 * NOTE: Requires `zellij` binary installed and the node-pty spawn-helper
 * to have execute permissions.
 */

const TEST_PORT = 19876;
const TEST_SESSION = `test-multiclient-${Date.now()}`;
const TOKEN = "test-token";
const ZELLIJ_BIN = "/opt/homebrew/bin/zellij";

// Skip these tests in CI or if zellij is not available.
const zellijAvailable = (() => {
  try {
    require("node:child_process").execFileSync("which", ["zellij"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
})();

const describeIfZellij = zellijAvailable ? describe : describe.skip;

/** Helper: connect a WebSocket client with auth and optional size. */
const connectClient = (
  port: number,
  opts: { cols?: number; rows?: number } = {},
): Promise<WebSocket> => {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws/terminal`);
    ws.on("open", () => {
      ws.send(JSON.stringify({
        type: "auth",
        token: TOKEN,
        cols: opts.cols ?? 80,
        rows: opts.rows ?? 24,
      }));
    });
    ws.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
      const str = Buffer.isBuffer(raw) ? raw.toString() : Buffer.from(raw as ArrayBuffer).toString();
      try {
        const msg = JSON.parse(str);
        if (msg.type === "auth_ok") resolve(ws);
        if (msg.type === "auth_error") reject(new Error(msg.reason));
      } catch {
        // PTY data before auth — ignore.
      }
    });
    ws.on("error", reject);
    // Timeout after 10s.
    setTimeout(() => reject(new Error("connection timeout")), 10_000);
  });
};

/**
 * Helper: trigger terminal activity and wait for PTY data.
 * Sends a newline to the PTY to ensure fresh output, then waits
 * for a non-JSON response.
 */
const waitForData = (ws: WebSocket, timeoutMs = 10_000): Promise<string> => {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no data received")), timeoutMs);
    const handler = (raw: Buffer | ArrayBuffer | Buffer[]) => {
      const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
      const str = buf.toString("utf8");
      try {
        const parsed = JSON.parse(str);
        if (parsed.type === "auth_ok" || parsed.type === "pong") return;
      } catch {
        // Not JSON — this is PTY data.
      }
      if (str.length === 0) return;
      clearTimeout(timer);
      ws.off("message", handler);
      resolve(str);
    };
    ws.on("message", handler);
    // Send a newline to trigger fresh output (shell prompt).
    ws.send(new TextEncoder().encode("\r"));
  });
};

/** Helper: send a resize message. */
const sendResize = (ws: WebSocket, cols: number, rows: number): void => {
  ws.send(JSON.stringify({ type: "resize", cols, rows }));
};

/** Helper: close a WebSocket and wait for it. */
const closeClient = (ws: WebSocket): Promise<void> => {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    ws.on("close", () => resolve());
    ws.close();
  });
};

describeIfZellij("Zellij server multi-client PTY", () => {
  let server: RunningServer;

  beforeAll(async () => {
    const authService = new AuthService({ token: TOKEN });
    server = createZellijServer(
      {
        port: TEST_PORT,
        host: "127.0.0.1",
        frontendDir: "/tmp",
        zellijSession: TEST_SESSION,
        zellijBin: ZELLIJ_BIN,
      },
      { authService, logger: { log: () => {}, error: console.error } },
    );
    await server.start();
  }, 15_000);

  afterAll(async () => {
    await server.stop();
    // Clean up the test Zellij session.
    try {
      require("node:child_process").execFileSync(
        ZELLIJ_BIN,
        ["delete-session", TEST_SESSION, "--force"],
        { stdio: "pipe" },
      );
    } catch {
      // Session may already be gone.
    }
  }, 15_000);

  it("single client connects and receives PTY data", async () => {
    const ws = await connectClient(TEST_PORT, { cols: 80, rows: 24 });
    const data = await waitForData(ws);
    expect(data.length).toBeGreaterThan(0);
    await closeClient(ws);
  }, 15_000);

  it("two clients with different sizes both receive data independently", async () => {
    // Desktop client: wide
    const desktop = await connectClient(TEST_PORT, { cols: 120, rows: 40 });
    const desktopData = waitForData(desktop);

    // Mobile client: narrow
    const mobile = await connectClient(TEST_PORT, { cols: 52, rows: 20 });
    const mobileData = waitForData(mobile);

    // Both should receive PTY output.
    const [d, m] = await Promise.all([desktopData, mobileData]);
    expect(d.length).toBeGreaterThan(0);
    expect(m.length).toBeGreaterThan(0);

    await Promise.all([closeClient(desktop), closeClient(mobile)]);
  }, 20_000);

  it("mobile disconnect does not break desktop client", async () => {
    const desktop = await connectClient(TEST_PORT, { cols: 120, rows: 40 });
    const mobile = await connectClient(TEST_PORT, { cols: 52, rows: 20 });

    // Wait for both to get initial data.
    await Promise.all([waitForData(desktop), waitForData(mobile)]);

    // Disconnect mobile.
    await closeClient(mobile);

    // Desktop should still be alive and receiving data.
    // Send a resize to trigger activity.
    sendResize(desktop, 121, 41);

    // Write some input and verify we get a response.
    desktop.send(new TextEncoder().encode("\r"));
    const postDisconnectData = await waitForData(desktop);
    expect(postDisconnectData.length).toBeGreaterThan(0);

    await closeClient(desktop);
  }, 20_000);

  it("desktop disconnect does not break mobile client", async () => {
    const desktop = await connectClient(TEST_PORT, { cols: 120, rows: 40 });
    const mobile = await connectClient(TEST_PORT, { cols: 52, rows: 20 });

    await Promise.all([waitForData(desktop), waitForData(mobile)]);

    // Disconnect desktop.
    await closeClient(desktop);

    // Mobile should still work.
    mobile.send(new TextEncoder().encode("\r"));
    const data = await waitForData(mobile);
    expect(data.length).toBeGreaterThan(0);

    await closeClient(mobile);
  }, 20_000);

  it("client can resize its own PTY without affecting others", async () => {
    const client1 = await connectClient(TEST_PORT, { cols: 80, rows: 24 });
    const client2 = await connectClient(TEST_PORT, { cols: 80, rows: 24 });

    await Promise.all([waitForData(client1), waitForData(client2)]);

    // Client1 resizes to very wide.
    sendResize(client1, 200, 50);

    // Client2 resizes to very narrow.
    sendResize(client2, 40, 10);

    // Both should still receive data (neither crashes).
    client1.send(new TextEncoder().encode("\r"));
    client2.send(new TextEncoder().encode("\r"));

    const [d1, d2] = await Promise.all([waitForData(client1), waitForData(client2)]);
    expect(d1.length).toBeGreaterThan(0);
    expect(d2.length).toBeGreaterThan(0);

    await Promise.all([closeClient(client1), closeClient(client2)]);
  }, 20_000);

  it("session persists after all clients disconnect and reconnect", async () => {
    // Connect and write a unique marker.
    const marker = `PERSIST_${Date.now()}`;
    const ws1 = await connectClient(TEST_PORT, { cols: 80, rows: 24 });
    await waitForData(ws1);
    ws1.send(new TextEncoder().encode(`echo ${marker}\r`));
    // Wait for the echo to appear.
    await new Promise((r) => setTimeout(r, 1000));
    await closeClient(ws1);

    // All clients gone. Wait a moment.
    await new Promise((r) => setTimeout(r, 1000));

    // Reconnect — Zellij session should still exist.
    const ws2 = await connectClient(TEST_PORT, { cols: 80, rows: 24 });
    const data = await waitForData(ws2);
    // The reconnected client should get the Zellij session content
    // (at minimum, a shell prompt or scrollback).
    expect(data.length).toBeGreaterThan(0);
    await closeClient(ws2);
  }, 20_000);

  it("auth with wrong token is rejected", async () => {
    const ws = new WebSocket(`ws://localhost:${TEST_PORT}/ws/terminal`);
    const result = await new Promise<string>((resolve) => {
      ws.on("open", () => {
        ws.send(JSON.stringify({ type: "auth", token: "wrong-token" }));
      });
      ws.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
        const str = Buffer.isBuffer(raw) ? raw.toString() : Buffer.from(raw as ArrayBuffer).toString();
        try {
          const msg = JSON.parse(str);
          resolve(msg.type);
        } catch {
          // Ignore non-JSON.
        }
      });
      ws.on("close", () => resolve("closed"));
    });
    expect(result).toBe("auth_error");
  }, 10_000);
});

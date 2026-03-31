import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createZellijServer, type RunningServer } from "../../src/backend/server-zellij.js";
import { AuthService } from "../../src/backend/auth/auth-service.js";

const TOKEN = "multi-session-token";

type BufferedWebSocket = WebSocket & {
  __messageQueue: string[];
};

type MockPty = {
  pid: number;
  session: string;
  kill: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  onData: (callback: (data: string) => void) => void;
  onExit: (callback: (info: { exitCode: number; signal?: number }) => void) => void;
};

describe("multi-session control and terminal flow", () => {
  let server: RunningServer;
  let baseWsUrl = "";
  let createdPtys: MockPty[] = [];

  beforeAll(async () => {
    server = createZellijServer(
      {
        port: 0,
        host: "127.0.0.1",
        frontendDir: path.resolve("dist"),
        zellijSession: "alpha",
      },
      {
        authService: new AuthService({ token: TOKEN, deviceStore: createMemoryDeviceStore() as never }),
        logger: { log: () => {}, error: () => {} },
        createPty: ({ session, cols, rows }) => {
          let exitHandler: ((info: { exitCode: number; signal?: number }) => void) | null = null;
          const pty: MockPty = {
            pid: createdPtys.length + 1,
            session,
            kill: vi.fn(() => {
              exitHandler?.({ exitCode: 0 });
            }),
            resize: vi.fn(),
            write: vi.fn(),
            onData: () => {},
            onExit(callback) {
              exitHandler = callback;
            },
          };
          createdPtys.push(pty);
          return pty;
        },
      },
    );

    await server.start();
    const address = server.server.address() as AddressInfo;
    baseWsUrl = `ws://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await server?.stop();
  });

  it("tracks current session per control client and scopes workspace broadcasts", async () => {
    const alpha = await connectControlClient(baseWsUrl, { type: "auth", token: TOKEN });
    const beta = await connectControlClient(baseWsUrl, { type: "auth", token: TOKEN });

    await expectMessage(alpha, (payload) => payload.type === "auth_ok");
    await expectMessage(beta, (payload) => payload.type === "auth_ok");

    alpha.send(JSON.stringify({ type: "subscribe_workspace" }));
    beta.send(JSON.stringify({ type: "subscribe_workspace" }));

    expect(await expectWorkspace(alpha)).toMatchObject({ session: "alpha" });
    expect(await expectWorkspace(beta)).toMatchObject({ session: "alpha" });

    alpha.send(JSON.stringify({ type: "switch_session", session: "beta" }));
    expect(await expectMessage(alpha, (payload) => payload.type === "session_switched")).toMatchObject({
      type: "session_switched",
      session: "beta",
    });
    expect(await expectWorkspace(alpha, "beta")).toMatchObject({ session: "beta" });
    alpha.__messageQueue.length = 0;
    beta.__messageQueue.length = 0;

    // new_tab returns an error in direct-shell mode (no Zellij multiplexer).
    beta.send(JSON.stringify({ type: "new_tab", name: "from-alpha-should-not-leak" }));
    expect(await expectMessage(beta, (payload) => payload.type === "error")).toMatchObject({
      type: "error",
      message: "tab/pane operations not available in direct-shell mode",
    });
    // No workspace_state broadcast should leak to alpha from beta's tab operation.
    await expectNoMessage(alpha, (payload) => payload.type === "workspace_state");

    beta.send(JSON.stringify({ type: "switch_session", session: "beta" }));
    await expectMessage(beta, (payload) => payload.type === "session_switched" && payload.session === "beta");
    await expectWorkspace(beta, "beta");

    // list_sessions returns known sessions (alpha + beta registered by switch_session).
    alpha.send(JSON.stringify({ type: "list_sessions" }));
    const sessionList = await expectMessage(alpha, (payload) => payload.type === "session_list");
    expect(sessionList.type).toBe("session_list");
    expect(sessionList.sessions).toBeInstanceOf(Array);
    const sessionNames = sessionList.sessions.map((s: any) => s.name);
    expect(sessionNames).toContain("alpha");
    expect(sessionNames).toContain("beta");

    // Create a session we can delete.
    alpha.send(JSON.stringify({ type: "create_session", name: "old-project" }));
    await expectMessage(alpha, (payload) => payload.type === "session_switched" && payload.session === "old-project");
    // Switch back to beta so we can delete old-project.
    alpha.send(JSON.stringify({ type: "switch_session", session: "beta" }));
    await expectMessage(alpha, (payload) => payload.type === "session_switched" && payload.session === "beta");
    alpha.__messageQueue.length = 0;

    alpha.send(JSON.stringify({ type: "delete_session", session: "old-project" }));
    expect(await expectMessage(alpha, (payload) => payload.type === "session_deleted")).toMatchObject({
      type: "session_deleted",
      session: "old-project",
    });

    alpha.close();
    beta.close();
  });

  it("recreates terminal PTY with the new session while preserving size", async () => {
    const ws = await connectTerminalClient(baseWsUrl, {
      type: "auth",
      token: TOKEN,
      cols: 80,
      rows: 24,
    });

    expect(createdPtys).toHaveLength(1);
    expect(createdPtys[0]).toMatchObject({
      session: "alpha",
    });

    ws.send(JSON.stringify({ type: "resize", cols: 132, rows: 40 }));
    await waitForAssertion(() => {
      expect(createdPtys[0].resize).toHaveBeenCalledWith(132, 40);
    });

    ws.send(JSON.stringify({ type: "switch_session", session: "beta" }));

    await waitForAssertion(() => {
      expect(createdPtys).toHaveLength(2);
      expect(createdPtys[0].kill).toHaveBeenCalledTimes(1);
      expect(createdPtys[1]).toMatchObject({
        session: "beta",
      });
    });

    ws.close();
  });

  it("publishes workspace state immediately when switching to a new session", async () => {
    const control = await connectControlClient(baseWsUrl, { type: "auth", token: TOKEN });

    await expectMessage(control, (payload) => payload.type === "auth_ok");
    control.send(JSON.stringify({ type: "subscribe_workspace" }));
    await expectWorkspace(control, "alpha");
    control.__messageQueue.length = 0;

    // In direct-shell mode, workspace state is always available synchronously
    // after switch_session (no need to wait for terminal attach).
    control.send(JSON.stringify({ type: "switch_session", session: "gamma" }));
    await expectMessage(control, (payload) => payload.type === "session_switched" && payload.session === "gamma");
    expect(await expectWorkspace(control, "gamma")).toMatchObject({ session: "gamma" });

    control.close();
  });

  it("creates a new session and immediately publishes workspace state", async () => {
    const control = await connectControlClient(baseWsUrl, { type: "auth", token: TOKEN });

    await expectMessage(control, (payload) => payload.type === "auth_ok");
    control.send(JSON.stringify({ type: "subscribe_workspace" }));
    await expectWorkspace(control, "alpha");
    control.__messageQueue.length = 0;

    // In direct-shell mode, create_session immediately switches and publishes state.
    control.send(JSON.stringify({ type: "create_session", name: "delta" }));
    await expectMessage(control, (payload) => payload.type === "session_switched" && payload.session === "delta");
    expect(await expectWorkspace(control, "delta")).toMatchObject({ session: "delta" });

    control.close();
  });
});

const connectControlClient = async (
  baseWsUrl: string,
  authMessage: Record<string, unknown>,
): Promise<BufferedWebSocket> => {
  const ws = new WebSocket(`${baseWsUrl}/ws/control`) as BufferedWebSocket;
  ws.__messageQueue = [];
  ws.on("message", (raw) => {
    ws.__messageQueue.push(String(raw));
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  ws.send(JSON.stringify(authMessage));
  return ws;
};

const connectTerminalClient = async (
  baseWsUrl: string,
  authMessage: Record<string, unknown>,
): Promise<WebSocket> => {
  const ws = new WebSocket(`${baseWsUrl}/ws/terminal`);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for terminal auth"));
    }, 5_000);

    const cleanup = () => {
      clearTimeout(timeout);
      ws.off("message", onMessage);
      ws.off("error", onError);
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const onMessage = (raw: WebSocket.RawData) => {
      const payload = JSON.parse(String(raw)) as Record<string, unknown>;
      if (payload.type !== "auth_ok") {
        return;
      }
      cleanup();
      resolve();
    };

    ws.on("open", () => {
      ws.send(JSON.stringify(authMessage));
    });
    ws.on("message", onMessage);
    ws.on("error", onError);
  });
  return ws;
};

const expectWorkspace = async (
  ws: BufferedWebSocket,
  session?: string,
): Promise<Record<string, any>> => {
  return expectMessage(ws, (payload) => {
    return payload.type === "workspace_state" && (session === undefined || payload.session === session);
  });
};

const expectMessage = async (
  ws: BufferedWebSocket,
  matcher: (payload: Record<string, any>) => boolean,
): Promise<Record<string, any>> => {
  const queuedIndex = ws.__messageQueue.findIndex((raw) => {
    try {
      return matcher(JSON.parse(raw) as Record<string, any>);
    } catch {
      return false;
    }
  });

  if (queuedIndex >= 0) {
    const [queued] = ws.__messageQueue.splice(queuedIndex, 1);
    return JSON.parse(queued) as Record<string, any>;
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for matching message"));
    }, 5_000);

    const cleanup = () => {
      clearTimeout(timeout);
      ws.off("message", onMessage);
      ws.off("error", onError);
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const onMessage = (raw: WebSocket.RawData) => {
      try {
        const normalized = String(raw);
        const payload = JSON.parse(normalized) as Record<string, any>;
        if (!matcher(payload)) {
          return;
        }
        const queuedMessageIndex = ws.__messageQueue.indexOf(normalized);
        if (queuedMessageIndex >= 0) {
          ws.__messageQueue.splice(queuedMessageIndex, 1);
        }
        cleanup();
        resolve(payload);
      } catch (error) {
        cleanup();
        reject(error);
      }
    };

    ws.on("message", onMessage);
    ws.on("error", onError);
  });
};

const waitForAssertion = async (
  assertion: () => void,
  timeoutMs = 1_000,
  intervalMs = 10,
): Promise<void> => {
  const startedAt = Date.now();
  while (true) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() - startedAt >= timeoutMs) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
};

const expectNoMessage = async (
  ws: BufferedWebSocket,
  matcher: (payload: Record<string, any>) => boolean,
  timeoutMs = 150,
): Promise<void> => {
  const matchedQueued = ws.__messageQueue.some((raw) => {
    try {
      return matcher(JSON.parse(raw) as Record<string, any>);
    } catch {
      return false;
    }
  });

  if (matchedQueued) {
    throw new Error("unexpected queued message matched");
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      ws.off("message", onMessage);
      ws.off("error", onError);
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const onMessage = (raw: WebSocket.RawData) => {
      try {
        const payload = JSON.parse(String(raw)) as Record<string, any>;
        if (!matcher(payload)) {
          return;
        }
        cleanup();
        reject(new Error("unexpected matching message"));
      } catch {
        cleanup();
        reject(new Error("unexpected non-JSON message"));
      }
    };

    ws.on("message", onMessage);
    ws.on("error", onError);
  });
};

const createMemoryDeviceStore = () => {
  const metadata = new Map<string, string>();
  return {
    close() {},
    getOrCreateMetadata(key: string, factory: () => string) {
      if (!metadata.has(key)) {
        metadata.set(key, factory());
      }
      return metadata.get(key) as string;
    },
    getDevice() {
      return null;
    },
    listDevices() {
      return [];
    },
    saveDevice(device: unknown) {
      return device;
    },
    updateDeviceLastSeen() {},
    revokeDevice() {
      return null;
    },
    savePairingSession(session: unknown) {
      return session;
    },
    getPairingSession() {
      return null;
    },
    markPairingSessionRedeemed() {
      return null;
    },
    markExpiredPairingSessions() {
      return 0;
    },
  };
};

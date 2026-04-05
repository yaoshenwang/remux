/**
 * Auth tests for Remux server.
 * Tests: auto-generated token, password authentication, token validation.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "child_process";
import http from "http";
import WebSocket from "ws";
import fs from "fs";
import path from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_JS = path.join(__dirname, "..", "server.js");

function httpGet(port, urlPath) {
  return new Promise((resolve, reject) => {
    http
      .get(`http://localhost:${port}${urlPath}`, (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () =>
          resolve({ status: res.statusCode, body, headers: res.headers }),
        );
      })
      .on("error", reject);
  });
}

function httpPost(port, urlPath, data) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(data).toString();
    const req = http.request(
      {
        hostname: "localhost",
        port,
        path: urlPath,
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let resBody = "";
        res.on("data", (d) => (resBody += d));
        res.on("end", () =>
          resolve({ status: res.statusCode, body: resBody, headers: res.headers }),
        );
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function connectWs(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

/** Unwrap envelope if present. */
function unwrap(parsed) {
  if (parsed && parsed.v === 1 && typeof parsed.type === "string") {
    return { type: parsed.type, ...(parsed.payload || {}) };
  }
  return parsed;
}

function waitForMsg(ws, type, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeListener("message", handler);
      reject(new Error(`timeout waiting for ${type}`));
    }, timeout);
    const handler = (raw) => {
      try {
        const msg = unwrap(JSON.parse(raw.toString()));
        if (msg.type === type) {
          clearTimeout(timer);
          ws.removeListener("message", handler);
          resolve(msg);
        }
      } catch {}
    };
    ws.on("message", handler);
  });
}

/** Start a server instance and wait for "Remux running" output.
 * Returns { proc, port, stdout } where stdout contains all console output.
 * Explicitly removes REMUX_TOKEN and REMUX_PASSWORD from parent env to avoid leaking. */
function startServer(env, port) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let timeout;
    const remuxHome =
      env.REMUX_HOME || fs.mkdtempSync(path.join(tmpdir(), "remux-auth-"));
    const cleanEnv = { ...process.env };
    delete cleanEnv.REMUX_TOKEN;
    delete cleanEnv.REMUX_PASSWORD;
    const proc = spawn(process.execPath, [SERVER_JS, "--no-tunnel"], {
      env: { ...cleanEnv, ...env, PORT: String(port), REMUX_HOME: remuxHome },
      stdio: "pipe",
    });
    const fail = (error) => {
      clearTimeout(timeout);
      proc.kill("SIGTERM");
      fs.rmSync(remuxHome, { recursive: true, force: true });
      reject(error);
    };
    timeout = setTimeout(
      () => fail(new Error("server start timeout")),
      10000,
    );
    proc.stdout.on("data", (d) => {
      stdout += d.toString();
      if (stdout.includes("Remux running")) {
        clearTimeout(timeout);
        // Extra delay for WASM init
        setTimeout(() => resolve({ proc, port, stdout, remuxHome }), 2000);
      }
    });
    proc.stderr.on("data", (d) => {
      stdout += d.toString();
    });
    proc.on("error", fail);
  });
}

function cleanupServer(server) {
  server?.proc?.kill("SIGTERM");
  if (server?.remuxHome) {
    fs.rmSync(server.remuxHome, { recursive: true, force: true });
  }
}

// ── Auto-generated token ─────────────────────────────────────────

describe("auto-generated token (no REMUX_TOKEN, no REMUX_PASSWORD)", () => {
  let server;

  beforeAll(async () => {
    server = await startServer(
      { REMUX_INSTANCE_ID: "auth-test-auto-" + Date.now() },
      19877,
    );
  }, 15000);

  afterAll(() => cleanupServer(server));

  it("prints full URL with auto-generated token on startup", () => {
    expect(server.stdout).toMatch(/http:\/\/localhost:\d+\?token=[a-f0-9]{32}/);
  });

  it("rejects access without token", async () => {
    const res = await httpGet(server.port, "/");
    expect(res.status).toBe(403);
  });

  it("accepts access with auto-generated token from startup output", async () => {
    const match = server.stdout.match(/token=([a-f0-9]{32})/);
    expect(match).not.toBeNull();
    const token = match[1];

    const res = await httpGet(server.port, `/?token=${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toContain("<title>Remux</title>");
  });

  it("authenticates WebSocket with auto-generated token", async () => {
    const match = server.stdout.match(/token=([a-f0-9]{32})/);
    const token = match[1];

    const ws = await connectWs(server.port);
    ws.send(JSON.stringify({ type: "auth", token }));
    const msg = await waitForMsg(ws, "auth_ok");
    expect(msg.type).toBe("auth_ok");
    ws.close();
  });
});

// ── Password authentication ──────────────────────────────────────

describe("password authentication (REMUX_PASSWORD set)", () => {
  let server;
  const TEST_PASSWORD = "test-secret-pw-" + Date.now();

  beforeAll(async () => {
    server = await startServer(
      {
        REMUX_PASSWORD: TEST_PASSWORD,
        REMUX_INSTANCE_ID: "auth-test-pw-" + Date.now(),
      },
      19878,
    );
  }, 15000);

  afterAll(() => cleanupServer(server));

  it("shows password page when accessing root without token", async () => {
    const res = await httpGet(server.port, "/");
    expect(res.status).toBe(200);
    expect(res.body).toContain("Remux — Login");
    expect(res.body).toContain('type="password"');
    expect(res.body).toContain('action="/auth"');
  });

  it("rejects wrong password and redirects with error", async () => {
    const res = await httpPost(server.port, "/auth", {
      password: "wrong-password",
    });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("error=1");
  });

  it("correct password generates working token and redirects", async () => {
    const res = await httpPost(server.port, "/auth", {
      password: TEST_PASSWORD,
    });
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/\?token=[a-f0-9]{32}/);

    // Follow the redirect — the token should work
    const tokenMatch = res.headers.location.match(/token=([a-f0-9]{32})/);
    const token = tokenMatch[1];

    const pageRes = await httpGet(server.port, `/?token=${token}`);
    expect(pageRes.status).toBe(200);
    expect(pageRes.body).toContain("<title>Remux</title>");
  });

  it("password-generated token works for WebSocket auth", async () => {
    // First get a token via password
    const res = await httpPost(server.port, "/auth", {
      password: TEST_PASSWORD,
    });
    const tokenMatch = res.headers.location.match(/token=([a-f0-9]{32})/);
    const token = tokenMatch[1];

    const ws = await connectWs(server.port);
    ws.send(JSON.stringify({ type: "auth", token }));
    const msg = await waitForMsg(ws, "auth_ok");
    expect(msg.type).toBe("auth_ok");
    ws.close();
  });

  it("rejects WebSocket auth with invalid token", async () => {
    const ws = await connectWs(server.port);
    ws.send(JSON.stringify({ type: "auth", token: "invalid-token" }));
    const msg = await waitForMsg(ws, "auth_error");
    expect(msg.reason).toBe("invalid token");
    ws.close();
  });
});

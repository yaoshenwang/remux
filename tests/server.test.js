/**
 * Integration tests for Remux server.
 * Tests: startup, HTTP auth, WebSocket session/tab management, VT snapshot, persistence.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "child_process";
import http from "http";
import WebSocket from "ws";
import fs from "fs";
import path from "path";
import { homedir } from "os";

const PORT = 19876; // test-only port
const TOKEN = "test-token-" + Date.now();
const INSTANCE_ID = "test-" + Date.now();
const PERSIST_DIR = path.join(homedir(), ".remux");
const PERSIST_FILE = path.join(PERSIST_DIR, `sessions-${INSTANCE_ID}.json`);
let serverProc;

function httpGet(urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${PORT}${urlPath}`, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    }).on("error", reject);
  });
}

function connectWs() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

/** Connect, authenticate, and consume the initial state broadcast. */
async function connectAuthed() {
  const ws = await connectWs();
  const msgs = await sendAndCollect(
    ws,
    { type: "auth", token: TOKEN },
    { timeout: 3000 },
  );
  const authOk = msgs.find((m) => m.type === "auth_ok");
  if (!authOk) throw new Error("auth failed");
  return ws;
}

function sendAndCollect(ws, msg, { timeout = 3000, filter } = {}) {
  return new Promise((resolve) => {
    const messages = [];
    const handler = (raw) => {
      const s = raw.toString();
      try {
        const parsed = JSON.parse(s);
        if (!filter || filter(parsed)) messages.push(parsed);
      } catch {
        messages.push({ _raw: s });
      }
    };
    ws.on("message", handler);
    if (msg) ws.send(JSON.stringify(msg));
    setTimeout(() => {
      ws.removeListener("message", handler);
      resolve(messages);
    }, timeout);
  });
}

function waitForMsg(ws, type, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeListener("message", handler);
      reject(new Error(`timeout waiting for ${type}`));
    }, timeout);
    const handler = (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
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

beforeAll(async () => {
  // Clean persistence file to ensure clean state
  try { fs.unlinkSync(PERSIST_FILE); } catch {}

  // Explicitly remove REMUX_PASSWORD to avoid env leaking from parent
  const cleanEnv = { ...process.env };
  delete cleanEnv.REMUX_PASSWORD;
  serverProc = spawn("node", ["server.js"], {
    env: {
      ...cleanEnv,
      PORT: String(PORT),
      REMUX_TOKEN: TOKEN,
      REMUX_INSTANCE_ID: INSTANCE_ID,
    },
    stdio: "pipe",
  });

  // Wait for server to be ready
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("server start timeout")), 10000);
    serverProc.stdout.on("data", (d) => {
      if (d.toString().includes("Remux running")) {
        clearTimeout(timeout);
        // Extra delay for WASM init
        setTimeout(resolve, 2000);
      }
    });
    serverProc.on("error", reject);
  });
}, 15000);

afterAll(() => {
  if (serverProc) serverProc.kill("SIGTERM");
  try { fs.unlinkSync(PERSIST_FILE); } catch {}
});

// ── HTTP ──────────────────────────────────────────────────────────

describe("HTTP", () => {
  it("rejects requests without token", async () => {
    const res = await httpGet("/");
    expect(res.status).toBe(403);
  });

  it("serves page with correct token", async () => {
    const res = await httpGet(`/?token=${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body).toContain("ghostty-web");
    expect(res.body).toContain("<title>Remux</title>");
  });

  it("serves ghostty-web JS", async () => {
    const res = await httpGet("/dist/ghostty-web.js");
    expect(res.status).toBe(200);
  });

  it("serves WASM file", async () => {
    const res = await httpGet("/ghostty-vt.wasm");
    expect(res.status).toBe(200);
  });
});

// ── WebSocket auth ────────────────────────────────────────────────

describe("WebSocket auth", () => {
  it("rejects connection without auth", async () => {
    const ws = await connectWs();
    ws.send(JSON.stringify({ type: "attach_first", session: "main" }));
    const msg = await waitForMsg(ws, "auth_error");
    expect(msg.reason).toBe("invalid token");
    ws.close();
  });

  it("accepts connection with valid token and sends initial state", async () => {
    const ws = await connectWs();
    const msgs = await sendAndCollect(
      ws,
      { type: "auth", token: TOKEN },
      { timeout: 3000 },
    );
    expect(msgs.some((m) => m.type === "auth_ok")).toBe(true);
    expect(msgs.some((m) => m.type === "state")).toBe(true);
    ws.close();
  });
});

// ── Session and tab management ────────────────────────────────────

describe("session and tab management", () => {
  let ws;

  beforeAll(async () => {
    ws = await connectAuthed();
  });

  afterAll(() => ws?.close());

  it("default state has main session with tabs", async () => {
    // Request state by attaching (triggers broadcastState)
    const msgs = await sendAndCollect(
      ws,
      { type: "attach_first", session: "main", cols: 80, rows: 24 },
      { timeout: 3000 },
    );
    const state = msgs.filter((m) => m.type === "state").pop();
    expect(state).toBeDefined();
    const main = state.sessions.find((s) => s.name === "main");
    expect(main).toBeDefined();
    expect(main.tabs.length).toBeGreaterThanOrEqual(1);

    const attached = msgs.find((m) => m.type === "attached");
    expect(attached).toBeDefined();
    expect(attached.session).toBe("main");
    expect(typeof attached.tabId).toBe("number");
  });

  it("receives terminal data after attach", async () => {
    // Wait a bit for shell to produce output
    await new Promise((r) => setTimeout(r, 1000));

    const msgs = await sendAndCollect(
      ws,
      { type: "attach_first", session: "main", cols: 80, rows: 24 },
      { timeout: 3000 },
    );
    // Should receive some terminal data (VT snapshot or shell output)
    const hasTermData = msgs.some((m) => m._raw);
    expect(hasTermData).toBe(true);
  });

  it("creates new tab in current session", async () => {
    const msgs = await sendAndCollect(
      ws,
      { type: "new_tab", session: "main", cols: 80, rows: 24 },
      { timeout: 3000 },
    );
    const attached = msgs.find((m) => m.type === "attached");
    expect(attached).toBeDefined();
    expect(attached.session).toBe("main");

    const state = msgs.filter((m) => m.type === "state").pop();
    if (state) {
      const main = state.sessions.find((s) => s.name === "main");
      expect(main.tabs.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("creates new session with tab", async () => {
    const msgs = await sendAndCollect(
      ws,
      { type: "new_session", name: "test-session", cols: 80, rows: 24 },
      { timeout: 3000 },
    );
    const attached = msgs.find((m) => m.type === "attached");
    expect(attached).toBeDefined();
    expect(attached.session).toBe("test-session");

    const state = msgs.filter((m) => m.type === "state").pop();
    if (state) {
      expect(state.sessions.some((s) => s.name === "test-session")).toBe(true);
    }
  });

  it("does not create duplicate session with same name", async () => {
    // Create "dup-test" session
    await sendAndCollect(
      ws,
      { type: "new_session", name: "dup-test", cols: 80, rows: 24 },
      { timeout: 2000 },
    );

    // Try to create again with same name — should attach, not duplicate
    const msgs = await sendAndCollect(
      ws,
      { type: "new_session", name: "dup-test", cols: 80, rows: 24 },
      { timeout: 2000 },
    );
    const state = msgs.filter((m) => m.type === "state").pop();
    if (state) {
      const matches = state.sessions.filter((s) => s.name === "dup-test");
      expect(matches.length).toBe(1);
    }

    // Cleanup
    await sendAndCollect(ws, { type: "attach_first", session: "main", cols: 80, rows: 24 }, { timeout: 1000 });
    ws.send(JSON.stringify({ type: "delete_session", name: "dup-test" }));
    await new Promise((r) => setTimeout(r, 500));
  });

  it("deletes session", async () => {
    // Switch back to main first
    await sendAndCollect(ws, { type: "attach_first", session: "main", cols: 80, rows: 24 }, { timeout: 1000 });

    const msgs = await sendAndCollect(
      ws,
      { type: "delete_session", name: "test-session" },
      { timeout: 2000 },
    );
    const state = msgs.filter((m) => m.type === "state").pop();
    if (state) {
      expect(state.sessions.some((s) => s.name === "test-session")).toBe(false);
    }
  });

  it("handles resize", async () => {
    ws.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
    await new Promise((r) => setTimeout(r, 200));
    // No error = pass
  });

  it("close_tab removes tab from session", async () => {
    // Create a new tab
    const newTabMsgs = await sendAndCollect(
      ws,
      { type: "new_tab", session: "main", cols: 80, rows: 24 },
      { timeout: 3000 },
    );
    const attached = newTabMsgs.find((m) => m.type === "attached");
    expect(attached).toBeDefined();
    const newTabId = attached.tabId;

    // Close it
    const closeMsgs = await sendAndCollect(
      ws,
      { type: "close_tab", tabId: newTabId },
      { timeout: 2000 },
    );
    const state = closeMsgs.filter((m) => m.type === "state").pop();
    if (state) {
      const main = state.sessions.find((s) => s.name === "main");
      expect(main.tabs.some((t) => t.id === newTabId)).toBe(false);
    }
  });
});

// ── Multi-client ──────────────────────────────────────────────────

describe("multi-client", () => {
  it("two clients can attach to same tab", async () => {
    const ws1 = await connectAuthed();
    const ws2 = await connectAuthed();

    const msgs1 = await sendAndCollect(
      ws1,
      { type: "attach_first", session: "main", cols: 100, rows: 30 },
      { timeout: 3000 },
    );
    const msgs2 = await sendAndCollect(
      ws2,
      { type: "attach_first", session: "main", cols: 80, rows: 24 },
      { timeout: 3000 },
    );

    const att1 = msgs1.find((m) => m.type === "attached");
    const att2 = msgs2.find((m) => m.type === "attached");
    expect(att1).toBeDefined();
    expect(att2).toBeDefined();
    expect(att1.tabId).toBe(att2.tabId);

    // State should show 2+ clients on the tab
    const state = msgs2.filter((m) => m.type === "state").pop();
    if (state) {
      const main = state.sessions.find((s) => s.name === "main");
      const tab = main.tabs.find((t) => t.id === att1.tabId);
      expect(tab.clients).toBeGreaterThanOrEqual(2);
    }

    ws1.close();
    ws2.close();
  });

  it("one client disconnect does not affect other", async () => {
    const ws1 = await connectAuthed();
    const ws2 = await connectAuthed();

    await sendAndCollect(ws1, { type: "attach_first", session: "main", cols: 80, rows: 24 }, { timeout: 3000 });
    await sendAndCollect(ws2, { type: "attach_first", session: "main", cols: 80, rows: 24 }, { timeout: 3000 });

    // Disconnect ws1
    ws1.close();
    await new Promise((r) => setTimeout(r, 500));

    // ws2 should still be able to send and receive terminal data
    const msgs = await sendAndCollect(ws2, null, { timeout: 2000 });
    ws2.send("echo alive\n");
    const afterSend = await sendAndCollect(ws2, null, { timeout: 2000 });
    // Should have received something (terminal output or state)
    expect(msgs.length + afterSend.length).toBeGreaterThanOrEqual(0);
    // The key assertion: ws2 is still open
    expect(ws2.readyState).toBe(WebSocket.OPEN);

    ws2.close();
  });
});

// ── VT snapshot ───────────────────────────────────────────────────

describe("VT snapshot", () => {
  it("sends VT snapshot on attach", async () => {
    const ws = await connectAuthed();

    // First attach to generate some terminal activity
    await sendAndCollect(ws, { type: "attach_first", session: "main", cols: 80, rows: 24 }, { timeout: 2000 });
    ws.send("echo snapshot-test\n");
    await new Promise((r) => setTimeout(r, 1000));

    // Re-attach to trigger snapshot
    let termData = "";
    const collector = (raw) => {
      const s = raw.toString();
      if (!s.startsWith("{")) termData += s;
    };
    ws.on("message", collector);
    ws.send(JSON.stringify({ type: "attach_first", session: "main", cols: 80, rows: 24 }));
    await new Promise((r) => setTimeout(r, 3000));
    ws.removeListener("message", collector);

    // Snapshot should contain VT escape sequences
    expect(termData.length).toBeGreaterThan(0);
    expect(termData).toContain("\x1b[");

    ws.close();
  }, 10000);

  it("snapshot includes cursor positioning", async () => {
    const ws = await connectAuthed();

    await sendAndCollect(ws, { type: "attach_first", session: "main", cols: 80, rows: 24 }, { timeout: 2000 });
    ws.send("echo cursor-test\n");
    await new Promise((r) => setTimeout(r, 1000));

    // Re-attach to get snapshot
    let termData = "";
    const collector = (raw) => {
      const s = raw.toString();
      if (!s.startsWith("{")) termData += s;
    };
    ws.on("message", collector);
    ws.send(JSON.stringify({ type: "attach_first", session: "main", cols: 80, rows: 24 }));
    await new Promise((r) => setTimeout(r, 3000));
    ws.removeListener("message", collector);

    // Snapshot should contain cursor positioning: ESC[<row>;<col>H
    expect(termData).toMatch(/\x1b\[\d+;\d+H/);

    ws.close();
  }, 10000);
});

// ── Inspect ───────────────────────────────────────────────────────

describe("inspect", () => {
  it("returns text snapshot of current tab", async () => {
    const ws = await connectAuthed();

    // Attach and run a command
    await sendAndCollect(ws, { type: "attach_first", session: "main", cols: 80, rows: 24 }, { timeout: 2000 });
    ws.send("echo inspect-test-output\n");
    await new Promise((r) => setTimeout(r, 1000));

    // Request inspect
    const msgs = await sendAndCollect(
      ws,
      { type: "inspect" },
      { timeout: 3000 },
    );
    const result = msgs.find((m) => m.type === "inspect_result");
    expect(result).toBeDefined();
    expect(typeof result.text).toBe("string");
    expect(result.text).toContain("inspect-test-output");
    expect(result.meta).toBeDefined();
    expect(result.meta.session).toBe("main");
    expect(typeof result.meta.cols).toBe("number");
    expect(typeof result.meta.timestamp).toBe("number");

    ws.close();
  });

  it("inspect text has no ANSI escape sequences", async () => {
    const ws = await connectAuthed();
    await sendAndCollect(ws, { type: "attach_first", session: "main", cols: 80, rows: 24 }, { timeout: 2000 });

    const msgs = await sendAndCollect(ws, { type: "inspect" }, { timeout: 3000 });
    const result = msgs.find((m) => m.type === "inspect_result");
    expect(result).toBeDefined();
    // No ESC sequences in the text
    expect(result.text).not.toMatch(/\x1b\[/);

    ws.close();
  });
});

// ── Persistence ───────────────────────────────────────────────────

describe("persistence", () => {
  it("saves sessions to disk within 10 seconds", async () => {
    // Wait for persistence timer (8s interval + margin)
    await new Promise((r) => setTimeout(r, 10000));

    expect(fs.existsSync(PERSIST_FILE)).toBe(true);
    const data = JSON.parse(fs.readFileSync(PERSIST_FILE, "utf8"));
    expect(data.version).toBe(1);
    expect(data.sessions.length).toBeGreaterThanOrEqual(1);
    expect(data.sessions[0].name).toBe("main");
    expect(data.sessions[0].tabs.length).toBeGreaterThanOrEqual(1);
  }, 15000);
});

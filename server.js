#!/usr/bin/env node

// src/server.ts
import fs3 from "fs";
import http from "http";
import path2 from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import qrcode from "qrcode-terminal";

// src/auth.ts
import crypto from "crypto";
var passwordTokens = /* @__PURE__ */ new Set();
function parseCliPassword(argv) {
  const idx = argv.indexOf("--password");
  return idx !== -1 && idx + 1 < argv.length ? argv[idx + 1] : null;
}
function resolveAuth(argv) {
  const PASSWORD2 = process.env.REMUX_PASSWORD || parseCliPassword(argv) || null;
  const TOKEN2 = process.env.REMUX_TOKEN || (PASSWORD2 ? null : crypto.randomBytes(16).toString("hex"));
  return { TOKEN: TOKEN2, PASSWORD: PASSWORD2 };
}
function generateToken() {
  return crypto.randomBytes(16).toString("hex");
}
function validateToken(token, TOKEN2) {
  if (TOKEN2 && token === TOKEN2) return true;
  if (passwordTokens.has(token)) return true;
  return false;
}
var PASSWORD_PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Remux \u2014 Login</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #1e1e1e; color: #ccc; height: 100vh; display: flex;
      align-items: center; justify-content: center; }
    .login { background: #252526; border-radius: 8px; padding: 32px; width: 320px;
      box-shadow: 0 4px 24px rgba(0,0,0,.4); }
    .login h1 { font-size: 18px; color: #e5e5e5; margin-bottom: 20px; text-align: center; }
    .login input { width: 100%; padding: 10px 12px; font-size: 14px; background: #1e1e1e;
      border: 1px solid #3a3a3a; border-radius: 4px; color: #d4d4d4;
      font-family: inherit; outline: none; margin-bottom: 12px; }
    .login input:focus { border-color: #007acc; }
    .login button { width: 100%; padding: 10px; font-size: 14px; background: #007acc;
      border: none; border-radius: 4px; color: #fff; cursor: pointer;
      font-family: inherit; font-weight: 500; }
    .login button:hover { background: #0098ff; }
    .login .error { color: #f14c4c; font-size: 12px; margin-bottom: 12px; display: none; text-align: center; }
  </style>
</head>
<body>
  <form class="login" method="POST" action="/auth">
    <h1>Remux</h1>
    <div class="error" id="error">Incorrect password</div>
    <input type="password" name="password" placeholder="Password" autofocus required />
    <button type="submit">Login</button>
  </form>
  <script>
    if (location.search.includes('error=1')) document.getElementById('error').style.display = 'block';
  </script>
</body>
</html>`;

// src/vt-tracker.ts
import fs from "fs";
var wasmExports = null;
var wasmMemory = null;
async function initGhosttyVt(wasmPath2) {
  const wasmBytes = fs.readFileSync(wasmPath2);
  const result = await WebAssembly.instantiate(wasmBytes, {
    env: { log: () => {
    } }
  });
  wasmExports = result.instance.exports;
  wasmMemory = wasmExports.memory;
  console.log("[ghostty-vt] WASM loaded for server-side VT tracking");
}
function createVtTerminal(cols, rows) {
  if (!wasmExports) return null;
  const handle = wasmExports.ghostty_terminal_new(cols, rows);
  if (!handle) return null;
  return {
    handle,
    consume(data) {
      const bytes = typeof data === "string" ? Buffer.from(data) : data;
      const ptr = wasmExports.ghostty_wasm_alloc_u8_array(bytes.length);
      new Uint8Array(wasmMemory.buffer).set(bytes, ptr);
      wasmExports.ghostty_terminal_write(handle, ptr, bytes.length);
      wasmExports.ghostty_wasm_free_u8_array(ptr, bytes.length);
    },
    resize(cols2, rows2) {
      wasmExports.ghostty_terminal_resize(handle, cols2, rows2);
    },
    isAltScreen() {
      return !!wasmExports.ghostty_terminal_is_alternate_screen(handle);
    },
    snapshot() {
      wasmExports.ghostty_render_state_update(handle);
      const cols2 = wasmExports.ghostty_render_state_get_cols(handle);
      const rows2 = wasmExports.ghostty_render_state_get_rows(handle);
      const cellSize = 16;
      const bufSize = cols2 * rows2 * cellSize;
      const bufPtr = wasmExports.ghostty_wasm_alloc_u8_array(bufSize);
      const count = wasmExports.ghostty_render_state_get_viewport(
        handle,
        bufPtr,
        bufSize
      );
      const view = new DataView(wasmMemory.buffer);
      let out = "\x1B[H\x1B[2J";
      let lastFg = null;
      let lastBg = null;
      let lastFlags = 0;
      for (let row = 0; row < rows2; row++) {
        if (row > 0) out += "\r\n";
        for (let col = 0; col < cols2; col++) {
          const off = bufPtr + (row * cols2 + col) * cellSize;
          const cp = view.getUint32(off, true);
          const fg_r = view.getUint8(off + 4);
          const fg_g = view.getUint8(off + 5);
          const fg_b = view.getUint8(off + 6);
          const bg_r = view.getUint8(off + 7);
          const bg_g = view.getUint8(off + 8);
          const bg_b = view.getUint8(off + 9);
          const flags = view.getUint8(off + 10);
          const width = view.getUint8(off + 11);
          if (width === 0) continue;
          const fgKey = fg_r << 16 | fg_g << 8 | fg_b;
          const bgKey = bg_r << 16 | bg_g << 8 | bg_b;
          let sgr = "";
          if (flags !== lastFlags) {
            sgr += "\x1B[0m";
            if (flags & 1) sgr += "\x1B[1m";
            if (flags & 2) sgr += "\x1B[3m";
            if (flags & 4) sgr += "\x1B[4m";
            if (flags & 128) sgr += "\x1B[2m";
            lastFg = null;
            lastBg = null;
            lastFlags = flags;
          }
          if (fgKey !== lastFg && fgKey !== 0) {
            sgr += `\x1B[38;2;${fg_r};${fg_g};${fg_b}m`;
            lastFg = fgKey;
          }
          if (bgKey !== lastBg && bgKey !== 0) {
            sgr += `\x1B[48;2;${bg_r};${bg_g};${bg_b}m`;
            lastBg = bgKey;
          }
          out += sgr;
          out += cp > 0 ? String.fromCodePoint(cp) : " ";
        }
      }
      const cx = wasmExports.ghostty_render_state_get_cursor_x(handle);
      const cy = wasmExports.ghostty_render_state_get_cursor_y(handle);
      out += `\x1B[0m\x1B[${cy + 1};${cx + 1}H`;
      wasmExports.ghostty_wasm_free_u8_array(bufPtr, bufSize);
      return out;
    },
    textSnapshot() {
      wasmExports.ghostty_render_state_update(handle);
      const cols2 = wasmExports.ghostty_render_state_get_cols(handle);
      const rows2 = wasmExports.ghostty_render_state_get_rows(handle);
      const cellSize = 16;
      const bufSize = cols2 * rows2 * cellSize;
      const bufPtr = wasmExports.ghostty_wasm_alloc_u8_array(bufSize);
      wasmExports.ghostty_render_state_get_viewport(handle, bufPtr, bufSize);
      const view = new DataView(wasmMemory.buffer);
      const lines = [];
      for (let row = 0; row < rows2; row++) {
        let line = "";
        for (let col = 0; col < cols2; col++) {
          const off = bufPtr + (row * cols2 + col) * cellSize;
          const cp = view.getUint32(off, true);
          const width = view.getUint8(off + 11);
          if (width === 0) continue;
          line += cp > 0 ? String.fromCodePoint(cp) : " ";
        }
        lines.push(line.trimEnd());
      }
      wasmExports.ghostty_wasm_free_u8_array(bufPtr, bufSize);
      while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
      return { text: lines.join("\n"), cols: cols2, rows: rows2 };
    },
    dispose() {
      wasmExports.ghostty_terminal_free(handle);
    }
  };
}

// src/session.ts
import fs2 from "fs";
import path from "path";
import { homedir } from "os";
import pty from "node-pty";
var RingBuffer = class {
  buf;
  maxBytes;
  writePos;
  length;
  constructor(maxBytes = 10 * 1024 * 1024) {
    this.buf = Buffer.alloc(maxBytes);
    this.maxBytes = maxBytes;
    this.writePos = 0;
    this.length = 0;
  }
  write(data) {
    const bytes = typeof data === "string" ? Buffer.from(data) : data;
    if (bytes.length >= this.maxBytes) {
      bytes.copy(this.buf, 0, bytes.length - this.maxBytes);
      this.writePos = 0;
      this.length = this.maxBytes;
      return;
    }
    const space = this.maxBytes - this.writePos;
    if (bytes.length <= space) {
      bytes.copy(this.buf, this.writePos);
    } else {
      bytes.copy(this.buf, this.writePos, 0, space);
      bytes.copy(this.buf, 0, space);
    }
    this.writePos = (this.writePos + bytes.length) % this.maxBytes;
    this.length = Math.min(this.length + bytes.length, this.maxBytes);
  }
  read() {
    if (this.length === 0) return Buffer.alloc(0);
    if (this.length < this.maxBytes) {
      return this.buf.subarray(this.writePos - this.length, this.writePos);
    }
    return Buffer.concat([
      this.buf.subarray(this.writePos),
      this.buf.subarray(0, this.writePos)
    ]);
  }
};
function getShell() {
  if (process.platform === "win32") return process.env.COMSPEC || "cmd.exe";
  if (process.env.SHELL) return process.env.SHELL;
  try {
    fs2.accessSync("/bin/zsh", fs2.constants.X_OK);
    return "/bin/zsh";
  } catch {
  }
  return "/bin/bash";
}
var tabIdCounter = 0;
var sessionMap = /* @__PURE__ */ new Map();
var controlClients = /* @__PURE__ */ new Set();
function createTab(session, cols = 80, rows = 24) {
  const id = tabIdCounter++;
  const ptyProcess = pty.spawn(getShell(), [], {
    name: "xterm-256color",
    cols,
    rows,
    cwd: homedir(),
    env: {
      ...process.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor"
    }
  });
  const vtTerminal = createVtTerminal(cols, rows);
  const tab = {
    id,
    pty: ptyProcess,
    scrollback: new RingBuffer(),
    vt: vtTerminal,
    clients: /* @__PURE__ */ new Set(),
    cols,
    rows,
    ended: false,
    title: `Tab ${session.tabs.length + 1}`
  };
  ptyProcess.onData((data) => {
    tab.scrollback.write(data);
    if (tab.vt) tab.vt.consume(data);
    for (const ws of tab.clients) {
      if (ws.readyState === ws.OPEN) ws.send(data);
    }
  });
  ptyProcess.onExit(({ exitCode }) => {
    tab.ended = true;
    if (tab.vt) {
      tab.vt.dispose();
      tab.vt = null;
    }
    const msg = `\r
\x1B[33mShell exited (code: ${exitCode})\x1B[0m\r
`;
    for (const ws of tab.clients) {
      if (ws.readyState === ws.OPEN) ws.send(msg);
    }
    broadcastState();
  });
  session.tabs.push(tab);
  console.log(
    `[tab] created id=${id} in session "${session.name}" (pid=${ptyProcess.pid})`
  );
  return tab;
}
function createSession(name) {
  if (sessionMap.has(name)) return sessionMap.get(name);
  const session = { name, tabs: [], createdAt: Date.now() };
  sessionMap.set(name, session);
  console.log(`[session] created "${name}"`);
  return session;
}
function deleteSession(name) {
  const session = sessionMap.get(name);
  if (!session) return;
  for (const tab of session.tabs) {
    if (!tab.ended) tab.pty.kill();
  }
  sessionMap.delete(name);
  console.log(`[session] deleted "${name}"`);
}
function getState() {
  return [...sessionMap.values()].map((s) => ({
    name: s.name,
    tabs: s.tabs.map((t) => ({
      id: t.id,
      title: t.title,
      ended: t.ended,
      clients: t.clients.size
    })),
    createdAt: s.createdAt
  }));
}
function findTab(tabId) {
  if (tabId == null) return null;
  for (const session of sessionMap.values()) {
    const tab = session.tabs.find((t) => t.id === tabId);
    if (tab) return { session, tab };
  }
  return null;
}
function attachToTab(tab, ws, cols, rows) {
  detachFromTab(ws);
  if (ws.readyState === ws.OPEN) {
    if (tab.vt && !tab.ended) {
      const snapshot = tab.vt.snapshot();
      if (snapshot) ws.send(snapshot);
    } else {
      const history = tab.scrollback.read();
      if (history.length > 0) ws.send(history.toString("utf8"));
    }
  }
  tab.clients.add(ws);
  ws._remuxTabId = tab.id;
  ws._remuxCols = cols;
  ws._remuxRows = rows;
  recalcTabSize(tab);
  if (!tab.ended) {
    setTimeout(() => {
      tab.pty.write("\f");
    }, 50);
  }
}
function detachFromTab(ws) {
  const prevId = ws._remuxTabId;
  if (prevId == null) return;
  for (const session of sessionMap.values()) {
    const tab = session.tabs.find((t) => t.id === prevId);
    if (tab) {
      tab.clients.delete(ws);
      if (tab.clients.size > 0) recalcTabSize(tab);
      break;
    }
  }
  ws._remuxTabId = null;
}
function recalcTabSize(tab) {
  let minCols = Infinity;
  let minRows = Infinity;
  for (const ws of tab.clients) {
    if (ws._remuxCols) minCols = Math.min(minCols, ws._remuxCols);
    if (ws._remuxRows) minRows = Math.min(minRows, ws._remuxRows);
  }
  if (minCols < Infinity && minRows < Infinity && !tab.ended) {
    tab.cols = minCols;
    tab.rows = minRows;
    tab.pty.resize(minCols, minRows);
    if (tab.vt) tab.vt.resize(minCols, minRows);
  }
}
var _sendEnvelopeFn = null;
var _getClientListFn = null;
function setBroadcastHooks(sendFn, clientListFn) {
  _sendEnvelopeFn = sendFn;
  _getClientListFn = clientListFn;
}
function broadcastState() {
  const state = getState();
  const clients = _getClientListFn ? _getClientListFn() : [];
  for (const ws of controlClients) {
    if (_sendEnvelopeFn) {
      _sendEnvelopeFn(ws, "state", { sessions: state, clients });
    } else {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ v: 1, type: "state", payload: { sessions: state, clients } }));
      }
    }
  }
}
var PERSIST_DIR = path.join(homedir(), ".remux");
var PORT = process.env.PORT || 8767;
var PERSIST_ID = process.env.REMUX_INSTANCE_ID || `port-${PORT}`;
var PERSIST_FILE = path.join(PERSIST_DIR, `sessions-${PERSIST_ID}.json`);
var PERSIST_INTERVAL_MS = 8e3;
function persistSessions() {
  const data = [...sessionMap.values()].map((s) => ({
    name: s.name,
    createdAt: s.createdAt,
    tabs: s.tabs.map((t) => ({
      id: t.id,
      title: t.title,
      ended: t.ended,
      scrollback: t.ended ? null : t.scrollback.read().toString("utf8").slice(-2e5)
    }))
  }));
  try {
    if (!fs2.existsSync(PERSIST_DIR))
      fs2.mkdirSync(PERSIST_DIR, { recursive: true });
    fs2.writeFileSync(
      PERSIST_FILE,
      JSON.stringify({ version: 1, sessions: data })
    );
  } catch (e) {
    console.error("[persist] save failed:", e.message);
  }
}
function restoreSessions() {
  try {
    if (!fs2.existsSync(PERSIST_FILE)) return false;
    const raw = JSON.parse(fs2.readFileSync(PERSIST_FILE, "utf8"));
    if (raw.version !== 1 || !Array.isArray(raw.sessions)) return false;
    console.log(`[persist] restoring ${raw.sessions.length} session(s)`);
    return raw;
  } catch (e) {
    console.error("[persist] restore failed:", e.message);
    return false;
  }
}

// src/ws-handler.ts
import crypto2 from "crypto";
import { WebSocketServer } from "ws";
function sendEnvelope(ws, type, payload) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ v: 1, type, payload }));
  }
}
function unwrapMessage(parsed) {
  if (parsed && parsed.v === 1 && typeof parsed.type === "string") {
    return { type: parsed.type, ...parsed.payload || {} };
  }
  return parsed;
}
var clientStates = /* @__PURE__ */ new Map();
function generateClientId() {
  return crypto2.randomBytes(4).toString("hex");
}
function getActiveClientForTab(tabId) {
  for (const [ws, state] of clientStates) {
    if (state.currentTabId === tabId && state.role === "active") return ws;
  }
  return null;
}
function assignRole(ws, tabId) {
  const state = clientStates.get(ws);
  if (!state) return;
  const existingActive = getActiveClientForTab(tabId);
  if (!existingActive || existingActive === ws) {
    state.role = "active";
  } else {
    state.role = "observer";
  }
  state.currentTabId = tabId;
}
function reassignRolesAfterDetach(tabId, wasActive) {
  if (!wasActive) return;
  for (const [ws, state] of clientStates) {
    if (state.currentTabId === tabId && state.role === "observer" && ws.readyState === ws.OPEN) {
      state.role = "active";
      sendEnvelope(ws, "role_changed", {
        clientId: state.clientId,
        role: "active"
      });
      break;
    }
  }
}
function getClientList() {
  const list = [];
  for (const [ws, state] of clientStates) {
    if (ws.readyState === ws.OPEN) {
      list.push({
        clientId: state.clientId,
        role: state.role,
        session: state.currentSession,
        tabId: state.currentTabId
      });
    }
  }
  return list;
}
function setupWebSocket(httpServer2, TOKEN2, PASSWORD2) {
  setBroadcastHooks(sendEnvelope, getClientList);
  const wss = new WebSocketServer({ noServer: true });
  httpServer2.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === "/ws") {
      wss.handleUpgrade(
        req,
        socket,
        head,
        (ws) => wss.emit("connection", ws, req)
      );
    } else {
      socket.destroy();
    }
  });
  const HEARTBEAT_INTERVAL = 3e4;
  setInterval(() => {
    for (const ws of controlClients) {
      if (ws.readyState === ws.OPEN) ws.ping();
    }
  }, HEARTBEAT_INTERVAL);
  wss.on("connection", (rawWs) => {
    const ws = rawWs;
    ws._remuxTabId = null;
    ws._remuxCols = 80;
    ws._remuxRows = 24;
    const requiresAuth = !!(TOKEN2 || PASSWORD2);
    ws._remuxAuthed = !requiresAuth;
    const clientId = generateClientId();
    const clientState = {
      clientId,
      role: "observer",
      connectedAt: Date.now(),
      currentSession: null,
      currentTabId: null
    };
    clientStates.set(ws, clientState);
    if (!requiresAuth) controlClients.add(ws);
    ws.on("message", (raw) => {
      const msg = raw.toString("utf8");
      if (!ws._remuxAuthed) {
        try {
          const rawParsed = JSON.parse(msg);
          const parsed = unwrapMessage(rawParsed);
          if (parsed.type === "auth") {
            if (validateToken(parsed.token, TOKEN2)) {
              ws._remuxAuthed = true;
              controlClients.add(ws);
              sendEnvelope(ws, "auth_ok", {});
              sendEnvelope(ws, "state", {
                sessions: getState(),
                clients: getClientList()
              });
              return;
            }
          }
        } catch {
        }
        sendEnvelope(ws, "auth_error", { reason: "invalid token" });
        ws.close(4001, "unauthorized");
        return;
      }
      if (msg.startsWith("{")) {
        try {
          const rawParsed = JSON.parse(msg);
          const p = unwrapMessage(rawParsed);
          if (p.type === "attach_first") {
            const name = p.session || "main";
            const session = createSession(name);
            let tab = session.tabs.find((t) => !t.ended);
            if (!tab)
              tab = createTab(
                session,
                p.cols || ws._remuxCols,
                p.rows || ws._remuxRows
              );
            attachToTab(
              tab,
              ws,
              p.cols || ws._remuxCols,
              p.rows || ws._remuxRows
            );
            clientState.currentSession = name;
            assignRole(ws, tab.id);
            broadcastState();
            sendEnvelope(ws, "attached", {
              tabId: tab.id,
              session: name,
              clientId: clientState.clientId,
              role: clientState.role
            });
            return;
          }
          if (p.type === "attach_tab") {
            const found2 = findTab(p.tabId);
            if (found2) {
              attachToTab(
                found2.tab,
                ws,
                p.cols || ws._remuxCols,
                p.rows || ws._remuxRows
              );
              clientState.currentSession = found2.session.name;
              assignRole(ws, found2.tab.id);
              broadcastState();
              sendEnvelope(ws, "attached", {
                tabId: found2.tab.id,
                session: found2.session.name,
                clientId: clientState.clientId,
                role: clientState.role
              });
            }
            return;
          }
          if (p.type === "new_tab") {
            const session = createSession(p.session || "main");
            const tab = createTab(
              session,
              p.cols || ws._remuxCols,
              p.rows || ws._remuxRows
            );
            attachToTab(
              tab,
              ws,
              p.cols || ws._remuxCols,
              p.rows || ws._remuxRows
            );
            clientState.currentSession = session.name;
            assignRole(ws, tab.id);
            broadcastState();
            sendEnvelope(ws, "attached", {
              tabId: tab.id,
              session: session.name,
              clientId: clientState.clientId,
              role: clientState.role
            });
            return;
          }
          if (p.type === "close_tab") {
            const found2 = findTab(p.tabId);
            if (found2) {
              if (!found2.tab.ended) found2.tab.pty.kill();
              found2.session.tabs = found2.session.tabs.filter(
                (t) => t.id !== p.tabId
              );
              if (found2.session.tabs.length === 0 && found2.session.name !== "main") {
                sessionMap.delete(found2.session.name);
              }
            }
            broadcastState();
            return;
          }
          if (p.type === "new_session") {
            const name = p.name || "session-" + Date.now();
            const session = createSession(name);
            const tab = createTab(
              session,
              p.cols || ws._remuxCols,
              p.rows || ws._remuxRows
            );
            attachToTab(
              tab,
              ws,
              p.cols || ws._remuxCols,
              p.rows || ws._remuxRows
            );
            clientState.currentSession = name;
            assignRole(ws, tab.id);
            broadcastState();
            sendEnvelope(ws, "attached", {
              tabId: tab.id,
              session: name,
              clientId: clientState.clientId,
              role: clientState.role
            });
            return;
          }
          if (p.type === "delete_session") {
            if (p.name) {
              deleteSession(p.name);
              broadcastState();
            }
            return;
          }
          if (p.type === "inspect") {
            const found2 = findTab(ws._remuxTabId);
            if (found2 && found2.tab.vt && !found2.tab.ended) {
              const { text, cols, rows } = found2.tab.vt.textSnapshot();
              sendEnvelope(ws, "inspect_result", {
                text,
                meta: {
                  session: found2.session.name,
                  tabId: found2.tab.id,
                  tabTitle: found2.tab.title,
                  cols,
                  rows,
                  timestamp: Date.now()
                }
              });
            } else {
              const found22 = findTab(ws._remuxTabId);
              const rawText = found22 ? found22.tab.scrollback.read().toString("utf8") : "";
              const text = rawText.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
              sendEnvelope(ws, "inspect_result", {
                text,
                meta: { timestamp: Date.now() }
              });
            }
            return;
          }
          if (p.type === "rename_tab") {
            const found2 = findTab(p.tabId);
            if (found2 && typeof p.title === "string" && p.title.trim()) {
              found2.tab.title = p.title.trim().slice(0, 32);
              broadcastState();
            }
            return;
          }
          if (p.type === "resize") {
            ws._remuxCols = p.cols;
            ws._remuxRows = p.rows;
            const found2 = findTab(ws._remuxTabId);
            if (found2) recalcTabSize(found2.tab);
            return;
          }
          if (p.type === "request_control") {
            const tabId = ws._remuxTabId;
            if (tabId == null) return;
            const currentActive = getActiveClientForTab(tabId);
            if (currentActive && currentActive !== ws) {
              const activeState = clientStates.get(currentActive);
              if (activeState) {
                activeState.role = "observer";
                sendEnvelope(currentActive, "role_changed", {
                  clientId: activeState.clientId,
                  role: "observer"
                });
              }
            }
            clientState.role = "active";
            sendEnvelope(ws, "role_changed", {
              clientId: clientState.clientId,
              role: "active"
            });
            broadcastState();
            return;
          }
          if (p.type === "release_control") {
            const tabId = ws._remuxTabId;
            if (tabId == null) return;
            if (clientState.role === "active") {
              clientState.role = "observer";
              sendEnvelope(ws, "role_changed", {
                clientId: clientState.clientId,
                role: "observer"
              });
              for (const [otherWs, otherState] of clientStates) {
                if (otherWs !== ws && otherState.currentTabId === tabId && otherState.role === "observer" && otherWs.readyState === otherWs.OPEN) {
                  otherState.role = "active";
                  sendEnvelope(otherWs, "role_changed", {
                    clientId: otherState.clientId,
                    role: "active"
                  });
                  break;
                }
              }
              broadcastState();
            }
            return;
          }
          return;
        } catch {
        }
      }
      if (clientState.role !== "active") return;
      const found = findTab(ws._remuxTabId);
      if (found && !found.tab.ended) {
        found.tab.pty.write(msg);
      }
    });
    ws.on("close", () => {
      const tabId = ws._remuxTabId;
      const wasActive = clientState.role === "active";
      detachFromTab(ws);
      controlClients.delete(ws);
      clientStates.delete(ws);
      if (tabId != null) {
        reassignRolesAfterDetach(tabId, wasActive);
        broadcastState();
      }
    });
    ws.on("error", () => {
    });
  });
  return wss;
}

// src/tunnel.ts
import { spawn, execFile } from "child_process";
function parseTunnelArgs(argv) {
  if (argv.includes("--no-tunnel")) return { tunnelMode: "disable" };
  if (argv.includes("--tunnel")) return { tunnelMode: "enable" };
  return { tunnelMode: "auto" };
}
function isCloudflaredAvailable() {
  return new Promise((resolve) => {
    execFile("cloudflared", ["--version"], (err) => {
      resolve(!err);
    });
  });
}
var TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
function startTunnel(port, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "cloudflared",
      ["tunnel", "--url", `http://localhost:${port}`],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    let resolved = false;
    let output = "";
    const TIMEOUT_MS = 3e4;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        reject(new Error("cloudflared tunnel URL not detected within 30s"));
      }
    }, TIMEOUT_MS);
    function handleData(data) {
      output += data.toString();
      const match = output.match(TUNNEL_URL_RE);
      if (match && !resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve({ url: match[0], process: child });
      }
    }
    child.stderr.on("data", handleData);
    child.stdout.on("data", handleData);
    child.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        reject(err);
      }
    });
    child.on("close", (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        reject(
          new Error(
            `cloudflared exited with code ${code} before URL was detected`
          )
        );
      }
    });
    if (options.signal) {
      options.signal.addEventListener(
        "abort",
        () => {
          child.kill("SIGTERM");
        },
        { once: true }
      );
    }
  });
}
function buildTunnelAccessUrl(tunnelUrl, token, password) {
  if (password && !token) return tunnelUrl;
  if (token) return `${tunnelUrl}?token=${token}`;
  return tunnelUrl;
}

// src/server.ts
var __filename = fileURLToPath(import.meta.url);
var __dirname = path2.dirname(__filename);
var require2 = createRequire(import.meta.url);
var PKG = JSON.parse(
  fs3.readFileSync(path2.join(__dirname, "package.json"), "utf8")
);
var VERSION = PKG.version;
var PORT2 = process.env.PORT || 8767;
var { TOKEN, PASSWORD } = resolveAuth(process.argv);
var { tunnelMode } = parseTunnelArgs(process.argv);
var tunnelProcess = null;
function findGhosttyWeb() {
  const ghosttyWebMain = require2.resolve("ghostty-web");
  const ghosttyWebRoot = ghosttyWebMain.replace(/[/\\]dist[/\\].*$/, "");
  const distPath2 = path2.join(ghosttyWebRoot, "dist");
  const wasmPath2 = path2.join(ghosttyWebRoot, "ghostty-vt.wasm");
  if (fs3.existsSync(path2.join(distPath2, "ghostty-web.js")) && fs3.existsSync(wasmPath2)) {
    return { distPath: distPath2, wasmPath: wasmPath2 };
  }
  console.error("Error: ghostty-web package not found.");
  process.exit(1);
}
var { distPath, wasmPath } = findGhosttyWeb();
var startupDone = false;
async function startup() {
  await initGhosttyVt(wasmPath);
  const saved = restoreSessions();
  if (saved && saved.sessions.length > 0) {
    for (const s of saved.sessions) {
      const session = createSession(s.name);
      for (const t of s.tabs) {
        if (t.ended) continue;
        const tab = createTab(session);
        tab.title = t.title || tab.title;
        if (t.scrollback) {
          tab.scrollback.write(t.scrollback);
        }
      }
      if (session.tabs.length === 0) createTab(session);
    }
  }
  if (sessionMap.size === 0) {
    const s = createSession("main");
    createTab(s);
  }
  setInterval(persistSessions, PERSIST_INTERVAL_MS);
  startupDone = true;
}
startup().catch((e) => {
  console.error("[startup] fatal:", e);
  if (sessionMap.size === 0) {
    const s = createSession("main");
    createTab(s);
  }
  startupDone = true;
});
var HTML_TEMPLATE = `<!doctype html>
<html lang="en" data-theme="dark">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
    <title>Remux</title>
    <style>
      /* -- Theme Variables -- */
      [data-theme="dark"] {
        --bg: #1e1e1e;
        --bg-sidebar: #252526;
        --bg-tab-bar: #2d2d2d;
        --bg-tab-active: #1e1e1e;
        --bg-hover: #2a2d2e;
        --bg-active: #37373d;
        --border: #1a1a1a;
        --text: #ccc;
        --text-muted: #888;
        --text-dim: #666;
        --text-bright: #e5e5e5;
        --text-on-active: #fff;
        --accent: #007acc;
        --dot-ok: #27c93f;
        --dot-err: #ff5f56;
        --dot-warn: #ffbd2e;
        --compose-bg: #3a3a3a;
        --compose-border: #555;
        --tab-hover: #383838;
        --view-switch-bg: #1a1a1a;
        --inspect-meta-border: #333;
      }

      [data-theme="light"] {
        --bg: #ffffff;
        --bg-sidebar: #f3f3f3;
        --bg-tab-bar: #e8e8e8;
        --bg-tab-active: #ffffff;
        --bg-hover: #e8e8e8;
        --bg-active: #d6d6d6;
        --border: #d4d4d4;
        --text: #333333;
        --text-muted: #666666;
        --text-dim: #999999;
        --text-bright: #1e1e1e;
        --text-on-active: #000000;
        --accent: #007acc;
        --dot-ok: #16a34a;
        --dot-err: #dc2626;
        --dot-warn: #d97706;
        --compose-bg: #e8e8e8;
        --compose-border: #c0c0c0;
        --tab-hover: #d6d6d6;
        --view-switch-bg: #d4d4d4;
        --inspect-meta-border: #d4d4d4;
      }

      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { height: 100%; overflow: hidden; overscroll-behavior: none; }
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        background: var(--bg); color: var(--text); height: 100vh; height: 100dvh; display: flex; }

      /* -- Sidebar -- */
      .sidebar { width: 220px; min-width: 220px; background: var(--bg-sidebar); border-right: 1px solid var(--border);
        display: flex; flex-direction: column; flex-shrink: 0; transition: margin-left .2s; }
      .sidebar.collapsed { margin-left: -220px; }
      .sidebar-header { padding: 10px 12px; font-size: 11px; font-weight: 600; color: var(--text-muted);
        text-transform: uppercase; letter-spacing: .5px; display: flex; align-items: center;
        justify-content: space-between; }
      .sidebar-header button { background: none; border: none; color: var(--text-dim); cursor: pointer;
        font-size: 18px; line-height: 1; padding: 2px 6px; border-radius: 4px; }
      .sidebar-header button:hover { color: var(--text-bright); background: var(--compose-bg); }

      .session-list { flex: 1; overflow-y: auto; padding: 4px 6px; }
      .session-item { display: flex; align-items: center; gap: 8px; padding: 7px 8px; border-radius: 4px;
        font-size: 13px; cursor: pointer; color: var(--text); border: none; background: none;
        width: 100%; text-align: left; font-family: inherit; min-height: 32px; }
      .session-item:hover { background: var(--bg-hover); color: var(--text-bright); }
      .session-item.active { background: var(--bg-active); color: var(--text-on-active); }
      .session-item .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dot-ok); flex-shrink: 0; }
      .session-item .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .session-item .count { font-size: 10px; color: var(--compose-border); min-width: 16px; text-align: center; }
      .session-item .del { opacity: 0; font-size: 14px; color: var(--text-dim); background: none; border: none;
        cursor: pointer; padding: 0 4px; font-family: inherit; line-height: 1; border-radius: 3px; }
      .session-item:hover .del { opacity: 1; }
      .session-item .del:hover { color: var(--dot-err); background: var(--compose-bg); }

      .sidebar-footer { padding: 8px 12px; border-top: 1px solid var(--border);
        display: flex; flex-direction: column; gap: 6px; }
      .sidebar-footer .version { font-size: 10px; color: var(--text-dim); }
      .sidebar-footer .footer-row { display: flex; align-items: center; gap: 8px; }
        display: flex; align-items: center; gap: 8px; }
      .sidebar-footer .status { font-size: 11px; color: var(--text-muted); display: flex; align-items: center; gap: 6px; }
      .status-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--text-muted); flex-shrink: 0; }
      .status-dot.connected { background: var(--dot-ok); }
      .status-dot.disconnected { background: var(--dot-err); }
      .status-dot.connecting { background: var(--dot-warn); animation: pulse 1s infinite; }
      @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.5} }

      .role-indicator { font-size: 11px; color: var(--text-muted); display: flex; align-items: center; gap: 4px; }
      .role-indicator.active { color: var(--dot-ok); }
      .role-indicator.observer { color: var(--dot-warn); }
      .role-btn { background: none; border: 1px solid var(--border); border-radius: 4px;
        color: var(--text-muted); font-size: 10px; padding: 2px 8px; cursor: pointer; font-family: inherit; }
      .role-btn:hover { color: var(--text-bright); border-color: var(--text-muted); }

      /* -- Theme toggle -- */
      .theme-toggle { background: none; border: none; cursor: pointer; font-size: 16px;
        color: var(--text-muted); padding: 4px 8px; border-radius: 4px; }
      .theme-toggle:hover { color: var(--text-bright); background: var(--bg-hover); }

      /* -- Main -- */
      .main { flex: 1; display: flex; flex-direction: column; min-width: 0; }

      /* -- Tab bar (Chrome-style) -- */
      .tab-bar { background: var(--bg-tab-bar); display: flex; align-items: flex-end; flex-shrink: 0;
        min-height: 36px; padding: 0 0 0 0; }
      .tab-toggle { padding: 8px 10px; background: none; border: none; color: var(--text-muted);
        cursor: pointer; font-size: 16px; flex-shrink: 0; align-self: center; }
      .tab-toggle:hover { color: var(--text-bright); }
      .tab-list { display: flex; flex: 1; min-width: 0; align-items: flex-end; overflow-x: auto;
        -webkit-overflow-scrolling: touch; scrollbar-width: none; }
      .tab-list::-webkit-scrollbar { display: none; }

      .tab { position: relative; display: flex; align-items: center; gap: 0;
        padding: 6px 8px 6px 12px; font-size: 12px; color: var(--text-dim); background: var(--bg-tab-bar);
        border: none; cursor: pointer; white-space: nowrap; font-family: inherit;
        border-top: 2px solid transparent; margin-right: 1px; min-height: 32px; }
      .tab:hover { color: var(--text-bright); background: var(--tab-hover); }
      .tab.active { color: var(--text-on-active); background: var(--bg-tab-active); border-top-color: var(--accent);
        border-radius: 6px 6px 0 0; }
      .tab .title { pointer-events: none; }
      .tab .close { display: flex; align-items: center; justify-content: center;
        width: 18px; height: 18px; margin-left: 6px; font-size: 12px; color: var(--text-dim);
        border-radius: 3px; border: none; background: none; cursor: pointer;
        font-family: inherit; flex-shrink: 0; }
      .tab .close:hover { color: var(--text-on-active); background: var(--compose-border); }
      .tab:not(:hover) .close:not(:focus) { opacity: 0; }
      .tab.active .close { opacity: 1; color: var(--text-muted); }

      .tab .client-count { font-size: 9px; color: var(--text-muted); margin-left: 4px;
        background: var(--bg-hover); border-radius: 8px; padding: 1px 5px; pointer-events: none; }

      .tab-new { display: flex; align-items: center; justify-content: center;
        width: 28px; height: 28px; margin: 0 4px; font-size: 18px; color: var(--text-dim);
        background: none; border: none; cursor: pointer; border-radius: 4px;
        flex-shrink: 0; align-self: center; }
      .tab-new:hover { color: var(--text); background: var(--compose-bg); }

      /* -- Terminal -- */
      #terminal { flex: 1; background: var(--bg); overflow: hidden; }
      #terminal canvas { display: block; }
      #terminal.hidden { display: none; }

      /* -- View switcher -- */
      .view-switch { display: flex; gap: 1px; margin-left: auto; margin-right: 8px;
        align-self: center; background: var(--view-switch-bg); border-radius: 4px; overflow: hidden; }
      .view-switch button { padding: 4px 10px; font-size: 11px; font-family: inherit;
        color: var(--text-muted); background: var(--bg-tab-bar); border: none; cursor: pointer; }
      .view-switch button:hover { color: var(--text); }
      .view-switch button.active { color: var(--text-on-active); background: var(--accent); }

      /* -- Inspect -- */
      #inspect { flex: 1; background: var(--bg); overflow: auto; display: none;
        padding: 12px 16px; -webkit-overflow-scrolling: touch; }
      #inspect.visible { display: block; }
      #inspect-content { font-family: 'Menlo','Monaco','Courier New',monospace; font-size: 13px;
        line-height: 1.5; color: var(--text-bright); white-space: pre; tab-size: 8;
        user-select: text; -webkit-user-select: text; }
      #inspect-content mark { background: #ffbd2e; color: #1e1e1e; border-radius: 2px; }
      #inspect-header { font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 11px;
        color: var(--text-dim); padding: 8px 0; border-bottom: 1px solid var(--inspect-meta-border); margin-bottom: 8px;
        display: flex; flex-direction: column; gap: 8px; }
      #inspect-meta { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
      #inspect-meta span { white-space: nowrap; }
      #inspect-meta .inspect-btn { padding: 2px 10px; font-size: 11px; font-family: inherit;
        color: var(--text-bright); background: var(--compose-bg); border: 1px solid var(--compose-border);
        border-radius: 4px; cursor: pointer; white-space: nowrap; }
      #inspect-meta .inspect-btn:hover { background: var(--compose-border); }
      #inspect-search { display: flex; gap: 8px; align-items: center; }
      #inspect-search input { padding: 4px 8px; font-size: 12px; font-family: inherit;
        background: var(--bg); border: 1px solid var(--compose-border); border-radius: 4px;
        color: var(--text); outline: none; flex: 1; max-width: 260px; }
      #inspect-search input:focus { border-color: var(--accent); }
      #inspect-search .match-count { font-size: 11px; color: var(--text-muted); white-space: nowrap; }

      /* -- Compose bar -- */
      .compose-bar { display: none; background: var(--bg-sidebar); border-top: 1px solid var(--border);
        padding: 5px 8px; gap: 5px; flex-shrink: 0; overflow-x: auto; flex-wrap: wrap;
        -webkit-overflow-scrolling: touch; }
      .compose-bar button { padding: 8px 12px; font-size: 14px;
        font-family: 'Menlo','Monaco',monospace; color: var(--text-bright); background: var(--compose-bg);
        border: 1px solid var(--compose-border); border-radius: 5px; cursor: pointer; white-space: nowrap;
        -webkit-tap-highlight-color: transparent; touch-action: manipulation;
        min-width: 40px; text-align: center; user-select: none; }
      .compose-bar button:active { background: var(--compose-border); }
      .compose-bar button.active { background: #4a6a9a; border-color: #6a9ade; }
      @media (hover: none) and (pointer: coarse) { .compose-bar { display: flex; } }

      /* -- Tab rename input -- */
      .tab .rename-input { background: var(--bg); border: 1px solid var(--accent); border-radius: 3px;
        color: var(--text-bright); font-size: 12px; font-family: inherit; padding: 1px 4px;
        outline: none; width: 80px; }

      /* -- Mobile -- */
      @media (max-width: 768px) {
        .sidebar { position: fixed; left: 0; top: 0; bottom: 0; z-index: 100;
          margin-left: -220px; box-shadow: 4px 0 20px rgba(0,0,0,.5); }
        .sidebar.open { margin-left: 0; }
        .sidebar-overlay { display: none; position: fixed; inset: 0;
          background: rgba(0,0,0,.4); z-index: 99; }
        .sidebar-overlay.visible { display: block; }
        .session-item { min-height: 44px; } /* touch-friendly */
        .tab { min-height: 36px; }
      }
    </style>
  </head>
  <body>
    <div class="sidebar-overlay" id="sidebar-overlay"></div>
    <aside class="sidebar" id="sidebar">
      <div class="sidebar-header">
        <span>Sessions</span>
        <button id="btn-new-session" title="New session">+</button>
      </div>
      <div class="session-list" id="session-list"></div>
      <div class="sidebar-footer">
        <div class="role-indicator" id="role-indicator">
          <span id="role-dot"></span>
          <span id="role-text"></span>
          <button class="role-btn" id="btn-role" style="display:none"></button>
        </div>
        <button id="btn-theme" class="theme-toggle" title="Toggle theme">&#9728;</button>
        <div class="status">
          <div class="status-dot connecting" id="status-dot"></div>
          <span id="status-text">...</span>
        </div>
        <div class="version">v${VERSION}</div>
      </div>
    </aside>
    <div class="main">
      <div class="tab-bar">
        <button class="tab-toggle" id="btn-sidebar" title="Toggle sidebar">&#9776;</button>
        <div class="tab-list" id="tab-list"></div>
        <button class="tab-new" id="btn-new-tab" title="New tab">+</button>
        <div class="view-switch">
          <button id="btn-live" class="active">Live</button>
          <button id="btn-inspect">Inspect</button>
        </div>
      </div>
      <div id="terminal"></div>
      <div id="inspect">
        <div id="inspect-header">
          <div id="inspect-meta"></div>
          <div id="inspect-search">
            <input type="text" id="inspect-search-input" placeholder="Search..." />
            <span class="match-count" id="inspect-match-count"></span>
          </div>
        </div>
        <pre id="inspect-content"></pre>
      </div>
      <div class="compose-bar" id="compose-bar">
        <button data-seq="esc">Esc</button>
        <button data-seq="tab">Tab</button>
        <button data-mod="ctrl" id="btn-ctrl">Ctrl</button>
        <button data-seq="up">&#8593;</button>
        <button data-seq="down">&#8595;</button>
        <button data-seq="left">&#8592;</button>
        <button data-seq="right">&#8594;</button>
        <button data-ch="|">|</button>
        <button data-ch="~">~</button>
        <button data-ch="/">/ </button>
        <button data-seq="ctrl-c">C-c</button>
        <button data-seq="ctrl-d">C-d</button>
        <button data-seq="ctrl-z">C-z</button>
        <button data-seq="pgup">PgUp</button>
        <button data-seq="pgdn">PgDn</button>
        <button data-seq="home">Home</button>
        <button data-seq="end">End</button>
      </div>
    </div>

    <script type="module">
      import { init, Terminal, FitAddon } from '/dist/ghostty-web.js';
      await init();

      // -- Terminal color themes (ghostty-web ITheme) --
      const THEMES = {
        dark: {
          // ghostty-web default dark
          background: '#1e1e1e', foreground: '#d4d4d4', cursor: '#ffffff',
          cursorAccent: '#1e1e1e', selectionBackground: '#264f78', selectionForeground: '#ffffff',
          black: '#000000', red: '#cd3131', green: '#0dbc79', yellow: '#e5e510',
          blue: '#2472c8', magenta: '#bc3fbc', cyan: '#11a8cd', white: '#e5e5e5',
          brightBlack: '#666666', brightRed: '#f14c4c', brightGreen: '#23d18b',
          brightYellow: '#f5f543', brightBlue: '#3b8eea', brightMagenta: '#d670d6',
          brightCyan: '#29b8db', brightWhite: '#ffffff',
        },
        light: {
          // Ghostty-style light
          background: '#ffffff', foreground: '#1d1f21', cursor: '#1d1f21',
          cursorAccent: '#ffffff', selectionBackground: '#b4d5fe', selectionForeground: '#1d1f21',
          black: '#1d1f21', red: '#c82829', green: '#718c00', yellow: '#eab700',
          blue: '#4271ae', magenta: '#8959a8', cyan: '#3e999f', white: '#d6d6d6',
          brightBlack: '#969896', brightRed: '#cc6666', brightGreen: '#b5bd68',
          brightYellow: '#f0c674', brightBlue: '#81a2be', brightMagenta: '#b294bb',
          brightCyan: '#8abeb7', brightWhite: '#ffffff',
        },
      };

      const initTheme = localStorage.getItem('remux-theme') ||
        (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');

      let term, fitAddon;
      function createTerminal(themeMode) {
        const container = document.getElementById('terminal');
        if (term) { term.dispose(); container.innerHTML = ''; }
        term = window._remuxTerm = new Terminal({ cols: 80, rows: 24,
          fontFamily: 'Menlo, Monaco, "Courier New", monospace',
          fontSize: 14, cursorBlink: true,
          theme: THEMES[themeMode] || THEMES.dark,
          scrollback: 10000 });
        fitAddon = new FitAddon();
        term.loadAddon(fitAddon);
        term.open(container);
        fitAddon.fit();
        fitAddon.observeResize();
        return term;
      }
      createTerminal(initTheme);
      window.addEventListener('resize', () => { if (fitAddon) fitAddon.fit(); });

      let sessions = [], currentSession = 'main', currentTabId = null, ws = null, ctrlActive = false;
      let myClientId = null, myRole = null, clientsList = [];
      const $ = id => document.getElementById(id);
      const setStatus = (s, t) => { $('status-dot').className = 'status-dot ' + s; $('status-text').textContent = t; };

      // -- Theme switching --
      function setTheme(mode) {
        document.documentElement.setAttribute('data-theme', mode);
        localStorage.setItem('remux-theme', mode);
        $('btn-theme').innerHTML = mode === 'dark' ? '&#9728;' : '&#9790;';
        // Recreate terminal with new theme (ghostty-web doesn't support runtime theme change)
        createTerminal(mode);
        // Rebind terminal I/O
        term.onData(data => {
          if (!ws || ws.readyState !== WebSocket.OPEN) return;
          if (ctrlActive) {
            ctrlActive = false; $('btn-ctrl').classList.remove('active');
            const ch = data.toLowerCase().charCodeAt(0);
            if (ch >= 0x61 && ch <= 0x7a) { ws.send(String.fromCharCode(ch - 0x60)); return; }
          }
          ws.send(data);
        });
        term.onResize(({ cols, rows }) => sendCtrl({ type: 'resize', cols, rows }));
        // Re-attach to current tab to get snapshot
        if (currentTabId != null) {
          sendCtrl({ type: 'attach_tab', tabId: currentTabId, cols: term.cols, rows: term.rows });
        }
      }
      // Apply initial theme CSS (terminal already created with correct theme)
      document.documentElement.setAttribute('data-theme', initTheme);
      $('btn-theme').innerHTML = initTheme === 'dark' ? '&#9728;' : '&#9790;';
      $('btn-theme').addEventListener('click', () => {
        const current = document.documentElement.getAttribute('data-theme') || 'dark';
        setTheme(current === 'dark' ? 'light' : 'dark');
      });

      // -- Sidebar --
      const sidebar = $('sidebar'), overlay = $('sidebar-overlay');
      function toggleSidebar() {
        if (window.innerWidth <= 768) {
          sidebar.classList.toggle('open');
          overlay.classList.toggle('visible', sidebar.classList.contains('open'));
        } else { sidebar.classList.toggle('collapsed'); }
        setTimeout(() => fitAddon.fit(), 250);
      }
      function closeSidebarMobile() {
        if (window.innerWidth <= 768) { sidebar.classList.remove('open'); overlay.classList.remove('visible'); }
      }
      $('btn-sidebar').addEventListener('pointerdown', e => { e.preventDefault(); toggleSidebar(); });
      overlay.addEventListener('pointerdown', closeSidebarMobile);

      // -- Render sessions --
      function renderSessions() {
        const list = $('session-list'); list.innerHTML = '';
        sessions.forEach(s => {
          const el = document.createElement('button');
          el.className = 'session-item' + (s.name === currentSession ? ' active' : '');
          const live = s.tabs.filter(t => !t.ended).length;
          el.innerHTML = '<span class="dot"></span><span class="name">' + s.name
            + '</span><span class="count">' + live + '</span>'
            + '<button class="del" data-del="' + s.name + '">\xD7</button>';
          el.addEventListener('pointerdown', e => {
            if (e.target.dataset.del) {
              e.stopPropagation(); e.preventDefault();
              if (sessions.length <= 1) return; // don't delete last session
              sendCtrl({ type: 'delete_session', name: e.target.dataset.del });
              // if deleting current, switch to first other
              if (e.target.dataset.del === currentSession) {
                const other = sessions.find(x => x.name !== currentSession);
                if (other) selectSession(other.name);
              }
              return;
            }
            e.preventDefault();
            selectSession(s.name);
            closeSidebarMobile();
          });
          list.appendChild(el);
        });
      }

      // -- Render tabs (Chrome-style) --
      function renderTabs() {
        const list = $('tab-list'); list.innerHTML = '';
        const sess = sessions.find(s => s.name === currentSession);
        if (!sess) return;
        sess.tabs.forEach(t => {
          const el = document.createElement('button');
          el.className = 'tab' + (t.id === currentTabId ? ' active' : '');
          const clientCount = t.clients || 0;
          const countBadge = clientCount > 1 ? '<span class="client-count">' + clientCount + '</span>' : '';
          el.innerHTML = '<span class="title">' + t.title + '</span>' + countBadge
            + '<button class="close" data-close="' + t.id + '">\xD7</button>';
          el.addEventListener('pointerdown', e => {
            const closeId = e.target.dataset.close ?? e.target.closest('[data-close]')?.dataset.close;
            if (closeId != null) {
              e.stopPropagation(); e.preventDefault();
              closeTab(Number(closeId));
              return;
            }
            e.preventDefault();
            if (t.id !== currentTabId) attachTab(t.id);
          });
          list.appendChild(el);
        });
      }

      // -- Render role indicator --
      function renderRole() {
        const indicator = $('role-indicator');
        const dot = $('role-dot');
        const text = $('role-text');
        const btn = $('btn-role');
        if (!indicator || !myRole) return;
        indicator.className = 'role-indicator ' + myRole;
        if (myRole === 'active') {
          dot.textContent = '\u25CF';
          text.textContent = 'Active';
          btn.textContent = 'Release';
          btn.style.display = 'inline-block';
        } else {
          dot.textContent = '\u25CB';
          text.textContent = 'Observer';
          btn.textContent = 'Take control';
          btn.style.display = 'inline-block';
        }
      }
      $('btn-role').addEventListener('click', () => {
        if (myRole === 'active') sendCtrl({ type: 'release_control' });
        else sendCtrl({ type: 'request_control' });
      });

      function selectSession(name) {
        currentSession = name;
        const sess = sessions.find(s => s.name === name);
        if (sess && sess.tabs.length > 0) attachTab(sess.tabs[0].id);
        renderSessions(); renderTabs();
      }

      function attachTab(tabId) {
        currentTabId = tabId;
        term.reset(); // full reset to avoid duplicate content
        sendCtrl({ type: 'attach_tab', tabId, cols: term.cols, rows: term.rows });
        renderTabs(); renderSessions();
      }

      function closeTab(tabId) {
        const sess = sessions.find(s => s.name === currentSession);
        if (!sess) return;
        // if closing active tab, switch to neighbor first
        if (tabId === currentTabId) {
          const idx = sess.tabs.findIndex(t => t.id === tabId);
          const next = sess.tabs[idx + 1] || sess.tabs[idx - 1];
          if (next) attachTab(next.id);
        }
        sendCtrl({ type: 'close_tab', tabId });
      }

      $('btn-new-tab').addEventListener('pointerdown', e => {
        e.preventDefault();
        sendCtrl({ type: 'new_tab', session: currentSession, cols: term.cols, rows: term.rows });
      });
      $('btn-new-session').addEventListener('pointerdown', e => {
        e.preventDefault();
        const name = prompt('Session name:');
        if (name && name.trim()) sendCtrl({ type: 'new_session', name: name.trim(), cols: term.cols, rows: term.rows });
      });

      // -- WebSocket with exponential backoff + heartbeat --
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const urlToken = new URLSearchParams(location.search).get('token');

      // Exponential backoff: 1s -> 2s -> 4s -> 8s -> 16s -> 30s max
      let backoffMs = 1000;
      const BACKOFF_MAX = 30000;
      let reconnectTimer = null;

      // Heartbeat: if no message received for 45s, consider connection dead
      const HEARTBEAT_TIMEOUT = 45000;
      let lastMessageAt = Date.now();
      let heartbeatChecker = null;

      function startHeartbeat() {
        lastMessageAt = Date.now();
        if (heartbeatChecker) clearInterval(heartbeatChecker);
        heartbeatChecker = setInterval(() => {
          if (Date.now() - lastMessageAt > HEARTBEAT_TIMEOUT) {
            console.log('[remux] heartbeat timeout, reconnecting');
            if (ws) ws.close();
          }
        }, 5000);
      }

      function stopHeartbeat() {
        if (heartbeatChecker) { clearInterval(heartbeatChecker); heartbeatChecker = null; }
      }

      function scheduleReconnect() {
        if (reconnectTimer) return;
        const delay = backoffMs;
        let remaining = Math.ceil(delay / 1000);
        setStatus('disconnected', 'Reconnecting in ' + remaining + 's...');
        const countdown = setInterval(() => {
          remaining--;
          if (remaining > 0) setStatus('disconnected', 'Reconnecting in ' + remaining + 's...');
        }, 1000);
        reconnectTimer = setTimeout(() => {
          clearInterval(countdown);
          reconnectTimer = null;
          backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX);
          connect();
        }, delay);
      }

      function connect() {
        setStatus('connecting', 'Connecting...');
        ws = new WebSocket(proto + '//' + location.host + '/ws');
        ws.onopen = () => {
          backoffMs = 1000; // reset backoff on successful connection
          startHeartbeat();
          if (urlToken) ws.send(JSON.stringify({ type: 'auth', token: urlToken }));
          sendCtrl({ type: 'attach_first', session: currentSession || 'main', cols: term.cols, rows: term.rows });
        };
        ws.onmessage = e => {
          lastMessageAt = Date.now();
          if (typeof e.data === 'string' && e.data[0] === '{') {
            try {
              const parsed = JSON.parse(e.data);
              // Handle both envelope (v:1) and legacy messages
              const msg = parsed.v === 1 ? { type: parsed.type, ...parsed.payload } : parsed;
              if (msg.type === 'auth_ok') return;
              if (msg.type === 'auth_error') { setStatus('disconnected', 'Auth failed'); ws.close(); return; }
              if (msg.type === 'state') {
                sessions = msg.sessions || [];
                clientsList = msg.clients || [];
                renderSessions(); renderTabs(); renderRole(); return;
              }
              if (msg.type === 'attached') {
                currentTabId = msg.tabId; currentSession = msg.session;
                if (msg.clientId) myClientId = msg.clientId;
                if (msg.role) myRole = msg.role;
                setStatus('connected', msg.session); renderSessions(); renderTabs(); renderRole(); return;
              }
              if (msg.type === 'role_changed') {
                if (msg.clientId === myClientId) myRole = msg.role;
                renderRole(); return;
              }
              if (msg.type === 'inspect_result') {
                window._inspectText = msg.text || '(empty)';
                const m = msg.meta || {};
                $('inspect-meta').innerHTML =
                  '<span>' + (m.session || '') + ' / ' + (m.tabTitle || 'Tab ' + m.tabId) + '</span>' +
                  '<span>' + (m.cols || '?') + 'x' + (m.rows || '?') + '</span>' +
                  '<span>' + new Date(m.timestamp || Date.now()).toLocaleTimeString() + '</span>' +
                  '<button class="inspect-btn" id="btn-copy-inspect">Copy</button>';
                $('btn-copy-inspect').addEventListener('click', () => {
                  navigator.clipboard.writeText(window._inspectText).then(() => {
                    $('btn-copy-inspect').textContent = 'Copied!';
                    setTimeout(() => { const el = $('btn-copy-inspect'); if (el) el.textContent = 'Copy'; }, 1500);
                  });
                });
                // Apply search highlight if active
                applyInspectSearch();
                return;
              }
            } catch {}
          }
          term.write(e.data);
        };
        ws.onclose = () => { stopHeartbeat(); scheduleReconnect(); };
        ws.onerror = () => setStatus('disconnected', 'Error');
      }
      connect();
      function sendCtrl(msg) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); }

      // -- Terminal I/O --
      term.onData(data => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        if (ctrlActive) {
          ctrlActive = false; $('btn-ctrl').classList.remove('active');
          const ch = data.toLowerCase().charCodeAt(0);
          if (ch >= 0x61 && ch <= 0x7a) { ws.send(String.fromCharCode(ch - 0x60)); return; }
        }
        ws.send(data);
      });
      term.onResize(({ cols, rows }) => sendCtrl({ type: 'resize', cols, rows }));

      // -- Compose bar --
      const SEQ = {
        esc: '\\x1b', tab: '\\t',
        up: '\\x1b[A', down: '\\x1b[B', left: '\\x1b[D', right: '\\x1b[C',
        'ctrl-c': '\\x03', 'ctrl-d': '\\x04', 'ctrl-z': '\\x1a',
        pgup: '\\x1b[5~', pgdn: '\\x1b[6~', home: '\\x1b[H', end: '\\x1b[F',
      };
      $('compose-bar').addEventListener('pointerdown', e => {
        const btn = e.target.closest('button'); if (!btn) return;
        e.preventDefault();
        if (btn.dataset.mod === 'ctrl') { ctrlActive = !ctrlActive; btn.classList.toggle('active', ctrlActive); return; }
        const d = SEQ[btn.dataset.seq] || btn.dataset.ch;
        if (d && ws && ws.readyState === WebSocket.OPEN) ws.send(d);
        term.focus();
      });

      // -- Inspect view --
      let inspectMode = false, inspectTimer = null;
      function setView(mode) {
        inspectMode = mode === 'inspect';
        $('btn-live').classList.toggle('active', !inspectMode);
        $('btn-inspect').classList.toggle('active', inspectMode);
        $('terminal').classList.toggle('hidden', inspectMode);
        $('inspect').classList.toggle('visible', inspectMode);
        if (inspectMode) {
          sendCtrl({ type: 'inspect' });
          inspectTimer = setInterval(() => sendCtrl({ type: 'inspect' }), 3000);
        } else {
          if (inspectTimer) { clearInterval(inspectTimer); inspectTimer = null; }
          term.focus();
          fitAddon.fit();
        }
      }
      $('btn-live').addEventListener('pointerdown', e => { e.preventDefault(); setView('live'); });
      $('btn-inspect').addEventListener('pointerdown', e => { e.preventDefault(); setView('inspect'); });

      // -- Inspect search --
      function applyInspectSearch() {
        const query = ($('inspect-search-input') || {}).value || '';
        const text = window._inspectText || '';
        if (!query) {
          $('inspect-content').textContent = text;
          $('inspect-match-count').textContent = '';
          return;
        }
        // Simple case-insensitive text search with <mark> highlighting
        // Work on raw text to avoid HTML entity issues, then escape each fragment
        const esc = t => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const q = query.toLowerCase();
        const lower = text.toLowerCase();
        let result = '', count = 0, pos = 0;
        while (pos < text.length) {
          const idx = lower.indexOf(q, pos);
          if (idx === -1) { result += esc(text.slice(pos)); break; }
          result += esc(text.slice(pos, idx)) + '<mark>' + esc(text.slice(idx, idx + q.length)) + '</mark>';
          count++; pos = idx + q.length;
        }
        $('inspect-content').innerHTML = result;
        $('inspect-match-count').textContent = count > 0 ? count + ' match' + (count !== 1 ? 'es' : '') : 'No matches';
      }
      $('inspect-search-input').addEventListener('input', applyInspectSearch);

      // -- Tab rename (double-click) --
      $('tab-list').addEventListener('dblclick', e => {
        const tabEl = e.target.closest('.tab');
        if (!tabEl) return;
        const titleSpan = tabEl.querySelector('.title');
        if (!titleSpan) return;
        // Find tab id from close button
        const closeBtn = tabEl.querySelector('.close');
        if (!closeBtn) return;
        const tabId = Number(closeBtn.dataset.close);
        const oldTitle = titleSpan.textContent;

        const input = document.createElement('input');
        input.className = 'rename-input';
        input.value = oldTitle;
        input.setAttribute('maxlength', '32');
        titleSpan.replaceWith(input);
        input.focus();
        input.select();

        function commit() {
          const newTitle = input.value.trim() || oldTitle;
          // Send rename to server
          if (newTitle !== oldTitle) sendCtrl({ type: 'rename_tab', tabId, title: newTitle });
          // Restore span immediately
          const span = document.createElement('span');
          span.className = 'title';
          span.textContent = newTitle;
          input.replaceWith(span);
        }
        function cancel() {
          const span = document.createElement('span');
          span.className = 'title';
          span.textContent = oldTitle;
          input.replaceWith(span);
        }
        input.addEventListener('keydown', ev => {
          if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
          if (ev.key === 'Escape') { ev.preventDefault(); cancel(); }
        });
        input.addEventListener('blur', commit);
      });

      // -- Mobile --
      let fitDebounceTimer = null;
      if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', () => {
          document.body.style.height = window.visualViewport.height + 'px';
          // Debounce fit() to avoid excessive recalculations during keyboard animation
          clearTimeout(fitDebounceTimer);
          fitDebounceTimer = setTimeout(() => { if (fitAddon) fitAddon.fit(); }, 100);
        });
        window.visualViewport.addEventListener('scroll', () => window.scrollTo(0, 0));
      }
      // iOS Safari: touching terminal area focuses hidden textarea for input
      document.getElementById('terminal').addEventListener('touchend', () => { if (!inspectMode) term.focus(); });
    </script>
  </body>
</html>`;
var MIME = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".wasm": "application/wasm",
  ".css": "text/css",
  ".json": "application/json"
};
var httpServer = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === "/auth" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => body += chunk);
    req.on("end", () => {
      const params = new URLSearchParams(body);
      const submitted = params.get("password");
      if (PASSWORD && submitted === PASSWORD) {
        const sessionToken = generateToken();
        passwordTokens.add(sessionToken);
        res.writeHead(302, { Location: `/?token=${sessionToken}` });
        res.end();
      } else {
        res.writeHead(302, { Location: "/?error=1" });
        res.end();
      }
    });
    return;
  }
  if (url.pathname === "/" || url.pathname === "/index.html") {
    const urlToken = url.searchParams.get("token");
    const isAuthed = !TOKEN && !PASSWORD || // no auth configured (impossible after auto-gen, but safe)
    TOKEN != null && urlToken === TOKEN || passwordTokens.has(urlToken);
    if (!isAuthed) {
      if (PASSWORD) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(PASSWORD_PAGE);
        return;
      }
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden: invalid or missing token");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(HTML_TEMPLATE);
    return;
  }
  if (url.pathname.startsWith("/dist/")) {
    return serveFile(path2.join(distPath, url.pathname.slice(6)), res);
  }
  if (url.pathname === "/ghostty-vt.wasm") {
    return serveFile(wasmPath, res);
  }
  res.writeHead(404);
  res.end("Not Found");
});
function serveFile(filePath, res) {
  const ext = path2.extname(filePath);
  fs3.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream"
    });
    res.end(data);
  });
}
setupWebSocket(httpServer, TOKEN, PASSWORD);
httpServer.listen(PORT2, () => {
  let url = `http://localhost:${PORT2}`;
  if (TOKEN) url += `?token=${TOKEN}`;
  console.log(`
  Remux running at ${url}
`);
  if (PASSWORD) {
    console.log(`  Password authentication enabled`);
    console.log(`  Login page: http://localhost:${PORT2}
`);
  } else if (TOKEN) {
    console.log(`  Token: ${TOKEN}
`);
  }
  qrcode.generate(url, { small: true }, (code) => {
    console.log(code);
  });
  launchTunnel();
});
async function launchTunnel() {
  if (tunnelMode === "disable") return;
  const available = await isCloudflaredAvailable();
  if (!available) {
    if (tunnelMode === "enable") {
      console.log(
        "\n  [tunnel] cloudflared not found -- install it for tunnel support"
      );
      console.log(
        "  https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/\n"
      );
    }
    return;
  }
  console.log("  [tunnel] starting cloudflare tunnel...");
  try {
    const { url: tunnelUrl, process: child } = await startTunnel(
      Number(PORT2)
    );
    tunnelProcess = child;
    const accessUrl = buildTunnelAccessUrl(tunnelUrl, TOKEN, PASSWORD);
    console.log(`
  Tunnel: ${accessUrl}
`);
    qrcode.generate(accessUrl, { small: true }, (code) => {
      console.log(code);
    });
    child.on("close", (code) => {
      if (code !== null && code !== 0) {
        console.log(`  [tunnel] cloudflared exited (code ${code})`);
      }
      tunnelProcess = null;
    });
  } catch (err) {
    console.log(`  [tunnel] failed to start: ${err.message}`);
    tunnelProcess = null;
  }
}
function shutdown() {
  persistSessions();
  if (tunnelProcess) {
    try {
      tunnelProcess.kill("SIGTERM");
    } catch {
    }
    tunnelProcess = null;
  }
  for (const session of sessionMap.values()) {
    for (const tab of session.tabs) {
      if (tab.vt) {
        tab.vt.dispose();
        tab.vt = null;
      }
      if (!tab.ended) tab.pty.kill();
    }
  }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

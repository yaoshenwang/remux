#!/usr/bin/env node

/**
 * Remux server — ghostty-web terminal with session management.
 * Adapted from coder/ghostty-web demo (MIT) + tsm session patterns.
 */

import crypto from "crypto";
import fs from "fs";
import http from "http";
import { homedir } from "os";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import pty from "node-pty";
import { WebSocketServer } from "ws";
import qrcode from "qrcode-terminal";
import { parseTunnelArgs, isCloudflaredAvailable, startTunnel, buildTunnelAccessUrl } from "./tunnel.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const PKG = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"));
const VERSION = PKG.version;
const PORT = process.env.PORT || 8767;

// ── Authentication ────────────────────────────────────────────────
// Priority: REMUX_TOKEN > REMUX_PASSWORD (+ --password CLI) > auto-generated token
const PASSWORD = process.env.REMUX_PASSWORD || (function() {
  const idx = process.argv.indexOf("--password");
  return (idx !== -1 && idx + 1 < process.argv.length) ? process.argv[idx + 1] : null;
})();
const TOKEN = process.env.REMUX_TOKEN || (PASSWORD ? null : crypto.randomBytes(16).toString("hex"));

// ── Tunnel ────────────────────────────────────────────────────────
const { tunnelMode } = parseTunnelArgs(process.argv);
let tunnelProcess = null; // child_process handle, killed on shutdown

// Tokens generated from password login (valid for the lifetime of the server)
const passwordTokens = new Set();

// ── Locate ghostty-web assets ──────────────────────────────────────

function findGhosttyWeb() {
  const ghosttyWebMain = require.resolve("ghostty-web");
  const ghosttyWebRoot = ghosttyWebMain.replace(/[/\\]dist[/\\].*$/, "");
  const distPath = path.join(ghosttyWebRoot, "dist");
  const wasmPath = path.join(ghosttyWebRoot, "ghostty-vt.wasm");
  if (fs.existsSync(path.join(distPath, "ghostty-web.js")) && fs.existsSync(wasmPath)) {
    return { distPath, wasmPath };
  }
  console.error("Error: ghostty-web package not found.");
  process.exit(1);
}

const { distPath, wasmPath } = findGhosttyWeb();

// ── Server-side ghostty-vt (WASM) — tsm-style VT tracking ────────

let wasmExports = null;
let wasmMemory = null;

async function initGhosttyVt() {
  const wasmBytes = fs.readFileSync(wasmPath);
  const result = await WebAssembly.instantiate(wasmBytes, {
    env: { log: () => {} },
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
    resize(cols, rows) {
      wasmExports.ghostty_terminal_resize(handle, cols, rows);
    },
    isAltScreen() {
      return !!wasmExports.ghostty_terminal_is_alternate_screen(handle);
    },
    /** Build a VT escape sequence snapshot from viewport cells (tsm Snapshot equivalent). */
    snapshot() {
      wasmExports.ghostty_render_state_update(handle);
      const cols = wasmExports.ghostty_render_state_get_cols(handle);
      const rows = wasmExports.ghostty_render_state_get_rows(handle);
      const cellSize = 16;
      const bufSize = cols * rows * cellSize;
      const bufPtr = wasmExports.ghostty_wasm_alloc_u8_array(bufSize);
      const count = wasmExports.ghostty_render_state_get_viewport(handle, bufPtr, bufSize);

      const view = new DataView(wasmMemory.buffer);
      let out = "\x1b[H\x1b[2J"; // clear + home
      let lastFg = null, lastBg = null, lastFlags = 0;

      for (let row = 0; row < rows; row++) {
        if (row > 0) out += "\r\n";
        for (let col = 0; col < cols; col++) {
          const off = bufPtr + (row * cols + col) * cellSize;
          const cp = view.getUint32(off, true);
          const fg_r = view.getUint8(off + 4);
          const fg_g = view.getUint8(off + 5);
          const fg_b = view.getUint8(off + 6);
          const bg_r = view.getUint8(off + 7);
          const bg_g = view.getUint8(off + 8);
          const bg_b = view.getUint8(off + 9);
          const flags = view.getUint8(off + 10);
          const width = view.getUint8(off + 11);

          if (width === 0) continue; // continuation cell (wide char)

          // SGR: only emit changes
          const fgKey = (fg_r << 16) | (fg_g << 8) | fg_b;
          const bgKey = (bg_r << 16) | (bg_g << 8) | bg_b;
          let sgr = "";
          if (flags !== lastFlags) {
            sgr += "\x1b[0m"; // reset, then re-apply
            if (flags & 1) sgr += "\x1b[1m";  // bold
            if (flags & 2) sgr += "\x1b[3m";  // italic
            if (flags & 4) sgr += "\x1b[4m";  // underline
            if (flags & 128) sgr += "\x1b[2m"; // faint
            lastFg = null; lastBg = null; // force re-emit colors after reset
            lastFlags = flags;
          }
          if (fgKey !== lastFg && fgKey !== 0) {
            sgr += `\x1b[38;2;${fg_r};${fg_g};${fg_b}m`;
            lastFg = fgKey;
          }
          if (bgKey !== lastBg && bgKey !== 0) {
            sgr += `\x1b[48;2;${bg_r};${bg_g};${bg_b}m`;
            lastBg = bgKey;
          }
          out += sgr;
          out += cp > 0 ? String.fromCodePoint(cp) : " ";
        }
      }

      // Restore cursor position
      const cx = wasmExports.ghostty_render_state_get_cursor_x(handle);
      const cy = wasmExports.ghostty_render_state_get_cursor_y(handle);
      out += `\x1b[0m\x1b[${cy + 1};${cx + 1}H`;

      wasmExports.ghostty_wasm_free_u8_array(bufPtr, bufSize);
      return out;
    },
    /** Extract plain text from viewport (for Inspect view). */
    textSnapshot() {
      wasmExports.ghostty_render_state_update(handle);
      const cols = wasmExports.ghostty_render_state_get_cols(handle);
      const rows = wasmExports.ghostty_render_state_get_rows(handle);
      const cellSize = 16;
      const bufSize = cols * rows * cellSize;
      const bufPtr = wasmExports.ghostty_wasm_alloc_u8_array(bufSize);
      wasmExports.ghostty_render_state_get_viewport(handle, bufPtr, bufSize);

      const view = new DataView(wasmMemory.buffer);
      const lines = [];

      for (let row = 0; row < rows; row++) {
        let line = "";
        for (let col = 0; col < cols; col++) {
          const off = bufPtr + (row * cols + col) * cellSize;
          const cp = view.getUint32(off, true);
          const width = view.getUint8(off + 11);
          if (width === 0) continue; // continuation cell (wide char)
          line += cp > 0 ? String.fromCodePoint(cp) : " ";
        }
        lines.push(line.trimEnd());
      }

      wasmExports.ghostty_wasm_free_u8_array(bufPtr, bufSize);

      // Trim trailing empty lines
      while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
      return { text: lines.join("\n"), cols, rows };
    },
    dispose() {
      wasmExports.ghostty_terminal_free(handle);
    },
  };
}

// ── Session Persistence ──────────────────────────────────────────

const PERSIST_DIR = path.join(homedir(), ".remux");
const PERSIST_ID = process.env.REMUX_INSTANCE_ID || `port-${PORT}`;
const PERSIST_FILE = path.join(PERSIST_DIR, `sessions-${PERSIST_ID}.json`);
const PERSIST_INTERVAL_MS = 8000;

function persistSessions() {
  const data = [...sessionMap.values()].map(s => ({
    name: s.name,
    createdAt: s.createdAt,
    tabs: s.tabs.map(t => ({
      id: t.id,
      title: t.title,
      ended: t.ended,
      scrollback: t.ended ? null : t.scrollback.read().toString("utf8").slice(-200000),
    })),
  }));
  try {
    if (!fs.existsSync(PERSIST_DIR)) fs.mkdirSync(PERSIST_DIR, { recursive: true });
    fs.writeFileSync(PERSIST_FILE, JSON.stringify({ version: 1, sessions: data }));
  } catch (e) {
    console.error("[persist] save failed:", e.message);
  }
}

function restoreSessions() {
  try {
    if (!fs.existsSync(PERSIST_FILE)) return false;
    const raw = JSON.parse(fs.readFileSync(PERSIST_FILE, "utf8"));
    if (raw.version !== 1 || !Array.isArray(raw.sessions)) return false;
    console.log(`[persist] restoring ${raw.sessions.length} session(s)`);
    // We don't restore PTY processes (they're gone), but we restore session/tab structure
    // and scrollback so the user sees their history
    return raw;
  } catch (e) {
    console.error("[persist] restore failed:", e.message);
    return false;
  }
}

// ── Data Model ────────────────────────────────────────────────────
//
//  Session "work"          ← sidebar (left)
//  ├── Tab 0  (PTY: zsh)  ← tab bar (right)
//  ├── Tab 1  (PTY: vim)
//  └── Tab 2  (PTY: htop)
//
//  Session "logs"
//  └── Tab 0  (PTY: tail)

function getShell() {
  if (process.platform === "win32") return process.env.COMSPEC || "cmd.exe";
  if (process.env.SHELL) return process.env.SHELL;
  try { fs.accessSync("/bin/zsh", fs.constants.X_OK); return "/bin/zsh"; } catch {}
  return "/bin/bash";
}

class RingBuffer {
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
      this.buf.subarray(0, this.writePos),
    ]);
  }
}

let tabIdCounter = 0;

function createTab(session, cols = 80, rows = 24) {
  const id = tabIdCounter++;
  const ptyProcess = pty.spawn(getShell(), [], {
    name: "xterm-256color",
    cols, rows,
    cwd: homedir(),
    env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
  });

  const vtTerminal = createVtTerminal(cols, rows);
  const tab = {
    id,
    pty: ptyProcess,
    scrollback: new RingBuffer(),
    vt: vtTerminal,
    clients: new Set(),
    cols, rows,
    ended: false,
    title: `Tab ${session.tabs.length + 1}`,
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
    if (tab.vt) { tab.vt.dispose(); tab.vt = null; }
    const msg = `\r\n\x1b[33mShell exited (code: ${exitCode})\x1b[0m\r\n`;
    for (const ws of tab.clients) {
      if (ws.readyState === ws.OPEN) ws.send(msg);
    }
    broadcastState();
  });

  session.tabs.push(tab);
  console.log(`[tab] created id=${id} in session "${session.name}" (pid=${ptyProcess.pid})`);
  return tab;
}

const sessionMap = new Map();

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
  return [...sessionMap.values()].map(s => ({
    name: s.name,
    tabs: s.tabs.map(t => ({
      id: t.id,
      title: t.title,
      ended: t.ended,
      clients: t.clients.size,
    })),
    createdAt: s.createdAt,
  }));
}

// Attach ws to a specific tab — detach from previous first.
// Uses tsm-style snapshot: if VT tracking available, send viewport
// snapshot; otherwise fall back to raw scrollback.
// After snapshot, resize PTY + send Ctrl+L to trigger app redraw.
function attachToTab(tab, ws, cols, rows) {
  detachFromTab(ws);

  if (ws.readyState === ws.OPEN) {
    if (tab.vt && !tab.ended) {
      // tsm pattern: send VT snapshot (screen content with colors + cursor)
      const snapshot = tab.vt.snapshot();
      if (snapshot) ws.send(snapshot);
    } else {
      // fallback: raw scrollback
      const history = tab.scrollback.read();
      if (history.length > 0) ws.send(history.toString("utf8"));
    }
  }

  tab.clients.add(ws);
  ws._remuxTabId = tab.id;
  ws._remuxCols = cols;
  ws._remuxRows = rows;
  recalcTabSize(tab);

  // tsm pattern: after attach, resize + Ctrl+L to trigger running app redraw
  if (!tab.ended) {
    setTimeout(() => {
      tab.pty.write("\x0c"); // Ctrl+L — forces shell/vim/etc to redraw
    }, 50);
  }
}

function detachFromTab(ws) {
  const prevId = ws._remuxTabId;
  if (prevId == null) return;
  // find tab across all sessions
  for (const session of sessionMap.values()) {
    const tab = session.tabs.find(t => t.id === prevId);
    if (tab) {
      tab.clients.delete(ws);
      if (tab.clients.size > 0) recalcTabSize(tab);
      break;
    }
  }
  ws._remuxTabId = null;
}

function findTab(tabId) {
  for (const session of sessionMap.values()) {
    const tab = session.tabs.find(t => t.id === tabId);
    if (tab) return { session, tab };
  }
  return null;
}

function recalcTabSize(tab) {
  let minCols = Infinity, minRows = Infinity;
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

const controlClients = new Set();

function broadcastState() {
  const state = getState();
  const msg = JSON.stringify({ type: "state", sessions: state });
  for (const ws of controlClients) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}

// Startup: init WASM, restore sessions, create default if needed
let startupDone = false;
async function startup() {
  await initGhosttyVt();

  // Try restoring saved sessions
  const saved = restoreSessions();
  if (saved && saved.sessions.length > 0) {
    for (const s of saved.sessions) {
      const session = createSession(s.name);
      // Restore tabs — each tab gets a new PTY, but pre-fill scrollback with saved data
      for (const t of s.tabs) {
        if (t.ended) continue;
        const tab = createTab(session);
        tab.title = t.title || tab.title;
        if (t.scrollback) {
          // Write saved scrollback to the RingBuffer so it's available on attach
          // Note: this goes to RingBuffer only, NOT to PTY or VT terminal
          tab.scrollback.write(t.scrollback);
        }
      }
      // If all tabs were ended, create a fresh one
      if (session.tabs.length === 0) createTab(session);
    }
  }

  // Ensure at least a "main" session exists
  if (sessionMap.size === 0) {
    const s = createSession("main");
    createTab(s);
  }

  // Persistence timer (8s, like cmux)
  setInterval(persistSessions, PERSIST_INTERVAL_MS);

  startupDone = true;
}

startup().catch(e => {
  console.error("[startup] fatal:", e);
  // Fallback: create default session without VT tracking
  if (sessionMap.size === 0) {
    const s = createSession("main");
    createTab(s);
  }
  startupDone = true;
});

// ── HTML Template ──────────────────────────────────────────────────

const HTML_TEMPLATE = `<!doctype html>
<html lang="en" data-theme="dark">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
    <title>Remux</title>
    <style>
      /* ── Theme Variables ── */
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

      /* ── Sidebar ── */
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

      /* ── Theme toggle ── */
      .theme-toggle { background: none; border: none; cursor: pointer; font-size: 16px;
        color: var(--text-muted); padding: 4px 8px; border-radius: 4px; }
      .theme-toggle:hover { color: var(--text-bright); background: var(--bg-hover); }

      /* ── Main ── */
      .main { flex: 1; display: flex; flex-direction: column; min-width: 0; }

      /* ── Tab bar (Chrome-style) ── */
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

      .tab-new { display: flex; align-items: center; justify-content: center;
        width: 28px; height: 28px; margin: 0 4px; font-size: 18px; color: var(--text-dim);
        background: none; border: none; cursor: pointer; border-radius: 4px;
        flex-shrink: 0; align-self: center; }
      .tab-new:hover { color: var(--text); background: var(--compose-bg); }

      /* ── Terminal ── */
      #terminal { flex: 1; background: var(--bg); overflow: hidden; }
      #terminal canvas { display: block; }
      #terminal.hidden { display: none; }

      /* ── View switcher ── */
      .view-switch { display: flex; gap: 1px; margin-left: auto; margin-right: 8px;
        align-self: center; background: var(--view-switch-bg); border-radius: 4px; overflow: hidden; }
      .view-switch button { padding: 4px 10px; font-size: 11px; font-family: inherit;
        color: var(--text-muted); background: var(--bg-tab-bar); border: none; cursor: pointer; }
      .view-switch button:hover { color: var(--text); }
      .view-switch button.active { color: var(--text-on-active); background: var(--accent); }

      /* ── Inspect ── */
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

      /* ── Compose bar ── */
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

      /* ── Tab rename input ── */
      .tab .rename-input { background: var(--bg); border: 1px solid var(--accent); border-radius: 3px;
        color: var(--text-bright); font-size: 12px; font-family: inherit; padding: 1px 4px;
        outline: none; width: 80px; }

      /* ── Mobile ── */
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
        <button class="tab-toggle" id="btn-sidebar" title="Toggle sidebar">☰</button>
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
        <button data-seq="up">↑</button>
        <button data-seq="down">↓</button>
        <button data-seq="left">←</button>
        <button data-seq="right">→</button>
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

      // ── Terminal color themes (ghostty-web ITheme) ──
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
      const $ = id => document.getElementById(id);
      const setStatus = (s, t) => { $('status-dot').className = 'status-dot ' + s; $('status-text').textContent = t; };

      // ── Theme switching ──
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

      // ── Sidebar ──
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

      // ── Render sessions ──
      function renderSessions() {
        const list = $('session-list'); list.innerHTML = '';
        sessions.forEach(s => {
          const el = document.createElement('button');
          el.className = 'session-item' + (s.name === currentSession ? ' active' : '');
          const live = s.tabs.filter(t => !t.ended).length;
          el.innerHTML = '<span class="dot"></span><span class="name">' + s.name
            + '</span><span class="count">' + live + '</span>'
            + '<button class="del" data-del="' + s.name + '">×</button>';
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

      // ── Render tabs (Chrome-style) ──
      function renderTabs() {
        const list = $('tab-list'); list.innerHTML = '';
        const sess = sessions.find(s => s.name === currentSession);
        if (!sess) return;
        sess.tabs.forEach(t => {
          const el = document.createElement('button');
          el.className = 'tab' + (t.id === currentTabId ? ' active' : '');
          el.innerHTML = '<span class="title">' + t.title + '</span>'
            + '<button class="close" data-close="' + t.id + '">×</button>';
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

      // ── WebSocket with exponential backoff + heartbeat ──
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
              const msg = JSON.parse(e.data);
              if (msg.type === 'auth_ok') return;
              if (msg.type === 'auth_error') { setStatus('disconnected', 'Auth failed'); ws.close(); return; }
              if (msg.type === 'state') { sessions = msg.sessions; renderSessions(); renderTabs(); return; }
              if (msg.type === 'attached') {
                currentTabId = msg.tabId; currentSession = msg.session;
                setStatus('connected', msg.session); renderSessions(); renderTabs(); return;
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

      // ── Terminal I/O ──
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

      // ── Compose bar ──
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

      // ── Inspect view ──
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

      // ── Inspect search ──
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

      // ── Tab rename (double-click) ──
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

      // ── Mobile ──
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

// ── MIME ────────────────────────────────────────────────────────────

const MIME = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".wasm": "application/wasm",
  ".css": "text/css",
  ".json": "application/json",
};

// ── Password page HTML ────────────────────────────────────────────

const PASSWORD_PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Remux — Login</title>
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

// ── HTTP Server ────────────────────────────────────────────────────

const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Handle password form submission
  if (url.pathname === "/auth" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const params = new URLSearchParams(body);
      const submitted = params.get("password");
      if (PASSWORD && submitted === PASSWORD) {
        // Generate a session token and redirect with it
        const sessionToken = crypto.randomBytes(16).toString("hex");
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
    const isAuthed = !TOKEN && !PASSWORD  // no auth configured (impossible after auto-gen, but safe)
      || (TOKEN && urlToken === TOKEN)
      || passwordTokens.has(urlToken);

    if (!isAuthed) {
      // If password mode is active and no valid token, show login page
      if (PASSWORD) {
        const showError = url.searchParams.has("error");
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
    return serveFile(path.join(distPath, url.pathname.slice(6)), res);
  }

  if (url.pathname === "/ghostty-vt.wasm") {
    return serveFile(wasmPath, res);
  }

  res.writeHead(404);
  res.end("Not Found");
});

function serveFile(filePath, res) {
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end("Not Found"); return; }
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
}

// ── WebSocket Server ──────────────────────────────────────────────

const wss = new WebSocketServer({ noServer: true });

httpServer.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === "/ws") {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

// ── Heartbeat: ping authenticated clients every 30s ──────────────

const HEARTBEAT_INTERVAL = 30_000;
setInterval(() => {
  for (const ws of controlClients) {
    if (ws.readyState === ws.OPEN) ws.ping();
  }
}, HEARTBEAT_INTERVAL);

wss.on("connection", (ws) => {
  ws._remuxTabId = null;
  ws._remuxCols = 80;
  ws._remuxRows = 24;

  // Auth: no auth needed only if neither token nor password is configured
  const requiresAuth = !!(TOKEN || PASSWORD);
  ws._remuxAuthed = !requiresAuth;
  if (!requiresAuth) controlClients.add(ws);

  ws.on("message", (raw) => {
    const msg = raw.toString("utf8");

    // ── Auth gate ──
    if (!ws._remuxAuthed) {
      try {
        const parsed = JSON.parse(msg);
        if (parsed.type === "auth") {
          const validToken = (TOKEN && parsed.token === TOKEN)
            || passwordTokens.has(parsed.token);
          if (validToken) {
            ws._remuxAuthed = true;
            controlClients.add(ws);
            ws.send(JSON.stringify({ type: "auth_ok" }));
            ws.send(JSON.stringify({ type: "state", sessions: getState() }));
            return;
          }
        }
      } catch {}
      ws.send(JSON.stringify({ type: "auth_error", reason: "invalid token" }));
      ws.close(4001, "unauthorized");
      return;
    }

    // ── JSON control messages ──
    if (msg.startsWith("{")) {
      try {
        const p = JSON.parse(msg);

        // Attach to first tab of a session (or create one)
        if (p.type === "attach_first") {
          const name = p.session || "main";
          const session = createSession(name);
          let tab = session.tabs.find(t => !t.ended);
          if (!tab) tab = createTab(session, p.cols || ws._remuxCols, p.rows || ws._remuxRows);
          attachToTab(tab, ws, p.cols || ws._remuxCols, p.rows || ws._remuxRows);
          // Send state BEFORE attached so client has session/tab data when processing attached
          broadcastState();
          ws.send(JSON.stringify({ type: "attached", tabId: tab.id, session: name }));
          return;
        }

        // Attach to an existing tab by id
        if (p.type === "attach_tab") {
          const found = findTab(p.tabId);
          if (found) {
            attachToTab(found.tab, ws, p.cols || ws._remuxCols, p.rows || ws._remuxRows);
            broadcastState();
            ws.send(JSON.stringify({ type: "attached", tabId: found.tab.id, session: found.session.name }));
          }
          return;
        }

        // Create a new tab in a session (creates session if needed)
        if (p.type === "new_tab") {
          const session = createSession(p.session || "main");
          const tab = createTab(session, p.cols || ws._remuxCols, p.rows || ws._remuxRows);
          attachToTab(tab, ws, p.cols || ws._remuxCols, p.rows || ws._remuxRows);
          broadcastState();
          ws.send(JSON.stringify({ type: "attached", tabId: tab.id, session: session.name }));
          return;
        }

        // Close a tab (kill its PTY)
        if (p.type === "close_tab") {
          const found = findTab(p.tabId);
          if (found) {
            if (!found.tab.ended) found.tab.pty.kill();
            found.session.tabs = found.session.tabs.filter(t => t.id !== p.tabId);
            // If session has no tabs left, remove it (unless it's "main")
            if (found.session.tabs.length === 0 && found.session.name !== "main") {
              sessionMap.delete(found.session.name);
            }
          }
          broadcastState();
          return;
        }

        // Create a new session (with one default tab)
        if (p.type === "new_session") {
          const name = p.name || "session-" + Date.now();
          const session = createSession(name);
          const tab = createTab(session, p.cols || ws._remuxCols, p.rows || ws._remuxRows);
          attachToTab(tab, ws, p.cols || ws._remuxCols, p.rows || ws._remuxRows);
          broadcastState();
          ws.send(JSON.stringify({ type: "attached", tabId: tab.id, session: name }));
          return;
        }

        // Delete entire session
        if (p.type === "delete_session") {
          if (p.name) { deleteSession(p.name); broadcastState(); }
          return;
        }

        // Inspect: capture current tab's terminal content as text
        if (p.type === "inspect") {
          const found = findTab(ws._remuxTabId);
          if (found && found.tab.vt && !found.tab.ended) {
            const { text, cols, rows } = found.tab.vt.textSnapshot();
            ws.send(JSON.stringify({
              type: "inspect_result",
              text,
              meta: {
                session: found.session.name,
                tabId: found.tab.id,
                tabTitle: found.tab.title,
                cols, rows,
                timestamp: Date.now(),
              },
            }));
          } else {
            // Fallback: raw scrollback as text
            const found2 = findTab(ws._remuxTabId);
            const raw = found2 ? found2.tab.scrollback.read().toString("utf8") : "";
            // Strip ANSI escape sequences
            const text = raw.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
            ws.send(JSON.stringify({
              type: "inspect_result",
              text,
              meta: { timestamp: Date.now() },
            }));
          }
          return;
        }

        // Rename a tab
        if (p.type === "rename_tab") {
          const found = findTab(p.tabId);
          if (found && typeof p.title === "string" && p.title.trim()) {
            found.tab.title = p.title.trim().slice(0, 32);
            broadcastState();
          }
          return;
        }

        // Resize current tab
        if (p.type === "resize") {
          ws._remuxCols = p.cols;
          ws._remuxRows = p.rows;
          const found = findTab(ws._remuxTabId);
          if (found) recalcTabSize(found.tab);
          return;
        }

        return;
      } catch { /* not JSON */ }
    }

    // ── Raw terminal input → current tab's PTY ──
    const found = findTab(ws._remuxTabId);
    if (found && !found.tab.ended) {
      found.tab.pty.write(msg);
    }
  });

  ws.on("close", () => {
    detachFromTab(ws);
    controlClients.delete(ws);
  });

  ws.on("error", () => {});
});

// ── Start ──────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  let url = `http://localhost:${PORT}`;
  if (TOKEN) url += `?token=${TOKEN}`;

  console.log(`\n  Remux running at ${url}\n`);

  if (PASSWORD) {
    console.log(`  Password authentication enabled`);
    console.log(`  Login page: http://localhost:${PORT}\n`);
  } else if (TOKEN) {
    console.log(`  Token: ${TOKEN}\n`);
  }

  // Print QR code for local URL
  qrcode.generate(url, { small: true }, (code) => {
    console.log(code);
  });

  // ── Tunnel: launch async after server is listening ──
  launchTunnel();
});

async function launchTunnel() {
  if (tunnelMode === "disable") return;

  const available = await isCloudflaredAvailable();
  if (!available) {
    if (tunnelMode === "enable") {
      console.log("\n  [tunnel] cloudflared not found — install it for tunnel support");
      console.log("  https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/\n");
    }
    return;
  }

  console.log("  [tunnel] starting cloudflare tunnel...");
  try {
    const { url: tunnelUrl, process: child } = await startTunnel(PORT);
    tunnelProcess = child;

    const accessUrl = buildTunnelAccessUrl(tunnelUrl, TOKEN, PASSWORD);
    console.log(`\n  Tunnel: ${accessUrl}\n`);

    // Print QR code for tunnel URL (great for mobile access)
    qrcode.generate(accessUrl, { small: true }, (code) => {
      console.log(code);
    });

    // Log if tunnel exits unexpectedly
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
  persistSessions(); // save before exit
  // Kill cloudflared tunnel if running
  if (tunnelProcess) {
    try { tunnelProcess.kill("SIGTERM"); } catch {}
    tunnelProcess = null;
  }
  for (const session of sessionMap.values()) {
    for (const tab of session.tabs) {
      if (tab.vt) { tab.vt.dispose(); tab.vt = null; }
      if (!tab.ended) tab.pty.kill();
    }
  }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

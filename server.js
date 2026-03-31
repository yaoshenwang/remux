#!/usr/bin/env node

/**
 * Remux server — ghostty-web terminal with session management.
 * Adapted from coder/ghostty-web demo (MIT) + tsm session patterns.
 */

import fs from "fs";
import http from "http";
import { homedir } from "os";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import pty from "node-pty";
import { WebSocketServer } from "ws";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const PORT = process.env.PORT || 8767;
const TOKEN = process.env.REMUX_TOKEN || null;

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
    dispose() {
      wasmExports.ghostty_terminal_free(handle);
    },
  };
}

// ── Session Persistence ──────────────────────────────────────────

const PERSIST_DIR = path.join(homedir(), ".remux");
const PERSIST_FILE = path.join(PERSIST_DIR, "sessions.json");
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
  return process.platform === "win32"
    ? (process.env.COMSPEC || "cmd.exe")
    : (process.env.SHELL || "/bin/bash");
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
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
    <title>Remux</title>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { height: 100%; overflow: hidden; overscroll-behavior: none; }
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        background: #1e1e1e; color: #ccc; height: 100vh; height: 100dvh; display: flex; }

      /* ── Sidebar ── */
      .sidebar { width: 220px; min-width: 220px; background: #252526; border-right: 1px solid #1a1a1a;
        display: flex; flex-direction: column; flex-shrink: 0; transition: margin-left .2s; }
      .sidebar.collapsed { margin-left: -220px; }
      .sidebar-header { padding: 10px 12px; font-size: 11px; font-weight: 600; color: #888;
        text-transform: uppercase; letter-spacing: .5px; display: flex; align-items: center;
        justify-content: space-between; }
      .sidebar-header button { background: none; border: none; color: #666; cursor: pointer;
        font-size: 18px; line-height: 1; padding: 2px 6px; border-radius: 4px; }
      .sidebar-header button:hover { color: #e5e5e5; background: #3a3a3a; }

      .session-list { flex: 1; overflow-y: auto; padding: 4px 6px; }
      .session-item { display: flex; align-items: center; gap: 8px; padding: 7px 8px; border-radius: 4px;
        font-size: 13px; cursor: pointer; color: #aaa; border: none; background: none;
        width: 100%; text-align: left; font-family: inherit; min-height: 32px; }
      .session-item:hover { background: #2a2d2e; color: #e5e5e5; }
      .session-item.active { background: #37373d; color: #fff; }
      .session-item .dot { width: 6px; height: 6px; border-radius: 50%; background: #27c93f; flex-shrink: 0; }
      .session-item .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .session-item .count { font-size: 10px; color: #555; min-width: 16px; text-align: center; }
      .session-item .del { opacity: 0; font-size: 14px; color: #666; background: none; border: none;
        cursor: pointer; padding: 0 4px; font-family: inherit; line-height: 1; border-radius: 3px; }
      .session-item:hover .del { opacity: 1; }
      .session-item .del:hover { color: #ff5f56; background: #3a3a3a; }

      .sidebar-footer { padding: 8px 12px; border-top: 1px solid #1a1a1a; }
      .sidebar-footer .status { font-size: 11px; color: #888; display: flex; align-items: center; gap: 6px; }
      .status-dot { width: 7px; height: 7px; border-radius: 50%; background: #888; flex-shrink: 0; }
      .status-dot.connected { background: #27c93f; }
      .status-dot.disconnected { background: #ff5f56; }
      .status-dot.connecting { background: #ffbd2e; animation: pulse 1s infinite; }
      @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.5} }

      /* ── Main ── */
      .main { flex: 1; display: flex; flex-direction: column; min-width: 0; }

      /* ── Tab bar (Chrome-style) ── */
      .tab-bar { background: #2d2d2d; display: flex; align-items: flex-end; flex-shrink: 0;
        min-height: 36px; padding: 0 0 0 0; }
      .tab-toggle { padding: 8px 10px; background: none; border: none; color: #888;
        cursor: pointer; font-size: 16px; flex-shrink: 0; align-self: center; }
      .tab-toggle:hover { color: #e5e5e5; }
      .tab-list { display: flex; flex: 1; min-width: 0; align-items: flex-end; overflow-x: auto;
        -webkit-overflow-scrolling: touch; scrollbar-width: none; }
      .tab-list::-webkit-scrollbar { display: none; }

      .tab { position: relative; display: flex; align-items: center; gap: 0;
        padding: 6px 8px 6px 12px; font-size: 12px; color: #999; background: #2d2d2d;
        border: none; cursor: pointer; white-space: nowrap; font-family: inherit;
        border-top: 2px solid transparent; margin-right: 1px; min-height: 32px; }
      .tab:hover { color: #ddd; background: #383838; }
      .tab.active { color: #fff; background: #1e1e1e; border-top-color: #007acc;
        border-radius: 6px 6px 0 0; }
      .tab .title { pointer-events: none; }
      .tab .close { display: flex; align-items: center; justify-content: center;
        width: 18px; height: 18px; margin-left: 6px; font-size: 12px; color: #666;
        border-radius: 3px; border: none; background: none; cursor: pointer;
        font-family: inherit; flex-shrink: 0; }
      .tab .close:hover { color: #fff; background: #555; }
      .tab:not(:hover) .close:not(:focus) { opacity: 0; }
      .tab.active .close { opacity: 1; color: #888; }

      .tab-new { display: flex; align-items: center; justify-content: center;
        width: 28px; height: 28px; margin: 0 4px; font-size: 18px; color: #666;
        background: none; border: none; cursor: pointer; border-radius: 4px;
        flex-shrink: 0; align-self: center; }
      .tab-new:hover { color: #ccc; background: #3a3a3a; }

      /* ── Terminal ── */
      #terminal { flex: 1; background: #1e1e1e; overflow: hidden; }
      #terminal canvas { display: block; }

      /* ── Compose bar ── */
      .compose-bar { display: none; background: #252526; border-top: 1px solid #1a1a1a;
        padding: 5px 8px; gap: 5px; flex-shrink: 0; overflow-x: auto;
        -webkit-overflow-scrolling: touch; }
      .compose-bar button { padding: 8px 12px; font-size: 14px;
        font-family: 'Menlo','Monaco',monospace; color: #d4d4d4; background: #3a3a3a;
        border: 1px solid #555; border-radius: 5px; cursor: pointer; white-space: nowrap;
        -webkit-tap-highlight-color: transparent; touch-action: manipulation;
        min-width: 40px; text-align: center; user-select: none; }
      .compose-bar button:active { background: #555; }
      .compose-bar button.active { background: #4a6a9a; border-color: #6a9ade; }
      @media (hover: none) and (pointer: coarse) { .compose-bar { display: flex; } }

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
        <div class="status">
          <div class="status-dot connecting" id="status-dot"></div>
          <span id="status-text">...</span>
        </div>
      </div>
    </aside>
    <div class="main">
      <div class="tab-bar">
        <button class="tab-toggle" id="btn-sidebar" title="Toggle sidebar">☰</button>
        <div class="tab-list" id="tab-list"></div>
        <button class="tab-new" id="btn-new-tab" title="New tab">+</button>
      </div>
      <div id="terminal"></div>
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
      </div>
    </div>

    <script type="module">
      import { init, Terminal, FitAddon } from '/dist/ghostty-web.js';
      await init();

      const term = new Terminal({ cols: 80, rows: 24,
        fontFamily: 'Menlo, Monaco, "Courier New", monospace',
        fontSize: 14, cursorBlink: true,
        theme: { background: '#1e1e1e', foreground: '#d4d4d4' },
        scrollback: 10000 });
      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(document.getElementById('terminal'));
      fitAddon.fit();
      fitAddon.observeResize();
      window.addEventListener('resize', () => fitAddon.fit());

      let sessions = [], currentSession = 'main', currentTabId = null, ws = null, ctrlActive = false;
      const $ = id => document.getElementById(id);
      const setStatus = (s, t) => { $('status-dot').className = 'status-dot ' + s; $('status-text').textContent = t; };

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

      // ── WebSocket ──
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const urlToken = new URLSearchParams(location.search).get('token');

      function connect() {
        setStatus('connecting', '...');
        ws = new WebSocket(proto + '//' + location.host + '/ws');
        ws.onopen = () => {
          if (urlToken) ws.send(JSON.stringify({ type: 'auth', token: urlToken }));
          sendCtrl({ type: 'attach_first', session: 'main', cols: term.cols, rows: term.rows });
        };
        ws.onmessage = e => {
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
            } catch {}
          }
          term.write(e.data);
        };
        ws.onclose = () => { setStatus('disconnected', 'Disconnected'); setTimeout(connect, 2000); };
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
      const SEQ = { esc: '\\x1b', tab: '\\t', up: '\\x1b[A', down: '\\x1b[B', left: '\\x1b[D', right: '\\x1b[C' };
      $('compose-bar').addEventListener('pointerdown', e => {
        const btn = e.target.closest('button'); if (!btn) return;
        e.preventDefault();
        if (btn.dataset.mod === 'ctrl') { ctrlActive = !ctrlActive; btn.classList.toggle('active', ctrlActive); return; }
        const d = SEQ[btn.dataset.seq] || btn.dataset.ch;
        if (d && ws && ws.readyState === WebSocket.OPEN) ws.send(d);
        term.focus();
      });

      // ── Mobile ──
      if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', () => {
          document.body.style.height = window.visualViewport.height + 'px'; fitAddon.fit();
        });
        window.visualViewport.addEventListener('scroll', () => window.scrollTo(0, 0));
      }
      document.getElementById('terminal').addEventListener('touchend', () => term.focus());
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

// ── HTTP Server ────────────────────────────────────────────────────

const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/" || url.pathname === "/index.html") {
    // If token is configured, require it in query string to serve the page
    if (TOKEN && url.searchParams.get("token") !== TOKEN) {
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

wss.on("connection", (ws) => {
  ws._remuxTabId = null;
  ws._remuxCols = 80;
  ws._remuxRows = 24;
  ws._remuxAuthed = !TOKEN;
  if (!TOKEN) controlClients.add(ws); // auto-auth: register for broadcasts immediately

  ws.on("message", (raw) => {
    const msg = raw.toString("utf8");

    // ── Auth gate ──
    if (!ws._remuxAuthed) {
      try {
        const parsed = JSON.parse(msg);
        if (parsed.type === "auth" && parsed.token === TOKEN) {
          ws._remuxAuthed = true;
          controlClients.add(ws);
          ws.send(JSON.stringify({ type: "auth_ok" }));
          ws.send(JSON.stringify({ type: "state", sessions: getState() }));
          return;
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
  console.log(`\n  Remux running at http://localhost:${PORT}\n`);
});

function shutdown() {
  persistSessions(); // save before exit
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

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

// ── Session Manager (tsm pattern) ─────────────────────────────────

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

const sessionMap = new Map();

function createSession(name, cols = 80, rows = 24) {
  if (sessionMap.has(name)) return sessionMap.get(name);

  const ptyProcess = pty.spawn(getShell(), [], {
    name: "xterm-256color",
    cols, rows,
    cwd: homedir(),
    env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
  });

  const session = {
    name,
    pty: ptyProcess,
    scrollback: new RingBuffer(),
    clients: new Set(),
    cols, rows,
    createdAt: Date.now(),
    ended: false,
  };

  ptyProcess.onData((data) => {
    session.scrollback.write(data);
    for (const ws of session.clients) {
      if (ws.readyState === ws.OPEN) ws.send(data);
    }
  });

  ptyProcess.onExit(({ exitCode }) => {
    session.ended = true;
    const msg = `\r\n\x1b[33mShell exited (code: ${exitCode})\x1b[0m\r\n`;
    for (const ws of session.clients) {
      if (ws.readyState === ws.OPEN) ws.send(msg);
    }
    broadcastSessionList();
  });

  sessionMap.set(name, session);
  console.log(`[session] created "${name}" (pid=${ptyProcess.pid})`);
  return session;
}

function deleteSession(name) {
  const session = sessionMap.get(name);
  if (!session) return;
  if (!session.ended) session.pty.kill();
  sessionMap.delete(name);
  console.log(`[session] deleted "${name}"`);
}

function getSessionList() {
  return [...sessionMap.entries()].map(([name, s]) => ({
    name,
    clients: s.clients.size,
    ended: s.ended,
    createdAt: s.createdAt,
  }));
}

function attachClient(session, ws, cols, rows) {
  // Send scrollback history to new client
  const history = session.scrollback.read();
  if (history.length > 0 && ws.readyState === ws.OPEN) {
    ws.send(history.toString("utf8"));
  }
  session.clients.add(ws);
  // Resize to smallest client (tsm pattern)
  recalcSize(session);
}

function detachClient(ws) {
  const sessionName = ws._remuxSession;
  if (!sessionName) return;
  const session = sessionMap.get(sessionName);
  if (!session) return;
  session.clients.delete(ws);
  if (session.clients.size > 0) recalcSize(session);
}

function recalcSize(session) {
  let minCols = Infinity, minRows = Infinity;
  for (const ws of session.clients) {
    if (ws._remuxCols) minCols = Math.min(minCols, ws._remuxCols);
    if (ws._remuxRows) minRows = Math.min(minRows, ws._remuxRows);
  }
  if (minCols < Infinity && minRows < Infinity && !session.ended) {
    session.cols = minCols;
    session.rows = minRows;
    session.pty.resize(minCols, minRows);
  }
}

// Track control clients for session list broadcasts
const controlClients = new Set();

function broadcastSessionList() {
  const list = getSessionList();
  const msg = JSON.stringify({ type: "session_list", sessions: list });
  for (const ws of controlClients) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}

// Create default session
createSession("main");

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

      body {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        background: #1e1e1e;
        display: flex;
        flex-direction: column;
        height: 100vh;
        height: 100dvh;
      }

      /* ── Title bar ── */
      .title-bar {
        background: #2d2d2d;
        padding: 6px 12px;
        display: flex;
        align-items: center;
        gap: 8px;
        border-bottom: 1px solid #1a1a1a;
        flex-shrink: 0;
        overflow-x: auto;
        -webkit-overflow-scrolling: touch;
      }

      .status {
        font-size: 11px;
        color: #888;
        display: flex;
        align-items: center;
        gap: 4px;
        white-space: nowrap;
      }

      .status-dot {
        width: 7px; height: 7px; border-radius: 50%; background: #888;
        flex-shrink: 0;
      }
      .status-dot.connected { background: #27c93f; }
      .status-dot.disconnected { background: #ff5f56; }
      .status-dot.connecting { background: #ffbd2e; animation: pulse 1s infinite; }

      @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.5} }

      /* ── Tab bar ── */
      .tab-bar {
        display: flex;
        gap: 2px;
        flex: 1;
        min-width: 0;
      }

      .tab {
        padding: 4px 12px;
        font-size: 12px;
        color: #888;
        background: transparent;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        white-space: nowrap;
        font-family: inherit;
      }
      .tab:hover { background: #3a3a3a; color: #ccc; }
      .tab.active { background: #1e1e1e; color: #e5e5e5; }
      .tab .close {
        margin-left: 6px; opacity: 0.4; font-size: 10px;
      }
      .tab .close:hover { opacity: 1; }

      .tab-new {
        padding: 4px 8px;
        font-size: 14px;
        color: #666;
        background: transparent;
        border: none;
        cursor: pointer;
        font-family: inherit;
      }
      .tab-new:hover { color: #ccc; }

      /* ── Terminal ── */
      #terminal {
        flex: 1;
        background: #1e1e1e;
        overflow: hidden;
        position: relative;
      }
      #terminal canvas { display: block; }

      /* ── Compose bar (mobile) ── */
      .compose-bar {
        display: none;
        background: #2d2d2d;
        border-top: 1px solid #1a1a1a;
        padding: 4px 8px;
        gap: 4px;
        flex-shrink: 0;
        overflow-x: auto;
        -webkit-overflow-scrolling: touch;
      }

      .compose-bar button {
        padding: 6px 10px;
        font-size: 13px;
        font-family: 'Menlo', 'Monaco', monospace;
        color: #d4d4d4;
        background: #3a3a3a;
        border: 1px solid #555;
        border-radius: 4px;
        cursor: pointer;
        white-space: nowrap;
        -webkit-tap-highlight-color: transparent;
        touch-action: manipulation;
        min-width: 36px;
        text-align: center;
      }
      .compose-bar button:active { background: #555; }
      .compose-bar button.modifier-active { background: #4a6a9a; border-color: #6a9ade; }

      /* Show compose bar on touch devices */
      @media (hover: none) and (pointer: coarse) {
        .compose-bar { display: flex; }
      }
    </style>
  </head>
  <body>
    <div class="title-bar">
      <div class="tab-bar" id="tab-bar"></div>
      <button class="tab-new" id="btn-new-tab" title="New session">+</button>
      <div class="status">
        <div class="status-dot connecting" id="status-dot"></div>
        <span id="status-text">...</span>
      </div>
    </div>

    <div id="terminal"></div>

    <div class="compose-bar" id="compose-bar">
      <button data-seq="esc">Esc</button>
      <button data-seq="tab">Tab</button>
      <button data-modifier="ctrl" id="btn-ctrl">Ctrl</button>
      <button data-seq="up">↑</button>
      <button data-seq="down">↓</button>
      <button data-seq="left">←</button>
      <button data-seq="right">→</button>
      <button data-ch="|">|</button>
      <button data-ch="~">~</button>
      <button data-ch="-">-</button>
      <button data-ch="/">/ </button>
    </div>

    <script type="module">
      import { init, Terminal, FitAddon } from '/dist/ghostty-web.js';

      await init();

      const term = new Terminal({
        cols: 80, rows: 24,
        fontFamily: 'Menlo, Monaco, "Courier New", monospace',
        fontSize: 14,
        cursorBlink: true,
        theme: { background: '#1e1e1e', foreground: '#d4d4d4' },
        scrollback: 10000,
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(document.getElementById('terminal'));
      fitAddon.fit();
      fitAddon.observeResize();
      window.addEventListener('resize', () => fitAddon.fit());

      // ── State ──
      let currentSession = 'main';
      let sessions = [];
      let ws = null;
      let ctrlActive = false;

      const dot = document.getElementById('status-dot');
      const statusText = document.getElementById('status-text');
      function setStatus(s, t) { dot.className = 'status-dot ' + s; statusText.textContent = t; }

      // ── Tab bar ──
      const tabBar = document.getElementById('tab-bar');

      function renderTabs() {
        tabBar.innerHTML = '';
        sessions.forEach(s => {
          const btn = document.createElement('button');
          btn.className = 'tab' + (s.name === currentSession ? ' active' : '');
          btn.innerHTML = s.name + (s.ended ? ' ✕' : '') +
            '<span class="close" data-delete="' + s.name + '">×</span>';
          btn.addEventListener('click', (e) => {
            if (e.target.dataset.delete) {
              sendControl({ type: 'delete_session', name: e.target.dataset.delete });
              return;
            }
            switchSession(s.name);
          });
          tabBar.appendChild(btn);
        });
      }

      document.getElementById('btn-new-tab').addEventListener('click', () => {
        const name = prompt('Session name:');
        if (name && name.trim()) {
          switchSession(name.trim());
        }
      });

      function switchSession(name) {
        currentSession = name;
        sendControl({ type: 'attach', session: name, cols: term.cols, rows: term.rows });
        term.clear();
      }

      // ── WebSocket ──
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';

      function connect() {
        setStatus('connecting', '...');
        ws = new WebSocket(proto + '//' + location.host + '/ws');

        ws.onopen = () => {
          setStatus('connected', currentSession);
          sendControl({ type: 'attach', session: currentSession, cols: term.cols, rows: term.rows });
        };

        ws.onmessage = (e) => {
          if (typeof e.data === 'string' && e.data[0] === '{') {
            try {
              const msg = JSON.parse(e.data);
              if (msg.type === 'session_list') {
                sessions = msg.sessions;
                renderTabs();
                return;
              }
              if (msg.type === 'attached') {
                currentSession = msg.session;
                setStatus('connected', currentSession);
                renderTabs();
                return;
              }
            } catch {}
          }
          term.write(e.data);
        };

        ws.onclose = () => {
          setStatus('disconnected', 'Disconnected');
          setTimeout(connect, 2000);
        };
        ws.onerror = () => setStatus('disconnected', 'Error');
      }

      connect();

      function sendControl(msg) {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
      }

      // ── Input → server ──
      term.onData((data) => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        if (ctrlActive) {
          ctrlActive = false;
          document.getElementById('btn-ctrl').classList.remove('modifier-active');
          // Convert to ctrl char: 'c' -> 0x03, 'z' -> 0x1a, etc.
          const ch = data.toLowerCase().charCodeAt(0);
          if (ch >= 0x61 && ch <= 0x7a) {
            ws.send(String.fromCharCode(ch - 0x60));
            return;
          }
        }
        ws.send(data);
      });

      // ── Resize → server ──
      term.onResize(({ cols, rows }) => {
        sendControl({ type: 'resize', cols, rows });
      });

      // ── Compose bar ──
      const SEQ_MAP = {
        esc: '\\x1b', tab: '\\t',
        up: '\\x1b[A', down: '\\x1b[B', left: '\\x1b[D', right: '\\x1b[C',
      };

      document.getElementById('compose-bar').addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;
        e.preventDefault();

        if (btn.dataset.modifier === 'ctrl') {
          ctrlActive = !ctrlActive;
          btn.classList.toggle('modifier-active', ctrlActive);
          return;
        }

        const data = SEQ_MAP[btn.dataset.seq] || btn.dataset.ch;
        if (data && ws && ws.readyState === WebSocket.OPEN) {
          ws.send(data);
        }
        term.focus();
      });

      // ── Mobile keyboard (visualViewport) ──
      if (window.visualViewport) {
        const termEl = document.getElementById('terminal');
        window.visualViewport.addEventListener('resize', () => {
          const kbH = window.innerHeight - window.visualViewport.height;
          document.body.style.height = window.visualViewport.height + 'px';
          fitAddon.fit();
        });
        window.visualViewport.addEventListener('scroll', () => {
          window.scrollTo(0, 0);
        });
      }

      // Focus terminal on touch
      document.getElementById('terminal').addEventListener('touchend', () => {
        term.focus();
      });
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
  ws._remuxSession = null;
  ws._remuxCols = 80;
  ws._remuxRows = 24;
  controlClients.add(ws);

  // Send session list on connect
  ws.send(JSON.stringify({ type: "session_list", sessions: getSessionList() }));

  ws.on("message", (raw) => {
    const msg = raw.toString("utf8");

    // Try JSON control message
    if (msg.startsWith("{")) {
      try {
        const parsed = JSON.parse(msg);

        if (parsed.type === "attach") {
          // Detach from current session
          detachClient(ws);

          // Create or get session
          const name = parsed.session || "main";
          const cols = parsed.cols || 80;
          const rows = parsed.rows || 24;
          ws._remuxCols = cols;
          ws._remuxRows = rows;

          const session = createSession(name, cols, rows);
          ws._remuxSession = name;
          attachClient(session, ws, cols, rows);

          ws.send(JSON.stringify({ type: "attached", session: name }));
          broadcastSessionList();
          return;
        }

        if (parsed.type === "resize") {
          ws._remuxCols = parsed.cols;
          ws._remuxRows = parsed.rows;
          const session = sessionMap.get(ws._remuxSession);
          if (session) recalcSize(session);
          return;
        }

        if (parsed.type === "delete_session") {
          const name = parsed.name;
          if (name && name !== ws._remuxSession) {
            deleteSession(name);
            broadcastSessionList();
          }
          return;
        }

        return;
      } catch { /* not JSON, fall through to PTY write */ }
    }

    // Raw terminal input → PTY
    const session = sessionMap.get(ws._remuxSession);
    if (session && !session.ended) {
      session.pty.write(msg);
    }
  });

  ws.on("close", () => {
    detachClient(ws);
    controlClients.delete(ws);
  });

  ws.on("error", () => {});
});

// ── Start ──────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`\n  Remux running at http://localhost:${PORT}\n`);
});

process.on("SIGINT", () => {
  for (const [, session] of sessionMap) {
    if (!session.ended) session.pty.kill();
  }
  process.exit(0);
});

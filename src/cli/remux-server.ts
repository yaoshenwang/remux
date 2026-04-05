/**
 * Remux server -- ghostty-web terminal with session management.
 * Adapted from coder/ghostty-web demo (MIT) + tsm session patterns.
 */

import fs from "fs";
import http from "http";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import qrcode from "qrcode-terminal";
import {
  resolveAuth,
  generateToken,
  validateToken,
  addPasswordToken,
  passwordTokens,
  PASSWORD_PAGE,
} from "../domain/auth/auth-service.js";
import { initGhosttyVt } from "../runtime/vt-snapshot.js";
import { getDb, closeDb } from "../persistence/store.js";
import { initPush } from "../integrations/push/push-service.js";
import {
  sessionMap,
  createSession,
  createTab,
  persistSessions,
  restoreSessions,
  PERSIST_INTERVAL_MS,
  createRestoredTab,
  findAliveDaemonSocket,
  reattachToDaemon,
} from "../runtime/session-runtime.js";
import { setupWebSocket } from "../gateway/ws/websocket-server.js";
import { adapterRegistry, initAdapterRuntime } from "../integrations/adapters/runtime.js";
import { initGitService } from "../integrations/git/git-service.js";
import {
  parseTunnelArgs,
  isCloudflaredAvailable,
  startTunnel,
  buildTunnelAccessUrl,
} from "../integrations/tunnel/tunnel-service.js";
import type { ChildProcess } from "child_process";
import { handleServiceCommand } from "../integrations/macos/launchd-service.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Service subcommand (must run before any heavy init) ─────────
if (handleServiceCommand(process.argv)) {
  process.exit(0);
}

const require = createRequire(import.meta.url);
const PKG = JSON.parse(
  fs.readFileSync(path.join(__dirname, "package.json"), "utf8"),
);
const VERSION = PKG.version;
const PORT = process.env.PORT || 8767;

// ── Authentication ───────────────────────────────────────────────
const { TOKEN, PASSWORD } = resolveAuth(process.argv);

// ── Tunnel ───────────────────────────────────────────────────────
const { tunnelMode } = parseTunnelArgs(process.argv);
let tunnelProcess: ChildProcess | null = null;

// ── Locate ghostty-web assets ────────────────────────────────────

function findGhosttyWeb(): { distPath: string; wasmPath: string } {
  const ghosttyWebMain = require.resolve("ghostty-web");
  const ghosttyWebRoot = ghosttyWebMain.replace(/[/\\]dist[/\\].*$/, "");
  const distPath = path.join(ghosttyWebRoot, "dist");
  const wasmPath = path.join(ghosttyWebRoot, "ghostty-vt.wasm");
  if (
    fs.existsSync(path.join(distPath, "ghostty-web.js")) &&
    fs.existsSync(wasmPath)
  ) {
    return { distPath, wasmPath };
  }
  console.error("Error: ghostty-web package not found.");
  process.exit(1);
}

const { distPath, wasmPath } = findGhosttyWeb();

// ── Startup: init WASM, restore sessions, create default ─────────

let startupDone = false;

async function startup(): Promise<void> {
  // Initialize SQLite store (creates tables if needed)
  getDb();

  // Initialize Web Push (loads or generates VAPID keys)
  initPush();

  await initGhosttyVt(wasmPath);

  // Try restoring saved sessions
  const saved = restoreSessions();
  if (saved && saved.sessions.length > 0) {
    for (const s of saved.sessions) {
      const session = createSession(s.name);
      // Restore tabs — check for alive daemons first, then fall back to restored mode
      for (const t of s.tabs) {
        if (t.ended) continue;

        // Check if a daemon is still alive for this tab
        const daemonSocket = findAliveDaemonSocket(t.id);
        const restoredTab = createRestoredTab(session, t);

        if (daemonSocket) {
          // Daemon is alive — try to reattach
          reattachToDaemon(restoredTab, session, daemonSocket).catch(() => {
            console.log(`[startup] daemon reattach failed for tab ${t.id}, staying in restored mode`);
          });
        }
        // If no daemon found, tab stays in restored-readonly mode
        // User will see scrollback + banner prompting to press Enter
      }
      // If all tabs were ended, create a fresh one
      if (session.tabs.length === 0) createTab(session);
    }
  }

  // If no sessions were restored, create an initial one.
  // The name "default" is not privileged — it's just the bootstrap name.
  if (sessionMap.size === 0) {
    const s = createSession("default");
    createTab(s);
  }

  // Persistence timer (8s, like cmux)
  setInterval(persistSessions, PERSIST_INTERVAL_MS);

  // Initialize git service (E11)
  initGitService();

  // Initialize adapter registry (E10)
  initAdapterRuntime();

  startupDone = true;
}

startup().catch((e) => {
  console.error("[startup] fatal:", e);
  // Fallback: create default session without VT tracking
  if (sessionMap.size === 0) {
    const s = createSession("default");
    createTab(s);
  }
  startupDone = true;
});


// ── HTML Template (Emergency Mode) ──────────────────────────────
// Read-only terminal display + compose input. No raw keyboard input.

const HTML_TEMPLATE = `<!doctype html>
<html lang="en" data-theme="dark">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <title>Remux</title>
    <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>⬛</text></svg>">
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

      .session-composer { display: none; padding: 0 6px 8px; gap: 6px; }
      .session-composer.visible { display: flex; }
      .session-composer input { flex: 1; min-width: 0; padding: 6px 8px; font-size: 12px; font-family: inherit;
        background: var(--compose-bg); border: 1px solid var(--compose-border); border-radius: 4px;
        color: var(--text-bright); outline: none; }
      .session-composer input:focus { border-color: var(--accent); }
      .session-composer button { padding: 6px 10px; font-size: 11px; font-family: inherit;
        border-radius: 4px; border: 1px solid var(--compose-border); cursor: pointer; }
      .session-composer button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
      .session-composer button.secondary { background: var(--compose-bg); color: var(--text-bright); }

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
        display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      .sidebar-footer .version { font-size: 10px; color: var(--text-dim); }

      .status-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--text-muted); flex-shrink: 0; }
      .status-dot.connected { background: var(--dot-ok); }
      .status-dot.disconnected { background: var(--dot-err); }
      .status-dot.connecting { background: var(--dot-warn); animation: pulse 1s infinite; }
      @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.5} }

      /* -- Theme toggle -- */
      .theme-toggle { background: none; border: none; cursor: pointer; font-size: 16px;
        color: var(--text-muted); padding: 4px 8px; border-radius: 4px; }
      .theme-toggle:hover { color: var(--text-bright); background: var(--bg-hover); }

      /* -- Main -- */
      .main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
      .main-toolbar { display: flex; align-items: center; gap: 8px; padding: 6px 10px;
        border-bottom: 1px solid var(--border); background: var(--bg); min-height: 40px; }
      .main-toolbar .toolbar-spacer { flex: 1; }

      /* -- Tab bar -- */
      .tab-bar { background: var(--bg-tab-bar); display: flex; align-items: flex-end; flex-shrink: 0;
        min-height: 36px; position: relative; z-index: 101; }
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

      /* -- Terminal (read-only) -- */
      #terminal { flex: 1; background: var(--bg); overflow: hidden; position: relative; }
      #terminal canvas { display: block; position: absolute; top: 0; left: 0; }

      /* -- Compose input -- */
      .compose-input { display: flex; background: var(--bg-sidebar); border-top: 1px solid var(--border);
        padding: 8px; gap: 6px; flex-shrink: 0; align-items: center; }
      .compose-input input { flex: 1; min-width: 0; padding: 8px 12px; font-size: 14px;
        font-family: 'Menlo','Monaco','Courier New',monospace;
        background: var(--compose-bg); border: 1px solid var(--compose-border); border-radius: 6px;
        color: var(--text-bright); outline: none; }
      .compose-input input:focus { border-color: var(--accent); }
      .compose-input .send-btn { padding: 8px 16px; font-size: 13px; font-family: inherit;
        background: var(--accent); color: #fff; border: none; border-radius: 6px;
        cursor: pointer; white-space: nowrap; flex-shrink: 0; }
      .compose-input .send-btn:hover { opacity: 0.9; }
      .compose-input .send-btn:active { opacity: 0.8; }
      .compose-input .preset-toggle { padding: 8px; font-size: 16px; background: none;
        border: 1px solid var(--compose-border); border-radius: 6px; color: var(--text-muted);
        cursor: pointer; flex-shrink: 0; line-height: 1; }
      .compose-input .preset-toggle:hover { color: var(--text-bright); background: var(--compose-bg); }
      .compose-input .preset-toggle.active { color: var(--accent); border-color: var(--accent); }

      /* -- Preset commands -- */
      .preset-bar { display: none; background: var(--bg-sidebar); border-top: 1px solid var(--border);
        padding: 6px 8px; gap: 5px; flex-shrink: 0; flex-wrap: wrap; }
      .preset-bar.visible { display: flex; }
      .preset-bar button { padding: 6px 12px; font-size: 12px;
        font-family: 'Menlo','Monaco',monospace; color: var(--text-bright); background: var(--compose-bg);
        border: 1px solid var(--compose-border); border-radius: 5px; cursor: pointer; white-space: nowrap;
        -webkit-tap-highlight-color: transparent; touch-action: manipulation;
        min-width: 36px; text-align: center; user-select: none; }
      .preset-bar button:active { background: var(--compose-border); }

      /* -- Mobile -- */
      @media (max-width: 768px) {
        .sidebar { position: fixed; left: 0; top: 0; bottom: 0; z-index: 100;
          width: 260px; margin-left: 0; transform: translateX(-100%); box-shadow: none;
          transition: transform .2s ease, box-shadow .2s ease; overflow-y: auto; }
        .sidebar.open { transform: translateX(0); box-shadow: 4px 0 20px rgba(0,0,0,.5); }
        .sidebar-overlay { display: none; position: fixed; inset: 0;
          background: rgba(0,0,0,.4); z-index: 99; pointer-events: none; }
        .sidebar-overlay.visible { display: block; pointer-events: auto; }
        .main { margin-left: 0 !important; width: 100vw; min-width: 0; }
        .tab-bar { overflow-x: auto; }
        .session-item { min-height: 44px; }
        .tab { min-height: 36px; }
        .main-toolbar { padding-left: 8px; padding-right: 8px; }
        .compose-input input { font-size: 16px; } /* prevent iOS zoom on focus */
      }

      @media (hover: none), (pointer: coarse) {
        .session-item .del,
        .tab .close {
          opacity: 1;
        }
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
      <div class="session-composer" id="session-composer">
        <input type="text" id="new-session-input" placeholder="New session name" />
        <button class="primary" id="btn-create-session">Add</button>
        <button class="secondary" id="btn-cancel-session">Cancel</button>
      </div>
      <div class="session-list" id="session-list"></div>

      <div class="sidebar-footer">
        <div class="version">v${VERSION}</div>
      </div>
    </aside>
    <div class="main">
      <div class="tab-bar">
        <button class="tab-toggle" id="btn-sidebar" title="Toggle sidebar">&#9776;</button>
        <div class="tab-list" id="tab-list"></div>
        <button class="tab-new" id="btn-new-tab" title="New tab">+</button>
      </div>
      <div class="main-toolbar">
        <div class="status">
          <div class="status-dot connecting" id="status-dot"></div>
          <span id="status-text">Connecting...</span>
        </div>
        <div class="toolbar-spacer"></div>
        <button id="btn-theme" class="theme-toggle" title="Toggle theme">&#9728;</button>
      </div>
      <div id="terminal"></div>
      <div class="preset-bar" id="preset-bar">
        <button data-seq="ctrl-c">Ctrl+C</button>
        <button data-seq="ctrl-d">Ctrl+D</button>
        <button data-seq="ctrl-z">Ctrl+Z</button>
        <button data-seq="ctrl-l">Ctrl+L</button>
        <button data-seq="up">&#8593;</button>
        <button data-seq="down">&#8595;</button>
        <button data-seq="tab">Tab</button>
        <button data-seq="esc">Esc</button>
      </div>
      <div class="compose-input" id="compose-input">
        <button class="preset-toggle" id="btn-preset-toggle" title="Quick keys">&#9881;</button>
        <input type="text" id="cmd-input" placeholder="Type command..." autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" />
        <button class="send-btn" id="btn-send">Send</button>
      </div>
    </div>

    <script type="module">
      import { init, Terminal, FitAddon } from '/dist/ghostty-web.js';
      await init();

      const THEMES = {
        dark: {
          background: '#1e1e1e', foreground: '#d4d4d4', cursor: '#ffffff',
          cursorAccent: '#1e1e1e', selectionBackground: '#264f78', selectionForeground: '#ffffff',
          black: '#000000', red: '#cd3131', green: '#0dbc79', yellow: '#e5e510',
          blue: '#2472c8', magenta: '#bc3fbc', cyan: '#11a8cd', white: '#e5e5e5',
          brightBlack: '#666666', brightRed: '#f14c4c', brightGreen: '#23d18b',
          brightYellow: '#f5f543', brightBlue: '#3b8eea', brightMagenta: '#d670d6',
          brightCyan: '#29b8db', brightWhite: '#ffffff',
        },
        light: {
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

      let term, fitAddon, fitObserver = null, fitSettleTimer = null;
      function createTerminal(themeMode) {
        const container = document.getElementById('terminal');
        if (fitObserver) { fitObserver.disconnect(); fitObserver = null; }
        if (fitSettleTimer) { clearTimeout(fitSettleTimer); fitSettleTimer = null; }
        if (term) { term.dispose(); container.innerHTML = ''; }
        term = window._remuxTerm = new Terminal({ cols: 80, rows: 24,
          fontFamily: 'Menlo, Monaco, "Courier New", monospace',
          fontSize: 14, cursorBlink: false,
          theme: THEMES[themeMode] || THEMES.dark,
          scrollback: 10000,
          disableStdin: true });
        fitAddon = new FitAddon();
        term.loadAddon(fitAddon);
        term.open(container);
        fitObserver = new ResizeObserver(() => safeFit());
        fitObserver.observe(container);
        safeFit();
        fitSettleTimer = setTimeout(() => { fitSettleTimer = null; safeFit(); }, 250);
        if (document.fonts && document.fonts.ready) {
          document.fonts.ready.then(() => safeFit()).catch(() => {});
        }
        return term;
      }

      let fitDebounceTimer = null;
      function safeFit() { if (fitAddon) fitAddon.fit(); }
      function stabilizeFit() {
        safeFit();
        if (fitSettleTimer) clearTimeout(fitSettleTimer);
        fitSettleTimer = setTimeout(() => { fitSettleTimer = null; safeFit(); }, 250);
      }
      function syncTouchViewportHeight() {
        if (!window.visualViewport) return;
        const vh = window.visualViewport.height;
        if (vh > 0) document.body.style.height = vh + 'px';
        clearTimeout(fitDebounceTimer);
        fitDebounceTimer = setTimeout(safeFit, 100);
      }
      window.addEventListener('resize', safeFit);
      createTerminal(initTheme);

      let sessions = [], currentSession = null, currentTabId = null, ws = null;
      let myClientId = null, clientsList = [];

      const $ = id => document.getElementById(id);
      const esc = t => (t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      const setStatus = (s, t) => { $('status-dot').className = 'status-dot ' + s; $('status-text').textContent = t; };

      // -- Theme switching --
      function setTheme(mode) {
        document.documentElement.setAttribute('data-theme', mode);
        localStorage.setItem('remux-theme', mode);
        $('btn-theme').innerHTML = mode === 'dark' ? '&#9728;' : '&#9790;';
        createTerminal(mode);
        term.onResize(({ cols, rows }) => sendCtrl({ type: 'resize', cols, rows }));
        if (currentTabId != null) {
          sendCtrl({ type: 'attach_tab', tabId: currentTabId, cols: term.cols, rows: term.rows });
        }
      }
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
          sidebar.classList.remove('collapsed');
          sidebar.classList.toggle('open');
          overlay.classList.toggle('visible', sidebar.classList.contains('open'));
        } else { sidebar.classList.toggle('collapsed'); }
        setTimeout(stabilizeFit, 250);
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
          const el = document.createElement('div');
          el.className = 'session-item' + (s.name === currentSession ? ' active' : '');
          el.tabIndex = 0;
          el.setAttribute('role', 'button');
          const live = s.tabs.filter(t => !t.ended).length;
          el.innerHTML = '<span class="dot"></span><span class="name">' + esc(s.name)
            + '</span><span class="count">' + live + '</span>'
            + '<button class="del" data-del="' + esc(s.name) + '">\\u00d7</button>';
          el.addEventListener('pointerdown', e => {
            if (e.target.dataset.del) {
              e.stopPropagation(); e.preventDefault();
              sendCtrl({ type: 'delete_session', name: e.target.dataset.del });
              if (e.target.dataset.del === currentSession) {
                const other = sessions.find(x => x.name !== currentSession);
                if (other) { selectSession(other.name); }
                else { currentSession = null; sendCtrl({ type: 'attach_first', cols: term.cols, rows: term.rows }); }
              }
              return;
            }
            e.preventDefault();
            selectSession(s.name);
            closeSidebarMobile();
          });
          el.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectSession(s.name); closeSidebarMobile(); }
          });
          list.appendChild(el);
        });
      }

      // -- Render tabs --
      function renderTabs() {
        const list = $('tab-list'); list.innerHTML = '';
        const sess = sessions.find(s => s.name === currentSession);
        if (!sess) return;
        sess.tabs.forEach(t => {
          const el = document.createElement('div');
          el.className = 'tab' + (t.id === currentTabId ? ' active' : '');
          el.tabIndex = 0;
          el.setAttribute('role', 'button');
          const clientCount = t.clients || 0;
          const countBadge = clientCount > 1 ? '<span class="client-count">' + clientCount + '</span>' : '';
          el.innerHTML = '<span class="title">' + esc(t.title) + '</span>' + countBadge
            + '<button class="close" data-close="' + t.id + '">\\u00d7</button>';
          el.addEventListener('pointerdown', e => {
            const closeId = e.target.dataset.close ?? e.target.closest('[data-close]')?.dataset.close;
            if (closeId != null) { e.stopPropagation(); e.preventDefault(); closeTab(Number(closeId)); return; }
            e.preventDefault();
            if (t.id !== currentTabId) attachTab(t.id);
          });
          el.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (t.id !== currentTabId) attachTab(t.id); }
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
        term.reset();
        sendCtrl({ type: 'attach_tab', tabId, cols: term.cols, rows: term.rows });
        stabilizeFit();
        renderTabs(); renderSessions();
      }

      function closeTab(tabId) {
        const sess = sessions.find(s => s.name === currentSession);
        if (!sess) return;
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
      function openSessionComposer() {
        $('session-composer').classList.add('visible');
        $('new-session-input').focus();
        $('new-session-input').select();
      }
      function closeSessionComposer() {
        $('session-composer').classList.remove('visible');
        $('new-session-input').value = '';
      }
      $('btn-new-session').addEventListener('pointerdown', e => { e.preventDefault(); openSessionComposer(); });
      $('btn-create-session').addEventListener('click', () => {
        const name = $('new-session-input').value.trim();
        if (!name) return;
        sendCtrl({ type: 'new_session', name, cols: term.cols, rows: term.rows });
        closeSessionComposer();
      });
      $('btn-cancel-session').addEventListener('click', closeSessionComposer);
      $('new-session-input').addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); $('btn-create-session').click(); }
        else if (e.key === 'Escape') { e.preventDefault(); closeSessionComposer(); }
      });

      // -- E2EE client (Web Crypto API) --
      const e2ee = {
        established: false, sendCounter: 0n, recvCounter: -1n,
        localKeyPair: null, sharedKey: null,
        available: !!(crypto && crypto.subtle),
        async init() {
          if (!this.available) return;
          try {
            const kp = await crypto.subtle.generateKey('X25519', false, ['deriveBits']);
            const rawPub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
            this.localKeyPair = { publicKey: kp.publicKey, privateKey: kp.privateKey, rawPublic: rawPub };
          } catch (e) { this.available = false; }
        },
        getPublicKeyB64() {
          if (!this.localKeyPair) return null;
          return btoa(String.fromCharCode(...this.localKeyPair.rawPublic));
        },
        async completeHandshake(peerPubKeyB64) {
          if (!this.localKeyPair) return;
          try {
            const peerRaw = Uint8Array.from(atob(peerPubKeyB64), c => c.charCodeAt(0));
            const peerKey = await crypto.subtle.importKey('raw', peerRaw, 'X25519', false, []);
            const rawBits = await crypto.subtle.deriveBits({ name: 'X25519', public: peerKey }, this.localKeyPair.privateKey, 256);
            const hkdfKey = await crypto.subtle.importKey('raw', rawBits, 'HKDF', false, ['deriveBits']);
            const derived = await crypto.subtle.deriveBits(
              { name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('remux-e2ee-v1'), info: new TextEncoder().encode('aes-256-gcm') }, hkdfKey, 256);
            this.sharedKey = await crypto.subtle.importKey('raw', derived, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
            this.established = true; this.sendCounter = 0n; this.recvCounter = -1n;
          } catch (e) { this.available = false; }
        },
        async encryptMessage(plaintext) {
          if (!this.sharedKey) throw new Error('E2EE not established');
          const iv = new Uint8Array(12); crypto.getRandomValues(iv.subarray(0, 4));
          new DataView(iv.buffer, iv.byteOffset + 4, 8).setBigUint64(0, this.sendCounter, false);
          this.sendCounter++;
          const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, this.sharedKey, new TextEncoder().encode(plaintext));
          const result = new Uint8Array(12 + encrypted.byteLength);
          result.set(iv, 0); result.set(new Uint8Array(encrypted), 12);
          return btoa(String.fromCharCode(...result));
        },
        async decryptMessage(encryptedB64) {
          if (!this.sharedKey) throw new Error('E2EE not established');
          const packed = Uint8Array.from(atob(encryptedB64), c => c.charCodeAt(0));
          if (packed.length < 28) throw new Error('E2EE message too short');
          const iv = packed.subarray(0, 12);
          const counter = new DataView(iv.buffer, iv.byteOffset + 4, 8).getBigUint64(0, false);
          if (counter <= this.recvCounter) throw new Error('E2EE replay detected');
          const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, tagLength: 128 }, this.sharedKey, packed.subarray(12));
          this.recvCounter = counter;
          return new TextDecoder().decode(decrypted);
        }
      };

      // -- WebSocket with exponential backoff + heartbeat --
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const urlToken = new URLSearchParams(location.search).get('token');
      let backoffMs = 1000;
      const BACKOFF_MAX = 30000;
      let reconnectTimer = null;
      const HEARTBEAT_TIMEOUT = 45000;
      let lastMessageAt = Date.now();
      let heartbeatChecker = null;
      let lastReceivedTimestamp = 0;
      let isResuming = false;

      function startHeartbeat() {
        lastMessageAt = Date.now();
        if (heartbeatChecker) clearInterval(heartbeatChecker);
        heartbeatChecker = setInterval(() => {
          if (Date.now() - lastMessageAt > HEARTBEAT_TIMEOUT) { if (ws) ws.close(); }
        }, 5000);
      }
      function stopHeartbeat() { if (heartbeatChecker) { clearInterval(heartbeatChecker); heartbeatChecker = null; } }

      function scheduleReconnect() {
        if (reconnectTimer) return;
        const delay = backoffMs;
        let remaining = Math.ceil(delay / 1000);
        setStatus('disconnected', 'Reconnecting in ' + remaining + 's...');
        const countdown = setInterval(() => { remaining--; if (remaining > 0) setStatus('disconnected', 'Reconnecting in ' + remaining + 's...'); }, 1000);
        reconnectTimer = setTimeout(() => {
          clearInterval(countdown); reconnectTimer = null;
          backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX);
          connect();
        }, delay);
      }

      function connect() {
        setStatus('connecting', 'Connecting...');
        e2ee.established = false; e2ee.sharedKey = null;
        ws = new WebSocket(proto + '//' + location.host + '/ws');
        ws.onopen = async () => {
          backoffMs = 1000;
          startHeartbeat();
          if (urlToken) {
            if (!localStorage.getItem('remux-device-id')) {
              localStorage.setItem('remux-device-id', Math.random().toString(36).slice(2, 10) + Date.now().toString(36));
            }
            ws.send(JSON.stringify({ type: 'auth', token: urlToken, deviceId: localStorage.getItem('remux-device-id') }));
          }
          if (e2ee.available) {
            await e2ee.init();
            const pubKey = e2ee.getPublicKeyB64();
            if (pubKey) ws.send(JSON.stringify({ v: 1, type: 'e2ee_init', payload: { publicKey: pubKey } }));
          }
          const deviceId = localStorage.getItem('remux-device-id');
          if (lastReceivedTimestamp > 0 && deviceId) {
            isResuming = true;
            setStatus('connecting', 'Resuming session...');
            sendCtrl({ type: 'resume', deviceId, lastTimestamp: lastReceivedTimestamp });
          }
          sendCtrl({ type: 'attach_first', session: currentSession || undefined, cols: term.cols, rows: term.rows });
        };
        ws.onmessage = e => {
          lastMessageAt = Date.now();
          if (typeof e.data === 'string' && e.data[0] === '{') {
            try {
              const parsed = JSON.parse(e.data);
              const msg = parsed.v === 1 ? { ...(parsed.payload || {}), type: parsed.type } : parsed;
              if (msg.type === 'ping') return;
              if (msg.type === 'e2ee_init') { if (msg.publicKey && e2ee.available && e2ee.localKeyPair) e2ee.completeHandshake(msg.publicKey); return; }
              if (msg.type === 'e2ee_ready') return;
              if (msg.type === 'e2ee_msg') {
                if (e2ee.established && msg.data) e2ee.decryptMessage(msg.data).then(d => term.write(d)).catch(() => {});
                return;
              }
              if (msg.type === 'resume_complete') { isResuming = false; return; }
              lastReceivedTimestamp = Date.now();
              if (msg.type === 'auth_ok') return;
              if (msg.type === 'bootstrap') { sessions = msg.sessions || []; clientsList = msg.clients || []; renderSessions(); renderTabs(); stabilizeFit(); return; }
              if (msg.type === 'auth_error') { setStatus('disconnected', 'Auth failed'); ws.close(); return; }
              if (msg.type === 'error') { alert('Error: ' + (msg.reason || 'unknown error')); return; }
              if (msg.type === 'state') { sessions = msg.sessions || []; clientsList = msg.clients || []; renderSessions(); renderTabs(); stabilizeFit(); return; }
              if (msg.type === 'attached') {
                currentTabId = msg.tabId; currentSession = msg.session;
                if (msg.clientId) myClientId = msg.clientId;
                setStatus('connected', 'Connected'); renderSessions(); renderTabs(); stabilizeFit(); return;
              }
              if (msg.type === 'role_changed' || msg.type === 'inspect_result') return;
              if (parsed.v === 1) return;
            } catch {}
          }
          term.write(e.data);
        };
        ws.onclose = () => { stopHeartbeat(); scheduleReconnect(); };
        ws.onerror = () => setStatus('disconnected', 'Error');
      }
      connect();
      function sendCtrl(msg) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); }
      function sendTermData(data) {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        if (e2ee.established) {
          e2ee.encryptMessage(data).then(encrypted => {
            if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ v: 1, type: 'e2ee_msg', payload: { data: encrypted } }));
          }).catch(() => { ws.send(data); });
        } else { ws.send(data); }
      }

      // -- Terminal resize (read-only, no keyboard input) --
      term.onResize(({ cols, rows }) => sendCtrl({ type: 'resize', cols, rows }));

      // -- Compose input: text field + send --
      const cmdInput = $('cmd-input');
      function sendCommand() {
        const cmd = cmdInput.value;
        if (!cmd) return;
        sendTermData(cmd + '\\n');
        cmdInput.value = '';
        cmdInput.focus();
      }
      $('btn-send').addEventListener('click', sendCommand);
      cmdInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); sendCommand(); }
      });

      // -- Preset quick keys --
      const SEQ = {
        esc: '\\x1b', tab: '\\t',
        up: '\\x1b[A', down: '\\x1b[B',
        'ctrl-c': '\\x03', 'ctrl-d': '\\x04', 'ctrl-z': '\\x1a', 'ctrl-l': '\\x0c',
      };
      $('btn-preset-toggle').addEventListener('click', () => {
        const bar = $('preset-bar');
        const btn = $('btn-preset-toggle');
        bar.classList.toggle('visible');
        btn.classList.toggle('active', bar.classList.contains('visible'));
        setTimeout(stabilizeFit, 50);
      });
      $('preset-bar').addEventListener('pointerdown', e => {
        const btn = e.target.closest('button'); if (!btn) return;
        e.preventDefault();
        const d = SEQ[btn.dataset.seq];
        if (d) sendTermData(d);
        cmdInput.focus();
      });

      // -- Tab rename (double-click) --
      $('tab-list').addEventListener('dblclick', e => {
        const tabEl = e.target.closest('.tab');
        if (!tabEl) return;
        const titleSpan = tabEl.querySelector('.title');
        if (!titleSpan) return;
        const closeBtn = tabEl.querySelector('.close');
        if (!closeBtn) return;
        const tabId = Number(closeBtn.dataset.close);
        const oldTitle = titleSpan.textContent;
        const input = document.createElement('input');
        input.className = 'rename-input';
        input.value = oldTitle;
        input.setAttribute('maxlength', '32');
        titleSpan.replaceWith(input);
        input.focus(); input.select();
        function commit() {
          const newTitle = input.value.trim() || oldTitle;
          if (newTitle !== oldTitle) sendCtrl({ type: 'rename_tab', tabId, title: newTitle });
          const span = document.createElement('span'); span.className = 'title'; span.textContent = newTitle;
          input.replaceWith(span);
        }
        function cancel() {
          const span = document.createElement('span'); span.className = 'title'; span.textContent = oldTitle;
          input.replaceWith(span);
        }
        input.addEventListener('keydown', ev => {
          if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
          if (ev.key === 'Escape') { ev.preventDefault(); cancel(); }
        });
        input.addEventListener('blur', commit);
      });

      // -- Mobile viewport handling --
      if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', syncTouchViewportHeight);
        window.visualViewport.addEventListener('scroll', () => window.scrollTo(0, 0));
      }
    </script>
  </body>
</html>`;
// ── Service Worker for Push Notifications ───────────────────────

const SW_SCRIPT = `self.addEventListener('push', function(event) {
  if (!event.data) return;
  try {
    var data = event.data.json();
    event.waitUntil(
      self.registration.showNotification(data.title || 'Remux', {
        body: data.body || '',
        icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">></text></svg>',
        badge: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">></text></svg>',
        tag: 'remux-' + (data.tag || 'default'),
        renotify: true,
      })
    );
  } catch (e) {
    // Fallback for non-JSON payloads
    event.waitUntil(
      self.registration.showNotification('Remux', { body: event.data.text() })
    );
  }
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      for (var i = 0; i < clientList.length; i++) {
        if (clientList[i].url.includes(self.location.origin) && 'focus' in clientList[i]) {
          return clientList[i].focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow('/');
      }
    })
  );
});
`;

// ── MIME ──────────────────────────────────────────────────────────

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".wasm": "application/wasm",
  ".css": "text/css",
  ".json": "application/json",
};

// ── HTTP Server ──────────────────────────────────────────────────

const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url!, `http://${req.headers.host}`);

  // Handle password form submission
  if (url.pathname === "/auth" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk));
    req.on("end", () => {
      const params = new URLSearchParams(body);
      const submitted = params.get("password");
      if (PASSWORD && submitted === PASSWORD) {
        // Generate a session token and redirect with it
        const sessionToken = generateToken();
        addPasswordToken(sessionToken);
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
    const isAuthed =
      (!TOKEN && !PASSWORD) || // no auth configured (impossible after auto-gen, but safe)
      (urlToken != null && validateToken(urlToken, TOKEN));

    if (!isAuthed) {
      // If password mode is active and no valid token, show login page
      if (PASSWORD) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(PASSWORD_PAGE);
        return;
      }
      res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
      res.end('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Remux</title><link rel="icon" href="data:image/svg+xml,<svg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 100 100\'><text y=\'.9em\' font-size=\'90\'>⬛</text></svg>"><style>body{font-family:-apple-system,system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#1e1e1e;color:#ccc}div{text-align:center;max-width:400px;padding:2rem}h1{font-size:1.5rem;margin:0 0 1rem}p{color:#888;line-height:1.6}code{background:#333;padding:2px 6px;border-radius:3px;font-size:0.9em}</style></head><body><div><h1>Remux</h1><p>Access requires a valid token.</p><p>Add <code>?token=YOUR_TOKEN</code> to the URL.</p></div></body></html>');
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(HTML_TEMPLATE);
    return;
  }

  if (url.pathname.startsWith("/dist/")) {
    const resolved = path.resolve(distPath, url.pathname.slice(6));
    const rel = path.relative(distPath, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    return serveFile(resolved, res);
  }

  if (url.pathname === "/ghostty-vt.wasm") {
    return serveFile(wasmPath, res);
  }

  // Service worker for push notifications
  if (url.pathname === "/sw.js") {
    res.writeHead(200, {
      "Content-Type": "application/javascript",
      "Service-Worker-Allowed": "/",
    });
    res.end(SW_SCRIPT);
    return;
  }

  res.writeHead(404);
  res.end("Not Found");
});

function serveFile(filePath: string, res: http.ServerResponse): void {
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
    });
    res.end(data);
  });
}

// ── WebSocket Server ─────────────────────────────────────────────

const wss = setupWebSocket(httpServer, TOKEN, PASSWORD);

// E10-006: broadcast adapter events to all authenticated WebSocket clients
adapterRegistry.onEvent((event) => {
  const envelope = JSON.stringify({
    v: 1,
    type: "adapter_event",
    domain: "semantic",
    emittedAt: event.timestamp,
    source: "server",
    payload: event,
  });
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      // Only send to authenticated clients (they have _remuxAuthed flag)
      if ((client as any)._remuxAuthed) {
        client.send(envelope);
      }
    }
  }
});

// ── Start ────────────────────────────────────────────────────────

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
  qrcode.generate(url, { small: true }, (code: string) => {
    console.log(code);
  });

  // -- Tunnel: launch async after server is listening --
  launchTunnel();
});

async function launchTunnel(): Promise<void> {
  if (tunnelMode === "disable") return;

  const available = await isCloudflaredAvailable();
  if (!available) {
    if (tunnelMode === "enable") {
      console.log(
        "\n  [tunnel] cloudflared not found -- install it for tunnel support",
      );
      console.log(
        "  https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/\n",
      );
    }
    return;
  }

  console.log("  [tunnel] starting cloudflare tunnel...");
  try {
    const { url: tunnelUrl, process: child } = await startTunnel(
      Number(PORT),
    );
    tunnelProcess = child;

    const accessUrl = buildTunnelAccessUrl(tunnelUrl, TOKEN, PASSWORD);
    console.log(`\n  Tunnel: ${accessUrl}\n`);

    // Print QR code for tunnel URL (great for mobile access)
    qrcode.generate(accessUrl, { small: true }, (code: string) => {
      console.log(code);
    });

    // Log if tunnel exits unexpectedly
    child.on("close", (code: number | null) => {
      if (code !== null && code !== 0) {
        console.log(`  [tunnel] cloudflared exited (code ${code})`);
      }
      tunnelProcess = null;
    });
  } catch (err: any) {
    console.log(`  [tunnel] failed to start: ${err.message}`);
    tunnelProcess = null;
  }
}

function shutdown(): void {
  try {
    persistSessions(); // save before exit
  } catch (e: any) {
    console.error("[shutdown] persist failed:", e.message);
  }
  closeDb(); // close SQLite connection
  adapterRegistry.shutdown(); // stop all adapters
  // Kill cloudflared tunnel if running
      if (tunnelProcess) {
        try {
          tunnelProcess.kill("SIGTERM");
        } catch {}
        tunnelProcess = null;
  }
  for (const session of sessionMap.values()) {
    for (const tab of session.tabs) {
      if (tab.vt) {
        tab.vt.dispose();
        tab.vt = null;
      }
      if (!tab.ended && tab.pty) tab.pty.kill();
    }
  }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

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
import { resolveAuth, generateToken, validateToken, addPasswordToken, passwordTokens, PASSWORD_PAGE } from "./auth.js";
import { initGhosttyVt } from "./vt-tracker.js";
import { getDb, closeDb } from "./store.js";
import { initPush } from "./push.js";
import {
  sessionMap,
  createSession,
  createTab,
  persistSessions,
  restoreSessions,
  PERSIST_INTERVAL_MS,
} from "./session.js";
import { setupWebSocket } from "./ws-handler.js";
import { AdapterRegistry, GenericShellAdapter, ClaudeCodeAdapter, CodexAdapter } from "./adapters/index.js";
import { initGitService } from "./git-service.js";
import {
  parseTunnelArgs,
  isCloudflaredAvailable,
  startTunnel,
  buildTunnelAccessUrl,
} from "./tunnel.js";
import type { ChildProcess } from "child_process";
import { handleServiceCommand } from "./service.js";

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
      // Restore tabs -- each tab gets a new PTY, but pre-fill scrollback with saved data
      for (const t of s.tabs) {
        if (t.ended) continue;
        const tab = createTab(session);
        tab.title = t.title || tab.title;
        if (t.scrollback) {
          // Write saved scrollback to RingBuffer and VT terminal for attach snapshot
          tab.scrollback.write(t.scrollback);
          if (tab.vt) tab.vt.consume(t.scrollback);
        }
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
  initAdapters();

  startupDone = true;
}

// ── Adapter Registry (E10) ──────────────────────────────────────
export const adapterRegistry = new AdapterRegistry();

function initAdapters(): void {
  // E10-004: generic-shell adapter (always available)
  adapterRegistry.register(new GenericShellAdapter());

  // E10-005: claude-code adapter (passive, watches events.jsonl)
  const claudeAdapter = new ClaudeCodeAdapter((event) => {
    adapterRegistry.emit(event.adapterId, event.type, event.data);
  });
  adapterRegistry.register(claudeAdapter);

  // E10-008: codex adapter (passive, watches events and terminal)
  const codexAdapter = new CodexAdapter((event) => {
    adapterRegistry.emit(event.adapterId, event.type, event.data);
  });
  adapterRegistry.register(codexAdapter);
}

startup().catch((e) => {
  console.error("[startup] fatal:", e);
  // Fallback: create default session without VT tracking
  if (sessionMap.size === 0) {
    const s = createSession("main");
    createTab(s);
  }
  startupDone = true;
});

// ── HTML Template ────────────────────────────────────────────────

const HTML_TEMPLATE = `<!doctype html>
<html lang="en" data-theme="dark">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
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
        min-height: 36px; padding: 0 0 0 0; position: relative; z-index: 101; }
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

      /* -- Workspace -- */
      #workspace { flex: 1; background: var(--bg); overflow: auto; display: none;
        padding: 12px 16px; -webkit-overflow-scrolling: touch; }
      #workspace.visible { display: block; }
      .ws-section { margin-bottom: 16px; }
      .ws-section-title { font-size: 12px; font-weight: 600; color: var(--text-muted);
        text-transform: uppercase; letter-spacing: .5px; margin-bottom: 8px;
        display: flex; align-items: center; justify-content: space-between; }
      .ws-section-title button { background: none; border: 1px solid var(--border);
        color: var(--text-muted); font-size: 11px; padding: 2px 8px; border-radius: 4px;
        cursor: pointer; font-family: inherit; }
      .ws-section-title button:hover { color: var(--text-bright); border-color: var(--text-muted); }
      .ws-empty { font-size: 12px; color: var(--text-dim); padding: 8px 0; }
      .ws-card { background: var(--bg-sidebar); border: 1px solid var(--border); border-radius: 6px;
        padding: 8px 12px; margin-bottom: 6px; }
      .ws-card-header { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
      .ws-card-title { font-size: 13px; color: var(--text-bright); font-weight: 500; flex: 1;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ws-card-meta { font-size: 10px; color: var(--text-dim); }
      .ws-card-desc { font-size: 12px; color: var(--text-muted); margin-top: 2px; }
      .ws-badge { display: inline-block; font-size: 10px; padding: 1px 6px; border-radius: 8px;
        font-weight: 500; }
      .ws-badge.running { background: #1a3a5c; color: #4da6ff; }
      .ws-badge.completed { background: #1a3c1a; color: #4dff4d; }
      .ws-badge.failed { background: #3c1a1a; color: #ff4d4d; }
      .ws-badge.pending { background: #3c3a1a; color: #ffbd2e; }
      .ws-badge.approved { background: #1a3c1a; color: #4dff4d; }
      .ws-badge.rejected { background: #3c1a1a; color: #ff4d4d; }
      .ws-badge.snapshot { background: #1a2a3c; color: #88bbdd; }
      .ws-badge.command-card { background: #2a1a3c; color: #bb88dd; }
      .ws-badge.note { background: #1a3c2a; color: #88ddbb; }
      .ws-badge.diff { background: #2a2a1a; color: #ddbb55; }
      .ws-badge.markdown { background: #1a2a2a; color: #55bbdd; }
      .ws-badge.ansi { background: #2a1a2a; color: #dd88bb; }
      .ws-card-actions { display: flex; gap: 4px; margin-top: 6px; }
      .ws-card-actions button { background: none; border: 1px solid var(--border);
        color: var(--text-muted); font-size: 11px; padding: 3px 10px; border-radius: 4px;
        cursor: pointer; font-family: inherit; }
      .ws-card-actions button:hover { color: var(--text-bright); border-color: var(--text-muted); }
      .ws-card-actions button.approve { border-color: #27c93f; color: #27c93f; }
      .ws-card-actions button.approve:hover { background: #27c93f22; }
      .ws-card-actions button.reject { border-color: #ff5f56; color: #ff5f56; }
      .ws-card-actions button.reject:hover { background: #ff5f5622; }
      .ws-card .del-topic { opacity: 0; background: none; border: none; color: var(--text-dim);
        cursor: pointer; font-size: 14px; padding: 0 4px; font-family: inherit; border-radius: 3px; }
      .ws-card:hover .del-topic { opacity: 1; }
      .ws-card .del-topic:hover { color: var(--dot-err); }

      /* -- Search bar -- */
      .ws-search { display: flex; gap: 8px; margin-bottom: 16px; }
      .ws-search input { flex: 1; padding: 6px 10px; font-size: 13px; font-family: inherit;
        background: var(--compose-bg); border: 1px solid var(--compose-border); border-radius: 6px;
        color: var(--text-bright); outline: none; }
      .ws-search input:focus { border-color: var(--accent); }
      .ws-search input::placeholder { color: var(--text-dim); }
      .ws-search-results { margin-bottom: 12px; }
      .ws-search-result { padding: 6px 10px; margin-bottom: 4px; background: var(--bg-sidebar);
        border: 1px solid var(--border); border-radius: 4px; cursor: pointer; }
      .ws-search-result:hover { border-color: var(--accent); }
      .ws-search-result .sr-type { font-size: 10px; color: var(--text-dim); text-transform: uppercase; }
      .ws-search-result .sr-title { font-size: 12px; color: var(--text-bright); }

      /* -- Notes -- */
      .ws-note { background: var(--bg-sidebar); border: 1px solid var(--border); border-radius: 6px;
        padding: 8px 12px; margin-bottom: 6px; position: relative; }
      .ws-note.pinned { border-color: var(--accent); }
      .ws-note-content { font-size: 12px; color: var(--text-bright); white-space: pre-wrap; word-break: break-word; }
      .ws-note-actions { display: flex; gap: 4px; margin-top: 4px; }
      .ws-note-actions button { background: none; border: none; color: var(--text-dim);
        font-size: 11px; cursor: pointer; padding: 2px 6px; border-radius: 3px; font-family: inherit; }
      .ws-note-actions button:hover { color: var(--text-bright); background: var(--bg-hover); }
      .ws-note-input { display: flex; gap: 6px; margin-bottom: 8px; }
      .ws-note-input input { flex: 1; padding: 6px 10px; font-size: 12px; font-family: inherit;
        background: var(--compose-bg); border: 1px solid var(--compose-border); border-radius: 4px;
        color: var(--text-bright); outline: none; }
      .ws-note-input input:focus { border-color: var(--accent); }
      .ws-note-input button { padding: 4px 12px; font-size: 12px; font-family: inherit;
        background: var(--accent); color: #fff; border: none; border-radius: 4px; cursor: pointer; }

      /* -- Commands -- */
      .ws-cmd { background: var(--bg-sidebar); border: 1px solid var(--border); border-radius: 6px;
        padding: 6px 12px; margin-bottom: 4px; display: flex; align-items: center; gap: 8px; }
      .ws-cmd-text { font-size: 12px; color: var(--text-bright); font-family: 'Menlo','Monaco',monospace;
        flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ws-cmd-exit { font-size: 11px; font-weight: 600; }
      .ws-cmd-exit.ok { color: #27c93f; }
      .ws-cmd-exit.err { color: #ff5f56; }
      .ws-cmd-meta { font-size: 10px; color: var(--text-dim); white-space: nowrap; }

      /* -- Handoff -- */
      .ws-handoff { background: var(--bg-sidebar); border: 1px solid var(--border); border-radius: 6px;
        padding: 12px; margin-bottom: 12px; display: none; }
      .ws-handoff.visible { display: block; }
      .ws-handoff-section { margin-bottom: 8px; }
      .ws-handoff-label { font-size: 11px; color: var(--text-dim); text-transform: uppercase;
        letter-spacing: .5px; margin-bottom: 4px; }
      .ws-handoff-list { font-size: 12px; color: var(--text-muted); padding-left: 12px; }
      .ws-handoff-list li { margin-bottom: 2px; }

      /* -- Rich content rendering (diff, markdown, ANSI) -- */
      .ws-card-content { margin-top: 6px; font-size: 12px; max-height: 200px; overflow: auto;
        border-top: 1px solid var(--border); padding-top: 6px; }
      .ws-card-content.expanded { max-height: none; }
      .ws-card-toggle { font-size: 11px; color: var(--text-dim); background: none; border: none;
        cursor: pointer; padding: 2px 6px; font-family: inherit; border-radius: 3px; }
      .ws-card-toggle:hover { color: var(--text-bright); background: var(--bg-hover); }

      /* Diff */
      .diff-container { font-family: 'Menlo','Monaco','Courier New',monospace; font-size: 11px;
        line-height: 1.5; overflow-x: auto; }
      .diff-container > div { padding: 0 8px; white-space: pre; }
      .diff-add { background: #1a3a1a; color: #4eff4e; }
      .diff-del { background: #3a1a1a; color: #ff4e4e; }
      .diff-hunk { color: #6a9eff; font-style: italic; }
      .diff-header { color: #888; font-style: italic; }
      .diff-ctx { color: var(--text-muted); }
      .diff-line-num { display: inline-block; width: 32px; text-align: right; margin-right: 8px;
        color: var(--text-dim); user-select: none; }

      /* Markdown */
      .rendered-md { font-size: 13px; line-height: 1.6; color: var(--text-bright); }
      .rendered-md h1 { font-size: 18px; margin: 0.5em 0 0.3em; border-bottom: 1px solid var(--border); padding-bottom: 4px; }
      .rendered-md h2 { font-size: 15px; margin: 0.5em 0 0.3em; }
      .rendered-md h3 { font-size: 13px; margin: 0.5em 0 0.3em; font-weight: 600; }
      .rendered-md p { margin: 0.4em 0; }
      .rendered-md code { background: #2a2a2a; padding: 2px 6px; border-radius: 3px;
        font-family: 'Menlo','Monaco',monospace; font-size: 11px; }
      .rendered-md pre { background: #1e1e1e; padding: 12px; border-radius: 6px;
        overflow-x: auto; margin: 0.4em 0; }
      .rendered-md pre code { background: none; padding: 0; font-size: 11px; }
      .rendered-md blockquote { border-left: 3px solid #555; padding-left: 12px; color: #aaa;
        margin: 0.4em 0; }
      .rendered-md ul, .rendered-md ol { padding-left: 20px; margin: 0.3em 0; }
      .rendered-md li { margin: 0.15em 0; }
      .rendered-md a { color: var(--accent); text-decoration: none; }
      .rendered-md a:hover { text-decoration: underline; }
      .rendered-md hr { border: none; border-top: 1px solid var(--border); margin: 0.5em 0; }
      .rendered-md strong { color: var(--text-on-active); }

      /* ANSI */
      .ansi-bold { font-weight: bold; }
      .ansi-dim { opacity: 0.6; }
      .ansi-italic { font-style: italic; }
      .ansi-underline { text-decoration: underline; }

      /* Light theme overrides */
      [data-theme="light"] .diff-add { background: #e6ffec; color: #1a7f37; }
      [data-theme="light"] .diff-del { background: #ffebe9; color: #cf222e; }
      [data-theme="light"] .diff-hunk { color: #0969da; }
      [data-theme="light"] .diff-header { color: #6e7781; }
      [data-theme="light"] .diff-ctx { color: #57606a; }
      [data-theme="light"] .rendered-md code { background: #eee; }
      [data-theme="light"] .rendered-md pre { background: #f6f8fa; }
      [data-theme="light"] .rendered-md blockquote { border-left-color: #ccc; color: #666; }

      #inspect-content { font-family: 'Menlo','Monaco','Courier New',monospace; font-size: 13px;
        line-height: 1.5; color: var(--text-bright); white-space: pre-wrap; word-break: break-all;
        tab-size: 8; user-select: text; -webkit-user-select: text; }
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

      /* -- Devices section -- */
      .devices-section { border-top: 1px solid var(--border); }
      .devices-header { padding: 8px 12px; font-size: 11px; font-weight: 600; color: var(--text-muted);
        text-transform: uppercase; letter-spacing: .5px; cursor: pointer; display: flex;
        align-items: center; justify-content: space-between; user-select: none; }
      .devices-header:hover { color: var(--text-bright); }
      .devices-toggle { font-size: 8px; transition: transform .2s; }
      .devices-toggle.collapsed { transform: rotate(-90deg); }
      .devices-list { padding: 2px 6px; max-height: 200px; overflow-y: auto; }
      .devices-list.collapsed { display: none; }
      .device-item { display: flex; align-items: center; gap: 6px; padding: 5px 8px; border-radius: 4px;
        font-size: 12px; color: var(--text); }
      .device-item:hover { background: var(--bg-hover); }
      .device-item .device-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
      .device-dot.trusted { background: var(--dot-ok); }
      .device-dot.untrusted { background: var(--dot-warn); }
      .device-dot.blocked { background: var(--dot-err); }
      .device-item .device-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .device-item .device-self { font-size: 9px; color: var(--accent); margin-left: 2px; }
      .device-item .device-actions { display: flex; gap: 2px; opacity: 0; }
      .device-item:hover .device-actions { opacity: 1; }
      .device-actions button { background: none; border: none; color: var(--text-dim); cursor: pointer;
        font-size: 11px; padding: 1px 4px; border-radius: 3px; font-family: inherit; }
      .device-actions button:hover { color: var(--text-bright); background: var(--compose-bg); }
      .devices-actions { padding: 4px 12px 8px; }
      .pair-btn { width: 100%; padding: 5px 8px; font-size: 11px; font-family: inherit;
        color: var(--text-bright); background: var(--compose-bg); border: 1px solid var(--compose-border);
        border-radius: 4px; cursor: pointer; margin-bottom: 4px; }
      .pair-btn:hover { background: var(--compose-border); }
      .pair-code-display { text-align: center; padding: 6px; }
      .pair-code { font-family: 'Menlo','Monaco',monospace; font-size: 24px; font-weight: bold;
        color: var(--accent); letter-spacing: 4px; }
      .pair-expires { display: block; font-size: 10px; color: var(--text-dim); margin-top: 2px; }
      .pair-input-area { display: flex; gap: 4px; }
      .pair-input-area input { flex: 1; padding: 5px 8px; font-size: 13px; font-family: 'Menlo','Monaco',monospace;
        background: var(--bg); border: 1px solid var(--compose-border); border-radius: 4px;
        color: var(--text); outline: none; text-align: center; letter-spacing: 2px; }
      .pair-input-area input:focus { border-color: var(--accent); }
      .pair-input-area .pair-btn { width: auto; }

      /* -- Push notification section -- */
      .push-section { padding: 4px 12px 8px; border-top: 1px solid var(--border); }
      .push-toggle { width: 100%; padding: 5px 8px; font-size: 11px; font-family: inherit;
        color: var(--text-bright); background: var(--compose-bg); border: 1px solid var(--compose-border);
        border-radius: 4px; cursor: pointer; display: flex; align-items: center; gap: 6px;
        justify-content: center; }
      .push-toggle:hover { background: var(--compose-border); }
      .push-toggle.subscribed { background: var(--accent); border-color: var(--accent); }
      .push-toggle .push-icon { font-size: 14px; }
      .push-test-btn { width: 100%; padding: 4px 8px; font-size: 10px; font-family: inherit;
        color: var(--text-muted); background: none; border: 1px solid var(--border);
        border-radius: 4px; cursor: pointer; margin-top: 4px; }
      .push-test-btn:hover { color: var(--text-bright); border-color: var(--compose-border); }

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

      <!-- Devices section (collapsible) -->
      <div class="devices-section" id="devices-section">
        <div class="devices-header" id="devices-header">
          <span>Devices</span>
          <span class="devices-toggle" id="devices-toggle">&#9660;</span>
        </div>
        <div class="devices-list" id="devices-list"></div>
        <div class="devices-actions" id="devices-actions" style="display:none">
          <button class="pair-btn" id="btn-pair">Generate Pair Code</button>
          <div class="pair-code-display" id="pair-code-display" style="display:none">
            <span class="pair-code" id="pair-code-value"></span>
            <span class="pair-expires" id="pair-expires"></span>
          </div>
          <div class="pair-input-area" id="pair-input-area" style="display:none">
            <input type="text" id="pair-code-input" placeholder="Enter 6-digit code" maxlength="6" />
            <button class="pair-btn" id="btn-submit-pair">Pair</button>
          </div>
        </div>
      </div>

      <!-- Push notifications -->
      <div class="push-section" id="push-section" style="display:none">
        <button class="push-toggle" id="btn-push-toggle">
          <span class="push-icon">&#128276;</span>
          <span id="push-label">Enable Notifications</span>
        </button>
        <button class="push-test-btn" id="btn-push-test" style="display:none">Send Test</button>
      </div>

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
          <button id="btn-workspace">Workspace</button>
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
      <div id="workspace">
        <div class="ws-search">
          <input type="text" id="ws-search-input" placeholder="Search topics, artifacts, runs..." />
        </div>
        <div id="ws-search-results" class="ws-search-results"></div>
        <div id="ws-handoff" class="ws-handoff"></div>
        <div class="ws-section" id="ws-notes-section">
          <div class="ws-section-title">
            <span>Notes</span>
            <button id="btn-handoff">Handoff</button>
          </div>
          <div class="ws-note-input">
            <input type="text" id="ws-note-input" placeholder="Add a note..." />
            <button id="btn-add-note">Add</button>
          </div>
          <div id="ws-notes"></div>
        </div>
        <div class="ws-section">
          <div class="ws-section-title">
            <span>Pending Approvals</span>
          </div>
          <div id="ws-approvals"></div>
        </div>
        <div class="ws-section">
          <div class="ws-section-title">
            <span>Topics</span>
            <button id="btn-new-topic">+ New</button>
          </div>
          <div id="ws-topics"></div>
        </div>
        <div class="ws-section">
          <div class="ws-section-title">
            <span>Active Runs</span>
          </div>
          <div id="ws-runs"></div>
        </div>
        <div class="ws-section">
          <div class="ws-section-title">
            <span>Recent Artifacts</span>
            <button id="btn-capture-snapshot">Capture Snapshot</button>
          </div>
          <div id="ws-artifacts"></div>
        </div>
        <div class="ws-section">
          <div class="ws-section-title">
            <span>Commands</span>
          </div>
          <div id="ws-commands"></div>
        </div>
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

      let sessions = [], currentSession = null, currentTabId = null, ws = null, ctrlActive = false;
      let myClientId = null, myRole = null, clientsList = [];

      // -- Predictive echo (Mosh-style local echo, see #80) --
      // Adapted from VS Code TypeAheadAddon + Mosh SSP prediction model
      class PredictiveEcho {
        constructor(t) { this.attach(t); this._tid = setInterval(() => this._timeout(), 500); }
        attach(t) {
          this.term = t; this.preds = []; this.enabled = true;
          this.latency = 0; this.latSamples = 0;
          this.total = 0; this.correct = 0; this.accuracy = 1;
        }
        dispose() { clearInterval(this._tid); this.preds = []; }
        onInput(data) {
          if (!this.enabled || !this.term) return;
          if (this.term.buffer && this.term.buffer.active &&
              this.term.buffer.active.type === 'alternate') return;
          if (myRole && myRole !== 'active') return;
          for (let i = 0; i < data.length; i++) {
            const c = data.charCodeAt(i);
            if (c >= 0x20 && c <= 0x7e) {
              if (this.preds.length >= 32) return;
              const buf = this.term.buffer && this.term.buffer.active;
              const cx = buf ? buf.cursorX : 0, cy = buf ? buf.cursorY : 0;
              this.term.write('\\x1b[2m' + data[i] + '\\x1b[22m');
              this.preds.push({ ch: data[i], ts: Date.now(), x: cx, y: cy });
            } else if (c === 0x7f && this.preds.length > 0) {
              this.preds.pop();
              this.term.write('\\x1b[D \\x1b[D');
            } else if (c < 0x20 || c === 0x7f) {
              // Control characters — rollback predictions (terminal state may change)
              this._rollback();
            }
            // Non-ASCII (CJK, emoji, etc.) — skip prediction, don't rollback
          }
        }
        onServerData(data) {
          if (this.preds.length === 0) return data;
          let consumed = 0;
          for (let i = 0; i < data.length && this.preds.length > 0; i++) {
            const b = data.charCodeAt(i);
            if (b === 0x1b) { this._rollback(); return data.slice(consumed); }
            const p = this.preds[0];
            if (data[i] === p.ch) {
              this.preds.shift(); consumed = i + 1;
              const rtt = Date.now() - p.ts;
              this.latSamples === 0 ? (this.latency = rtt) :
                (this.latency = 0.3 * rtt + 0.7 * this.latency);
              this.latSamples++;
              if (this.latency < 30 && this.latSamples > 5) { this.enabled = false; this._rollback(); }
              this.total++; this.correct++;
              this.accuracy = this.correct / this.total;
              // Un-dim confirmed char
              this.term.write('\\x1b[s\\x1b[' + (p.y+1) + ';' + (p.x+1) + 'H\\x1b[22m' + p.ch + '\\x1b[u');
            } else {
              this._rollback(); return data.slice(consumed);
            }
          }
          const rest = data.slice(consumed);
          return rest.length > 0 ? rest : null;
        }
        _rollback() {
          if (this.preds.length === 0) return;
          this.term.write('\\x1b[s');
          for (let i = this.preds.length - 1; i >= 0; i--) {
            const p = this.preds[i];
            this.term.write('\\x1b[' + (p.y+1) + ';' + (p.x+1) + 'H ');
          }
          const first = this.preds[0];
          this.term.write('\\x1b[' + (first.y+1) + ';' + (first.x+1) + 'H');
          this.total += this.preds.length; // count as misses
          this.accuracy = this.total > 0 ? this.correct / this.total : 1;
          if (this.total > 20 && this.accuracy < 0.3) this.enabled = false;
          this.preds = [];
        }
        _timeout() {
          if (this.preds.length > 0 && Date.now() - this.preds[0].ts > 2000) this._rollback();
        }
      }
      const pe = new PredictiveEcho(term);
      const $ = id => document.getElementById(id);
      const esc = t => (t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      const setStatus = (s, t) => { $('status-dot').className = 'status-dot ' + s; $('status-text').textContent = t; };

      // -- Theme switching --
      function setTheme(mode) {
        document.documentElement.setAttribute('data-theme', mode);
        localStorage.setItem('remux-theme', mode);
        $('btn-theme').innerHTML = mode === 'dark' ? '&#9728;' : '&#9790;';
        // Recreate terminal with new theme (ghostty-web doesn't support runtime theme change)
        createTerminal(mode);
        // Rebind terminal I/O + predictive echo
        pe.attach(term);
        term.onData(data => {
          if (!ws || ws.readyState !== WebSocket.OPEN) return;
          if (ctrlActive) {
            ctrlActive = false; $('btn-ctrl').classList.remove('active');
            const ch = data.toLowerCase().charCodeAt(0);
            if (ch >= 0x61 && ch <= 0x7a) { sendTermData(String.fromCharCode(ch - 0x60)); return; }
          }
          pe.onInput(data);
          sendTermData(data);
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
          sidebar.classList.remove('collapsed');
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
          el.innerHTML = '<span class="dot"></span><span class="name">' + esc(s.name)
            + '</span><span class="count">' + live + '</span>'
            + '<button class="del" data-del="' + esc(s.name) + '">\u00d7</button>';
          el.addEventListener('pointerdown', e => {
            if (e.target.dataset.del) {
              e.stopPropagation(); e.preventDefault();
              if (!confirm('Delete session "' + e.target.dataset.del + '"? All tabs will be closed.')) return;
              sendCtrl({ type: 'delete_session', name: e.target.dataset.del });
              // if deleting current, switch to another or create fresh
              if (e.target.dataset.del === currentSession) {
                const other = sessions.find(x => x.name !== currentSession);
                if (other) {
                  selectSession(other.name);
                } else {
                  // Last session deleted — re-bootstrap via attach_first
                  currentSession = null;
                  sendCtrl({ type: 'attach_first', cols: term.cols, rows: term.rows });
                }
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
          el.innerHTML = '<span class="title">' + esc(t.title) + '</span>' + countBadge
            + '<button class="close" data-close="' + t.id + '">\u00d7</button>';
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
          dot.textContent = '\u25cf';
          text.textContent = 'Active';
          btn.textContent = 'Release';
          btn.style.display = 'inline-block';
          // Auto-focus terminal when becoming active so keystrokes reach xterm
          if (currentView === 'live') setTimeout(() => term.focus(), 50);
        } else {
          dot.textContent = '\u25cb';
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

      // -- E2EE client (Web Crypto API) --
      // Adapted from Signal Protocol X25519+AES-GCM pattern
      const e2ee = {
        established: false,
        sendCounter: 0n,
        recvCounter: -1n,
        localKeyPair: null,  // { publicKey: CryptoKey, privateKey: CryptoKey, rawPublic: Uint8Array }
        sharedKey: null,     // CryptoKey (AES-GCM)
        available: !!(crypto && crypto.subtle),

        async init() {
          if (!this.available) return;
          try {
            const kp = await crypto.subtle.generateKey('X25519', false, ['deriveBits']);
            const rawPub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
            this.localKeyPair = { publicKey: kp.publicKey, privateKey: kp.privateKey, rawPublic: rawPub };
          } catch (e) {
            console.warn('[e2ee] X25519 not available:', e);
            this.available = false;
          }
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
            // ECDH: derive raw shared bits
            const rawBits = await crypto.subtle.deriveBits(
              { name: 'X25519', public: peerKey },
              this.localKeyPair.privateKey,
              256
            );
            // HKDF-SHA256 to derive AES-256-GCM key
            const hkdfKey = await crypto.subtle.importKey('raw', rawBits, 'HKDF', false, ['deriveBits']);
            const salt = new TextEncoder().encode('remux-e2ee-v1');
            const info = new TextEncoder().encode('aes-256-gcm');
            const derived = await crypto.subtle.deriveBits(
              { name: 'HKDF', hash: 'SHA-256', salt, info },
              hkdfKey,
              256
            );
            this.sharedKey = await crypto.subtle.importKey('raw', derived, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
            this.established = true;
            this.sendCounter = 0n;
            this.recvCounter = -1n;
            console.log('[e2ee] handshake complete');
          } catch (e) {
            console.error('[e2ee] handshake failed:', e);
            this.available = false;
          }
        },

        async encryptMessage(plaintext) {
          if (!this.sharedKey) throw new Error('E2EE not established');
          const plaintextBuf = new TextEncoder().encode(plaintext);
          // IV: 4 random bytes + 8 byte counter (big-endian)
          const iv = new Uint8Array(12);
          crypto.getRandomValues(iv.subarray(0, 4));
          const counterView = new DataView(iv.buffer, iv.byteOffset + 4, 8);
          counterView.setBigUint64(0, this.sendCounter, false);
          this.sendCounter++;
          const encrypted = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv, tagLength: 128 },
            this.sharedKey,
            plaintextBuf
          );
          // AES-GCM returns ciphertext + tag concatenated
          const result = new Uint8Array(12 + encrypted.byteLength);
          result.set(iv, 0);
          result.set(new Uint8Array(encrypted), 12);
          return btoa(String.fromCharCode(...result));
        },

        async decryptMessage(encryptedB64) {
          if (!this.sharedKey) throw new Error('E2EE not established');
          const packed = Uint8Array.from(atob(encryptedB64), c => c.charCodeAt(0));
          if (packed.length < 28) throw new Error('E2EE message too short'); // 12 iv + 16 tag minimum
          const iv = packed.subarray(0, 12);
          const ciphertextWithTag = packed.subarray(12);
          // Anti-replay: check counter is monotonically increasing
          const counterView = new DataView(iv.buffer, iv.byteOffset + 4, 8);
          const counter = counterView.getBigUint64(0, false);
          if (counter <= this.recvCounter) throw new Error('E2EE replay detected');
          const decrypted = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv, tagLength: 128 },
            this.sharedKey,
            ciphertextWithTag
          );
          this.recvCounter = counter;
          return new TextDecoder().decode(decrypted);
        }
      };

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

      // Track last received message timestamp for session recovery
      let lastReceivedTimestamp = 0;
      let isResuming = false;

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
        e2ee.established = false;
        e2ee.sharedKey = null;
        ws = new WebSocket(proto + '//' + location.host + '/ws');
        ws.onopen = async () => {
          backoffMs = 1000; // reset backoff on successful connection
          startHeartbeat();
          if (urlToken) {
            // Use persistent device ID from localStorage so each browser context
            // is a distinct device even with identical User-Agent
            if (!localStorage.getItem('remux-device-id')) {
              localStorage.setItem('remux-device-id', 'dev-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36));
            }
            ws.send(JSON.stringify({ type: 'auth', token: urlToken, deviceId: localStorage.getItem('remux-device-id') }));
          }
          // Initiate E2EE handshake if Web Crypto API is available
          if (e2ee.available) {
            await e2ee.init();
            const pubKey = e2ee.getPublicKeyB64();
            if (pubKey) {
              ws.send(JSON.stringify({ v: 1, type: 'e2ee_init', payload: { publicKey: pubKey } }));
            }
          }
          // Session recovery: if we have a previous timestamp, request buffered messages
          const deviceId = localStorage.getItem('remux-device-id');
          if (lastReceivedTimestamp > 0 && deviceId) {
            isResuming = true;
            setStatus('connecting', 'Resuming session...');
            sendCtrl({ type: 'resume', deviceId: deviceId, lastTimestamp: lastReceivedTimestamp });
          }
          // Let server pick the session if we have none (bootstrap flow)
          sendCtrl({ type: 'attach_first', session: currentSession || undefined, cols: term.cols, rows: term.rows });
          // Request device list (works with or without auth)
          sendCtrl({ type: 'list_devices' });
          // Request VAPID key for push notifications
          sendCtrl({ type: 'get_vapid_key' });
        };
        ws.onmessage = e => {
          lastMessageAt = Date.now();
          if (typeof e.data === 'string' && e.data[0] === '{') {
            try {
              const parsed = JSON.parse(e.data);
              // Handle both envelope (v:1) and legacy messages
              // Unwrap envelope: spread payload first, then override type with the
              // envelope's type to prevent payload.type (e.g. artifact type "snapshot")
              // from colliding with the message type (e.g. "snapshot_captured")
              const msg = parsed.v === 1 ? { ...(parsed.payload || {}), type: parsed.type } : parsed;
              // Server heartbeat — just keep connection alive (lastMessageAt already updated)
              if (msg.type === 'ping') return;
              // E2EE handshake: server responds with its public key
              if (msg.type === 'e2ee_init') {
                if (msg.publicKey && e2ee.available && e2ee.localKeyPair) {
                  e2ee.completeHandshake(msg.publicKey);
                }
                return;
              }
              if (msg.type === 'e2ee_ready') {
                console.log('[e2ee] server confirmed E2EE established');
                return;
              }
              // E2EE encrypted message (terminal output from server)
              if (msg.type === 'e2ee_msg') {
                if (e2ee.established && msg.data) {
                  e2ee.decryptMessage(msg.data).then(decrypted => {
                    const filtered = pe.onServerData(decrypted);
                    if (filtered) term.write(filtered);
                  }).catch(err => console.error('[e2ee] decrypt failed:', err));
                }
                return;
              }
              // Session recovery complete
              if (msg.type === 'resume_complete') {
                isResuming = false;
                if (msg.replayed > 0) {
                  console.log('[remux] session recovered: ' + msg.replayed + ' buffered messages replayed');
                }
                return;
              }
              // Track timestamp for session recovery on reconnect
              lastReceivedTimestamp = Date.now();
              if (msg.type === 'auth_ok') {
                if (msg.deviceId) myDeviceId = msg.deviceId;
                // Request device list and workspace data after auth
                sendCtrl({ type: 'list_devices' });
                sendCtrl({ type: 'list_notes' });
                return;
              }
              if (msg.type === 'auth_error') { setStatus('disconnected', 'Auth failed'); ws.close(); return; }
              // Generic server error — show to user (e.g. pair code trust errors)
              if (msg.type === 'error') {
                console.warn('[remux] server error:', msg.reason || 'unknown');
                alert('Error: ' + (msg.reason || 'unknown error'));
                return;
              }
              if (msg.type === 'device_list') {
                devicesList = msg.devices || [];
                renderDevices(); return;
              }
              if (msg.type === 'pair_code') {
                const display = $('pair-code-display');
                if (display) {
                  display.style.display = 'block';
                  $('pair-code-value').textContent = msg.code;
                  const remaining = Math.max(0, Math.ceil((msg.expiresAt - Date.now()) / 1000));
                  $('pair-expires').textContent = 'Expires in ' + Math.ceil(remaining / 60) + ' min';
                  setTimeout(() => { display.style.display = 'none'; }, remaining * 1000);
                }
                return;
              }
              if (msg.type === 'pair_result') {
                if (msg.success) {
                  $('pair-code-input').value = '';
                  sendCtrl({ type: 'list_devices' });
                } else {
                  alert('Pairing failed: ' + (msg.reason || 'invalid code'));
                }
                return;
              }
              if (msg.type === 'vapid_key') {
                pushVapidKey = msg.publicKey;
                showPushSection();
                // Check current push status
                sendCtrl({ type: 'get_push_status' });
                return;
              }
              if (msg.type === 'push_subscribed') {
                pushSubscribed = msg.success;
                updatePushUI();
                return;
              }
              if (msg.type === 'push_unsubscribed') {
                pushSubscribed = false;
                updatePushUI();
                return;
              }
              if (msg.type === 'push_status') {
                pushSubscribed = msg.subscribed;
                updatePushUI();
                return;
              }
              if (msg.type === 'push_test_result') {
                // Brief visual feedback
                const testBtn = $('btn-push-test');
                if (testBtn) {
                  testBtn.textContent = msg.sent ? 'Sent!' : 'Failed';
                  setTimeout(() => { testBtn.textContent = 'Send Test'; }, 2000);
                }
                return;
              }
              if (msg.type === 'state') {
                sessions = msg.sessions || [];
                clientsList = msg.clients || [];
                // Re-derive own role from authoritative server state
                if (myClientId) {
                  const me = clientsList.find(c => c.clientId === myClientId);
                  if (me) myRole = me.role;
                }
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
                  '<span>' + esc(m.session) + ' / ' + esc(m.tabTitle || 'Tab ' + m.tabId) + '</span>' +
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
              // Workspace message handlers
              if (msg.type === 'topic_list') { wsTopics = msg.topics || []; renderWorkspaceTopics(); return; }
              if (msg.type === 'topic_created') {
                // Optimistic render: add topic directly
                if (msg.id && msg.title) wsTopics.unshift({ id: msg.id, sessionName: msg.sessionName, title: msg.title, createdAt: msg.createdAt, updatedAt: msg.updatedAt });
                renderWorkspaceTopics();
                return;
              }
              if (msg.type === 'topic_deleted') { refreshWorkspace(); return; }
              if (msg.type === 'run_list') { wsRuns = msg.runs || []; renderWorkspaceRuns(); return; }
              if (msg.type === 'run_created' || msg.type === 'run_updated') { if (currentView === 'workspace') refreshWorkspace(); return; }
              if (msg.type === 'artifact_list') { wsArtifacts = msg.artifacts || []; renderWorkspaceArtifacts(); return; }
              if (msg.type === 'snapshot_captured') {
                // Optimistic render: add artifact directly (with server-rendered HTML)
                if (msg.id) wsArtifacts.unshift({ id: msg.id, type: 'snapshot', title: msg.title || 'Snapshot', content: msg.content, contentType: msg.contentType || 'plain', renderedHtml: msg.renderedHtml, createdAt: msg.createdAt || Date.now() });
                renderWorkspaceArtifacts();
                return;
              }
              if (msg.type === 'approval_list') { wsApprovals = msg.approvals || []; renderWorkspaceApprovals(); return; }
              if (msg.type === 'approval_created') { if (currentView === 'workspace') refreshWorkspace(); return; }
              if (msg.type === 'approval_resolved') { if (currentView === 'workspace') refreshWorkspace(); return; }
              // Search results
              if (msg.type === 'search_results') { renderSearchResults(msg.results || []); return; }
              // Handoff bundle
              if (msg.type === 'handoff_bundle') { renderHandoffBundle(msg); return; }
              // Notes
              if (msg.type === 'note_list') { wsNotes = msg.notes || []; renderNotes(); return; }
              if (msg.type === 'note_created') {
                // Optimistic render: add note directly without waiting for list refresh
                if (msg.id && msg.content) wsNotes.unshift({ id: msg.id, content: msg.content, pinned: msg.pinned || false, createdAt: msg.createdAt, updatedAt: msg.updatedAt });
                renderNotes();
                return;
              }
              if (msg.type === 'note_updated' || msg.type === 'note_deleted' || msg.type === 'note_pinned') { sendCtrl({ type: 'list_notes' }); return; }
              // Commands
              if (msg.type === 'command_list') { wsCommands = msg.commands || []; renderCommands(); return; }
              // Unrecognized enveloped control message — discard, never write to terminal
              if (parsed.v === 1) {
                console.warn('[remux] unhandled message type:', msg.type);
                return;
              }
              // Non-enveloped JSON (e.g. PTY output that looks like JSON) — fall through to term.write
            } catch {}
          }
          const filtered = pe.onServerData(e.data);
          if (filtered) term.write(filtered);
        };
        ws.onclose = () => { stopHeartbeat(); pe._rollback(); scheduleReconnect(); };
        ws.onerror = () => setStatus('disconnected', 'Error');
      }
      connect();
      function sendCtrl(msg) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); }
      // Send terminal data, encrypting if E2EE is established
      function sendTermData(data) {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        if (e2ee.established) {
          e2ee.encryptMessage(data).then(encrypted => {
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ v: 1, type: 'e2ee_msg', payload: { data: encrypted } }));
            }
          }).catch(err => {
            console.error('[e2ee] encrypt failed, sending plaintext:', err);
            ws.send(data);
          });
        } else {
          ws.send(data);
        }
      }

      // -- Terminal I/O --
      term.onData(data => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        if (ctrlActive) {
          ctrlActive = false; $('btn-ctrl').classList.remove('active');
          const ch = data.toLowerCase().charCodeAt(0);
          if (ch >= 0x61 && ch <= 0x7a) { sendTermData(String.fromCharCode(ch - 0x60)); return; }
        }
        pe.onInput(data);
        sendTermData(data);
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
        if (d) sendTermData(d);
        term.focus();
      });

      // -- Inspect view --
      let currentView = 'live', inspectTimer = null, wsRefreshTimer = null;
      function setView(mode) {
        currentView = mode;
        $('btn-live').classList.toggle('active', mode === 'live');
        $('btn-inspect').classList.toggle('active', mode === 'inspect');
        $('btn-workspace').classList.toggle('active', mode === 'workspace');
        $('terminal').classList.toggle('hidden', mode !== 'live');
        $('inspect').classList.toggle('visible', mode === 'inspect');
        $('workspace').classList.toggle('visible', mode === 'workspace');
        // Inspect auto-refresh
        if (inspectTimer) { clearInterval(inspectTimer); inspectTimer = null; }
        if (mode === 'inspect') {
          sendCtrl({ type: 'inspect' });
          inspectTimer = setInterval(() => sendCtrl({ type: 'inspect' }), 3000);
        }
        // Workspace auto-refresh
        if (wsRefreshTimer) { clearInterval(wsRefreshTimer); wsRefreshTimer = null; }
        if (mode === 'workspace') {
          refreshWorkspace();
          wsRefreshTimer = setInterval(refreshWorkspace, 5000);
        }
        if (mode === 'live') { term.focus(); fitAddon.fit(); }
      }
      $('btn-live').addEventListener('pointerdown', e => { e.preventDefault(); closeSidebarMobile(); setView('live'); });
      $('btn-inspect').addEventListener('pointerdown', e => { e.preventDefault(); closeSidebarMobile(); setView('inspect'); });
      $('btn-workspace').addEventListener('pointerdown', e => { e.preventDefault(); closeSidebarMobile(); setView('workspace'); });

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

      // -- Devices section --
      let devicesList = [], myDeviceId = null, devicesCollapsed = false;

      function renderDevices() {
        const list = $('devices-list');
        const actions = $('devices-actions');
        if (!list) return;
        list.innerHTML = '';
        devicesList.forEach(d => {
          const el = document.createElement('div');
          el.className = 'device-item';
          const isSelf = d.id === myDeviceId;
          el.innerHTML = '<span class="device-dot ' + esc(d.trust) + '"></span>'
            + '<span class="device-name">' + esc(d.name) + (isSelf ? ' <span class="device-self">(you)</span>' : '') + '</span>'
            + '<span class="device-actions">'
            + (d.trust !== 'trusted' ? '<button data-trust="' + d.id + '" title="Trust">&#10003;</button>' : '')
            + (d.trust !== 'blocked' ? '<button data-block="' + d.id + '" title="Block">&#10007;</button>' : '')
            + '<button data-rename-dev="' + d.id + '" title="Rename">&#9998;</button>'
            + (!isSelf ? '<button data-revoke="' + d.id + '" title="Revoke">&#128465;</button>' : '')
            + '</span>';
          el.addEventListener('click', e => {
            const btn = e.target.closest('button');
            if (!btn) return;
            if (btn.dataset.trust) sendCtrl({ type: 'trust_device', deviceId: btn.dataset.trust });
            if (btn.dataset.block) sendCtrl({ type: 'block_device', deviceId: btn.dataset.block });
            if (btn.dataset.renameDev) {
              const newName = prompt('Device name:', d.name);
              if (newName && newName.trim()) sendCtrl({ type: 'rename_device', deviceId: btn.dataset.renameDev, name: newName.trim() });
            }
            if (btn.dataset.revoke) {
              if (confirm('Revoke device "' + d.name + '"?')) sendCtrl({ type: 'revoke_device', deviceId: btn.dataset.revoke });
            }
          });
          list.appendChild(el);
        });

        // Show actions only for trusted devices
        const isTrusted = devicesList.find(d => d.id === myDeviceId && d.trust === 'trusted');
        if (actions) {
          actions.style.display = isTrusted ? 'block' : 'none';
          // Show pair input for untrusted devices
          const pairInput = $('pair-input-area');
          if (pairInput && !isTrusted) {
            pairInput.style.display = 'flex';
            actions.style.display = 'block';
          }
        }
      }

      $('devices-header').addEventListener('click', () => {
        devicesCollapsed = !devicesCollapsed;
        $('devices-list').classList.toggle('collapsed', devicesCollapsed);
        $('devices-toggle').classList.toggle('collapsed', devicesCollapsed);
        if ($('devices-actions')) $('devices-actions').style.display = devicesCollapsed ? 'none' : '';
      });

      $('btn-pair').addEventListener('click', () => {
        sendCtrl({ type: 'generate_pair_code' });
      });

      $('btn-submit-pair').addEventListener('click', () => {
        const code = $('pair-code-input').value.trim();
        if (code.length === 6) sendCtrl({ type: 'pair', code });
      });

      $('pair-code-input').addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); $('btn-submit-pair').click(); }
      });

      // -- Push notifications --
      let pushSubscribed = false;
      let pushVapidKey = null;

      function showPushSection() {
        // Show only if browser supports push + service workers
        if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
        $('push-section').style.display = 'block';
      }

      function updatePushUI() {
        const btn = $('btn-push-toggle');
        const label = $('push-label');
        const testBtn = $('btn-push-test');
        if (pushSubscribed) {
          btn.classList.add('subscribed');
          label.textContent = 'Notifications On';
          testBtn.style.display = 'block';
        } else {
          btn.classList.remove('subscribed');
          label.textContent = 'Enable Notifications';
          testBtn.style.display = 'none';
        }
      }

      function urlBase64ToUint8Array(base64String) {
        const padding = '='.repeat((4 - base64String.length % 4) % 4);
        const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
        const rawData = atob(base64);
        const outputArray = new Uint8Array(rawData.length);
        for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
        return outputArray;
      }

      async function subscribePush() {
        if (!pushVapidKey) return;
        try {
          const reg = await navigator.serviceWorker.register('/sw.js');
          await navigator.serviceWorker.ready;
          const sub = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(pushVapidKey),
          });
          const subJson = sub.toJSON();
          sendCtrl({
            type: 'subscribe_push',
            subscription: {
              endpoint: subJson.endpoint,
              keys: { p256dh: subJson.keys.p256dh, auth: subJson.keys.auth },
            },
          });
        } catch (err) {
          console.error('[push] subscribe failed:', err);
          if (Notification.permission === 'denied') {
            $('push-label').textContent = 'Permission Denied';
          } else {
            $('push-label').textContent = 'Not Available';
          }
        }
      }

      async function unsubscribePush() {
        try {
          const reg = await navigator.serviceWorker.getRegistration();
          if (reg) {
            const sub = await reg.pushManager.getSubscription();
            if (sub) await sub.unsubscribe();
          }
          sendCtrl({ type: 'unsubscribe_push' });
        } catch (err) {
          console.error('[push] unsubscribe failed:', err);
        }
      }

      $('btn-push-toggle').addEventListener('click', async () => {
        if (pushSubscribed) {
          await unsubscribePush();
          pushSubscribed = false;
        } else {
          await subscribePush();
        }
        updatePushUI();
      });

      $('btn-push-test').addEventListener('click', () => {
        sendCtrl({ type: 'test_push' });
      });

      // -- Workspace view --
      let wsTopics = [], wsRuns = [], wsArtifacts = [], wsApprovals = [];
      let wsNotes = [], wsCommands = [];

      function refreshWorkspace() {
        if (!currentSession) return; // Wait until bootstrap resolves a session
        sendCtrl({ type: 'list_topics', sessionName: currentSession });
        sendCtrl({ type: 'list_runs' });
        sendCtrl({ type: 'list_artifacts', sessionName: currentSession });
        sendCtrl({ type: 'list_approvals' });
        sendCtrl({ type: 'list_notes' }); // Notes are global workspace memory, not session-scoped
        sendCtrl({ type: 'list_commands' });
      }

      function timeAgo(ts) {
        const s = Math.floor((Date.now() - ts) / 1000);
        if (s < 60) return s + 's ago';
        if (s < 3600) return Math.floor(s / 60) + 'm ago';
        if (s < 86400) return Math.floor(s / 3600) + 'h ago';
        return Math.floor(s / 86400) + 'd ago';
      }

      function renderWorkspaceApprovals() {
        const el = $('ws-approvals');
        if (!el) return;
        const pending = wsApprovals.filter(a => a.status === 'pending');
        if (pending.length === 0) { el.innerHTML = '<div class="ws-empty">No pending approvals</div>'; return; }
        el.innerHTML = pending.map(a =>
          '<div class="ws-card">' +
            '<div class="ws-card-header">' +
              '<span class="ws-badge pending">pending</span>' +
              '<span class="ws-card-title">' + esc(a.title) + '</span>' +
              '<span class="ws-card-meta">' + timeAgo(a.createdAt) + '</span>' +
            '</div>' +
            (a.description ? '<div class="ws-card-desc">' + esc(a.description) + '</div>' : '') +
            '<div class="ws-card-actions">' +
              '<button class="approve" data-approve-id="' + a.id + '">Approve</button>' +
              '<button class="reject" data-reject-id="' + a.id + '">Reject</button>' +
            '</div>' +
          '</div>'
        ).join('');
        el.querySelectorAll('[data-approve-id]').forEach(btn => {
          btn.addEventListener('click', () => sendCtrl({ type: 'resolve_approval', approvalId: btn.dataset.approveId, status: 'approved' }));
        });
        el.querySelectorAll('[data-reject-id]').forEach(btn => {
          btn.addEventListener('click', () => sendCtrl({ type: 'resolve_approval', approvalId: btn.dataset.rejectId, status: 'rejected' }));
        });
      }

      function renderWorkspaceTopics() {
        const el = $('ws-topics');
        if (!el) return;
        if (wsTopics.length === 0) { el.innerHTML = '<div class="ws-empty">No topics yet</div>'; return; }
        el.innerHTML = wsTopics.map(t =>
          '<div class="ws-card">' +
            '<div class="ws-card-header">' +
              '<span class="ws-card-title">' + esc(t.title) + '</span>' +
              '<span class="ws-card-meta">' + timeAgo(t.createdAt) + '</span>' +
              '<button class="del-topic" data-del-topic="' + t.id + '" title="Delete">&times;</button>' +
            '</div>' +
            '<div class="ws-card-meta">' + esc(t.sessionName) + '</div>' +
          '</div>'
        ).join('');
        el.querySelectorAll('[data-del-topic]').forEach(btn => {
          btn.addEventListener('click', () => {
            sendCtrl({ type: 'delete_topic', topicId: btn.dataset.delTopic });
            setTimeout(refreshWorkspace, 200);
          });
        });
      }

      function renderWorkspaceRuns() {
        const el = $('ws-runs');
        if (!el) return;
        const active = wsRuns.filter(r => r.status === 'running');
        const recent = wsRuns.filter(r => r.status !== 'running').slice(-5).reverse();
        const all = [...active, ...recent];
        if (all.length === 0) { el.innerHTML = '<div class="ws-empty">No runs</div>'; return; }
        el.innerHTML = all.map(r =>
          '<div class="ws-card">' +
            '<div class="ws-card-header">' +
              '<span class="ws-badge ' + r.status + '">' + r.status + '</span>' +
              '<span class="ws-card-title">' + esc(r.command || '(no command)') + '</span>' +
              '<span class="ws-card-meta">' + timeAgo(r.startedAt) + '</span>' +
            '</div>' +
            (r.exitCode !== null ? '<div class="ws-card-meta">Exit: ' + r.exitCode + '</div>' : '') +
          '</div>'
        ).join('');
      }

      function renderWorkspaceArtifacts() {
        const el = $('ws-artifacts');
        if (!el) return;
        // Artifacts are already filtered by session_name on the server side
        const recent = wsArtifacts.slice(-10).reverse();
        if (recent.length === 0) { el.innerHTML = '<div class="ws-empty">No artifacts</div>'; return; }
        el.innerHTML = recent.map((a, idx) => {
          var hasContent = a.content && a.content.trim();
          var ct = a.contentType || 'plain';
          var badge = (ct !== 'plain') ? ' <span class="ws-badge ' + esc(ct) + '">' + esc(ct) + '</span>' : '';
          // Use server-rendered HTML if available, otherwise show raw text
          var rendered = a.renderedHtml || (hasContent ? '<pre style="margin:0;font-size:11px;color:var(--text-muted);white-space:pre-wrap;word-break:break-word">' + esc(a.content) + '</pre>' : '');
          return '<div class="ws-card">' +
            '<div class="ws-card-header">' +
              '<span class="ws-badge ' + esc(a.type) + '">' + esc(a.type) + '</span>' +
              badge +
              '<span class="ws-card-title">' + esc(a.title) + '</span>' +
              '<span class="ws-card-meta">' + timeAgo(a.createdAt) + '</span>' +
              (hasContent ? '<button class="ws-card-toggle" data-toggle-idx="' + idx + '">Show</button>' : '') +
            '</div>' +
            (hasContent ? '<div class="ws-card-content" id="ws-art-content-' + idx + '" style="display:none">' + rendered + '</div>' : '') +
          '</div>';
        }).join('');
        // Wire up toggle buttons
        el.querySelectorAll('[data-toggle-idx]').forEach(function(btn) {
          btn.addEventListener('click', function() {
            var idx = btn.getAttribute('data-toggle-idx');
            var contentEl = document.getElementById('ws-art-content-' + idx);
            if (!contentEl) return;
            var visible = contentEl.style.display !== 'none';
            contentEl.style.display = visible ? 'none' : 'block';
            btn.textContent = visible ? 'Show' : 'Hide';
          });
        });
      }

      $('btn-new-topic').addEventListener('click', () => {
        const title = prompt('Topic title:');
        if (title && title.trim()) {
          sendCtrl({ type: 'create_topic', sessionName: currentSession, title: title.trim() });
          // Optimistic render in topic_created handler, no delayed refresh needed
        }
      });

      $('btn-capture-snapshot').addEventListener('click', () => {
        sendCtrl({ type: 'capture_snapshot' });
        // Optimistic render in snapshot_captured handler, no delayed refresh needed
      });

      // -- Search --
      let searchDebounce = null;
      $('ws-search-input').addEventListener('input', () => {
        clearTimeout(searchDebounce);
        const q = $('ws-search-input').value.trim();
        if (!q) { $('ws-search-results').innerHTML = ''; return; }
        searchDebounce = setTimeout(() => sendCtrl({ type: 'search', query: q }), 200);
      });

      function renderSearchResults(results) {
        const el = $('ws-search-results');
        if (!el) return;
        if (results.length === 0) {
          const q = ($('ws-search-input') || {}).value || '';
          el.innerHTML = q ? '<div class="ws-empty">No results</div>' : '';
          return;
        }
        const esc = t => (t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        el.innerHTML = results.map(r =>
          '<div class="ws-search-result">' +
            '<span class="sr-type">' + esc(r.entityType) + '</span> ' +
            '<span class="sr-title">' + esc(r.title) + '</span>' +
          '</div>'
        ).join('');
      }

      // -- Handoff --
      $('btn-handoff').addEventListener('click', () => {
        const el = $('ws-handoff');
        if (el.classList.contains('visible')) { el.classList.remove('visible'); return; }
        sendCtrl({ type: 'get_handoff' });
      });

      function renderHandoffBundle(bundle) {
        const el = $('ws-handoff');
        if (!el) return;
        el.classList.add('visible');
        const esc = t => (t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        let html = '<div class="ws-handoff-section"><div class="ws-handoff-label">Sessions</div>';
        html += '<ul class="ws-handoff-list">';
        (bundle.sessions || []).forEach(s => {
          html += '<li>' + esc(s.name) + ' (' + s.activeTabs + ' active tabs)</li>';
        });
        html += '</ul></div>';
        if ((bundle.activeTopics || []).length > 0) {
          html += '<div class="ws-handoff-section"><div class="ws-handoff-label">Active Topics (24h)</div>';
          html += '<ul class="ws-handoff-list">';
          bundle.activeTopics.forEach(t => { html += '<li>' + esc(t.title) + '</li>'; });
          html += '</ul></div>';
        }
        if ((bundle.pendingApprovals || []).length > 0) {
          html += '<div class="ws-handoff-section"><div class="ws-handoff-label">Pending Approvals</div>';
          html += '<ul class="ws-handoff-list">';
          bundle.pendingApprovals.forEach(a => { html += '<li>' + esc(a.title) + '</li>'; });
          html += '</ul></div>';
        }
        html += '<div class="ws-handoff-section"><div class="ws-handoff-label">Recent Runs (' + (bundle.recentRuns || []).length + ')</div></div>';
        html += '<div class="ws-handoff-section"><div class="ws-handoff-label">Key Artifacts (' + (bundle.keyArtifacts || []).length + ')</div></div>';
        el.innerHTML = html;
      }

      // -- Notes --
      function renderNotes() {
        const el = $('ws-notes');
        if (!el) return;
        if (wsNotes.length === 0) { el.innerHTML = '<div class="ws-empty">No notes yet</div>'; return; }
        const esc = t => (t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        el.innerHTML = wsNotes.map(n =>
          '<div class="ws-note' + (n.pinned ? ' pinned' : '') + '">' +
            '<div class="ws-note-content">' + esc(n.content) + '</div>' +
            '<div class="ws-note-actions">' +
              '<button data-pin-note="' + n.id + '">' + (n.pinned ? 'Unpin' : 'Pin') + '</button>' +
              '<button data-del-note="' + n.id + '">Delete</button>' +
            '</div>' +
          '</div>'
        ).join('');
        el.querySelectorAll('[data-pin-note]').forEach(btn => {
          btn.addEventListener('click', () => sendCtrl({ type: 'pin_note', noteId: btn.dataset.pinNote }));
        });
        el.querySelectorAll('[data-del-note]').forEach(btn => {
          btn.addEventListener('click', () => sendCtrl({ type: 'delete_note', noteId: btn.dataset.delNote }));
        });
      }

      $('btn-add-note').addEventListener('click', () => {
        const input = $('ws-note-input');
        const content = input.value.trim();
        if (!content) return;
        sendCtrl({ type: 'create_note', content });
        input.value = '';
        // Feedback: show saving indicator, revert if no response in 3s
        const el = $('ws-notes');
        const prevHtml = el.innerHTML;
        el.innerHTML = '<div class="ws-empty">Saving...</div>';
        setTimeout(() => {
          if (el.innerHTML.includes('Saving...')) {
            el.innerHTML = '<div class="ws-empty" style="color:var(--text-dim)">Note may not have saved — check server logs</div>';
          }
        }, 3000);
      });
      $('ws-note-input').addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); $('btn-add-note').click(); }
      });

      // -- Commands --
      function formatDuration(startedAt, endedAt) {
        if (!endedAt) return 'running';
        const ms = endedAt - startedAt;
        if (ms < 1000) return ms + 'ms';
        if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
        return Math.floor(ms / 60000) + 'm ' + Math.floor((ms % 60000) / 1000) + 's';
      }

      function renderCommands() {
        const el = $('ws-commands');
        if (!el) return;
        if (wsCommands.length === 0) { el.innerHTML = '<div class="ws-empty">No commands detected (requires shell integration)</div>'; return; }
        const esc = t => (t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        el.innerHTML = wsCommands.slice(0, 20).map(c => {
          const exitClass = c.exitCode === null ? '' : (c.exitCode === 0 ? 'ok' : 'err');
          const exitSymbol = c.exitCode === null ? '' : (c.exitCode === 0 ? '&#10003;' : '&#10007; ' + c.exitCode);
          return '<div class="ws-cmd">' +
            '<span class="ws-cmd-text">' + esc(c.command || '(unknown)') + '</span>' +
            (exitSymbol ? '<span class="ws-cmd-exit ' + exitClass + '">' + exitSymbol + '</span>' : '') +
            '<span class="ws-cmd-meta">' + formatDuration(c.startedAt, c.endedAt) + '</span>' +
            (c.cwd ? '<span class="ws-cmd-meta">' + esc(c.cwd) + '</span>' : '') +
          '</div>';
        }).join('');
      }

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

      // -- Mobile virtual keyboard handling --
      // Only apply visualViewport height adjustments on touch devices.
      // On desktop, IME candidate windows trigger visualViewport resize
      // with incorrect height values, causing the page to go blank.
      let fitDebounceTimer = null;
      const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
      if (window.visualViewport && isTouchDevice) {
        window.visualViewport.addEventListener('resize', () => {
          const vh = window.visualViewport.height;
          if (vh > 0) document.body.style.height = vh + 'px';
          clearTimeout(fitDebounceTimer);
          fitDebounceTimer = setTimeout(() => { if (fitAddon) fitAddon.fit(); }, 100);
        });
        window.visualViewport.addEventListener('scroll', () => window.scrollTo(0, 0));
      }
      // iOS Safari: touching terminal area focuses hidden textarea for input
      document.getElementById('terminal').addEventListener('touchend', () => { if (currentView === 'live') term.focus(); });

      // -- IME diagnostic (active when ?debug=1) --
      if (new URLSearchParams(location.search).has('debug')) {
        const _d = window._imeDiag = { events: [], t0: Date.now() };
        function _ilog(type, detail) {
          const e = { t: Date.now() - _d.t0, type, ...detail };
          _d.events.push(e);
          if (_d.events.length > 300) _d.events.shift();
          try { localStorage.setItem('_imeDiag', JSON.stringify(_d.events.slice(-50))); } catch {}
        }
        const _ta = document.querySelector('textarea');
        if (_ta) {
          ['compositionstart','compositionupdate','compositionend'].forEach(n =>
            _ta.addEventListener(n, e => _ilog(n, { data: e.data }), true));
          _ta.addEventListener('input', e => _ilog('input', {
            data: e.data?.substring(0,20), inputType: e.inputType, isComposing: e.isComposing
          }), true);
          _ta.addEventListener('keydown', e => {
            if (e.isComposing || e.keyCode === 229)
              _ilog('keydown-ime', { key: e.key, code: e.code, kc: e.keyCode });
          }, true);
        }
        new ResizeObserver(entries => entries.forEach(e => {
          const n = e.target.id || e.target.tagName;
          _ilog('resize', { el: n, h: Math.round(e.contentRect.height) });
        })).observe(document.body);
        if (window.visualViewport) window.visualViewport.addEventListener('resize', () =>
          _ilog('vv-resize', { vh: Math.round(window.visualViewport.height), bh: document.body.offsetHeight }));
        new MutationObserver(() => _ilog('body-style', {
          h: document.body.style.height, oh: document.body.offsetHeight
        })).observe(document.body, { attributes: true, attributeFilter: ['style'] });
        window.addEventListener('error', e => _ilog('js-error', { msg: e.message, line: e.lineno }));
        // Track textarea style/size changes (IME may resize it)
        if (_ta) {
          new ResizeObserver(() => {
            _ilog('ta-resize', { w: _ta.offsetWidth, h: _ta.offsetHeight, vis: getComputedStyle(_ta).visibility, op: getComputedStyle(_ta).opacity });
          }).observe(_ta);
        }
        // Track canvas visibility
        const _cvs = document.querySelector('#terminal canvas');
        if (_cvs) {
          new ResizeObserver(() => {
            _ilog('canvas-resize', { w: _cvs.width, h: _cvs.height, display: getComputedStyle(_cvs).display });
          }).observe(_cvs);
        }
        // Floating debug overlay — stays visible even when page goes "blank"
        const _dbg = document.createElement('div');
        _dbg.id = 'ime-debug';
        _dbg.style.cssText = 'position:fixed;bottom:0;right:0;z-index:999999;background:rgba(0,0,0,0.85);color:#0f0;font:10px monospace;padding:4px 8px;max-width:50vw;max-height:30vh;overflow:auto;pointer-events:none;white-space:pre-wrap;';
        document.documentElement.appendChild(_dbg);
        function _updateDbg() {
          const last = _d.events.slice(-8);
          _dbg.textContent = last.map(e => {
            const {t, type, ...r} = e;
            return t + 'ms ' + type + ' ' + JSON.stringify(r);
          }).join('\\n');
        }
        const _origIlog = _ilog;
        // Patch _ilog to also update debug overlay
        const _ilog2 = function(type, detail) { _origIlog(type, detail); _updateDbg(); };
        // Re-register with patched logger — but since _ilog is used by closures above,
        // we need to update the overlay via an interval instead
        setInterval(_updateDbg, 200);
        console.log('[remux] IME diagnostic active + overlay. Access via window._imeDiag.events or localStorage._imeDiag');
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
      if (!tab.ended) tab.pty.kill();
    }
  }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

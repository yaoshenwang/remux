/**
 * Session and tab management for Remux.
 * Data model, PTY lifecycle, scrollback, VT tracking, persistence.
 */

import fs from "fs";
import { homedir } from "os";
import pty from "node-pty";
import {
  upsertSession,
  upsertTab,
  loadSessions as loadSessionsFromDb,
  removeSession as removeSessionFromDb,
  removeStaleTab,
  createCommand,
  completeCommand,
  type CommandRecord,
} from "./store.js";
import { broadcastPush } from "./push.js";
import type { IPty } from "node-pty";
import type WebSocket from "ws";
import { createVtTerminal, type VtTerminal } from "./vt-tracker.js";

// ── Idle activity tracking (for push on resume) ─────────────────

const IDLE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
let lastOutputTimestamp = Date.now();
let isIdle = false;

// ── RingBuffer ───────────────────────────────────────────────────

export class RingBuffer {
  buf: Buffer;
  maxBytes: number;
  writePos: number;
  length: number;

  constructor(maxBytes = 10 * 1024 * 1024) {
    this.buf = Buffer.alloc(maxBytes);
    this.maxBytes = maxBytes;
    this.writePos = 0;
    this.length = 0;
  }

  write(data: string | Buffer): void {
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

  read(): Buffer {
    if (this.length === 0) return Buffer.alloc(0);
    if (this.length < this.maxBytes) {
      // Return a copy to prevent data corruption if buffer is written to before consumer finishes
      return Buffer.from(this.buf.subarray(this.writePos - this.length, this.writePos));
    }
    return Buffer.concat([
      this.buf.subarray(this.writePos),
      this.buf.subarray(0, this.writePos),
    ]);
  }
}

// ── Types ────────────────────────────────────────────────────────

export interface RemuxWebSocket extends WebSocket {
  _remuxTabId: number | null;
  _remuxCols: number;
  _remuxRows: number;
  _remuxAuthed: boolean;
  _remuxDeviceId: string | null;
}

/** Shell integration state tracking for OSC 133 sequences. */
export interface ShellIntegration {
  /** Current phase: 'idle' | 'prompt' | 'command' | 'output' */
  phase: "idle" | "prompt" | "command" | "output";
  /** Buffer to capture command text between 133;B and 133;C */
  commandBuffer: string;
  /** Current working directory from OSC 7 */
  cwd: string | null;
  /** Active command record ID (from DB) */
  activeCommandId: string | null;
}

export interface Tab {
  id: number;
  pty: IPty;
  scrollback: RingBuffer;
  vt: VtTerminal | null;
  clients: Set<RemuxWebSocket>;
  cols: number;
  rows: number;
  ended: boolean;
  title: string;
  /** Shell integration state for OSC 133 command tracking */
  shellIntegration: ShellIntegration;
}

export interface Session {
  name: string;
  tabs: Tab[];
  createdAt: number;
}

// ── Data Model ───────────────────────────────────────────────────
//
//  Session "work"          <- sidebar (left)
//  +-- Tab 0  (PTY: zsh)  <- tab bar (right)
//  +-- Tab 1  (PTY: vim)
//  +-- Tab 2  (PTY: htop)
//
//  Session "logs"
//  +-- Tab 0  (PTY: tail)

function getShell(): string {
  if (process.platform === "win32") return process.env.COMSPEC || "cmd.exe";
  if (process.env.SHELL) return process.env.SHELL;
  try {
    fs.accessSync("/bin/zsh", fs.constants.X_OK);
    return "/bin/zsh";
  } catch {}
  return "/bin/bash";
}

// ── State ────────────────────────────────────────────────────────

let tabIdCounter = 0;
export const sessionMap = new Map<string, Session>();
export const controlClients = new Set<RemuxWebSocket>();

// ── Shell Integration: OSC 133 + OSC 7 parsing ─────────────────

/**
 * Parse PTY output for shell integration OSC sequences:
 * - OSC 133;A -- prompt start
 * - OSC 133;B -- command start (user pressed Enter)
 * - OSC 133;C -- command output start
 * - OSC 133;D;exitcode -- command end with exit code
 * - OSC 7;file://host/path -- CWD update
 *
 * Adapted from Warp terminal / VS Code shell integration patterns.
 */
export function processShellIntegration(
  data: string,
  tab: Tab,
  sessionName: string,
): void {
  const si = tab.shellIntegration;

  // OSC 7: CWD tracking -- \x1b]7;file://host/path\x07 or \x1b]7;file://host/path\x1b\\
  const osc7Re = /\x1b\]7;file:\/\/[^/]*([^\x07\x1b]*?)(?:\x07|\x1b\\)/g;
  let m7;
  while ((m7 = osc7Re.exec(data)) !== null) {
    const cwdPath = decodeURIComponent(m7[1]);
    if (cwdPath) si.cwd = cwdPath;
  }

  // OSC 133: command boundary markers
  // Match \x1b]133;X(;params)?\x07 or \x1b]133;X(;params)?\x1b\\
  const osc133Re = /\x1b\]133;([ABCD])(?:;([^\x07\x1b]*?))?(?:\x07|\x1b\\)/g;
  let m;
  while ((m = osc133Re.exec(data)) !== null) {
    const marker = m[1];
    const params = m[2] || "";

    switch (marker) {
      case "A": // Prompt start
        si.phase = "prompt";
        si.commandBuffer = "";
        break;

      case "B": // Command start (after Enter)
        si.phase = "command";
        si.commandBuffer = "";
        break;

      case "C": { // Command output start -- capture command text between B and C
        // The text between B and C markers contains the command
        // We extract it from data between the B marker end and C marker start
        const bIdx = data.indexOf("\x1b]133;B");
        const cIdx = data.indexOf("\x1b]133;C");
        if (bIdx >= 0 && cIdx > bIdx) {
          // Find end of B marker
          const bEnd = data.indexOf("\x07", bIdx);
          const bEnd2 = data.indexOf("\x1b\\", bIdx);
          const bEndPos = bEnd >= 0 && bEnd < cIdx
            ? bEnd + 1
            : bEnd2 >= 0 && bEnd2 < cIdx
              ? bEnd2 + 2
              : bIdx + 9; // fallback: skip \x1b]133;B\x07
          const cmdText = data.slice(bEndPos, cIdx).trim();
          if (cmdText) si.commandBuffer = cmdText;
        }
        si.phase = "output";
        // Create command record in DB
        const cmd = createCommand({
          sessionName,
          tabId: tab.id,
          command: si.commandBuffer || undefined,
          cwd: si.cwd || undefined,
        });
        si.activeCommandId = cmd.id;
        break;
      }

      case "D": { // Command end with exit code
        const exitCode = params ? parseInt(params, 10) : 0;
        if (si.activeCommandId) {
          completeCommand(
            si.activeCommandId,
            isNaN(exitCode) ? 0 : exitCode,
          );
          si.activeCommandId = null;
        }
        si.phase = "idle";
        si.commandBuffer = "";
        break;
      }
    }
  }
}

// ── Tab lifecycle ────────────────────────────────────────────────

export function createTab(
  session: Session,
  cols = 80,
  rows = 24,
): Tab {
  const id = tabIdCounter++;
  const ptyProcess = pty.spawn(getShell(), [], {
    name: "xterm-256color",
    cols,
    rows,
    cwd: homedir(),
    env: {
      ...process.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
    },
  });

  const vtTerminal = createVtTerminal(cols, rows);

  const tab: Tab = {
    id,
    pty: ptyProcess,
    scrollback: new RingBuffer(),
    vt: vtTerminal,
    clients: new Set(),
    cols,
    rows,
    ended: false,
    title: `Tab ${session.tabs.length + 1}`,
    shellIntegration: {
      phase: "idle",
      commandBuffer: "",
      cwd: null,
      activeCommandId: null,
    },
  };

  ptyProcess.onData((data: string) => {
    tab.scrollback.write(data);
    if (tab.vt) tab.vt.consume(data);
    for (const ws of tab.clients) {
      sendData(ws, data);
    }

    // Shell integration: parse OSC 133 / OSC 7 sequences
    processShellIntegration(data, tab, session.name);

    // E10: dispatch terminal data to adapters
    try {
      const { adapterRegistry } = require("./server.js");
      adapterRegistry?.dispatchTerminalData(session.name, data);
    } catch { /* adapter not initialized yet */ }

    // Idle activity tracking: notify on resume after >5 min silence
    const now = Date.now();
    const wasIdle = isIdle || (now - lastOutputTimestamp > IDLE_THRESHOLD_MS);
    if (now - lastOutputTimestamp > IDLE_THRESHOLD_MS) {
      isIdle = true;
    }
    if (wasIdle && isIdle) {
      isIdle = false;
      // Collect deviceIds of currently connected clients to exclude
      const connectedDeviceIds: string[] = [];
      for (const ws of controlClients) {
        if (ws._remuxDeviceId) connectedDeviceIds.push(ws._remuxDeviceId);
      }
      broadcastPush(
        "Terminal Activity",
        `New output in "${session.name}" after idle`,
        connectedDeviceIds,
      ).catch(() => {});
    }
    lastOutputTimestamp = now;
  });

  ptyProcess.onExit(({ exitCode }) => {
    tab.ended = true;
    if (tab.vt) {
      tab.vt.dispose();
      tab.vt = null;
    }
    const msg = `\r\n\x1b[33mShell exited (code: ${exitCode})\x1b[0m\r\n`;
    for (const ws of tab.clients) {
      sendData(ws, msg);
    }
    broadcastState();

    // Push notification: shell exit
    broadcastPush(
      "Shell Exited",
      `"${session.name}" tab "${tab.title}" exited (code: ${exitCode})`,
    ).catch(() => {});
  });

  session.tabs.push(tab);
  console.log(
    `[tab] created id=${id} in session "${session.name}" (pid=${ptyProcess.pid})`,
  );
  return tab;
}

// ── Session lifecycle ────────────────────────────────────────────

export function createSession(name: string): Session {
  if (sessionMap.has(name)) return sessionMap.get(name)!;
  const session: Session = { name, tabs: [], createdAt: Date.now() };
  sessionMap.set(name, session);
  console.log(`[session] created "${name}"`);
  return session;
}

export function deleteSession(name: string): void {
  const session = sessionMap.get(name);
  if (!session) return;
  for (const tab of session.tabs) {
    if (!tab.ended) tab.pty.kill();
  }
  sessionMap.delete(name);
  removeSessionFromDb(name);
  console.log(`[session] deleted "${name}"`);
}

// ── State queries ────────────────────────────────────────────────

/** Return the name of the first existing session, or null if none. */
export function getFirstSessionName(): string | null {
  const first = sessionMap.values().next();
  return first.done ? null : first.value.name;
}

export function getState(): Array<{
  name: string;
  tabs: Array<{
    id: number;
    title: string;
    ended: boolean;
    clients: number;
  }>;
  createdAt: number;
}> {
  return [...sessionMap.values()].map((s) => ({
    name: s.name,
    tabs: s.tabs.map((t) => ({
      id: t.id,
      title: t.title,
      ended: t.ended,
      clients: t.clients.size,
    })),
    createdAt: s.createdAt,
  }));
}

export function findTab(
  tabId: number | null,
): { session: Session; tab: Tab } | null {
  if (tabId == null) return null;
  for (const session of sessionMap.values()) {
    const tab = session.tabs.find((t) => t.id === tabId);
    if (tab) return { session, tab };
  }
  return null;
}

// ── Attach / Detach ──────────────────────────────────────────────

/**
 * Attach ws to a specific tab -- detach from previous first.
 * Uses tsm-style snapshot: if VT tracking available, send viewport
 * snapshot; otherwise fall back to raw scrollback.
 * After snapshot, resize PTY + send Ctrl+L to trigger app redraw.
 */
export function attachToTab(
  tab: Tab,
  ws: RemuxWebSocket,
  cols: number,
  rows: number,
): void {
  detachFromTab(ws);

  if (ws.readyState === ws.OPEN) {
    if (tab.vt && !tab.ended) {
      // tsm pattern: send VT snapshot (screen content with colors + cursor)
      const snapshot = tab.vt.snapshot();
      if (snapshot) sendData(ws, snapshot);
    } else {
      // fallback: raw scrollback
      const history = tab.scrollback.read();
      if (history.length > 0) sendData(ws, history.toString("utf8"));
    }
  }

  tab.clients.add(ws);
  ws._remuxTabId = tab.id;
  ws._remuxCols = cols;
  ws._remuxRows = rows;
  recalcTabSize(tab);

  // Only send Ctrl+L redraw when a VT snapshot exists (app is actively
  // rendering).  Idle shells don't need it and it pollutes scrollback
  // with ^L artifacts visible in Inspect.
  if (!tab.ended && tab.vt) {
    const { text } = tab.vt.textSnapshot();
    // Only redraw if there's real content beyond an empty prompt
    if (text && text.trim().length > 0) {
      setTimeout(() => {
        tab.pty.write("\x0c");
      }, 50);
    }
  }
}

export function detachFromTab(ws: RemuxWebSocket): void {
  const prevId = ws._remuxTabId;
  if (prevId == null) return;
  // find tab across all sessions
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

export function recalcTabSize(tab: Tab): void {
  let minCols = Infinity;
  let minRows = Infinity;
  for (const ws of tab.clients) {
    if (ws._remuxCols) minCols = Math.min(minCols, ws._remuxCols);
    if (ws._remuxRows) minRows = Math.min(minRows, ws._remuxRows);
  }
  if (minCols < Infinity && minRows < Infinity && !tab.ended) {
    // Clamp to sane ranges to prevent crashes or extreme memory allocation
    minCols = Math.max(1, Math.min(minCols, 500));
    minRows = Math.max(1, Math.min(minRows, 200));
    tab.cols = minCols;
    tab.rows = minRows;
    tab.pty.resize(minCols, minRows);
    if (tab.vt) tab.vt.resize(minCols, minRows);
  }
}

// ── Broadcast ────────────────────────────────────────────────────

// Broadcast hooks -- injected by ws-handler to avoid circular imports.
// sendEnvelopeFn and getClientListFn are set at startup.
let _sendEnvelopeFn: ((ws: any, type: string, payload: any) => void) | null =
  null;
let _getClientListFn: (() => any[]) | null = null;
// E2EE-aware data send hook: encrypts raw terminal data when E2EE is active
let _sendDataFn: ((ws: any, data: string) => void) | null = null;

export function setBroadcastHooks(
  sendFn: (ws: any, type: string, payload: any) => void,
  clientListFn: () => any[],
  sendDataFn?: (ws: any, data: string) => void,
): void {
  _sendEnvelopeFn = sendFn;
  _getClientListFn = clientListFn;
  if (sendDataFn) _sendDataFn = sendDataFn;
}

/** Send raw data to a client, using E2EE if available. */
function sendData(ws: RemuxWebSocket, data: string): void {
  if (_sendDataFn) {
    _sendDataFn(ws, data);
  } else if (ws.readyState === ws.OPEN) {
    ws.send(data);
  }
}

export function broadcastState(): void {
  const state = getState();
  const clients = _getClientListFn ? _getClientListFn() : [];
  for (const ws of controlClients) {
    if (_sendEnvelopeFn) {
      _sendEnvelopeFn(ws, "state", { sessions: state, clients });
    } else {
      // Fallback: legacy format (before hooks are wired)
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ v: 1, type: "state", payload: { sessions: state, clients } }));
      }
    }
  }
}

// ── Persistence (SQLite via store.ts) ────────────────────────────

export const PERSIST_INTERVAL_MS = 8000;

/**
 * Persist all live sessions and tabs to SQLite (scrollback as BLOB).
 */
export function persistSessions(): void {
  try {
    for (const session of sessionMap.values()) {
      upsertSession(session.name, session.createdAt);
      for (const tab of session.tabs) {
        upsertTab({
          id: tab.id,
          sessionName: session.name,
          title: tab.title,
          scrollback: tab.ended ? null : tab.scrollback.read(),
          ended: tab.ended,
        });
      }
    }
  } catch (e: any) {
    console.error("[persist] save failed:", e.message);
  }
}

/**
 * Restore sessions from SQLite. Returns saved data or false.
 */
export function restoreSessions(): {
  sessions: Array<{
    name: string;
    createdAt: number;
    tabs: Array<{
      id: number;
      title: string;
      ended: boolean;
      scrollback: Buffer | null;
    }>;
  }>;
} | false {
  try {
    const sessions = loadSessionsFromDb();
    if (sessions.length === 0) return false;
    console.log(`[persist] restoring ${sessions.length} session(s) from SQLite`);
    return { sessions };
  } catch (e: any) {
    console.error("[persist] restore failed:", e.message);
    return false;
  }
}

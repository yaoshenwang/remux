/**
 * Session and tab management for Remux.
 * Data model, PTY lifecycle, scrollback, VT tracking, persistence.
 */

import fs from "fs";
import path from "path";
import { homedir } from "os";
import pty from "node-pty";
import type { IPty } from "node-pty";
import type WebSocket from "ws";
import { createVtTerminal, type VtTerminal } from "./vt-tracker.js";

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
      return this.buf.subarray(this.writePos - this.length, this.writePos);
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
  };

  ptyProcess.onData((data: string) => {
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
    const msg = `\r\n\x1b[33mShell exited (code: ${exitCode})\x1b[0m\r\n`;
    for (const ws of tab.clients) {
      if (ws.readyState === ws.OPEN) ws.send(msg);
    }
    broadcastState();
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
  console.log(`[session] deleted "${name}"`);
}

// ── State queries ────────────────────────────────────────────────

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
      tab.pty.write("\x0c"); // Ctrl+L -- forces shell/vim/etc to redraw
    }, 50);
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

export function setBroadcastHooks(
  sendFn: (ws: any, type: string, payload: any) => void,
  clientListFn: () => any[],
): void {
  _sendEnvelopeFn = sendFn;
  _getClientListFn = clientListFn;
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

// ── Persistence ──────────────────────────────────────────────────

const PERSIST_DIR = path.join(homedir(), ".remux");
const PORT = process.env.PORT || 8767;
const PERSIST_ID = process.env.REMUX_INSTANCE_ID || `port-${PORT}`;
const PERSIST_FILE = path.join(PERSIST_DIR, `sessions-${PERSIST_ID}.json`);
export const PERSIST_INTERVAL_MS = 8000;

export function persistSessions(): void {
  const data = [...sessionMap.values()].map((s) => ({
    name: s.name,
    createdAt: s.createdAt,
    tabs: s.tabs.map((t) => ({
      id: t.id,
      title: t.title,
      ended: t.ended,
      scrollback: t.ended
        ? null
        : t.scrollback.read().toString("utf8").slice(-200000),
    })),
  }));
  try {
    if (!fs.existsSync(PERSIST_DIR))
      fs.mkdirSync(PERSIST_DIR, { recursive: true });
    fs.writeFileSync(
      PERSIST_FILE,
      JSON.stringify({ version: 1, sessions: data }),
    );
  } catch (e: any) {
    console.error("[persist] save failed:", e.message);
  }
}

export function restoreSessions(): {
  version: number;
  sessions: Array<{
    name: string;
    createdAt: number;
    tabs: Array<{
      id: number;
      title: string;
      ended: boolean;
      scrollback: string | null;
    }>;
  }>;
} | false {
  try {
    if (!fs.existsSync(PERSIST_FILE)) return false;
    const raw = JSON.parse(fs.readFileSync(PERSIST_FILE, "utf8"));
    if (raw.version !== 1 || !Array.isArray(raw.sessions)) return false;
    console.log(`[persist] restoring ${raw.sessions.length} session(s)`);
    return raw;
  } catch (e: any) {
    console.error("[persist] restore failed:", e.message);
    return false;
  }
}

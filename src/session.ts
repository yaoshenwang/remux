/**
 * Session and tab management for Remux.
 * Data model, PTY lifecycle, scrollback, VT tracking, persistence.
 * Supports both direct PTY and daemon-backed PTY modes.
 */

import fs from "fs";
import path from "path";
import net from "net";
import { homedir } from "os";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
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
import {
  encodeFrame,
  FrameParser,
  TAG_PTY_OUTPUT,
  TAG_CLIENT_INPUT,
  TAG_RESIZE,
  TAG_STATUS_REQ,
  TAG_SNAPSHOT_REQ,
  TAG_SHUTDOWN,
} from "./pty-daemon.js";
import type { IPty } from "node-pty";
import type WebSocket from "ws";
import { createVtTerminal, type VtTerminal } from "./vt-tracker.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
  pty: IPty | null;
  scrollback: RingBuffer;
  vt: VtTerminal | null;
  clients: Set<RemuxWebSocket>;
  cols: number;
  rows: number;
  ended: boolean;
  title: string;
  /** Shell integration state for OSC 133 command tracking */
  shellIntegration: ShellIntegration;
  /** Path to daemon Unix socket (null = direct PTY mode) */
  daemonSocket: string | null;
  /** Connected client socket to daemon (null = not connected) */
  daemonClient: net.Socket | null;
  /** True when tab was restored from DB with dead daemon (readonly until user presses Enter) */
  restored: boolean;
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

// ── Daemon helpers ──────────────────────────────────────────────

/**
 * Get the path to the compiled pty-daemon.js script.
 * It's compiled alongside server.js in the same directory.
 */
function getDaemonScriptPath(): string {
  return path.join(__dirname, "pty-daemon.js");
}

/**
 * Build a unique socket path for a tab's daemon.
 * Includes process PID to avoid collisions between server instances.
 */
function buildSocketPath(tabId: number): string {
  return `/tmp/remux-pty-${tabId}-${process.pid}.sock`;
}

/**
 * Spawn a PTY daemon as a detached child process.
 * Returns the socket path where the daemon listens.
 */
function spawnDaemon(
  tabId: number,
  shell: string,
  cols: number,
  rows: number,
  cwd: string,
): string {
  const socketPath = buildSocketPath(tabId);
  const daemonScript = getDaemonScriptPath();

  const child = spawn(process.execPath, [
    daemonScript,
    "--socket", socketPath,
    "--shell", shell,
    "--cols", String(cols),
    "--rows", String(rows),
    "--cwd", cwd,
    "--tab-id", String(tabId),
  ], {
    detached: true,
    stdio: "ignore",
  });

  child.unref();
  console.log(`[session] spawned daemon for tab ${tabId}: pid=${child.pid} socket=${socketPath}`);
  return socketPath;
}

/**
 * Connect to a daemon's Unix socket. Returns a Promise that resolves
 * with the connected socket, or rejects on timeout/error.
 */
function connectToDaemon(
  socketPath: string,
  retries = 20,
  delayMs = 100,
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    let attempt = 0;

    function tryConnect() {
      attempt++;
      const socket = net.createConnection({ path: socketPath }, () => {
        resolve(socket);
      });

      socket.on("error", (err) => {
        socket.destroy();
        if (attempt < retries) {
          setTimeout(tryConnect, delayMs);
        } else {
          reject(new Error(`Failed to connect to daemon at ${socketPath} after ${retries} attempts: ${err.message}`));
        }
      });
    }

    tryConnect();
  });
}

/**
 * Wire up daemon socket data to tab clients and shell integration.
 * The daemon sends TLV frames; we parse them and broadcast PTY output.
 */
function wireDaemonToTab(
  tab: Tab,
  daemonSocket: net.Socket,
  sessionName: string,
): void {
  const parser = new FrameParser((tag, payload) => {
    if (tag === TAG_PTY_OUTPUT) {
      const data = payload.toString("utf8");
      tab.scrollback.write(data);
      if (tab.vt) tab.vt.consume(data);
      for (const ws of tab.clients) {
        sendData(ws, data);
      }

      // Buffer PTY output for recently-disconnected devices watching this tab
      if (_bufferTabOutputFn) _bufferTabOutputFn(tab.id, data);

      // Shell integration: parse OSC 133 / OSC 7 sequences
      processShellIntegration(data, tab, sessionName);

      // E10: dispatch terminal data to adapters
      try {
        const { adapterRegistry } = require("./server.js");
        adapterRegistry?.dispatchTerminalData(sessionName, data);
      } catch { /* adapter not initialized yet */ }

      // Idle activity tracking: notify on resume after >5 min silence
      const now = Date.now();
      const wasIdle = isIdle || (now - lastOutputTimestamp > IDLE_THRESHOLD_MS);
      if (now - lastOutputTimestamp > IDLE_THRESHOLD_MS) {
        isIdle = true;
      }
      if (wasIdle && isIdle) {
        isIdle = false;
        const connectedDeviceIds: string[] = [];
        for (const ws of controlClients) {
          if (ws._remuxDeviceId) connectedDeviceIds.push(ws._remuxDeviceId);
        }
        broadcastPush(
          "Terminal Activity",
          `New output in "${sessionName}" after idle`,
          connectedDeviceIds,
        ).catch(() => {});
      }
      lastOutputTimestamp = now;
    }
  });

  daemonSocket.on("data", (data: Buffer) => {
    parser.feed(data);
  });

  daemonSocket.on("close", () => {
    console.log(`[session] daemon connection closed for tab ${tab.id}`);
    tab.daemonClient = null;
    // If the daemon connection closes unexpectedly and tab isn't ended, mark as ended
    if (!tab.ended) {
      tab.ended = true;
      if (tab.vt) {
        tab.vt.dispose();
        tab.vt = null;
      }
      const msg = `\r\n\x1b[33mDaemon connection lost\x1b[0m\r\n`;
      for (const ws of tab.clients) {
        sendData(ws, msg);
      }
      broadcastState();
    }
  });

  daemonSocket.on("error", (err) => {
    console.error(`[session] daemon socket error for tab ${tab.id}:`, err.message);
  });
}

/**
 * Spawn a new daemon for a restored tab (user pressed Enter to revive).
 */
export async function reviveTab(tab: Tab, session: Session): Promise<boolean> {
  if (!tab.restored) return false;

  const shell = getShell();
  const socketPath = spawnDaemon(tab.id, shell, tab.cols, tab.rows, homedir());

  try {
    const client = await connectToDaemon(socketPath);
    tab.daemonSocket = socketPath;
    tab.daemonClient = client;
    tab.restored = false;
    tab.ended = false;

    // Create a new VT terminal for the revived tab
    tab.vt = createVtTerminal(tab.cols, tab.rows);

    wireDaemonToTab(tab, client, session.name);

    console.log(`[session] revived tab ${tab.id} in session "${session.name}"`);
    broadcastState();
    return true;
  } catch (err: any) {
    console.error(`[session] failed to revive tab ${tab.id}:`, err.message);
    return false;
  }
}

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
  const shell = getShell();

  // Check if daemon script exists — if so, use daemon mode
  const daemonScript = getDaemonScriptPath();
  const useDaemon = fs.existsSync(daemonScript);

  let ptyProcess: IPty | null = null;
  let socketPath: string | null = null;

  const vtTerminal = createVtTerminal(cols, rows);

  const tab: Tab = {
    id,
    pty: null,
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
    daemonSocket: null,
    daemonClient: null,
    restored: false,
  };

  if (useDaemon) {
    // Daemon mode: spawn detached pty-daemon process
    socketPath = spawnDaemon(id, shell, cols, rows, homedir());
    tab.daemonSocket = socketPath;

    // Connect to daemon asynchronously
    connectToDaemon(socketPath).then((client) => {
      tab.daemonClient = client;
      wireDaemonToTab(tab, client, session.name);
      console.log(`[tab] daemon connected for id=${id} in session "${session.name}"`);
    }).catch((err) => {
      console.error(`[tab] failed to connect to daemon for id=${id}:`, err.message);
      // Fallback: spawn direct PTY
      spawnDirectPty(tab, session, shell, cols, rows);
    });
  } else {
    // Direct PTY mode (fallback when daemon script not available)
    spawnDirectPty(tab, session, shell, cols, rows);
  }

  session.tabs.push(tab);
  console.log(
    `[tab] created id=${id} in session "${session.name}" (mode=${useDaemon ? "daemon" : "direct"})`,
  );
  return tab;
}

/**
 * Spawn a direct PTY (non-daemon fallback mode).
 * Used when pty-daemon.js is not available or daemon connection fails.
 */
function spawnDirectPty(
  tab: Tab,
  session: Session,
  shell: string,
  cols: number,
  rows: number,
): void {
  const ptyProcess = pty.spawn(shell, [], {
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

  tab.pty = ptyProcess;

  ptyProcess.onData((data: string) => {
    tab.scrollback.write(data);
    if (tab.vt) tab.vt.consume(data);
    for (const ws of tab.clients) {
      sendData(ws, data);
    }

    // Buffer PTY output for recently-disconnected devices watching this tab
    if (_bufferTabOutputFn) _bufferTabOutputFn(tab.id, data);

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
    if (!tab.ended) {
      if (tab.daemonClient) {
        // Send shutdown command to daemon
        try {
          tab.daemonClient.write(encodeFrame(TAG_SHUTDOWN, Buffer.alloc(0)));
        } catch { /* ignore */ }
      } else if (tab.pty) {
        tab.pty.kill();
      }
    }
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
    restored: boolean;
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
      restored: t.restored,
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

  // Send restored banner if tab is in restored-readonly mode
  if (tab.restored) {
    const banner = `\r\n\x1b[33m[Session restored — shell has exited. Press Enter to start a new shell.]\x1b[0m\r\n`;
    sendData(ws, banner);
  }

  // Only send Ctrl+L redraw when a VT snapshot exists (app is actively
  // rendering).  Idle shells don't need it and it pollutes scrollback
  // with ^L artifacts visible in Inspect.
  if (!tab.ended && !tab.restored && tab.vt) {
    const { text } = tab.vt.textSnapshot();
    // Only redraw if there's real content beyond an empty prompt
    if (text && text.trim().length > 0) {
      setTimeout(() => {
        if (tab.daemonClient) {
          tab.daemonClient.write(encodeFrame(TAG_CLIENT_INPUT, "\x0c"));
        } else if (tab.pty) {
          tab.pty.write("\x0c");
        }
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
    if (tab.daemonClient) {
      // Send resize to daemon
      const resizePayload = JSON.stringify({ cols: minCols, rows: minRows });
      tab.daemonClient.write(encodeFrame(TAG_RESIZE, resizePayload));
    } else if (tab.pty) {
      tab.pty.resize(minCols, minRows);
    }
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

// Buffer hooks -- injected by ws-handler for offline message queuing.
let _bufferTabOutputFn: ((tabId: number, data: string) => void) | null = null;
let _bufferStateForDisconnectedFn: (() => void) | null = null;

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

/**
 * Set buffer hooks for offline message queuing.
 * Called by ws-handler after initialization to avoid circular imports.
 */
export function setBufferHooks(
  bufferTabOutputFn: (tabId: number, data: string) => void,
  bufferStateFn: () => void,
): void {
  _bufferTabOutputFn = bufferTabOutputFn;
  _bufferStateForDisconnectedFn = bufferStateFn;
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
  // Also buffer state for recently-disconnected devices
  if (_bufferStateForDisconnectedFn) _bufferStateForDisconnectedFn();
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

/**
 * Check if a daemon socket file exists and is connectable.
 * Used during session restore to detect alive daemons.
 */
export function findAliveDaemonSocket(tabId: number): string | null {
  // Look for any socket file matching the tab ID pattern
  const tmpDir = "/tmp";
  try {
    const files = fs.readdirSync(tmpDir);
    const pattern = `remux-pty-${tabId}-`;
    for (const f of files) {
      if (f.startsWith(pattern) && f.endsWith(".sock")) {
        return path.join(tmpDir, f);
      }
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Create a restored tab (from persisted data, without a live PTY).
 * The tab is in restored-readonly mode until the user activates it.
 */
export function createRestoredTab(
  session: Session,
  savedTab: { id: number; title: string; scrollback: Buffer | null; ended: boolean },
): Tab {
  // Ensure tabIdCounter stays ahead of restored IDs
  if (savedTab.id >= tabIdCounter) {
    tabIdCounter = savedTab.id + 1;
  }

  const vtTerminal = createVtTerminal(80, 24);

  const tab: Tab = {
    id: savedTab.id,
    pty: null,
    scrollback: new RingBuffer(),
    vt: vtTerminal,
    clients: new Set(),
    cols: 80,
    rows: 24,
    ended: savedTab.ended,
    title: savedTab.title || `Tab ${session.tabs.length + 1}`,
    shellIntegration: {
      phase: "idle",
      commandBuffer: "",
      cwd: null,
      activeCommandId: null,
    },
    daemonSocket: null,
    daemonClient: null,
    restored: !savedTab.ended, // only "restored" if not already ended
  };

  // Pre-fill scrollback
  if (savedTab.scrollback) {
    tab.scrollback.write(savedTab.scrollback);
    if (tab.vt) tab.vt.consume(savedTab.scrollback);
  }

  session.tabs.push(tab);
  return tab;
}

/**
 * Attempt to reattach to an alive daemon for a restored tab.
 * Returns true if reattach succeeded, false otherwise.
 */
export async function reattachToDaemon(
  tab: Tab,
  session: Session,
  socketPath: string,
): Promise<boolean> {
  try {
    const client = await connectToDaemon(socketPath, 3, 50);
    tab.daemonSocket = socketPath;
    tab.daemonClient = client;
    tab.restored = false;
    tab.ended = false;

    wireDaemonToTab(tab, client, session.name);

    console.log(`[session] reattached to daemon for tab ${tab.id} at ${socketPath}`);
    return true;
  } catch (err: any) {
    console.log(`[session] daemon at ${socketPath} not reachable: ${err.message}`);
    return false;
  }
}

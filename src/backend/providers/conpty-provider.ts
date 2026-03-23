/**
 * Persistent session provider for platforms without tmux.
 *
 * Manages long-lived PTY sessions in-process using node-pty.
 * Sessions survive client disconnects — the provider keeps them alive
 * until explicitly killed, just like tmux would.
 *
 * On Windows this uses ConPTY under the hood (via node-pty).
 * On Unix it uses the native PTY subsystem.
 */

import * as pty from "node-pty";
import os from "node:os";
import type { TmuxGateway } from "../tmux/types.js";
import type { PtyFactory, PtyProcess } from "../pty/pty-adapter.js";
import type {
  TmuxPaneState,
  TmuxSessionSummary,
  TmuxWindowState,
} from "../../shared/protocol.js";
import { toFlatStringEnv, withoutTmuxEnv } from "../util/env.js";

// ---------------------------------------------------------------------------
// Persistent session state
// ---------------------------------------------------------------------------

interface ManagedSession {
  name: string;
  /** The underlying node-pty process. */
  ptyProcess: pty.IPty;
  /** Ring buffer of recent output for capturePane. */
  outputBuffer: string[];
  /** Maximum lines to keep in the ring buffer. */
  maxScrollback: number;
  /** Current terminal dimensions. */
  cols: number;
  rows: number;
  /** The command running inside the PTY. */
  command: string;
  /** Timestamp when session was created. */
  createdAt: Date;
  /** Whether a client is currently viewing this session. */
  attached: boolean;
}

// ---------------------------------------------------------------------------
// ConPtySessionProvider — implements TmuxGateway
// ---------------------------------------------------------------------------

export class ConPtySessionProvider implements TmuxGateway {
  private sessions = new Map<string, ManagedSession>();
  private readonly defaultShell: string;
  private readonly scrollbackLines: number;

  constructor(
    private readonly logger?: Pick<Console, "log" | "error">,
    options?: { scrollbackLines?: number }
  ) {
    this.scrollbackLines = options?.scrollbackLines ?? 1000;
    this.defaultShell =
      os.platform() === "win32"
        ? process.env.COMSPEC ?? "cmd.exe"
        : process.env.SHELL ?? "/bin/bash";
  }

  async listSessions(): Promise<TmuxSessionSummary[]> {
    return Array.from(this.sessions.values()).map((s) => ({
      name: s.name,
      attached: s.attached,
      windows: 1, // Each session has one "window" (single pane)
    }));
  }

  async listWindows(
    session: string
  ): Promise<Omit<TmuxWindowState, "panes">[]> {
    const s = this.sessions.get(session);
    if (!s) return [];
    return [
      {
        index: 0,
        name: s.command,
        active: true,
        paneCount: 1,
      },
    ];
  }

  async listPanes(
    session: string,
    _windowIndex: number
  ): Promise<TmuxPaneState[]> {
    const s = this.sessions.get(session);
    if (!s) return [];
    return [
      {
        index: 0,
        id: `%${session}-0`,
        currentCommand: s.command,
        currentPath: process.cwd(),
        active: true,
        width: s.cols,
        height: s.rows,
        zoomed: false,
      },
    ];
  }

  async createSession(name: string): Promise<void> {
    if (this.sessions.has(name)) {
      this.logger?.log(`[conpty] session "${name}" already exists`);
      return;
    }
    this.spawnSession(name);
  }

  async createGroupedSession(
    name: string,
    _targetSession: string
  ): Promise<void> {
    // Grouped sessions share windows in tmux. In our model, we create
    // a new "view" of the same session. For now, just track the name
    // as an alias — the server uses grouped sessions for multi-client
    // isolation, but with ConPTY we handle multi-client at a higher level.
    if (!this.sessions.has(name)) {
      // Create it pointing to the target session's PTY output.
      // The server's TerminalRuntime will attach to this.
      this.sessions.set(name, {
        ...this.getOrThrow(_targetSession),
        name,
        attached: false,
      });
    }
  }

  async killSession(name: string): Promise<void> {
    const session = this.sessions.get(name);
    if (!session) return;

    // Only kill the PTY if this is the original session (not an alias).
    const isAlias = Array.from(this.sessions.values()).some(
      (s) => s !== session && s.ptyProcess === session.ptyProcess
    );
    if (!isAlias) {
      session.ptyProcess.kill();
    }
    this.sessions.delete(name);
    this.logger?.log(`[conpty] killed session "${name}"`);
  }

  async switchClient(_session: string): Promise<void> {
    // No-op: tmux-specific concept (switch which session a client sees).
    // In our model, the server manages this at the WebSocket level.
  }

  async newWindow(_session: string): Promise<void> {
    // Not supported in single-pane model. Could be extended later.
    this.logger?.log("[conpty] newWindow not supported (single-pane sessions)");
  }

  async killWindow(_session: string, _windowIndex: number): Promise<void> {
    // Killing the only window kills the session.
    await this.killSession(_session);
  }

  async selectWindow(
    _session: string,
    _windowIndex: number
  ): Promise<void> {
    // No-op: single window per session.
  }

  async splitWindow(
    _paneId: string,
    _orientation: "h" | "v"
  ): Promise<void> {
    this.logger?.log("[conpty] splitWindow not supported");
  }

  async killPane(paneId: string): Promise<void> {
    const sessionName = this.sessionNameFromPaneId(paneId);
    if (sessionName) {
      await this.killSession(sessionName);
    }
  }

  async selectPane(_paneId: string): Promise<void> {
    // No-op: single pane per session.
  }

  async zoomPane(_paneId: string): Promise<void> {
    // No-op: single pane is always "zoomed".
  }

  async isPaneZoomed(_paneId: string): Promise<boolean> {
    return false;
  }

  async capturePane(paneId: string, lines: number): Promise<string> {
    const sessionName = this.sessionNameFromPaneId(paneId);
    if (!sessionName) return "";
    const session = this.sessions.get(sessionName);
    if (!session) return "";

    const buffer = session.outputBuffer;
    const start = Math.max(0, buffer.length - lines);
    return buffer.slice(start).join("");
  }

  // ---------------------------------------------------------------------------
  // Public helpers for the PtyFactory integration
  // ---------------------------------------------------------------------------

  /** Get the underlying IPty for a session (used by ConPtyFactory). */
  getSessionPty(name: string): pty.IPty | undefined {
    return this.sessions.get(name)?.ptyProcess;
  }

  /** Mark a session as attached/detached. */
  setAttached(name: string, attached: boolean): void {
    const session = this.sessions.get(name);
    if (session) {
      session.attached = attached;
    }
  }

  /** Resize a session's PTY. */
  resizeSession(name: string, cols: number, rows: number): void {
    const session = this.sessions.get(name);
    if (session) {
      session.ptyProcess.resize(cols, rows);
      session.cols = cols;
      session.rows = rows;
    }
  }

  /** Get the number of active sessions. */
  get sessionCount(): number {
    return this.sessions.size;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private spawnSession(name: string): ManagedSession {
    const cols = 200;
    const rows = 50;

    this.logger?.log(
      `[conpty] spawning session "${name}" (${this.defaultShell}, ${cols}x${rows})`
    );

    const spawned = pty.spawn(this.defaultShell, [], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: process.cwd(),
      env: toFlatStringEnv(withoutTmuxEnv(process.env)),
    });

    const session: ManagedSession = {
      name,
      ptyProcess: spawned,
      outputBuffer: [],
      maxScrollback: this.scrollbackLines,
      cols,
      rows,
      command: this.defaultShell,
      createdAt: new Date(),
      attached: false,
    };

    // Capture output into the ring buffer for capturePane.
    spawned.onData((data) => {
      // Split by newlines to store line-by-line.
      session.outputBuffer.push(data);
      // Trim to max scrollback.
      if (session.outputBuffer.length > session.maxScrollback) {
        session.outputBuffer.splice(
          0,
          session.outputBuffer.length - session.maxScrollback
        );
      }
    });

    spawned.onExit(({ exitCode }) => {
      this.logger?.log(
        `[conpty] session "${name}" exited with code ${exitCode}`
      );
      this.sessions.delete(name);
    });

    this.sessions.set(name, session);
    return session;
  }

  private getOrThrow(name: string): ManagedSession {
    const s = this.sessions.get(name);
    if (!s) throw new Error(`session "${name}" not found`);
    return s;
  }

  private sessionNameFromPaneId(paneId: string): string | undefined {
    // Pane IDs are formatted as "%sessionName-0"
    const match = paneId.match(/^%(.+)-\d+$/);
    return match?.[1];
  }
}

// ---------------------------------------------------------------------------
// ConPtyFactory — implements PtyFactory
// ---------------------------------------------------------------------------

/**
 * PtyFactory that connects to sessions managed by ConPtySessionProvider
 * instead of shelling out to `tmux attach`.
 *
 * When spawnTmuxAttach is called, it returns a PtyProcess that reads/writes
 * to the existing ConPTY session.
 */
export class ConPtyFactory implements PtyFactory {
  constructor(
    private readonly provider: ConPtySessionProvider,
    private readonly logger?: Pick<Console, "log" | "error">
  ) {}

  spawnTmuxAttach(session: string): PtyProcess {
    const ptyProcess = this.provider.getSessionPty(session);
    if (!ptyProcess) {
      throw new Error(
        `[conpty-factory] session "${session}" not found in provider`
      );
    }

    this.provider.setAttached(session, true);
    this.logger?.log(`[conpty-factory] attached to session "${session}"`);

    return new ConPtyProcess(ptyProcess, () => {
      this.provider.setAttached(session, false);
      this.logger?.log(`[conpty-factory] detached from session "${session}"`);
    });
  }
}

/**
 * PtyProcess wrapper around an existing node-pty IPty instance.
 * Does NOT own the process — the provider keeps it alive.
 */
class ConPtyProcess implements PtyProcess {
  private dataHandlers: Array<(data: string) => void> = [];
  private exitHandlers: Array<(code: number) => void> = [];
  private readonly dataDisposable: pty.IDisposable;
  private readonly exitDisposable: pty.IDisposable;

  constructor(
    private readonly process: pty.IPty,
    private readonly onDetach: () => void
  ) {
    // Forward events from the shared PTY to this client's handlers.
    this.dataDisposable = this.process.onData((data) => {
      for (const handler of this.dataHandlers) {
        handler(data);
      }
    });

    this.exitDisposable = this.process.onExit(({ exitCode }) => {
      for (const handler of this.exitHandlers) {
        handler(exitCode);
      }
    });
  }

  write(data: string): void {
    this.process.write(data);
  }

  resize(cols: number, rows: number): void {
    this.process.resize(cols, rows);
  }

  onData(handler: (data: string) => void): void {
    this.dataHandlers.push(handler);
  }

  onExit(handler: (code: number) => void): void {
    this.exitHandlers.push(handler);
  }

  kill(): void {
    // Don't kill the underlying PTY — just detach.
    this.dataDisposable.dispose();
    this.exitDisposable.dispose();
    this.dataHandlers = [];
    this.exitHandlers = [];
    this.onDetach();
  }
}

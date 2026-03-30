/**
 * Persistent session provider for platforms without zellij/tmux.
 *
 * Manages long-lived PTY sessions in-process using node-pty.
 * Sessions survive client disconnects — the provider keeps them alive
 * until explicitly killed, just like tmux/zellij would.
 *
 * On Windows this uses ConPTY under the hood (via node-pty).
 * On Unix it uses the native PTY subsystem.
 */

import * as pty from "node-pty";
import os from "node:os";

// ---------------------------------------------------------------------------
// Persistent session state
// ---------------------------------------------------------------------------

interface ManagedSession {
  name: string;
  /** The underlying node-pty process. */
  ptyProcess: pty.IPty;
  /** Ring buffer of recent output for screen capture. */
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
// ConPtySessionProvider
// ---------------------------------------------------------------------------

export class ConPtySessionProvider {
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

  /** List all active sessions. */
  listSessions(): Array<{ name: string; attached: boolean; cols: number; rows: number }> {
    return Array.from(this.sessions.values()).map((s) => ({
      name: s.name,
      attached: s.attached,
      cols: s.cols,
      rows: s.rows,
    }));
  }

  /** Create a new session. */
  createSession(name: string, cols = 200, rows = 50): void {
    if (this.sessions.has(name)) {
      this.logger?.log(`[conpty] session "${name}" already exists`);
      return;
    }
    this.spawnSession(name, cols, rows);
  }

  /** Kill a session. */
  killSession(name: string): void {
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

  /** Get captured output for a session. */
  captureOutput(name: string, lines: number): string {
    const session = this.sessions.get(name);
    if (!session) return "";
    const buffer = session.outputBuffer;
    const start = Math.max(0, buffer.length - lines);
    return buffer.slice(start).join("");
  }

  /** Get the number of active sessions. */
  get sessionCount(): number {
    return this.sessions.size;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private spawnSession(name: string, cols: number, rows: number): ManagedSession {
    this.logger?.log(
      `[conpty] spawning session "${name}" (${this.defaultShell}, ${cols}x${rows})`
    );

    const env = { ...process.env };
    // Remove tmux/zellij env vars that might confuse child processes.
    delete env.TMUX;
    delete env.TMUX_PANE;
    delete env.ZELLIJ;
    delete env.ZELLIJ_SESSION_NAME;

    const spawned = pty.spawn(this.defaultShell, [], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: process.cwd(),
      env: env as Record<string, string>,
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

    // Capture output into the ring buffer.
    spawned.onData((data) => {
      session.outputBuffer.push(data);
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
}

// ---------------------------------------------------------------------------
// ConPtyProcess — wraps an existing node-pty IPty for client attachment
// ---------------------------------------------------------------------------

/**
 * PtyProcess wrapper around an existing node-pty IPty instance.
 * Does NOT own the process — the provider keeps it alive.
 */
export class ConPtyProcess {
  private dataHandlers: Array<(data: string) => void> = [];
  private exitHandlers: Array<(info: { exitCode: number; signal?: number }) => void> = [];
  private readonly dataDisposable: pty.IDisposable;
  private readonly exitDisposable: pty.IDisposable;

  constructor(
    private readonly process: pty.IPty,
    private readonly onDetach: () => void
  ) {
    this.dataDisposable = this.process.onData((data) => {
      for (const handler of this.dataHandlers) {
        handler(data);
      }
    });

    this.exitDisposable = this.process.onExit(({ exitCode, signal }) => {
      for (const handler of this.exitHandlers) {
        handler({ exitCode, signal });
      }
    });
  }

  onData(callback: (data: string) => void): void {
    this.dataHandlers.push(callback);
  }

  onExit(callback: (info: { exitCode: number; signal?: number }) => void): void {
    this.exitHandlers.push(callback);
  }

  write(data: string): void {
    this.process.write(data);
  }

  resize(cols: number, rows: number): void {
    this.process.resize(cols, rows);
  }

  kill(): void {
    // Don't kill the underlying PTY — just detach.
    this.dataDisposable.dispose();
    this.exitDisposable.dispose();
    this.dataHandlers = [];
    this.exitHandlers = [];
    this.onDetach();
  }

  get pid(): number {
    return this.process.pid;
  }
}

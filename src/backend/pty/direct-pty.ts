/**
 * Direct shell PTY — spawns the user's shell via node-pty without Zellij.
 *
 * Provides the same interface shape as ZellijPty so the server can swap
 * implementations with minimal wiring changes.
 */

import { spawn as ptySpawn, type IPty } from "node-pty";

export interface DirectPtyOptions {
  /** Logical session name (for tracking, not multiplexer). */
  session?: string;
  /** Shell to spawn (default: $SHELL or /bin/sh). */
  shell?: string;
  /** Initial terminal size. */
  cols?: number;
  rows?: number;
  /** Extra environment variables. */
  env?: Record<string, string>;
  /** Working directory (default: $HOME). */
  cwd?: string;
}

export interface DirectPty {
  /** Register a callback for PTY output data. */
  onData(callback: (data: string) => void): void;
  /** Register a callback for PTY exit. */
  onExit(callback: (info: { exitCode: number; signal?: number }) => void): void;
  /** Write raw data to PTY stdin. */
  write(data: string): void;
  /** Resize the PTY. */
  resize(cols: number, rows: number): void;
  /** Kill the PTY process. */
  kill(): void;
  /** The underlying process ID. */
  readonly pid: number;
  /** The logical session name. */
  readonly session: string;
}

const resolveShell = (explicit?: string): string => {
  if (explicit) return explicit;
  return process.env.SHELL || "/bin/sh";
};

/**
 * Spawn a shell inside a node-pty pseudo-terminal.
 */
export const createDirectPty = (options: DirectPtyOptions = {}): DirectPty => {
  const {
    session = "default",
    shell,
    cols = 120,
    rows = 30,
    env,
    cwd,
  } = options;

  const shellBin = resolveShell(shell);

  // Pass --login for login shell behavior (loads .zprofile/.bash_profile)
  const shellArgs = shellBin.endsWith("zsh") || shellBin.endsWith("bash")
    ? ["--login"]
    : [];

  const pty: IPty = ptySpawn(shellBin, shellArgs, {
    name: "xterm-256color",
    cols,
    rows,
    cwd: cwd ?? process.env.HOME ?? "/",
    env: {
      ...process.env,
      TERM: "xterm-256color",
      LANG: process.env.LANG ?? "en_US.UTF-8",
      ...env,
    },
  });

  return {
    get session() {
      return session;
    },
    onData(callback) {
      pty.onData(callback);
    },
    onExit(callback) {
      pty.onExit(callback);
    },
    write(data) {
      pty.write(data);
    },
    resize(c, r) {
      pty.resize(c, r);
    },
    kill() {
      pty.kill();
    },
    get pid() {
      return pty.pid;
    },
  };
};

import { spawn as ptySpawn, type IPty } from "node-pty";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface ZellijPtyOptions {
  /** Zellij session name (default: "remux"). */
  session?: string;
  /** Path to zellij binary (auto-detected if omitted). */
  zellijBin?: string;
  /** Initial terminal size. */
  cols?: number;
  rows?: number;
  /** Extra environment variables. */
  env?: Record<string, string>;
}

export interface ZellijPty {
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
  /** The Zellij session name. */
  readonly session: string;
}

/**
 * Resolve the zellij binary path.
 * Throws with install instructions if not found.
 */
const resolveZellijBin = (explicit?: string): string => {
  if (explicit) return explicit;
  try {
    // Resolve the absolute path so node-pty can find the binary
    // regardless of its inherited PATH.
    const resolved = execFileSync("which", ["zellij"], { stdio: "pipe" })
      .toString()
      .trim();
    if (resolved) return resolved;
    return "zellij";
  } catch {
    throw new Error(
      "zellij not found. Install it with: brew install zellij (macOS) or cargo install zellij",
    );
  }
};

/**
 * Spawn Zellij inside a node-pty pseudo-terminal.
 *
 * The PTY runs `zellij attach --create <session>`, which reattaches to an
 * existing session or creates a new one.  All session/tab/pane management
 * is handled by Zellij natively.
 */
export const createZellijPty = (options: ZellijPtyOptions = {}): ZellijPty => {
  const {
    session = "remux",
    zellijBin,
    cols = 120,
    rows = 30,
    env,
  } = options;

  const bin = resolveZellijBin(zellijBin);
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const srcDir = path.resolve(thisDir, "../../src/backend/pty");

  // Resolve a bundled file — check compiled dist/ first, then source.
  const resolveBundled = (filename: string): string | undefined => {
    const distPath = path.resolve(thisDir, filename);
    const srcPath = path.resolve(srcDir, filename);
    if (fs.existsSync(distPath)) return distPath;
    if (fs.existsSync(srcPath)) return srcPath;
    return undefined;
  };

  // Use bundled config if user doesn't have their own.
  const configEnv: Record<string, string> = {};
  if (!process.env.ZELLIJ_CONFIG_FILE) {
    const configPath = resolveBundled("zellij-config.kdl");
    if (configPath) configEnv.ZELLIJ_CONFIG_FILE = configPath;
  }

  // Use bare layout (no tab-bar, no status-bar) so the web UI provides chrome.
  // --layout is a top-level zellij flag, placed BEFORE the subcommand.
  const layoutPath = resolveBundled("zellij-layout.kdl");
  const layoutArgs = layoutPath ? ["--layout", layoutPath] : [];

  const pty: IPty = ptySpawn(bin, [...layoutArgs, "attach", session, "--create"], {
    name: "xterm-256color",
    cols,
    rows,
    cwd: process.env.HOME ?? "/",
    env: {
      ...process.env,
      TERM: "xterm-256color",
      LANG: "en_US.UTF-8",
      ...configEnv,
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

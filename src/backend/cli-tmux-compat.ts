#!/usr/bin/env node
/**
 * tmux-compatible CLI adapter for Remux.
 *
 * Translates tmux commands into Zellij operations so that tools like
 * Gastown can use Remux without modification — just point the tmux
 * binary path at `remux-tmux`.
 *
 * Supported commands:
 *   new-session -d -s <name> -c <dir> [command]
 *   kill-session -t <name>
 *   has-session -t <name>
 *   list-sessions [-F <format>]
 *   send-keys -t <name> [-l] <keys...>
 *   capture-pane -p -t <name>
 *   set-environment -t <name> <key> <value>
 *   display-message -t <name> -p <format>
 */

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ZELLIJ = (() => {
  try {
    return execFileSync("which", ["zellij"], { stdio: "pipe" }).toString().trim();
  } catch {
    return "zellij";
  }
})();

/** Resolve the bundled Zellij config that hides tips/branding. */
const ZELLIJ_CONFIG = (() => {
  const thisDir = path.dirname(new URL(import.meta.url).pathname);
  const candidates = [
    path.resolve(thisDir, "pty/zellij-config.kdl"),
    path.resolve(thisDir, "../../src/backend/pty/zellij-config.kdl"),
  ];
  return candidates.find((p) => fs.existsSync(p));
})();

// --- Helpers ---

const zellij = (args: string[], opts?: { ignoreError?: boolean }): string => {
  try {
    return execFileSync(ZELLIJ, args, { stdio: "pipe", timeout: 10_000 }).toString();
  } catch (err) {
    if (opts?.ignoreError) return "";
    throw err;
  }
};

const zellijAction = (session: string, args: string[]): string =>
  zellij(["-s", session, "action", ...args]);

const listSessionNames = (): string[] => {
  const raw = zellij(["list-sessions", "--no-formatting"], { ignoreError: true });
  return raw
    .split("\n")
    .map((line) => line.split(" ")[0].replace(/\x1b\[[0-9;]*m/g, "").trim())
    .filter(Boolean);
};

const sessionExists = (name: string): boolean => listSessionNames().includes(name);

/** Parse target string: "session" or "session:window.pane" → session name. */
const parseTarget = (target: string): string => target.split(":")[0].split(".")[0];

// --- tmux key name → Zellij key name mapping ---

const TMUX_KEY_MAP: Record<string, string> = {
  Enter: "Enter", Space: "Space", Escape: "Esc", Tab: "Tab",
  BSpace: "Backspace", DC: "Del", IC: "Insert",
  Up: "Up", Down: "Down", Left: "Left", Right: "Right",
  Home: "Home", End: "End", PPage: "PageUp", NPage: "PageDown",
  F1: "F1", F2: "F2", F3: "F3", F4: "F4", F5: "F5", F6: "F6",
  F7: "F7", F8: "F8", F9: "F9", F10: "F10", F11: "F11", F12: "F12",
};

/** Convert a tmux key token to a Zellij send-keys argument. */
const mapTmuxKey = (key: string): string | null => {
  if (TMUX_KEY_MAP[key]) return TMUX_KEY_MAP[key];
  // C-x → Ctrl x
  const ctrlMatch = key.match(/^C-(.+)$/);
  if (ctrlMatch) return `Ctrl ${ctrlMatch[1]}`;
  // M-x → Alt x
  const metaMatch = key.match(/^M-(.+)$/);
  if (metaMatch) return `Alt ${metaMatch[1]}`;
  return null;
};

// --- Command implementations ---

const cmdNewSession = (args: string[]): void => {
  let name = "";
  let cwd = "";
  let command = "";
  const cmdArgs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-d") continue; // Always detached.
    if (a === "-s" && i + 1 < args.length) { name = args[++i]; continue; }
    if (a === "-c" && i + 1 < args.length) { cwd = args[++i]; continue; }
    if (a === "-x" || a === "-y") { i++; continue; }
    if (a === "-n") { i++; continue; }
    if (a === "-P" || a === "-F") { i++; continue; }
    if (!a.startsWith("-")) {
      command = a;
      cmdArgs.push(...args.slice(i + 1));
      break;
    }
  }

  if (!name) {
    console.error("remux-tmux: new-session requires -s <name>");
    process.exit(1);
  }

  // If session already exists, just return (idempotent).
  if (sessionExists(name)) return;

  // Generate a temporary layout file.
  const layoutDir = path.join(os.tmpdir(), "remux-tmux-layouts");
  fs.mkdirSync(layoutDir, { recursive: true });
  const layoutPath = path.join(layoutDir, `${name}.kdl`);

  if (command) {
    const parts = command.split(/\s+/);
    const prog = parts[0];
    const progArgs = [...parts.slice(1), ...cmdArgs];
    const argsKdl = progArgs.length > 0
      ? `\n        args ${progArgs.map((a) => `"${a}"`).join(" ")}`
      : "";
    const cwdKdl = cwd ? `\n        cwd "${cwd}"` : "";
    fs.writeFileSync(layoutPath, `layout {\n    pane command="${prog}" {${argsKdl}${cwdKdl}\n    }\n}\n`);
  } else {
    const cwdKdl = cwd ? `\n    pane cwd="${cwd}"` : "\n    pane";
    fs.writeFileSync(layoutPath, `layout {${cwdKdl}\n}\n`);
  }

  // Zellij requires a real TTY to create sessions.  Unlike tmux (which
  // has a client-server split where `new-session -d` talks to the server),
  // Zellij's `attach --create` IS the server for new sessions and needs a PTY.
  //
  // Strategy: use a small C helper (via `expect` or `unbuffer`) if available,
  // otherwise fall back to requiring the Remux web server to create sessions.
  //
  // TODO: Ship a small native helper binary for reliable detached session creation.
  const configEnv = ZELLIJ_CONFIG ? `ZELLIJ_CONFIG_FILE='${ZELLIJ_CONFIG}' ` : "";
  const workDir = cwd || process.env.HOME || "/";

  // Try `unbuffer` (from expect package) which provides a PTY.
  const hasUnbuffer = (() => {
    try { execFileSync("which", ["unbuffer"], { stdio: "pipe" }); return true; } catch { return false; }
  })();

  const pidDir = path.join(os.tmpdir(), "remux-tmux-pids");
  fs.mkdirSync(pidDir, { recursive: true });
  const pidFile = path.join(pidDir, `${name}.pid`);

  if (hasUnbuffer) {
    // `unbuffer` (without -p) keeps a PTY alive for the child process.
    // The zellij client stays connected, enabling dump-screen/write-chars.
    spawn("bash", ["-c",
      `cd '${workDir}' && ${configEnv}TERM=xterm-256color ` +
      `nohup unbuffer ${ZELLIJ} --session '${name}' --new-session-with-layout '${layoutPath}' > /dev/null 2>&1 &\n` +
      `echo $! > '${pidFile}'`,
    ], { detached: true, stdio: "ignore" }).unref();
  } else {
    // Fallback: use `zellij` directly. The session may not support
    // dump-screen until a real client (e.g., Remux web) attaches.
    spawn("bash", ["-c",
      `cd '${workDir}' && ${configEnv}TERM=xterm-256color ` +
      `${ZELLIJ} --session '${name}' --new-session-with-layout '${layoutPath}' < /dev/null &\n` +
      `echo $! > '${pidFile}'`,
    ], { detached: true, stdio: "ignore" }).unref();
  }

  // Wait for session to appear.
  const deadline = Date.now() + 5000;
  const poll = (): void => {
    if (sessionExists(name)) {
      try { fs.unlinkSync(layoutPath); } catch { /* ignore */ }
      return;
    }
    if (Date.now() > deadline) {
      try {
        const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
        if (pid > 0) process.kill(-pid);
      } catch { /* ignore */ }
      try { fs.unlinkSync(layoutPath); } catch { /* ignore */ }
      try { fs.unlinkSync(pidFile); } catch { /* ignore */ }
      throw new Error(`Timed out waiting for session '${name}' to start`);
    }
    execFileSync("sleep", ["0.2"]);
    poll();
  };
  poll();
};

const cmdKillSession = (args: string[]): void => {
  const target = extractTarget(args);
  const session = parseTarget(target);

  // Kill the background client process group if we created one.
  const pidFile = path.join(os.tmpdir(), "remux-tmux-pids", `${session}.pid`);
  try {
    const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
    if (pid > 0) process.kill(-pid); // Negative PID = kill process group.
  } catch { /* ignore */ }
  try { fs.unlinkSync(pidFile); } catch { /* ignore */ }

  try {
    zellij(["kill-session", session]);
  } catch {
    // Already gone — not an error.
  }
};

const cmdHasSession = (args: string[]): void => {
  const target = extractTarget(args);
  const session = parseTarget(target);
  process.exit(sessionExists(session) ? 0 : 1);
};

const cmdListSessions = (args: string[]): void => {
  let format = "";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-F" && i + 1 < args.length) { format = args[++i]; continue; }
  }

  const sessions = listSessionNames();

  if (format) {
    // Simple tmux format variable substitution.
    for (const name of sessions) {
      let line = format;
      line = line.replace(/#{session_name}/g, name);
      line = line.replace(/#\{session_attached\}/g, "0");
      line = line.replace(/#\{session_windows\}/g, "1");
      console.log(line);
    }
  } else {
    // Default tmux-like output: "name: N windows (created ...)"
    for (const name of sessions) {
      console.log(`${name}: 1 windows (created unknown)`);
    }
  }
};

const cmdSendKeys = (args: string[]): void => {
  let target = "";
  let literal = false;
  const keys: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-t" && i + 1 < args.length) { target = args[++i]; continue; }
    if (a === "-l") { literal = true; continue; }
    if (a === "-H") { continue; } // Ignore hex mode.
    keys.push(a);
  }

  const session = parseTarget(target);
  if (!session) {
    console.error("remux-tmux: send-keys requires -t <session>");
    process.exit(1);
  }

  if (literal || keys.length === 1) {
    // Literal mode or single string: write as text.
    const text = keys.join(" ");
    if (text) {
      zellijAction(session, ["write-chars", text]);
    }
    return;
  }

  // Non-literal: each argument is a key name or literal text.
  for (const key of keys) {
    const mapped = mapTmuxKey(key);
    if (mapped) {
      zellijAction(session, ["send-keys", mapped]);
    } else {
      // Treat as literal text.
      zellijAction(session, ["write-chars", key]);
    }
  }
};

const cmdCapturePane = (args: string[]): void => {
  let target = "";
  let print = false;
  let full = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-t" && i + 1 < args.length) { target = args[++i]; continue; }
    if (a === "-p") { print = true; continue; }
    if (a === "-J") { continue; } // Join wrapped lines — ignore.
    if (a === "-S" || a === "-E") { i++; continue; } // Start/end line — ignore.
    if (a === "-e") { continue; } // Include escape sequences.
  }

  const session = parseTarget(target);
  if (!session) {
    console.error("remux-tmux: capture-pane requires -t <session>");
    process.exit(1);
  }

  const output = zellijAction(session, ["dump-screen"]);
  if (print) {
    process.stdout.write(output);
  }
};

const cmdSetEnvironment = (args: string[]): void => {
  let target = "";
  let global = false;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-t" && i + 1 < args.length) { target = args[++i]; continue; }
    if (a === "-g") { global = true; continue; }
    if (a === "-r" || a === "-u") { continue; }
    positional.push(a);
  }

  if (positional.length < 2) return;
  const [key, value] = positional;
  const session = parseTarget(target);

  if (session) {
    // Inject env var into the session's shell.
    zellijAction(session, ["write-chars", `export ${key}=${JSON.stringify(value)}\n`]);
  }
};

const cmdDisplayMessage = (args: string[]): void => {
  let target = "";
  let format = "";

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-t" && i + 1 < args.length) { target = args[++i]; continue; }
    if (a === "-p" && i + 1 < args.length) { format = args[++i]; continue; }
  }

  const session = parseTarget(target);

  // For simple format queries, return best-effort data from Zellij.
  if (format.includes("pane_pid") || format.includes("pane_current_command")) {
    try {
      const raw = zellijAction(session, ["list-panes", "--json"]);
      const panes = JSON.parse(raw);
      const focused = panes.find((p: Record<string, unknown>) => p.is_focused) ?? panes[0];
      let output = format;
      output = output.replace(/#{pane_pid}/g, String(focused?.id ?? 0));
      output = output.replace(/#{pane_current_command}/g, String(focused?.pane_command ?? ""));
      output = output.replace(/#{pane_current_path}/g, String(focused?.pane_cwd ?? ""));
      output = output.replace(/#{session_name}/g, session);
      console.log(output);
    } catch {
      console.log(format.replace(/#\{[^}]+\}/g, ""));
    }
    return;
  }

  // Default: replace known variables, blank unknown ones.
  let output = format;
  output = output.replace(/#{session_name}/g, session);
  output = output.replace(/#\{[^}]+\}/g, "");
  console.log(output);
};

// --- Argument parsing helpers ---

const extractTarget = (args: string[]): string => {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-t" && i + 1 < args.length) return args[i + 1];
  }
  return "";
};

// --- Main dispatch ---

const main = (): void => {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log("remux-tmux: tmux-compatible adapter backed by Zellij");
    console.log("Usage: remux-tmux <command> [args...]");
    process.exit(0);
  }

  const command = args[0];
  const commandArgs = args.slice(1);

  try {
    switch (command) {
      case "new-session":
      case "new":
        cmdNewSession(commandArgs);
        break;
      case "kill-session":
        cmdKillSession(commandArgs);
        break;
      case "has-session":
      case "has":
        cmdHasSession(commandArgs);
        break;
      case "list-sessions":
      case "ls":
        cmdListSessions(commandArgs);
        break;
      case "send-keys":
      case "send":
        cmdSendKeys(commandArgs);
        break;
      case "capture-pane":
      case "capturep":
        cmdCapturePane(commandArgs);
        break;
      case "set-environment":
      case "setenv":
        cmdSetEnvironment(commandArgs);
        break;
      case "display-message":
      case "display":
        cmdDisplayMessage(commandArgs);
        break;
      case "list-panes":
      case "lsp":
        // Stub: list panes in tmux format.
        console.log("%0: [80x24] [active]");
        break;
      case "set-option":
      case "set":
      case "bind-key":
      case "bind":
      case "resize-window":
      case "resizew":
      case "rename-session":
      case "rename":
      case "attach-session":
      case "attach":
      case "respawn-pane":
      case "respawnp":
        // Stubs — silently succeed for compatibility.
        break;
      default:
        console.error(`remux-tmux: unknown command '${command}'`);
        process.exit(1);
    }
  } catch (err) {
    console.error(`remux-tmux: ${command} failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
};

main();

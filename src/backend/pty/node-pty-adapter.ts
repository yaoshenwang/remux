import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import * as pty from "node-pty";
import type { PtyFactory, PtyProcess } from "./pty-adapter.js";
import { toFlatStringEnv, withoutTmuxEnv } from "../util/env.js";

const require = createRequire(import.meta.url);
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\"'\"'")}'`;

const ensureNodePtySpawnHelperExecutable = (
  logger?: Pick<Console, "log" | "error">
): void => {
  if (os.platform() === "win32") {
    return;
  }

  try {
    const unixTerminalPath = require.resolve("node-pty/lib/unixTerminal.js");
    const rootDir = path.resolve(path.dirname(unixTerminalPath), "..");
    const candidates = [
      path.join(rootDir, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
      path.join(rootDir, "build", "Release", "spawn-helper"),
      path.join(rootDir, "build", "Debug", "spawn-helper")
    ];

    for (const candidate of candidates) {
      if (!fs.existsSync(candidate)) {
        continue;
      }
      fs.chmodSync(candidate, 0o755);
      logger?.log("node-pty spawn-helper is executable", candidate);
      return;
    }
  } catch (error) {
    logger?.error("unable to ensure node-pty spawn-helper permissions", error);
  }
};

class NodePtyProcess implements PtyProcess {
  public constructor(private readonly process: pty.IPty) {}

  public write(data: string): void {
    this.process.write(data);
  }

  public resize(cols: number, rows: number): void {
    this.process.resize(cols, rows);
  }

  public onData(handler: (data: string) => void): void {
    this.process.onData(handler);
  }

  public onExit(handler: (code: number) => void): void {
    this.process.onExit(({ exitCode }) => handler(exitCode));
  }

  public kill(): void {
    this.process.kill();
  }
}

interface NodePtyFactoryOptions {
  logger?: Pick<Console, "log" | "error">;
  socketName?: string;
  socketPath?: string;
  tmuxBinary?: string;
}

export class NodePtyFactory implements PtyFactory {
  private nodePtyUnavailable = false;
  private readonly forceScriptFallback: boolean;
  private readonly logger?: Pick<Console, "log" | "error">;
  private readonly socketArgs: string[];
  private readonly tmuxBinary: string;

  public constructor(options: NodePtyFactoryOptions = {}) {
    this.logger = options.logger;
    this.tmuxBinary = options.tmuxBinary ?? "tmux";
    this.socketArgs = options.socketPath
      ? ["-S", options.socketPath]
      : options.socketName
        ? ["-L", options.socketName]
        : [];
    this.forceScriptFallback = process.env.REMUX_FORCE_SCRIPT_PTY === "1";
    ensureNodePtySpawnHelperExecutable(this.logger);
  }

  private createResizeInvariantError(cause?: unknown): Error {
    const message = "tmux backend requires node-pty; script(1) fallback is disabled because it cannot preserve terminal resize invariants";
    const error = new Error(message);
    if (cause !== undefined) {
      (error as Error & { cause?: unknown }).cause = cause;
    }
    return error;
  }

  public spawnAttach(session: string): PtyProcess {
    if (os.platform() !== "win32" && (this.forceScriptFallback || this.nodePtyUnavailable)) {
      throw this.createResizeInvariantError();
    }

    try {
      const shell = os.platform() === "win32" ? "cmd.exe" : "/bin/sh";
      const args =
        os.platform() === "win32"
          ? ["/c", this.tmuxBinary, ...this.socketArgs, "attach-session", "-t", session]
          : ["-lc", this.buildAttachCommand(session)];
      this.logger?.log("[pty] spawn", shell, args.join(" "));

      const spawned = pty.spawn(shell, args, {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd: process.cwd(),
        env: toFlatStringEnv(withoutTmuxEnv(process.env))
      });

      return new NodePtyProcess(spawned);
    } catch (error) {
      if (os.platform() !== "win32") {
        this.nodePtyUnavailable = true;
        this.logger?.error("node-pty unavailable for tmux backend; refusing degraded PTY attach", error);
        throw this.createResizeInvariantError(error);
      }

      throw error;
    }
  }

  private buildAttachCommand(session: string): string {
    const commandParts = [
      this.tmuxBinary,
      ...this.socketArgs,
      "attach-session",
      "-t",
      session
    ].map(shellQuote);
    return `exec ${commandParts.join(" ")}`;
  }
}

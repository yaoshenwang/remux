import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PtyProcess, PtyFactory } from "../pty/pty-adapter.js";
import type { ZellijSubscribeEvent } from "./parser.js";

const execFileAsync = promisify(execFile);

/**
 * A PtyProcess that uses `zellij subscribe` for output and
 * `zellij action write-chars` / `send-keys` for input.
 *
 * This avoids attaching to the Zellij session (which would render
 * Zellij's own UI) and instead streams individual pane content.
 */
export class ZellijPaneIO implements PtyProcess {
  private readonly binary: string;
  private readonly session: string;
  private readonly paneId: string;
  private readonly logger?: Pick<Console, "log" | "error">;

  private dataHandlers: Array<(data: string) => void> = [];
  private exitHandlers: Array<(code: number) => void> = [];
  private subscribeProc: ReturnType<typeof spawn> | null = null;
  private killed = false;

  /** Last known viewport dimensions from subscribe events. */
  private lastCols = 80;
  private lastRows = 24;

  constructor(options: {
    binary?: string;
    session: string;
    paneId: string;
    logger?: Pick<Console, "log" | "error">;
  }) {
    this.binary = options.binary ?? "zellij";
    this.session = options.session;
    this.paneId = options.paneId;
    this.logger = options.logger;

    this.startSubscribe();
  }

  private startSubscribe(): void {
    const args = [
      "--session", this.session,
      "subscribe",
      "--pane-id", this.paneId,
      "--format", "json",
      "--ansi",
      "--scrollback"
    ];

    this.subscribeProc = spawn(this.binary, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let buffer = "";
    this.subscribeProc.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      // Each JSON event is a complete line
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        this.handleSubscribeEvent(line);
      }
    });

    this.subscribeProc.stderr?.on("data", (chunk: Buffer) => {
      this.logger?.error(`[zellij-subscribe] ${chunk.toString()}`);
    });

    this.subscribeProc.on("exit", (code) => {
      if (!this.killed) {
        this.logger?.log(`[zellij-subscribe] exited code=${code}`);
        for (const h of this.exitHandlers) h(code ?? 1);
      }
    });
  }

  private handleSubscribeEvent(jsonLine: string): void {
    let event: ZellijSubscribeEvent;
    try {
      event = JSON.parse(jsonLine);
    } catch {
      return;
    }
    if (event.event !== "pane_update") return;

    // Build terminal output from viewport lines.
    // Clear screen + cursor home, then write each line.
    const viewport = event.viewport ?? [];
    const output = this.renderViewport(viewport, event.scrollback, event.is_initial);
    if (output) {
      for (const h of this.dataHandlers) h(output);
    }
  }

  /**
   * Convert viewport lines (with ANSI codes) into a terminal byte stream
   * that xterm.js can render.
   */
  private renderViewport(
    viewport: string[],
    scrollback: string[] | null,
    isInitial: boolean
  ): string {
    const parts: string[] = [];

    if (isInitial && scrollback?.length) {
      // On initial delivery with scrollback, send scrollback first
      for (const line of scrollback) {
        parts.push(line + "\r\n");
      }
    }

    // Clear screen + cursor home
    parts.push("\x1b[2J\x1b[H");

    // Write viewport lines
    for (let i = 0; i < viewport.length; i++) {
      if (i > 0) parts.push("\r\n");
      parts.push(viewport[i]);
    }

    // Reset SGR at the end
    parts.push("\x1b[m");

    return parts.join("");
  }

  write(data: string): void {
    if (this.killed) return;

    // Use write-chars for regular text input
    const args = [
      "--session", this.session,
      "action", "write-chars",
      "--pane-id", this.paneId,
      data
    ];
    execFileAsync(this.binary, args, { timeout: 3_000 }).catch((err) => {
      this.logger?.error(`[zellij-write] ${err}`);
    });
  }

  resize(cols: number, rows: number): void {
    this.lastCols = cols;
    this.lastRows = rows;
    // Zellij pane sizes are determined by the layout, not individually
    // settable from CLI. Accept the desktop dimensions.
  }

  onData(handler: (data: string) => void): void {
    this.dataHandlers.push(handler);
  }

  onExit(handler: (code: number) => void): void {
    this.exitHandlers.push(handler);
  }

  kill(): void {
    this.killed = true;
    if (this.subscribeProc) {
      this.subscribeProc.kill("SIGTERM");
      this.subscribeProc = null;
    }
    this.dataHandlers = [];
    this.exitHandlers = [];
  }
}

/**
 * PtyFactory that creates ZellijPaneIO instances instead of spawning
 * `tmux attach-session` via node-pty.
 */
export class ZellijPtyFactory implements PtyFactory {
  private readonly binary: string;
  private readonly logger?: Pick<Console, "log" | "error">;

  constructor(options?: {
    zellijBinary?: string;
    logger?: Pick<Console, "log" | "error">;
  }) {
    this.binary = options?.zellijBinary ?? "zellij";
    this.logger = options?.logger;
  }

  spawnAttach(session: string): PtyProcess {
    // For Zellij, the "session" parameter is "sessionName:paneId"
    // If no pane is specified, default to terminal_0
    const [sessionName, paneId] = session.includes(":")
      ? session.split(":", 2)
      : [session, "terminal_0"];

    return new ZellijPaneIO({
      binary: this.binary,
      session: sessionName,
      paneId,
      logger: this.logger
    });
  }
}

import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PtyProcess, PtyFactory } from "../pty/pty-adapter.js";
import type { ZellijSubscribeEvent } from "./parser.js";

const execFileAsync = promisify(execFile);

/**
 * A PtyProcess that uses `zellij subscribe` for output and
 * `zellij action write` (raw bytes) for input.
 *
 * This avoids attaching to the Zellij session (which would render
 * Zellij's own UI) and instead streams individual pane content.
 *
 * Output model:
 * - `zellij subscribe --pane-id` pushes viewport snapshots as JSON events
 * - Each event contains an array of rendered lines with ANSI styling
 * - We convert these into a terminal byte stream using cursor addressing
 *   so xterm.js can render them correctly
 *
 * Input model:
 * - `zellij action write --pane-id` sends raw bytes to the pane
 * - This handles control characters (Ctrl+C), escape sequences (arrow keys),
 *   and regular text equally well
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

  /** Previous viewport for diffing (avoid sending unchanged lines). */
  private prevViewport: string[] = [];

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

    const viewport = event.viewport ?? [];
    const output = this.renderViewport(viewport, event.scrollback, event.is_initial);
    if (output) {
      for (const h of this.dataHandlers) h(output);
    }
    this.prevViewport = viewport;
  }

  /**
   * Convert viewport lines into a terminal byte stream for xterm.js.
   *
   * Strategy:
   * - Initial event: clear screen, write all lines
   * - Subsequent events: use cursor addressing to update only changed lines
   *   (avoids full-screen flicker on every keystroke)
   */
  private renderViewport(
    viewport: string[],
    scrollback: string[] | null,
    isInitial: boolean
  ): string {
    const parts: string[] = [];

    if (isInitial) {
      // Send scrollback as pre-history (will be in xterm scrollback buffer)
      if (scrollback?.length) {
        for (const line of scrollback) {
          parts.push(line + "\r\n");
        }
      }
      // Full redraw
      parts.push("\x1b[2J\x1b[H");
      for (let i = 0; i < viewport.length; i++) {
        if (i > 0) parts.push("\r\n");
        parts.push(viewport[i]);
      }
      parts.push("\x1b[m");
      return parts.join("");
    }

    // Incremental update: only redraw changed lines
    const maxLines = Math.max(viewport.length, this.prevViewport.length);
    let hasChanges = false;

    for (let i = 0; i < maxLines; i++) {
      const newLine = viewport[i] ?? "";
      const oldLine = this.prevViewport[i] ?? "";
      if (newLine !== oldLine) {
        // Reset SGR before clearing to prevent style leaking across rows
        parts.push("\x1b[m");
        // Move cursor to row i+1, col 1 (1-indexed)
        parts.push(`\x1b[${i + 1};1H`);
        // Clear the line
        parts.push("\x1b[2K");
        // Write new content
        parts.push(newLine);
        hasChanges = true;
      }
    }

    if (!hasChanges) return "";

    // Position cursor at bottom of viewport content
    // (in a real terminal this would be the cursor position from the shell)
    parts.push(`\x1b[${viewport.length};1H`);
    parts.push("\x1b[m");

    return parts.join("");
  }

  write(data: string): void {
    if (this.killed) return;

    // Use `action write` (raw bytes) for small payloads with control chars,
    // `write-chars` (string) for regular text to avoid ARG_MAX on large pastes.
    const hasControlChars = /[\x00-\x1f]/.test(data);
    const bytes = Buffer.from(data, "utf8");

    if (hasControlChars && bytes.length <= 256) {
      // Raw byte mode: each byte as a separate arg
      const byteArgs = Array.from(bytes).map(String);
      const args = [
        "--session", this.session,
        "action", "write",
        "--pane-id", this.paneId,
        ...byteArgs
      ];
      execFileAsync(this.binary, args, { timeout: 3_000 }).catch((err) => {
        this.logger?.error(`[zellij-write] ${err}`);
      });
    } else {
      // String mode: single argument, safe for large payloads
      const args = [
        "--session", this.session,
        "action", "write-chars",
        "--pane-id", this.paneId,
        data
      ];
      execFileAsync(this.binary, args, { timeout: 3_000 }).catch((err) => {
        this.logger?.error(`[zellij-write-chars] ${err}`);
      });
    }
  }

  resize(_cols: number, _rows: number): void {
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

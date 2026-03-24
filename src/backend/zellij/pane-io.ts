import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PtyProcess, PtyFactory } from "../pty/pty-adapter.js";
import type { ZellijSubscribeEvent } from "./parser.js";

const execFileAsync = promisify(execFile);

/**
 * A PtyProcess that uses `zellij subscribe` for output and
 * `zellij action write` (raw bytes) for input.
 *
 * Output model:
 * - Viewport snapshots from subscribe are diffed and sent as cursor-addressed
 *   terminal updates. This is a viewport viewer, not a full PTY stream.
 * - No server-side reflow: raw viewport lines are sent directly to xterm.js.
 *   The CSS grid constraint ensures xterm fits its container, and xterm
 *   handles column sizing via FitAddon.
 *
 * Input model:
 * - Batched `zellij action write/write-chars` for keystroke delivery.
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

  /** Write buffer for batching keystrokes into fewer process spawns. */
  private writeBuf = "";
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private writeInFlight = false;
  private static readonly WRITE_BATCH_MS = 8;

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

    if (event.event === "pane_closed") {
      this.killed = true;
      if (this.subscribeProc) {
        this.subscribeProc.kill("SIGTERM");
        this.subscribeProc = null;
      }
      for (const h of this.exitHandlers) h(0);
      this.dataHandlers = [];
      this.exitHandlers = [];
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
   * Initial: clear + full write. Subsequent: cursor-addressed diff.
   */
  private renderViewport(
    viewport: string[],
    scrollback: string[] | null,
    isInitial: boolean
  ): string {
    const parts: string[] = [];

    if (isInitial) {
      if (scrollback?.length) {
        for (const line of scrollback) {
          parts.push(line + "\r\n");
        }
      }
      parts.push("\x1b[2J\x1b[H");
      for (let i = 0; i < viewport.length; i++) {
        if (i > 0) parts.push("\r\n");
        parts.push(viewport[i]);
      }
      parts.push("\x1b[m");
      return parts.join("");
    }

    const maxLines = Math.max(viewport.length, this.prevViewport.length);
    let hasChanges = false;

    for (let i = 0; i < maxLines; i++) {
      const newLine = viewport[i] ?? "";
      const oldLine = this.prevViewport[i] ?? "";
      if (newLine !== oldLine) {
        parts.push("\x1b[m");
        parts.push(`\x1b[${i + 1};1H`);
        parts.push("\x1b[2K");
        parts.push(newLine);
        hasChanges = true;
      }
    }

    if (!hasChanges) return "";
    parts.push("\x1b[m");
    return parts.join("");
  }

  write(data: string): void {
    if (this.killed) return;
    this.writeBuf += data;
    if (!this.writeTimer) {
      const delay = this.writeInFlight ? ZellijPaneIO.WRITE_BATCH_MS : 0;
      this.writeTimer = setTimeout(() => this.flushWriteBuffer(), delay);
    }
  }

  private flushWriteBuffer(): void {
    this.writeTimer = null;
    if (this.killed || !this.writeBuf) return;

    const data = this.writeBuf;
    this.writeBuf = "";
    this.writeInFlight = true;

    const hasControlChars = /[\x00-\x1f]/.test(data);
    const bytes = Buffer.from(data, "utf8");

    const args = (hasControlChars && bytes.length <= 256)
      ? [
          "--session", this.session,
          "action", "write",
          "--pane-id", this.paneId,
          ...Array.from(bytes).map(String)
        ]
      : [
          "--session", this.session,
          "action", "write-chars",
          "--pane-id", this.paneId,
          data
        ];

    execFileAsync(this.binary, args, { timeout: 3_000 })
      .catch((err) => {
        this.logger?.error(`[zellij-write] ${err}`);
      })
      .finally(() => {
        this.writeInFlight = false;
        if (this.writeBuf && !this.writeTimer) {
          this.writeTimer = setTimeout(() => this.flushWriteBuffer(), 0);
        }
      });
  }

  resize(_cols: number, _rows: number): void {
    // Zellij pane sizes can't be set from CLI — no-op.
    // Column fitting is handled by xterm.js FitAddon on the client side.
  }

  onData(handler: (data: string) => void): void {
    this.dataHandlers.push(handler);
  }

  onExit(handler: (code: number) => void): void {
    this.exitHandlers.push(handler);
  }

  kill(): void {
    this.killed = true;
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    if (this.subscribeProc) {
      this.subscribeProc.kill("SIGTERM");
      this.subscribeProc = null;
    }
    this.dataHandlers = [];
    this.exitHandlers = [];
  }
}

/**
 * PtyFactory that creates ZellijPaneIO instances.
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

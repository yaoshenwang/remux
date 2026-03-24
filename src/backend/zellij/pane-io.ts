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
  /** Debounce flag for cursor position queries. */
  private cursorQueryPending = false;
  /** Client terminal column count for reflowing wide viewport lines. */
  private clientCols = 0;

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
      // Pane was closed — treat as process exit
      if (!this.killed) {
        for (const h of this.exitHandlers) h(0);
      }
      return;
    }

    if (event.event !== "pane_update") return;

    let viewport = event.viewport ?? [];
    // Reflow wide lines to client's column count (for narrow mobile screens)
    if (this.clientCols > 0) {
      viewport = reflowViewport(viewport, this.clientCols);
    }
    const output = this.renderViewport(viewport, event.scrollback, event.is_initial);
    if (output) {
      for (const h of this.dataHandlers) h(output);
    }
    this.prevViewport = viewport;

    // Query cursor position asynchronously and send cursor addressing
    this.queryCursorPosition();
  }

  /**
   * Query cursor_coordinates_in_pane from list-panes and send cursor
   * positioning escape to xterm.js so the cursor appears at the right place.
   */
  private queryCursorPosition(): void {
    if (this.killed || this.cursorQueryPending) return;
    this.cursorQueryPending = true;

    execFileAsync(this.binary, [
      "--session", this.session,
      "action", "list-panes", "--json", "--all"
    ], { timeout: 3_000 }).then(({ stdout }) => {
      this.cursorQueryPending = false;
      if (this.killed) return;

      const panes = JSON.parse(stdout) as Array<{
        id: number;
        is_plugin: boolean;
        cursor_coordinates_in_pane: [number, number] | null;
      }>;
      const numericId = parseInt(this.paneId.replace(/^terminal_/, ""), 10);
      const pane = panes.find((p) => !p.is_plugin && p.id === numericId);
      if (pane?.cursor_coordinates_in_pane) {
        let [col, row] = pane.cursor_coordinates_in_pane;
        // Remap cursor position if viewport was reflowed to narrower columns
        if (this.clientCols > 0 && col >= this.clientCols) {
          // Cursor is beyond the reflowed width — wrap it
          const extraRows = Math.floor(col / this.clientCols);
          col = col % this.clientCols;
          row = row + extraRows;
        }
        // Account for lines above cursor that were wrapped by reflow
        if (this.clientCols > 0) {
          let extraLines = 0;
          // Count how many extra lines reflow added before the cursor row
          const panesJson2 = JSON.parse(stdout) as Array<{
            id: number; is_plugin: boolean; pane_content_columns: number;
          }>;
          const paneInfo = panesJson2.find((p2) => !p2.is_plugin && p2.id === numericId);
          const paneWidth = paneInfo?.pane_content_columns ?? 0;
          if (paneWidth > this.clientCols) {
            // Each original line that's wider than clientCols adds floor(width/clientCols) extra lines
            // Approximate: use the stored prevViewport to count wrapped lines before cursor
            // For accuracy, count lines in the original (pre-reflow) viewport up to original row
            const origViewport = this.prevViewport;
            for (let i = 0; i < Math.min(row, origViewport.length); i++) {
              const lineLen = visibleLength(origViewport[i] ?? "");
              if (lineLen > this.clientCols) {
                extraLines += Math.ceil(lineLen / this.clientCols) - 1;
              }
            }
          }
          row += extraLines;
        }
        const cursorSeq = `\x1b[${row + 1};${col + 1}H`;
        for (const h of this.dataHandlers) h(cursorSeq);
      }
    }).catch(() => {
      this.cursorQueryPending = false;
    });
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

    // Reset SGR; cursor position is set by queryCursorPosition() async
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

  resize(cols: number, _rows: number): void {
    // Zellij pane sizes can't be set from CLI, but we use the client's
    // column count to reflow wide viewport lines for narrow screens.
    if (cols > 0) this.clientCols = cols;
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

// ── ANSI-aware line wrapping ──

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

/**
 * Measure visible (non-ANSI) character width of a string.
 */
function visibleLength(s: string): number {
  return s.replace(ANSI_RE, "").length;
}

/**
 * Wrap a single ANSI-styled line to `cols` visible characters.
 * Preserves ANSI escape sequences across wrap boundaries by tracking
 * active SGR state and re-emitting it at the start of continuation lines.
 */
function wrapAnsiLine(line: string, cols: number): string[] {
  if (cols <= 0 || visibleLength(line) <= cols) return [line];

  const result: string[] = [];
  let current = "";
  let visCount = 0;
  let i = 0;
  /** Active SGR sequences to replay on continuation lines. */
  let activeSgr = "";

  while (i < line.length) {
    const remaining = line.slice(i);
    const ansiMatch = remaining.match(/^\x1b\[[0-9;]*[A-Za-z]/);
    if (ansiMatch) {
      const seq = ansiMatch[0];
      current += seq;
      // Track SGR (m) sequences for replay on continuation lines
      if (seq.endsWith("m")) {
        if (seq === "\x1b[m" || seq === "\x1b[0m") {
          activeSgr = "";
        } else {
          activeSgr += seq;
        }
      }
      i += seq.length;
      continue;
    }

    current += line[i];
    visCount++;
    i++;

    if (visCount >= cols) {
      result.push(current);
      // Start continuation line with active SGR state
      current = activeSgr;
      visCount = 0;
    }
  }

  if (current && current !== activeSgr) result.push(current);
  return result;
}

/**
 * Reflow viewport lines to target column width.
 */
function reflowViewport(viewport: string[], targetCols: number): string[] {
  if (targetCols <= 0) return viewport;
  const result: string[] = [];
  for (const line of viewport) {
    result.push(...wrapAnsiLine(line, targetCols));
  }
  return result;
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

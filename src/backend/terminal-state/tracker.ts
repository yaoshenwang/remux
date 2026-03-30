/**
 * Server-side terminal state machine using xterm-headless.
 *
 * Maintains a virtual terminal that processes PTY output, enabling:
 * - Instant reconnection: send current screen state, not replay
 * - Differential updates: only send changed cells
 * - Bandwidth optimization: skip redundant data on slow connections
 *
 * This is the mosh-like approach: instead of streaming raw bytes,
 * we maintain terminal state and send state diffs.
 */

import headless from "@xterm/headless";
const { Terminal } = headless;
import serializeAddon from "@xterm/addon-serialize";
const { SerializeAddon } = serializeAddon;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CellState {
  char: string;
  fg: string;
  bg: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  dim: boolean;
}

export interface TerminalSnapshot {
  /** Serialized terminal content (HTML with ANSI styling). */
  content: string;
  /** Current cursor position. */
  cursor: { row: number; col: number };
  /** Terminal dimensions. */
  size: { cols: number; rows: number };
  /** Sequence number for ordering. */
  seq: number;
  /** Timestamp. */
  timestamp: string;
}

export interface TerminalDiff {
  /** Changed rows since last snapshot (row index → content). */
  changedRows: Map<number, string>;
  /** Cursor position if changed. */
  cursor?: { row: number; col: number };
  /** Sequence number. */
  seq: number;
  /** Whether this is a full snapshot (client should replace everything). */
  full: boolean;
}

/** Serializable version of TerminalDiff for WebSocket transport. */
export interface TerminalDiffMessage {
  type: "terminal_state";
  changedRows: Array<[number, string]>;
  cursor?: { row: number; col: number };
  seq: number;
  full: boolean;
  cols: number;
  rows: number;
}

// ---------------------------------------------------------------------------
// TerminalStateTracker
// ---------------------------------------------------------------------------

export class TerminalStateTracker {
  private terminal: InstanceType<typeof Terminal>;
  private serializeAddon: InstanceType<typeof SerializeAddon>;
  private seq = 0;
  private lastRowHashes: Map<number, string> = new Map();
  private lastCursor = { row: 0, col: 0 };
  private dirty = false;

  constructor(cols: number = 200, rows: number = 50) {
    this.terminal = new Terminal({
      cols,
      rows,
      allowProposedApi: true,
      scrollback: 10000,
    });
    this.serializeAddon = new SerializeAddon();
    this.terminal.loadAddon(this.serializeAddon);
  }

  /**
   * Process raw PTY output bytes through the virtual terminal.
   */
  write(data: string): void {
    this.terminal.write(data);
    this.dirty = true;
  }

  /**
   * Resize the virtual terminal.
   */
  resize(cols: number, rows: number): void {
    this.terminal.resize(cols, rows);
    this.lastRowHashes.clear(); // Force full diff after resize.
    this.dirty = true;
  }

  /**
   * Get a full snapshot of the current terminal state.
   * Used when a new client connects or reconnects.
   */
  snapshot(): TerminalSnapshot {
    this.seq++;
    const content = this.serializeAddon.serialize();
    const cursor = this.terminal.buffer.active;

    return {
      content,
      cursor: {
        row: cursor.cursorY,
        col: cursor.cursorX,
      },
      size: {
        cols: this.terminal.cols,
        rows: this.terminal.rows,
      },
      seq: this.seq,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Compute a differential update since the last diff.
   * Returns null if nothing changed.
   */
  diff(): TerminalDiffMessage | null {
    if (!this.dirty) return null;
    this.dirty = false;
    this.seq++;

    const buffer = this.terminal.buffer.active;
    const changedRows: Array<[number, string]> = [];
    const newHashes = new Map<number, string>();

    for (let row = 0; row < this.terminal.rows; row++) {
      const line = buffer.getLine(row);
      if (!line) continue;

      const lineStr = line.translateToString(true);
      newHashes.set(row, lineStr);

      if (this.lastRowHashes.get(row) !== lineStr) {
        changedRows.push([row, lineStr]);
      }
    }

    const cursor = { row: buffer.cursorY, col: buffer.cursorX };
    const cursorChanged =
      cursor.row !== this.lastCursor.row || cursor.col !== this.lastCursor.col;

    this.lastRowHashes = newHashes;
    this.lastCursor = cursor;

    if (changedRows.length === 0 && !cursorChanged) {
      return null;
    }

    // If most rows changed, send as full update.
    const full = changedRows.length > this.terminal.rows * 0.8;

    return {
      type: "terminal_state",
      changedRows,
      cursor: cursorChanged ? cursor : undefined,
      seq: this.seq,
      full,
      cols: this.terminal.cols,
      rows: this.terminal.rows,
    };
  }

  /**
   * Get the current sequence number.
   */
  currentSeq(): number {
    return this.seq;
  }

  /**
   * Get scrollback content (lines above the visible viewport).
   */
  getScrollback(fromLine: number, count: number): string[] {
    const buffer = this.terminal.buffer.active;
    const lines: string[] = [];
    const start = Math.max(0, fromLine);
    const end = Math.min(start + count, buffer.length);

    for (let i = start; i < end; i++) {
      const line = buffer.getLine(i);
      lines.push(line ? line.translateToString(true) : "");
    }

    return lines;
  }

  /**
   * Product-facing alias for inspect history reads.
   */
  getInspectLines(fromLine: number, count: number): string[] {
    return this.getScrollback(fromLine, count);
  }

  /**
   * Total lines in the buffer (viewport + scrollback).
   */
  get totalLines(): number {
    return this.terminal.buffer.active.length;
  }

  /**
   * Dispose the terminal.
   */
  dispose(): void {
    this.terminal.dispose();
  }
}

/**
 * Structured conversation event watcher.
 *
 * Watches `events.jsonl` files written by AI coding agents (Copilot CLI,
 * Claude Code) and emits parsed conversation events over a WebSocket channel.
 *
 * This enables rich native UIs (iOS app, Go TUI) to render conversation
 * data with markdown, tool call cards, and file changes — instead of
 * just raw terminal output.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

export interface ConversationEvent {
  type:
    | "assistant_message"
    | "user_message"
    | "tool_start"
    | "tool_end"
    | "session_shutdown"
    | "unknown";
  seq: number;
  timestamp: string;
  data: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// EventWatcher
// ---------------------------------------------------------------------------

export class EventWatcher extends EventEmitter {
  private watcher?: fs.FSWatcher;
  private filePosition = 0;
  private seq = 0;
  private readonly filePath: string;
  private pollTimer?: ReturnType<typeof setInterval>;

  constructor(
    sessionId: string,
    private readonly logger?: Pick<Console, "log" | "error">
  ) {
    super();
    // Copilot CLI writes to ~/.copilot/session-state/{sessionId}/events.jsonl
    this.filePath = path.join(
      os.homedir(),
      ".copilot",
      "session-state",
      sessionId,
      "events.jsonl"
    );
  }

  /** Start watching. Emits "event" for each parsed line. */
  start(): void {
    this.logger?.log(`[events] watching ${this.filePath}`);

    // Read any existing content first.
    this.readNewLines();

    // Watch for changes. Use polling as a fallback since fs.watch
    // can be unreliable on some platforms/network drives.
    try {
      this.watcher = fs.watch(this.filePath, () => this.readNewLines());
    } catch {
      // File doesn't exist yet — poll until it appears.
      this.pollTimer = setInterval(() => {
        if (fs.existsSync(this.filePath)) {
          this.readNewLines();
          if (!this.watcher) {
            try {
              this.watcher = fs.watch(this.filePath, () =>
                this.readNewLines()
              );
              if (this.pollTimer) {
                clearInterval(this.pollTimer);
                this.pollTimer = undefined;
              }
            } catch {
              // Keep polling.
            }
          }
        }
      }, 2000);
    }
  }

  /** Stop watching. */
  stop(): void {
    this.watcher?.close();
    this.watcher = undefined;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  /** Get all events seen so far (for reconnection). */
  get currentSeq(): number {
    return this.seq;
  }

  private readNewLines(): void {
    try {
      const stat = fs.statSync(this.filePath);
      if (stat.size <= this.filePosition) return;

      const fd = fs.openSync(this.filePath, "r");
      const buffer = Buffer.alloc(stat.size - this.filePosition);
      fs.readSync(fd, buffer, 0, buffer.length, this.filePosition);
      fs.closeSync(fd);

      this.filePosition = stat.size;

      const text = buffer.toString("utf8");
      const lines = text.split("\n").filter((line) => line.trim().length > 0);

      for (const line of lines) {
        const event = this.parseLine(line);
        if (event) {
          this.emit("event", event);
        }
      }
    } catch {
      // File not ready or read error — will retry on next change.
    }
  }

  private parseLine(line: string): ConversationEvent | null {
    try {
      const raw = JSON.parse(line) as Record<string, unknown>;

      const eventType = String(raw.type ?? raw.event ?? "unknown");
      let type: ConversationEvent["type"] = "unknown";

      if (
        eventType === "assistant" ||
        eventType.includes("assistant")
      ) {
        type = "assistant_message";
      } else if (
        eventType === "user" ||
        eventType.includes("user")
      ) {
        type = "user_message";
      } else if (
        eventType === "tool.execution_start" ||
        eventType === "tool_use"
      ) {
        type = "tool_start";
      } else if (
        eventType === "tool.execution_complete" ||
        eventType === "tool_result"
      ) {
        type = "tool_end";
      } else if (eventType === "session.shutdown") {
        type = "session_shutdown";
      }

      this.seq += 1;
      return {
        type,
        seq: this.seq,
        timestamp: new Date().toISOString(),
        data: raw,
      };
    } catch {
      return null;
    }
  }
}

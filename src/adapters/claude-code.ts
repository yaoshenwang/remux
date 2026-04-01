// E10-005: claude-code adapter — passive mode, monitors Claude Code events.jsonl
// Reports run status: idle/running/waiting_approval/error

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { SemanticAdapter, AdapterState, SemanticEvent } from "./types.js";

export class ClaudeCodeAdapter implements SemanticAdapter {
  id = "claude-code";
  name = "Claude Code";
  mode = "passive" as const;
  capabilities = ["run-status", "conversation-events", "tool-use"];

  private state: AdapterState = {
    adapterId: "claude-code",
    name: "Claude Code",
    mode: "passive",
    capabilities: this.capabilities,
    currentState: "idle",
  };

  private watcher: fs.FSWatcher | null = null;
  private lastFileSize = 0;
  private eventsDir: string;
  private onEmit?: (event: SemanticEvent) => void;

  constructor(onEmit?: (event: SemanticEvent) => void) {
    this.onEmit = onEmit;
    // Claude Code stores events in ~/.claude/ or project-specific paths
    this.eventsDir = path.join(os.homedir(), ".claude", "projects");
  }

  start(): void {
    this.watchForEvents();
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
  }

  onTerminalData(sessionName: string, data: string): void {
    // Detect Claude Code activity from terminal output patterns
    if (data.includes("claude") || data.includes("Claude")) {
      // Check for common Claude Code output patterns
      if (data.includes("Thinking...") || data.includes("⏳")) {
        this.updateState("running");
      } else if (
        data.includes("Done") ||
        data.includes("✓") ||
        data.includes("Complete")
      ) {
        this.updateState("idle");
      } else if (
        data.includes("Permission") ||
        data.includes("approve") ||
        data.includes("Allow")
      ) {
        this.updateState("waiting_approval");
      }
    }
  }

  getCurrentState(): AdapterState {
    return { ...this.state };
  }

  private updateState(
    newState: "idle" | "running" | "waiting_approval" | "error",
  ): void {
    if (this.state.currentState !== newState) {
      this.state.currentState = newState;

      if (this.onEmit) {
        this.onEmit({
          type: "state_change",
          seq: Date.now(),
          timestamp: new Date().toISOString(),
          data: { state: newState },
          adapterId: this.id,
        });
      }
    }
  }

  private watchForEvents(): void {
    // Watch for events.jsonl files in Claude Code project directories
    if (!fs.existsSync(this.eventsDir)) return;

    try {
      this.watcher = fs.watch(
        this.eventsDir,
        { recursive: true },
        (eventType, filename) => {
          if (
            filename &&
            (filename.endsWith("events.jsonl") ||
              filename.endsWith("conversation.jsonl"))
          ) {
            this.processEventFile(path.join(this.eventsDir, filename));
          }
        },
      );
    } catch {
      // Directory may not exist or not be watchable
    }
  }

  private processEventFile(filePath: string): void {
    try {
      const stat = fs.statSync(filePath);
      if (stat.size <= this.lastFileSize) return;

      // Read only new content
      const fd = fs.openSync(filePath, "r");
      const buffer = Buffer.alloc(stat.size - this.lastFileSize);
      fs.readSync(fd, buffer, 0, buffer.length, this.lastFileSize);
      fs.closeSync(fd);
      this.lastFileSize = stat.size;

      // Parse JSONL lines
      const lines = buffer
        .toString()
        .split("\n")
        .filter((l) => l.trim());
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          this.handleConversationEvent(event);
        } catch {
          // Skip malformed lines
        }
      }
    } catch {
      // File access error
    }
  }

  private handleConversationEvent(event: Record<string, unknown>): void {
    const type = event.type as string;

    if (type === "assistant" || type === "tool_use") {
      this.updateState("running");
    } else if (type === "result" || type === "end_turn") {
      this.updateState("idle");
    } else if (type === "permission_request") {
      this.updateState("waiting_approval");
    } else if (type === "error") {
      this.updateState("error");
    }
  }
}

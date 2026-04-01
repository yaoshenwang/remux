// E10-008: codex adapter — passive mode, monitors Codex CLI events
// Reports run status: idle/running/waiting_approval/error
// Watches ~/.codex/ for session JSONL files and detects terminal patterns.

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { SemanticAdapter, AdapterState, SemanticEvent } from "./types.js";

export class CodexAdapter implements SemanticAdapter {
  id = "codex";
  name = "OpenAI Codex";
  mode = "passive" as const;
  capabilities = ["run-status", "conversation-events", "tool-use"];

  private state: AdapterState = {
    adapterId: "codex",
    name: "OpenAI Codex",
    mode: "passive",
    capabilities: this.capabilities,
    currentState: "idle",
  };

  private watcher: fs.FSWatcher | null = null;
  private fileSizes = new Map<string, number>();
  private eventsDir: string;
  private onEmit?: (event: SemanticEvent) => void;

  constructor(onEmit?: (event: SemanticEvent) => void) {
    this.onEmit = onEmit;
    // Codex CLI stores session data in ~/.codex/
    this.eventsDir = path.join(os.homedir(), ".codex");
  }

  start(): void {
    this.watchForEvents();
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
  }

  onTerminalData(sessionName: string, data: string): void {
    // Detect Codex CLI activity from terminal output patterns.
    // Only process data that looks like Codex output to avoid false positives.

    // Running indicators: thinking/working state
    if (
      data.includes("Thinking...") ||
      data.includes("Working...") ||
      data.includes("⠋") ||
      data.includes("⠙") ||
      data.includes("⠹") ||
      data.includes("⠸") ||
      data.includes("⠼") ||
      data.includes("⠴") ||
      data.includes("⠦") ||
      data.includes("⠧") ||
      data.includes("⠇") ||
      data.includes("⠏")
    ) {
      this.updateState("running");
      return;
    }

    // Tool use indicators
    if (
      data.includes("Reading file:") ||
      data.includes("Writing file:") ||
      data.includes("Editing file:") ||
      data.includes("Running:") ||
      data.includes("Patch:") ||
      data.includes("[tool_use]")
    ) {
      this.updateState("running");
      return;
    }

    // Approval / permission request indicators
    if (
      data.includes("Approve?") ||
      data.includes("[y/N]") ||
      data.includes("[y/n]") ||
      data.includes("Allow this?") ||
      data.includes("Run command?")
    ) {
      this.updateState("waiting_approval");
      return;
    }

    // Error indicators
    if (data.includes("Error:") || data.includes("Failed:")) {
      // Only count as error if it looks like Codex produced it,
      // not arbitrary program output. Check for codex context.
      if (
        data.includes("codex") ||
        data.includes("Codex") ||
        data.includes("codex>")
      ) {
        this.updateState("error");
        return;
      }
    }

    // Completion: return to codex prompt or explicit "Done"
    if (data.includes("codex>") || data.includes("Done")) {
      this.updateState("idle");
      return;
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
    // Watch for JSONL session files in ~/.codex/
    if (!fs.existsSync(this.eventsDir)) return;

    try {
      this.watcher = fs.watch(
        this.eventsDir,
        { recursive: true },
        (eventType, filename) => {
          if (
            filename &&
            (filename.endsWith(".jsonl") || filename.endsWith(".json"))
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
      const lastSize = this.fileSizes.get(filePath) ?? 0;
      if (stat.size <= lastSize) return;

      // Read only new content (with proper fd cleanup)
      let newData: Buffer;
      const fd = fs.openSync(filePath, "r");
      try {
        newData = Buffer.alloc(stat.size - lastSize);
        fs.readSync(fd, newData, 0, newData.length, lastSize);
        this.fileSizes.set(filePath, stat.size);
      } finally {
        fs.closeSync(fd);
      }

      // Parse JSONL lines
      const lines = newData
        .toString()
        .split("\n")
        .filter((l) => l.trim());
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          this.handleSessionEvent(event);
        } catch {
          // Skip malformed lines
        }
      }
    } catch {
      // File access error — file may have been deleted between watch and read
    }
  }

  private handleSessionEvent(event: Record<string, unknown>): void {
    const type = event.type as string;

    // Codex JSON-RPC style events (items/turns/threads)
    if (
      type === "item.created" ||
      type === "tool_use" ||
      type === "turn.started"
    ) {
      this.updateState("running");
    } else if (type === "turn.completed" || type === "done") {
      this.updateState("idle");
    } else if (type === "permission_request") {
      this.updateState("waiting_approval");
    } else if (type === "error") {
      this.updateState("error");
    }
  }
}

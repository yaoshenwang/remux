// E10-004: generic-shell adapter — baseline adapter, always available as fallback
// Reports basic shell info from OSC 133 shell integration data

import { SemanticAdapter, AdapterState } from "./types.js";

export class GenericShellAdapter implements SemanticAdapter {
  id = "generic-shell";
  name = "Shell";
  mode = "passive" as const;
  capabilities = ["cwd", "last-command", "exit-code"];

  private state: AdapterState = {
    adapterId: "generic-shell",
    name: "Shell",
    mode: "passive",
    capabilities: this.capabilities,
    currentState: "idle",
  };

  private lastCwd: string | null = null;
  private lastCommand: string | null = null;

  onTerminalData(sessionName: string, data: string): void {
    // Detect command prompts and working directory from OSC sequences
    // OSC 7: working directory
    const osc7Match = data.match(/\x1b\]7;file:\/\/[^/]*([^\x07\x1b]+)/);
    if (osc7Match) {
      this.lastCwd = decodeURIComponent(osc7Match[1]);
    }

    // OSC 133;B: command start — the command text follows
    const osc133B = data.match(/\x1b\]133;B\x07/);
    if (osc133B) {
      this.state.currentState = "running";
    }

    // OSC 133;D: command finished
    const osc133D = data.match(/\x1b\]133;D;?(\d*)\x07/);
    if (osc133D) {
      this.state.currentState = "idle";
    }
  }

  getCurrentState(): AdapterState {
    return {
      ...this.state,
      lastEvent: this.lastCwd
        ? {
            type: "cwd",
            seq: 0,
            timestamp: new Date().toISOString(),
            data: { cwd: this.lastCwd, lastCommand: this.lastCommand },
            adapterId: this.id,
          }
        : undefined,
    };
  }
}

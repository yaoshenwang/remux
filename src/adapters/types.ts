// E10-001: SemanticEvent and AdapterState types

export interface SemanticEvent {
  type: string;
  seq: number;
  timestamp: string;
  data: Record<string, unknown>;
  adapterId: string;
}

export interface AdapterState {
  adapterId: string;
  name: string;
  mode: "none" | "passive" | "active";
  capabilities: string[];
  currentState: "idle" | "running" | "waiting_approval" | "error";
  lastEvent?: SemanticEvent;
}

// E10-002: SemanticAdapter interface
export interface SemanticAdapter {
  id: string;
  name: string;
  mode: "none" | "passive" | "active";
  capabilities: string[];

  // Passive mode: infer state from terminal data or event files
  onTerminalData?(sessionName: string, data: string): void;
  onEventFile?(path: string, event: Record<string, unknown>): void;

  // Active mode: can initiate operations
  createRun?(params: Record<string, unknown>): Promise<void>;
  steerRun?(runId: string, instruction: string): Promise<void>;

  // State query
  getCurrentState(): AdapterState;

  // Lifecycle
  start?(): void;
  stop?(): void;
}

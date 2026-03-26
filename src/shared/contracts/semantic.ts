// ── Semantic domain types ──
// Types for semantic adapter runtime.

export type SemanticAdapterMode = "none" | "passive" | "active";

export interface SemanticCapabilities {
  supportsThreads: boolean;
  supportsTurnHistory: boolean;
  supportsToolEvents: boolean;
  supportsApprovals: boolean;
  supportsImageAttachments: boolean;
  supportsGitActions: boolean;
  supportsWorktreeActions: boolean;
  supportsRuntimeModes: boolean;
  supportsReasoningControls: boolean;
  supportsFollowUpQueue: boolean;
}

export interface SemanticSessionState {
  adapterId: string;
  mode: SemanticAdapterMode;
  sessionId: string;
  title?: string;
  status: "idle" | "running" | "awaiting_input" | "complete" | "errored";
}

export interface SemanticEvent {
  adapterId: string;
  eventId: string;
  sessionId: string;
  kind:
    | "user_message"
    | "assistant_message"
    | "tool_start"
    | "tool_end"
    | "approval_requested"
    | "approval_resolved"
    | "file_change"
    | "git_status"
    | "run_status";
  emittedAt: string;
  payload: Record<string, unknown>;
}

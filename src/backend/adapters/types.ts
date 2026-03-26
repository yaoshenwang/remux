/**
 * Semantic adapter contract.
 *
 * Adapters observe and optionally control tool-specific runtimes
 * (e.g. Codex, Claude Code, Copilot CLI) running inside terminal sessions.
 */

import type {
  SemanticAdapterMode,
  SemanticCapabilities,
  SemanticEvent,
  SemanticSessionState
} from "../../shared/contracts/semantic.js";

// ── Adapter detection ──

export interface AdapterDetectContext {
  /** Current pane command (e.g. "codex", "claude", "bash"). */
  paneCommand: string;
  /** Current working directory of the pane. */
  cwd: string;
  /** Session name. */
  sessionName: string;
  /** Known runtime files in the CWD (e.g. ".codex", ".claude"). */
  knownFiles: string[];
  /** Explicit user preference for adapter selection. */
  userPreference?: string;
  /** Adapter-specific environment variables. */
  envVars: Record<string, string | undefined>;
}

export interface AdapterMatch {
  /** Whether this adapter claims the pane. */
  matched: boolean;
  /** Confidence level (0-1). Higher wins when multiple adapters match. */
  confidence: number;
  /** Suggested mode for this match. */
  suggestedMode: SemanticAdapterMode;
}

// ── Adapter runtime ──

export interface AdapterRuntimeContext {
  /** Session name this adapter is attached to. */
  sessionName: string;
  /** Pane ID this adapter is observing. */
  paneId: string;
  /** Emit a semantic event to connected clients. */
  emitEvent: (event: SemanticEvent) => void;
  /** Update the semantic session state. */
  updateState: (state: SemanticSessionState) => void;
  /** Logger. */
  logger?: Pick<Console, "log" | "error">;
}

export interface SemanticClientAction {
  adapterId: string;
  actionType: string;
  payload: Record<string, unknown>;
}

export interface SemanticActionResult {
  ok: boolean;
  error?: string;
  data?: Record<string, unknown>;
}

// ── Adapter interface ──

/** A running adapter instance for a specific session/pane. */
export interface SemanticAdapterInstance {
  /** Stop observing and clean up. */
  stop(): Promise<void>;
  /** Handle a client action (optional — only for active mode). */
  handleClientAction?(action: SemanticClientAction): Promise<SemanticActionResult>;
}

/**
 * Semantic adapter definition.
 *
 * `start()` returns a new instance per session/pane, so concurrent
 * panes running the same adapter do not share state.
 */
export interface SemanticAdapter {
  /** Unique adapter identifier (e.g. "codex", "claude-code"). */
  id: string;
  /** Human-readable display name. */
  displayName: string;
  /** Detect whether this adapter can handle the given context. */
  detect(context: AdapterDetectContext): Promise<AdapterMatch>;
  /** Get the capabilities this adapter provides. */
  getCapabilities(): SemanticCapabilities;
  /** Start observing a session/pane. Returns a new instance. */
  start(context: AdapterRuntimeContext): Promise<SemanticAdapterInstance>;
}

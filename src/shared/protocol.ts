// ── Backward-compatible barrel ──
// All types have been moved to src/shared/contracts/.
// This file re-exports everything so existing imports keep working.

export type {
  SessionSummary,
  PaneState,
  TabState,
  SessionState,
  RuntimeSnapshot,
  // @deprecated Use RuntimeSnapshot
  WorkspaceSnapshot,
  WorkspaceStreamMode,
  WorkspaceDegradedReason,
  WorkspaceRuntimeState,
  BackendCapabilities,
  ClientView,
  ClientDiagnosticAction,
  ClientDiagnosticDetails,
  ClientDiagnosticIssue,
  ClientDiagnosticSample,
  ClientDiagnosticSeverity,
  ClientDiagnosticStatus,
  TabHistoryEvent,
  TabHistoryPane
} from "./contracts/workspace.js";

export type {
  ServerCapabilities,
  WorkspaceCapabilities,
  NotificationCapabilities,
  TransportCapabilities,
  SemanticCapabilitySummary,
  SemanticAdapterHealthSummary,
  RemuxMessageEnvelope,
  MessageDomain
} from "./contracts/core.js";

export { PROTOCOL_VERSION } from "./contracts/core.js";

export type {
  TerminalOpenPayload,
  TerminalResizePayload,
  TerminalClosedPayload,
  TerminalPatchMessage,
  TerminalPatchPayloadAdapter,
  TerminalPatchPayloadV1,
  TerminalTransportMode,
} from "./contracts/terminal.js";

export type {
  DeviceIdentity,
  PairingState,
  TrustState
} from "./contracts/device.js";

export type {
  SemanticAdapterMode,
  SemanticCapabilities,
  SemanticSessionState,
  SemanticEvent
} from "./contracts/semantic.js";

export interface BandwidthStats {
  rawBytesPerSec: number;
  compressedBytesPerSec: number;
  savedPercent: number;
  fullSnapshotsSent: number;
  diffUpdatesSent: number;
  incrementalPatchesSent: number;
  /** @deprecated Compatibility alias for older UI/tests. */
  avgChangedRowsPerDiff: number;
  avgDiffBytesPerUpdate: number;
  rebuiltSnapshotsSent: number;
  continuationResumes: number;
  continuationFallbackSnapshots: number;
  snapshotBytesSent: number;
  streamBytesSent: number;
  viewerQueueHighWatermarkHits: number;
  droppedBacklogFrames: number;
  staleRevisionDrops: number;
  replayToLiveTransitions: number;
  avgReplayToLiveLatencyMs: number;
  totalRawBytes: number;
  totalCompressedBytes: number;
  totalSavedBytes: number;
  rttMs: number | null;
  protocol: string;
}

// ── Protocol messages (remain here until full domain migration) ──

import type {
  BackendCapabilities,
  SessionSummary,
  RuntimeSnapshot,
  WorkspaceRuntimeState,
  ClientView,
  ClientDiagnosticDetails,
  TabHistoryPane,
  TabHistoryEvent
} from "./contracts/workspace.js";

import type { ServerCapabilities } from "./contracts/core.js";

export type ControlClientMessage =
  | {
      type: "auth";
      token?: string;
      password?: string;
      clientId?: string;
      transportMode?: "raw" | "patch";
      viewRevision?: number;
      baseRevision?: number;
      session?: string;
      tabIndex?: number;
      paneId?: string;
      cols?: number;
      rows?: number;
    }
  | { type: "select_session"; session: string }
  | { type: "new_session"; name: string }
  | { type: "close_session"; session: string }
  | { type: "new_tab"; session: string }
  | { type: "select_tab"; session: string; tabIndex: number }
  | { type: "close_tab"; session: string; tabIndex: number }
  | { type: "select_pane"; paneId: string }
  | { type: "split_pane"; paneId: string; direction: "right" | "down" }
  | { type: "close_pane"; paneId: string }
  | { type: "toggle_fullscreen"; paneId: string }
  | { type: "capture_scrollback"; paneId: string; lines?: number }
  | { type: "capture_tab_history"; session?: string; tabIndex: number; lines?: number }
  | {
      type: "report_client_diagnostic";
      session?: string;
      tabIndex?: number;
      paneId?: string;
      viewRevision?: number;
      diagnostic: ClientDiagnosticDetails;
    }
  | { type: "send_compose"; text: string }
  | { type: "rename_session"; session: string; newName: string }
  | { type: "rename_tab"; session: string; tabIndex: number; newName: string }
  | { type: "set_follow_focus"; follow: boolean };

export type ControlServerMessage =
  | {
      type: "auth_ok";
      clientId: string;
      requiresPassword: boolean;
      capabilities?: BackendCapabilities;
      serverCapabilities?: ServerCapabilities;
      /**
       * @deprecated Use `serverCapabilities.semantic.runtimeKind` instead.
       * Kept on the wire for backward compatibility with older clients.
       */
      backendKind?: string;
    }
  | { type: "auth_error"; reason: string }
  | { type: "attached"; session: string; viewRevision: number }
  | { type: "bandwidth_stats"; stats: BandwidthStats }
  | { type: "session_picker"; sessions: SessionSummary[] }
  | { type: "workspace_state"; workspace: RuntimeSnapshot; clientView: ClientView; viewRevision: number; streamMode?: string; runtimeState?: WorkspaceRuntimeState }
  | { type: "scrollback"; paneId: string; text: string; lines: number; paneWidth: number; isApproximate?: boolean }
  | {
      type: "tab_history";
      viewRevision: number;
      sessionName: string;
      tabIndex: number;
      tabName: string;
      lines: number;
      source: "server_tab_history";
      precision: "precise" | "approximate" | "partial";
      capturedAt: string;
      panes: TabHistoryPane[];
      events: TabHistoryEvent[];
    }
  | { type: "error"; message: string }
  | { type: "info"; message: string }
  | { type: "bell"; session: string; paneId: string };

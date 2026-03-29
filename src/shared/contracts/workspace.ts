// ── Workspace domain types (multiplexer-neutral) ──

export type SessionLifecycle = "live" | "exited";

export interface SessionSummary {
  name: string;
  attached: boolean;
  tabCount: number;
  lifecycle?: SessionLifecycle;
  /** @deprecated Use tabCount */
  windows?: number;
}

export interface PaneState {
  index: number;
  id: string;
  currentCommand: string;
  active: boolean;
  width: number;
  height: number;
  zoomed: boolean;
  currentPath: string;
  isPlugin?: boolean;
  isFloating?: boolean;
}

export interface TabState {
  index: number;
  id?: string;
  name: string;
  active: boolean;
  paneCount: number;
  panes: PaneState[];
}

export interface SessionState extends SessionSummary {
  tabs: TabState[];
}

export interface RuntimeSnapshot {
  sessions: SessionState[];
  capturedAt: string;
}

/** @deprecated Use RuntimeSnapshot */
export type WorkspaceSnapshot = RuntimeSnapshot;

export type WorkspaceStreamMode = "pending" | "native-bridge" | "cli-polling" | "unsupported";

export type WorkspaceDegradedReason =
  | "bridge_disabled"
  | "binary_missing"
  | "unsupported_platform"
  | "version_unsupported"
  | "startup_failed"
  | "bridge_crashed"
  | "restart_exhausted"
  | "tab_layout_unsupported";

export interface WorkspaceRuntimeState {
  streamMode: WorkspaceStreamMode;
  degradedReason?: WorkspaceDegradedReason;
  inspectPrecision: "precise" | "approximate";
  /** @deprecated Use inspectPrecision */
  scrollbackPrecision: "precise" | "approximate";
}

// ── Backend capabilities ──

export interface BackendCapabilities {
  supportsPaneFocusById: boolean;
  supportsTabRename: boolean;
  supportsSessionRename: boolean;
  supportsPreciseInspect: boolean;
  /** @deprecated Use supportsPreciseInspect */
  supportsPreciseScrollback: boolean;
  supportsFloatingPanes: boolean;
  supportsFullscreenPane: boolean;
}

// ── Client view ──

export interface ClientView {
  sessionName: string;
  tabIndex: number;
  paneId?: string;
  followBackendFocus: boolean;
}

// ── Inspect / history types ──

export type ClientDiagnosticIssue =
  | "layout_misalignment"
  | "color_whiteout"
  | "width_mismatch"
  | "history_gap";

export type ClientDiagnosticSeverity = "warn" | "error";
export type ClientDiagnosticStatus = "open" | "resolved";

export interface ClientDiagnosticAction {
  at: string;
  type: string;
  label: string;
  detail?: string;
}

export interface ClientDiagnosticSample {
  theme?: "dark" | "light";
  viewMode?: "inspect" | "terminal";
  terminalViewState?: "idle" | "connecting" | "restoring" | "live" | "stale";
  frontendCols?: number;
  frontendRows?: number;
  backendCols?: number;
  backendRows?: number;
  hostWidth?: number;
  hostHeight?: number;
  screenWidth?: number;
  screenOffsetLeft?: number;
  screenOffsetTop?: number;
  viewportWidth?: number;
  viewportOffsetLeft?: number;
  contrastRatio?: number;
  bufferLineCount?: number;
  lastResizeSource?: string;
}

export interface ClientDiagnosticDetails {
  issue: ClientDiagnosticIssue;
  severity: ClientDiagnosticSeverity;
  status: ClientDiagnosticStatus;
  summary: string;
  sample: ClientDiagnosticSample;
  recentActions: ClientDiagnosticAction[];
  recentSamples?: ClientDiagnosticSample[];
}

export interface TabHistoryEvent {
  id: string;
  at: string;
  text: string;
  kind: "event" | "diagnostic";
  paneId?: string;
  diagnostic?: ClientDiagnosticDetails;
}

export interface TabHistoryPane {
  paneId: string;
  paneIndex: number;
  command: string;
  title: string;
  text: string;
  paneWidth: number;
  isApproximate: boolean;
  archived: boolean;
  capturedAt: string;
  lines: number;
}

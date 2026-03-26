// ── Workspace domain types (multiplexer-neutral) ──

export interface SessionSummary {
  name: string;
  attached: boolean;
  tabCount: number;
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

export interface WorkspaceSnapshot {
  sessions: SessionState[];
  capturedAt: string;
}

// ── Backend capabilities ──

export interface BackendCapabilities {
  supportsPaneFocusById: boolean;
  supportsTabRename: boolean;
  supportsSessionRename: boolean;
  supportsPreciseScrollback: boolean;
  supportsFloatingPanes: boolean;
  supportsFullscreenPane: boolean;
}

// ── Client view ──

export interface ClientView {
  sessionName: string;
  tabIndex: number;
  paneId: string;
  followBackendFocus: boolean;
}

// ── Inspect / history types ──

export interface TabHistoryEvent {
  id: string;
  at: string;
  text: string;
  kind: "event";
  paneId?: string;
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

// ── Deprecated aliases ──

/** @deprecated Use TabState */
export type WindowState = TabState;
/** @deprecated Use WorkspaceSnapshot */
export type StateSnapshot = WorkspaceSnapshot;
/** @deprecated Use SessionSummary */
export type TmuxSessionSummary = SessionSummary;
/** @deprecated Use PaneState */
export type TmuxPaneState = PaneState;
/** @deprecated Use TabState */
export type TmuxWindowState = TabState;
/** @deprecated Use SessionState */
export type TmuxSessionState = SessionState;
/** @deprecated Use WorkspaceSnapshot */
export type TmuxStateSnapshot = WorkspaceSnapshot;

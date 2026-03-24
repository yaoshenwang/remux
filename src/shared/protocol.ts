// ── Workspace state types (multiplexer-neutral) ──

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

// ── Protocol messages ──

export type ControlClientMessage =
  | { type: "auth"; token?: string; password?: string; clientId?: string; session?: string }
  | { type: "select_session"; session: string }
  | { type: "new_session"; name: string }
  | { type: "new_tab"; session: string }
  | { type: "select_tab"; session: string; tabIndex: number }
  | { type: "close_tab"; session: string; tabIndex: number }
  | { type: "select_pane"; paneId: string }
  | { type: "split_pane"; paneId: string; direction: "right" | "down" }
  | { type: "close_pane"; paneId: string }
  | { type: "toggle_fullscreen"; paneId: string }
  | { type: "capture_scrollback"; paneId: string; lines?: number }
  | { type: "send_compose"; text: string }
  | { type: "rename_session"; session: string; newName: string }
  | { type: "rename_tab"; session: string; tabIndex: number; newName: string }
  | { type: "set_follow_focus"; follow: boolean };

export type ControlServerMessage =
  | { type: "auth_ok"; clientId: string; requiresPassword: boolean; capabilities?: BackendCapabilities; backendKind?: string }
  | { type: "auth_error"; reason: string }
  | { type: "attached"; session: string }
  | { type: "session_picker"; sessions: SessionSummary[] }
  | { type: "workspace_state"; workspace: WorkspaceSnapshot; clientView: ClientView }
  | { type: "scrollback"; paneId: string; text: string; lines: number; paneWidth: number; isApproximate?: boolean }
  | { type: "error"; message: string }
  | { type: "info"; message: string };

// ── Deprecated aliases for backward compatibility ──

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

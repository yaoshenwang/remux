export type ControlClientMessage =
  | { type: "auth"; token?: string; password?: string; clientId?: string; session?: string }
  | { type: "select_session"; session: string }
  | { type: "new_session"; name: string }
  | { type: "new_window"; session: string }
  | { type: "select_window"; session: string; windowIndex: number; stickyZoom?: boolean }
  | { type: "kill_window"; session: string; windowIndex: number }
  | { type: "select_pane"; paneId: string; stickyZoom?: boolean }
  | { type: "split_pane"; paneId: string; orientation: "h" | "v" }
  | { type: "kill_pane"; paneId: string }
  | { type: "zoom_pane"; paneId: string }
  | { type: "capture_scrollback"; paneId: string; lines?: number }
  | { type: "send_compose"; text: string }
  | { type: "rename_session"; session: string; newName: string }
  | { type: "rename_window"; session: string; windowIndex: number; newName: string };

export interface SessionSummary {
  name: string;
  attached: boolean;
  windows: number;
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
}

export interface WindowState {
  index: number;
  name: string;
  active: boolean;
  paneCount: number;
  panes: PaneState[];
}

export interface SessionState extends SessionSummary {
  windowStates: WindowState[];
}

export interface StateSnapshot {
  sessions: SessionState[];
  capturedAt: string;
}

export type ControlServerMessage =
  | { type: "auth_ok"; clientId: string; requiresPassword: boolean }
  | { type: "auth_error"; reason: string }
  | { type: "attached"; session: string }
  | { type: "session_picker"; sessions: SessionSummary[] }
  | { type: "tmux_state"; state: StateSnapshot }
  | { type: "scrollback"; paneId: string; text: string; lines: number; paneWidth: number }
  | { type: "error"; message: string }
  | { type: "info"; message: string };

/** @deprecated Use SessionSummary */
export type TmuxSessionSummary = SessionSummary;
/** @deprecated Use PaneState */
export type TmuxPaneState = PaneState;
/** @deprecated Use WindowState */
export type TmuxWindowState = WindowState;
/** @deprecated Use SessionState */
export type TmuxSessionState = SessionState;
/** @deprecated Use StateSnapshot */
export type TmuxStateSnapshot = StateSnapshot;

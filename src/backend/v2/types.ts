export interface RuntimeV2Metadata {
  service: string;
  version?: string;
  protocolVersion: string;
  controlWebsocketPath: string;
  terminalWebsocketPath: string;
  publicBaseUrl?: string | null;
  gitBranch?: string;
  gitCommitSha?: string;
  gitDirty?: boolean;
}

export type RuntimeV2SessionState =
  | "starting"
  | "live"
  | "degraded"
  | "stopped"
  | "recoverable";

export type RuntimeV2InspectPrecision = "precise" | "approximate" | "partial";

export interface RuntimeV2TerminalSize {
  cols: number;
  rows: number;
}

export type RuntimeV2SplitDirection = "right" | "down" | "vertical" | "horizontal";

export type RuntimeV2LayoutNode =
  | {
      type: "leaf";
      paneId: string;
    }
  | {
      type: "split";
      direction: RuntimeV2SplitDirection;
      ratio: number;
      children: RuntimeV2LayoutNode[];
    };

export interface RuntimeV2PaneSummary {
  paneId: string;
  isActive: boolean;
  isZoomed: boolean;
  command?: string | null;
  currentPath?: string | null;
  width?: number | null;
  height?: number | null;
  leaseHolderClientId?: string | null;
}

export interface RuntimeV2TabSummary {
  tabId: string;
  tabTitle: string;
  isActive: boolean;
  activePaneId: string;
  zoomedPaneId?: string | null;
  paneCount: number;
  layout: RuntimeV2LayoutNode;
  panes: RuntimeV2PaneSummary[];
}

export interface RuntimeV2SessionSummary {
  sessionId: string;
  sessionName: string;
  sessionState: RuntimeV2SessionState;
  isActive: boolean;
  activeTabId: string;
  tabCount: number;
  tabs: RuntimeV2TabSummary[];
}

export interface RuntimeV2WorkspaceSummary {
  sessionId: string;
  tabId: string;
  paneId: string;
  sessionName: string;
  tabTitle: string;
  sessionState: RuntimeV2SessionState;
  sessionCount: number;
  tabCount: number;
  paneCount: number;
  activeSessionId?: string | null;
  activeTabId?: string | null;
  activePaneId?: string | null;
  zoomedPaneId?: string | null;
  layout: RuntimeV2LayoutNode;
  leaseHolderClientId?: string | null;
  sessions: RuntimeV2SessionSummary[];
}

export type RuntimeV2InspectScope =
  | { type: "pane"; paneId: string }
  | { type: "tab"; tabId: string }
  | { type: "session"; sessionId: string };

export interface RuntimeV2InspectSnapshot {
  scope: RuntimeV2InspectScope;
  precision: RuntimeV2InspectPrecision;
  summary: string;
  previewText: string;
  inspectRows?: string[];
  /** @deprecated Use inspectRows */
  scrollbackRows?: string[];
  visibleRows: string[];
  byteCount: number;
  size: RuntimeV2TerminalSize;
}

export type RuntimeV2ControlClientMessage =
  | {
      type: "authenticate";
      token?: string;
      capabilities: {
        inspect: boolean;
        compose: boolean;
        upload: boolean;
        readOnly: boolean;
      };
    }
  | { type: "subscribe_workspace" }
  | { type: "request_diagnostics" }
  | { type: "request_inspect"; scope: RuntimeV2InspectScope }
  | { type: "split_pane"; paneId: string; direction: RuntimeV2SplitDirection }
  | { type: "focus_pane"; paneId: string }
  | { type: "close_pane"; paneId: string }
  | { type: "toggle_pane_zoom"; paneId: string }
  | { type: "create_session"; sessionName: string }
  | { type: "select_session"; sessionId: string }
  | { type: "rename_session"; sessionId: string; sessionName: string }
  | { type: "close_session"; sessionId: string }
  | { type: "create_tab"; sessionId: string; tabTitle: string }
  | { type: "select_tab"; tabId: string }
  | { type: "rename_tab"; tabId: string; tabTitle: string }
  | { type: "close_tab"; tabId: string };

export type RuntimeV2ControlServerMessage =
  | {
      type: "hello";
      protocolVersion: string;
      writeLeaseModel: string;
    }
  | {
      type: "workspace_snapshot";
      summary: RuntimeV2WorkspaceSummary;
    }
  | {
      type: "diagnostics_snapshot";
      runtimeStatus: string;
    }
  | {
      type: "inspect_snapshot";
      snapshot: RuntimeV2InspectSnapshot;
    }
  | {
      type: "command_rejected";
      reason: string;
    };

export type RuntimeV2TerminalClientMessage =
  | {
      type: "attach";
      paneId: string;
      mode: "interactive" | "read_only";
      size: RuntimeV2TerminalSize;
    }
  | {
      type: "input";
      dataBase64: string;
    }
  | {
      type: "resize";
      size: RuntimeV2TerminalSize;
    }
  | {
      type: "request_snapshot";
    };

export type RuntimeV2TerminalServerMessage =
  | {
      type: "hello";
      protocolVersion: string;
      paneId?: string | null;
    }
  | {
      type: "snapshot";
      size: RuntimeV2TerminalSize;
      sequence: number;
      contentBase64: string;
      replayBase64?: string | null;
    }
  | {
      type: "stream";
      sequence: number;
      chunkBase64: string;
    }
  | {
      type: "resize_confirmed";
      size: RuntimeV2TerminalSize;
    }
  | {
      type: "lease_state";
      clientId?: string | null;
    }
  | {
      type: "exit";
      exitCode?: number | null;
    };

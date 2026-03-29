#![forbid(unsafe_code)]

use remux_core::{
    InspectPrecision, PaneId, SessionId, SessionLifecycleState, SplitDirection, TabId,
    TerminalSize, RUNTIME_V2_PROTOCOL_VERSION,
};
use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: &str = RUNTIME_V2_PROTOCOL_VERSION;

pub mod control {
    use super::*;

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(tag = "type", rename_all = "snake_case")]
    pub enum LayoutNode {
        Leaf {
            pane_id: PaneId,
        },
        Split {
            direction: SplitDirection,
            ratio: u8,
            children: Vec<LayoutNode>,
        },
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct PaneSummary {
        pub pane_id: PaneId,
        pub is_active: bool,
        pub is_zoomed: bool,
        pub lease_holder_client_id: Option<String>,
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct TabSummary {
        pub tab_id: TabId,
        pub tab_title: String,
        pub is_active: bool,
        pub active_pane_id: PaneId,
        pub zoomed_pane_id: Option<PaneId>,
        pub pane_count: usize,
        pub layout: LayoutNode,
        pub panes: Vec<PaneSummary>,
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct SessionSummary {
        pub session_id: SessionId,
        pub session_name: String,
        pub session_state: SessionLifecycleState,
        pub is_active: bool,
        pub active_tab_id: TabId,
        pub tab_count: usize,
        pub tabs: Vec<TabSummary>,
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct ClientCapabilities {
        pub inspect: bool,
        pub compose: bool,
        pub upload: bool,
        pub read_only: bool,
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(tag = "type", rename_all = "snake_case")]
    pub enum InspectScope {
        Pane { pane_id: PaneId },
        Tab { tab_id: TabId },
        Session { session_id: SessionId },
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(tag = "type", rename_all = "snake_case")]
    pub enum ClientMessage {
        Authenticate {
            token: Option<String>,
            capabilities: ClientCapabilities,
        },
        SubscribeWorkspace,
        RequestDiagnostics,
        RequestInspect {
            scope: InspectScope,
        },
        SplitPane {
            pane_id: PaneId,
            direction: SplitDirection,
        },
        FocusPane {
            pane_id: PaneId,
        },
        ClosePane {
            pane_id: PaneId,
        },
        TogglePaneZoom {
            pane_id: PaneId,
        },
        CreateSession {
            session_name: String,
        },
        SelectSession {
            session_id: SessionId,
        },
        RenameSession {
            session_id: SessionId,
            session_name: String,
        },
        CloseSession {
            session_id: SessionId,
        },
        CreateTab {
            session_id: SessionId,
            tab_title: String,
        },
        SelectTab {
            tab_id: TabId,
        },
        RenameTab {
            tab_id: TabId,
            tab_title: String,
        },
        CloseTab {
            tab_id: TabId,
        },
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct WorkspaceSummary {
        pub session_id: SessionId,
        pub tab_id: TabId,
        pub pane_id: PaneId,
        pub session_name: String,
        pub tab_title: String,
        pub session_state: SessionLifecycleState,
        pub session_count: usize,
        pub tab_count: usize,
        pub pane_count: usize,
        pub active_session_id: Option<SessionId>,
        pub active_tab_id: Option<TabId>,
        pub active_pane_id: Option<PaneId>,
        pub zoomed_pane_id: Option<PaneId>,
        pub layout: LayoutNode,
        pub lease_holder_client_id: Option<String>,
        pub sessions: Vec<SessionSummary>,
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct InspectSnapshot {
        pub scope: InspectScope,
        pub precision: InspectPrecision,
        pub summary: String,
        pub preview_text: String,
        #[serde(alias = "scrollback_rows")]
        pub inspect_rows: Vec<String>,
        pub visible_rows: Vec<String>,
        pub byte_count: usize,
        pub size: TerminalSize,
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(tag = "type", rename_all = "snake_case")]
    pub enum ServerMessage {
        Hello {
            protocol_version: String,
            write_lease_model: String,
        },
        #[serde(rename = "workspace_snapshot")]
        RuntimeSnapshot {
            summary: WorkspaceSummary,
        },
        DiagnosticsSnapshot {
            runtime_status: String,
        },
        InspectSnapshot {
            snapshot: InspectSnapshot,
        },
        CommandRejected {
            reason: String,
        },
    }
}

pub mod terminal {
    use super::*;

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "snake_case")]
    pub enum ClientMode {
        Interactive,
        ReadOnly,
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(tag = "type", rename_all = "snake_case")]
    pub enum ClientMessage {
        Attach {
            pane_id: PaneId,
            mode: ClientMode,
            size: TerminalSize,
        },
        Input {
            data_base64: String,
        },
        Resize {
            size: TerminalSize,
        },
        RequestSnapshot,
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(tag = "type", rename_all = "snake_case")]
    pub enum ServerMessage {
        Hello {
            protocol_version: String,
            pane_id: Option<PaneId>,
        },
        Snapshot {
            size: TerminalSize,
            sequence: u64,
            content_base64: String,
            replay_base64: Option<String>,
        },
        Stream {
            sequence: u64,
            chunk_base64: String,
        },
        ResizeConfirmed {
            size: TerminalSize,
        },
        LeaseState {
            client_id: Option<String>,
        },
        Exit {
            exit_code: Option<i32>,
        },
    }
}

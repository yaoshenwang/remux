#![forbid(unsafe_code)]

use std::collections::BTreeMap;
use std::env;
use std::future::pending;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use futures_util::StreamExt;
use remux_core::{PaneId, SessionId, SplitDirection, TabId, TerminalSize, RUNTIME_V2_PROTOCOL_VERSION};
use remux_inspect::build_pane_inspect_view;
use remux_protocol::{control, terminal};
use remux_pty::{PortablePtyProcess, PtyCommand, PtyError, PtyEvent};
use remux_session::{
    LayoutNode as SessionLayoutNode, LeaseMode, PaneSnapshot as SessionPaneSnapshot,
    SessionSnapshot as RuntimeSessionSnapshot, SinglePaneWorkspace,
    TabSnapshot as RuntimeTabSnapshot, WorkspaceError,
};
use remux_terminal::TerminalState;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::sync::broadcast;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerConfig {
    pub host: String,
    pub port: u16,
    pub public_base_url: Option<String>,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ServerConfigOverrides {
    pub host: Option<String>,
    pub port: Option<u16>,
    pub public_base_url: Option<String>,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ServerConfigEnvironment {
    pub host: Option<String>,
    pub port: Option<String>,
    pub public_base_url: Option<String>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ConfigError {
    #[error("invalid REMUXD_PORT value: {0}")]
    InvalidPort(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServerMetadata {
    pub service: String,
    pub protocol_version: String,
    pub control_websocket_path: String,
    pub terminal_websocket_path: String,
    pub public_base_url: Option<String>,
}

#[derive(Clone)]
struct AppState {
    metadata: ServerMetadata,
    runtime: Option<Arc<WorkspaceRuntime>>,
}

#[derive(Debug, Clone)]
enum RuntimeUpdate {
    Output { sequence: u64, chunk_base64: String },
    Exit { exit_code: Option<i32> },
}

#[derive(Debug, Error)]
enum RuntimeError {
    #[error("unknown pane id: {0}")]
    UnknownPane(String),
    #[error("failed to resize pane: {0}")]
    Resize(#[source] PtyError),
    #[error("failed to query pane size: {0}")]
    Size(#[source] PtyError),
    #[error("failed to write to pane: {0}")]
    Write(#[source] PtyError),
    #[error("failed to spawn pane process: {0}")]
    Spawn(#[source] PtyError),
    #[error("failed to decode terminal input: {0}")]
    Decode(#[source] base64::DecodeError),
    #[error(transparent)]
    Session(#[from] WorkspaceError),
    #[error("pane {pane_id} does not grant write access to this client")]
    WriteLeaseUnavailable {
        pane_id: PaneId,
        current_client_id: Option<String>,
    },
}

struct PaneRuntime {
    process: Arc<PortablePtyProcess>,
    terminal: Mutex<TerminalState>,
    exit_code: Mutex<Option<i32>>,
    sequence: AtomicU64,
    updates: broadcast::Sender<RuntimeUpdate>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TerminalAttachment {
    client_id: Option<String>,
    hello: terminal::ServerMessage,
    snapshot: terminal::ServerMessage,
    lease_state: terminal::ServerMessage,
    exit: Option<terminal::ServerMessage>,
}

struct WorkspaceRuntime {
    workspace: Mutex<SinglePaneWorkspace>,
    panes: Mutex<BTreeMap<PaneId, Arc<PaneRuntime>>>,
    terminal_client_sequence: AtomicU64,
    default_command: PtyCommand,
}

impl PaneRuntime {
    fn spawn(command: PtyCommand, size: TerminalSize) -> Result<Arc<Self>, PtyError> {
        let process = PortablePtyProcess::spawn(command, size)?;
        let (updates, _) = broadcast::channel(256);

        let pane = Arc::new(Self {
            process,
            terminal: Mutex::new(TerminalState::new(size, 10_000)),
            exit_code: Mutex::new(None),
            sequence: AtomicU64::new(0),
            updates,
        });
        pane.start_event_forwarder();
        Ok(pane)
    }

    fn start_event_forwarder(self: &Arc<Self>) {
        let mut events = self.process.subscribe();
        let pane = Arc::clone(self);
        tokio::spawn(async move {
            while let Ok(event) = events.recv().await {
                pane.handle_process_event(event);
            }
        });
    }

    fn handle_process_event(&self, event: PtyEvent) {
        match event {
            PtyEvent::Output(chunk) => {
                self.terminal
                    .lock()
                    .expect("runtime terminal lock poisoned")
                    .ingest(&chunk);
                let sequence = self.sequence.fetch_add(1, Ordering::Relaxed) + 1;
                let _ = self.updates.send(RuntimeUpdate::Output {
                    sequence,
                    chunk_base64: BASE64.encode(chunk),
                });
            }
            PtyEvent::Exited { exit_code, .. } => {
                *self.exit_code.lock().expect("runtime exit lock poisoned") =
                    i32::try_from(exit_code).ok();
                let _ = self.updates.send(RuntimeUpdate::Exit {
                    exit_code: i32::try_from(exit_code).ok(),
                });
            }
        }
    }

    fn subscribe(&self) -> broadcast::Receiver<RuntimeUpdate> {
        self.updates.subscribe()
    }

    fn resize(&self, size: TerminalSize) -> Result<(), PtyError> {
        self.process.resize(size)?;
        self.terminal
            .lock()
            .expect("runtime terminal lock poisoned")
            .resize(size);
        Ok(())
    }

    fn size(&self) -> Result<TerminalSize, PtyError> {
        self.process.size()
    }

    fn write_all(&self, bytes: &[u8]) -> Result<(), PtyError> {
        self.process.write_all(bytes)
    }

    fn inspect_snapshot(&self, scope: control::InspectScope) -> control::InspectSnapshot {
        let terminal = self
            .terminal
            .lock()
            .expect("runtime terminal lock poisoned");
        let inspect = build_pane_inspect_view(&terminal);

        control::InspectSnapshot {
            scope,
            precision: inspect.precision,
            summary: inspect.summary,
            preview_text: inspect.preview_text,
            visible_rows: inspect.visible_rows,
            byte_count: inspect.byte_count,
            size: inspect.size,
        }
    }

    fn snapshot_message(&self) -> terminal::ServerMessage {
        let snapshot = self
            .terminal
            .lock()
            .expect("runtime terminal lock poisoned")
            .snapshot();
        terminal::ServerMessage::Snapshot {
            size: snapshot.size,
            sequence: self.sequence.load(Ordering::Relaxed),
            content_base64: BASE64.encode(snapshot.formatted_state),
        }
    }

    fn exit_message(&self) -> Option<terminal::ServerMessage> {
        self.exit_code
            .lock()
            .expect("runtime exit lock poisoned")
            .map(|exit_code| terminal::ServerMessage::Exit {
                exit_code: Some(exit_code),
            })
    }

    fn shutdown(&self) {
        let _ = self.process.kill();
    }
}

impl WorkspaceRuntime {
    fn spawn_default() -> Result<Arc<Self>, PtyError> {
        Self::spawn_with_command(PtyCommand::default_shell().env("TERM", "xterm-256color"))
    }

    fn spawn_with_command(default_command: PtyCommand) -> Result<Arc<Self>, PtyError> {
        let mut workspace = SinglePaneWorkspace::new("Main", "Shell");
        let root_pane_id = workspace.pane_id().clone();
        let root_pane = PaneRuntime::spawn(default_command.clone(), TerminalSize::new(80, 24))?;
        workspace.mark_live();

        let mut panes = BTreeMap::new();
        panes.insert(root_pane_id, root_pane);

        Ok(Arc::new(Self {
            workspace: Mutex::new(workspace),
            panes: Mutex::new(panes),
            terminal_client_sequence: AtomicU64::new(0),
            default_command,
        }))
    }

    fn workspace_summary(&self) -> control::WorkspaceSummary {
        let workspace = self
            .workspace
            .lock()
            .expect("runtime workspace lock poisoned");
        let runtime_snapshot = workspace.snapshot();
        let active_session = runtime_snapshot
            .sessions
            .iter()
            .find(|session| session.session_id == runtime_snapshot.active_session_id)
            .expect("active session must exist in workspace snapshot");
        let active_tab = active_session
            .tabs
            .iter()
            .find(|tab| tab.tab_id == active_session.active_tab_id)
            .expect("active tab must exist in session snapshot");
        let active_pane_id = active_tab.active_pane_id.clone();

        control::WorkspaceSummary {
            session_id: workspace.session_id().clone(),
            tab_id: workspace.tab_id().clone(),
            pane_id: active_pane_id.clone(),
            session_name: workspace.session_name().to_owned(),
            tab_title: workspace.tab_title().to_owned(),
            session_state: workspace.session_state(),
            session_count: workspace.session_count(),
            tab_count: workspace.tab_count(),
            pane_count: workspace.pane_count(),
            active_session_id: Some(workspace.session_id().clone()),
            active_tab_id: Some(workspace.tab_id().clone()),
            active_pane_id: Some(active_pane_id.clone()),
            zoomed_pane_id: workspace.zoomed_pane_id().cloned(),
            layout: map_layout_node(workspace.layout()),
            lease_holder_client_id: workspace
                .writer_lease(&active_pane_id)
                .map(|lease| lease.client_id.clone()),
            sessions: runtime_snapshot
                .sessions
                .iter()
                .map(|session| map_session_snapshot(session, &runtime_snapshot.active_session_id))
                .collect(),
        }
    }

    fn diagnostics_status(&self) -> String {
        match self.workspace_summary().session_state {
            remux_core::SessionLifecycleState::Starting => "starting",
            remux_core::SessionLifecycleState::Live => "live",
            remux_core::SessionLifecycleState::Degraded => "degraded",
            remux_core::SessionLifecycleState::Stopped => "stopped",
            remux_core::SessionLifecycleState::Recoverable => "recoverable",
        }
        .to_owned()
    }

    fn inspect_snapshot(&self, scope: control::InspectScope) -> control::InspectSnapshot {
        let target_pane = match &scope {
            control::InspectScope::Pane { pane_id } => pane_id.clone(),
            control::InspectScope::Tab { .. } | control::InspectScope::Session { .. } => {
                self.pane_id()
            }
        };

        match self.pane_runtime(&target_pane) {
            Ok(pane) => pane.inspect_snapshot(scope),
            Err(_) => self
                .pane_runtime(&self.pane_id())
                .expect("active pane runtime must exist")
                .inspect_snapshot(scope),
        }
    }

    fn pane_id(&self) -> PaneId {
        self.workspace
            .lock()
            .expect("runtime workspace lock poisoned")
            .active_pane_id()
            .clone()
    }

    fn create_session(&self, session_name: impl Into<String>) -> Result<SessionId, RuntimeError> {
        let default_size = TerminalSize::new(80, 24);
        let (session_id, pane_id) = {
            let mut workspace = self
                .workspace
                .lock()
                .expect("runtime workspace lock poisoned");
            let session_id = workspace.create_session(session_name.into())?;
            let pane_id = workspace.pane_id().clone();
            (session_id, pane_id)
        };

        match PaneRuntime::spawn(self.default_command.clone(), default_size) {
            Ok(pane) => {
                self.panes
                    .lock()
                    .expect("runtime panes lock poisoned")
                    .insert(pane_id, pane);
                self.workspace
                    .lock()
                    .expect("runtime workspace lock poisoned")
                    .mark_live();
                Ok(session_id)
            }
            Err(error) => {
                let _ = self
                    .workspace
                    .lock()
                    .expect("runtime workspace lock poisoned")
                    .close_session(&session_id);
                Err(RuntimeError::Spawn(error))
            }
        }
    }

    fn select_session(&self, session_id: &SessionId) -> Result<(), RuntimeError> {
        self.workspace
            .lock()
            .expect("runtime workspace lock poisoned")
            .select_session(session_id)?;
        Ok(())
    }

    fn rename_session(
        &self,
        session_id: &SessionId,
        session_name: impl Into<String>,
    ) -> Result<(), RuntimeError> {
        self.workspace
            .lock()
            .expect("runtime workspace lock poisoned")
            .rename_session(session_id, session_name)?;
        Ok(())
    }

    fn close_session(&self, session_id: &SessionId) -> Result<SessionId, RuntimeError> {
        let pane_ids = {
            let workspace = self
                .workspace
                .lock()
                .expect("runtime workspace lock poisoned");
            let snapshot = workspace.snapshot();
            let session = snapshot
                .sessions
                .iter()
                .find(|session| session.session_id == *session_id)
                .ok_or_else(|| {
                    RuntimeError::Session(WorkspaceError::UnknownSession(session_id.clone()))
                })?;
            collect_session_pane_ids(session)
        };
        let active_session_id = self
            .workspace
            .lock()
            .expect("runtime workspace lock poisoned")
            .close_session(session_id)?;

        for pane_id in pane_ids {
            if let Some(pane) = self
                .panes
                .lock()
                .expect("runtime panes lock poisoned")
                .remove(&pane_id)
            {
                pane.shutdown();
            }
        }

        Ok(active_session_id)
    }

    fn create_tab(
        &self,
        session_id: &SessionId,
        tab_title: impl Into<String>,
    ) -> Result<TabId, RuntimeError> {
        let default_size = TerminalSize::new(80, 24);
        let (tab_id, pane_id) = {
            let mut workspace = self
                .workspace
                .lock()
                .expect("runtime workspace lock poisoned");
            let tab_id = workspace.create_tab(session_id, tab_title.into())?;
            let pane_id = workspace.pane_id().clone();
            (tab_id, pane_id)
        };

        match PaneRuntime::spawn(self.default_command.clone(), default_size) {
            Ok(pane) => {
                self.panes
                    .lock()
                    .expect("runtime panes lock poisoned")
                    .insert(pane_id, pane);
                Ok(tab_id)
            }
            Err(error) => {
                let _ = self
                    .workspace
                    .lock()
                    .expect("runtime workspace lock poisoned")
                    .close_tab(&tab_id);
                Err(RuntimeError::Spawn(error))
            }
        }
    }

    fn select_tab(&self, tab_id: &TabId) -> Result<(), RuntimeError> {
        self.workspace
            .lock()
            .expect("runtime workspace lock poisoned")
            .select_tab(tab_id)?;
        Ok(())
    }

    fn rename_tab(&self, tab_id: &TabId, tab_title: impl Into<String>) -> Result<(), RuntimeError> {
        self.workspace
            .lock()
            .expect("runtime workspace lock poisoned")
            .rename_tab(tab_id, tab_title)?;
        Ok(())
    }

    fn close_tab(&self, tab_id: &TabId) -> Result<TabId, RuntimeError> {
        let pane_ids = {
            let workspace = self
                .workspace
                .lock()
                .expect("runtime workspace lock poisoned");
            let snapshot = workspace.snapshot();
            let tab = snapshot
                .sessions
                .iter()
                .flat_map(|session| session.tabs.iter())
                .find(|tab| tab.tab_id == *tab_id)
                .ok_or_else(|| RuntimeError::Session(WorkspaceError::UnknownTab(tab_id.clone())))?;
            collect_tab_pane_ids(tab)
        };
        let active_tab_id = self
            .workspace
            .lock()
            .expect("runtime workspace lock poisoned")
            .close_tab(tab_id)?;

        for pane_id in pane_ids {
            if let Some(pane) = self
                .panes
                .lock()
                .expect("runtime panes lock poisoned")
                .remove(&pane_id)
            {
                pane.shutdown();
            }
        }

        Ok(active_tab_id)
    }

    fn split_pane(
        &self,
        pane_id: &PaneId,
        direction: SplitDirection,
    ) -> Result<PaneId, RuntimeError> {
        let size = self
            .pane_runtime(pane_id)?
            .size()
            .map_err(RuntimeError::Size)?;
        let pane =
            PaneRuntime::spawn(self.default_command.clone(), size).map_err(RuntimeError::Spawn)?;
        let new_pane_id = {
            let mut workspace = self
                .workspace
                .lock()
                .expect("runtime workspace lock poisoned");
            match workspace.split_pane(pane_id, direction) {
                Ok(new_pane_id) => new_pane_id,
                Err(error) => {
                    pane.shutdown();
                    return Err(error.into());
                }
            }
        };

        self.panes
            .lock()
            .expect("runtime panes lock poisoned")
            .insert(new_pane_id.clone(), pane);
        Ok(new_pane_id)
    }

    fn focus_pane(&self, pane_id: &PaneId) -> Result<(), RuntimeError> {
        self.workspace
            .lock()
            .expect("runtime workspace lock poisoned")
            .focus_pane(pane_id)?;
        Ok(())
    }

    fn toggle_zoom(&self, pane_id: &PaneId) -> Result<(), RuntimeError> {
        self.workspace
            .lock()
            .expect("runtime workspace lock poisoned")
            .toggle_zoom(pane_id)?;
        Ok(())
    }

    fn close_pane(&self, pane_id: &PaneId) -> Result<PaneId, RuntimeError> {
        let active_pane_id = self
            .workspace
            .lock()
            .expect("runtime workspace lock poisoned")
            .close_pane(pane_id)?;

        let removed = self
            .panes
            .lock()
            .expect("runtime panes lock poisoned")
            .remove(pane_id);
        if let Some(pane) = removed {
            pane.shutdown();
        }

        Ok(active_pane_id)
    }

    fn attach(
        &self,
        pane_id: &PaneId,
        mode: terminal::ClientMode,
        size: TerminalSize,
    ) -> Result<TerminalAttachment, RuntimeError> {
        let pane = self.pane_runtime(pane_id)?;
        pane.resize(size).map_err(RuntimeError::Resize)?;

        let requested_client_id = matches!(mode, terminal::ClientMode::Interactive)
            .then(|| self.next_terminal_client_id());
        let granted_client_id = match requested_client_id.as_ref() {
            Some(client_id) => {
                let mut workspace = self
                    .workspace
                    .lock()
                    .expect("runtime workspace lock poisoned");
                match workspace.acquire_writer_lease(pane_id, client_id, LeaseMode::Interactive) {
                    Ok(()) => Some(client_id.clone()),
                    Err(WorkspaceError::LeaseConflict { .. }) => None,
                    Err(error) => return Err(error.into()),
                }
            }
            None => None,
        };
        let lease_holder = self.current_lease_holder(pane_id);

        Ok(TerminalAttachment {
            client_id: granted_client_id,
            hello: terminal::ServerMessage::Hello {
                protocol_version: RUNTIME_V2_PROTOCOL_VERSION.to_owned(),
                pane_id: Some(pane_id.clone()),
            },
            snapshot: pane.snapshot_message(),
            lease_state: terminal::ServerMessage::LeaseState {
                client_id: lease_holder,
            },
            exit: pane.exit_message(),
        })
    }

    fn detach(&self, pane_id: &PaneId, client_id: Option<&str>) {
        if let Some(client_id) = client_id {
            let _ = self
                .workspace
                .lock()
                .expect("runtime workspace lock poisoned")
                .release_writer_lease(pane_id, client_id);
        }
    }

    fn write_input(
        &self,
        pane_id: &PaneId,
        data_base64: &str,
        client_id: Option<&str>,
    ) -> Result<(), RuntimeError> {
        self.ensure_write_lease(pane_id, client_id)?;
        let bytes = BASE64.decode(data_base64).map_err(RuntimeError::Decode)?;
        self.pane_runtime(pane_id)?
            .write_all(&bytes)
            .map_err(RuntimeError::Write)
    }

    fn resize(&self, pane_id: &PaneId, size: TerminalSize) -> Result<(), RuntimeError> {
        self.pane_runtime(pane_id)?
            .resize(size)
            .map_err(RuntimeError::Resize)
    }

    fn snapshot_message(&self, pane_id: &PaneId) -> Result<terminal::ServerMessage, RuntimeError> {
        Ok(self.pane_runtime(pane_id)?.snapshot_message())
    }

    fn subscribe(
        &self,
        pane_id: &PaneId,
    ) -> Result<broadcast::Receiver<RuntimeUpdate>, RuntimeError> {
        Ok(self.pane_runtime(pane_id)?.subscribe())
    }

    fn current_lease_holder(&self, pane_id: &PaneId) -> Option<String> {
        self.workspace
            .lock()
            .expect("runtime workspace lock poisoned")
            .writer_lease(pane_id)
            .map(|lease| lease.client_id.clone())
    }

    #[cfg(test)]
    fn shutdown(&self) {
        let panes = self
            .panes
            .lock()
            .expect("runtime panes lock poisoned")
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for pane in panes {
            pane.shutdown();
        }
    }

    fn pane_runtime(&self, pane_id: &PaneId) -> Result<Arc<PaneRuntime>, RuntimeError> {
        self.panes
            .lock()
            .expect("runtime panes lock poisoned")
            .get(pane_id)
            .cloned()
            .ok_or_else(|| RuntimeError::UnknownPane(pane_id.0.clone()))
    }

    fn ensure_write_lease(
        &self,
        pane_id: &PaneId,
        client_id: Option<&str>,
    ) -> Result<(), RuntimeError> {
        let workspace = self
            .workspace
            .lock()
            .expect("runtime workspace lock poisoned");
        let current_client_id = workspace
            .writer_lease(pane_id)
            .map(|lease| lease.client_id.clone());

        match (client_id, current_client_id.clone()) {
            (Some(client_id), Some(current_holder)) if current_holder == client_id => Ok(()),
            _ => Err(RuntimeError::WriteLeaseUnavailable {
                pane_id: pane_id.clone(),
                current_client_id,
            }),
        }
    }

    fn next_terminal_client_id(&self) -> String {
        let sequence = self
            .terminal_client_sequence
            .fetch_add(1, Ordering::Relaxed)
            + 1;
        format!("terminal-client-{sequence}")
    }
}

impl ServerConfig {
    pub fn from_process_env(overrides: ServerConfigOverrides) -> Result<Self, ConfigError> {
        let environment = ServerConfigEnvironment {
            host: env::var("REMUXD_HOST").ok(),
            port: env::var("REMUXD_PORT").ok(),
            public_base_url: env::var("REMUXD_PUBLIC_BASE_URL").ok(),
        };
        Self::from_sources(overrides, environment)
    }

    pub fn from_sources(
        overrides: ServerConfigOverrides,
        environment: ServerConfigEnvironment,
    ) -> Result<Self, ConfigError> {
        let host = normalize_string(overrides.host)
            .or_else(|| normalize_string(environment.host))
            .unwrap_or_else(|| "127.0.0.1".to_owned());
        let public_base_url = normalize_string(overrides.public_base_url)
            .or_else(|| normalize_string(environment.public_base_url));

        let port = match overrides.port {
            Some(port) => port,
            None => match normalize_string(environment.port) {
                Some(raw) => raw.parse().map_err(|_| ConfigError::InvalidPort(raw))?,
                None => 3737,
            },
        };

        Ok(Self {
            host,
            port,
            public_base_url,
        })
    }

    #[must_use]
    pub fn metadata(&self) -> ServerMetadata {
        ServerMetadata {
            service: "remuxd".to_owned(),
            protocol_version: RUNTIME_V2_PROTOCOL_VERSION.to_owned(),
            control_websocket_path: "/v2/control".to_owned(),
            terminal_websocket_path: "/v2/terminal".to_owned(),
            public_base_url: self.public_base_url.clone(),
        }
    }
}

#[must_use]
pub fn build_router(config: ServerConfig) -> Router {
    build_router_with_runtime(config, None)
}

pub async fn serve(config: ServerConfig) -> Result<(), std::io::Error> {
    let runtime = WorkspaceRuntime::spawn_default()
        .map_err(|error| std::io::Error::other(error.to_string()))?;
    let bind_address = format!("{}:{}", config.host, config.port);
    let listener = tokio::net::TcpListener::bind(bind_address).await?;
    axum::serve(listener, build_router_with_runtime(config, Some(runtime))).await
}

fn build_router_with_runtime(
    config: ServerConfig,
    runtime: Option<Arc<WorkspaceRuntime>>,
) -> Router {
    let state = AppState {
        metadata: config.metadata(),
        runtime,
    };

    Router::new()
        .route("/healthz", get(healthz))
        .route("/v2/meta", get(meta))
        .route("/v2/control", get(control_socket))
        .route("/v2/terminal", get(terminal_socket))
        .with_state(state)
}

fn map_layout_node(node: &SessionLayoutNode) -> control::LayoutNode {
    match node {
        SessionLayoutNode::Leaf(pane_id) => control::LayoutNode::Leaf {
            pane_id: pane_id.clone(),
        },
        SessionLayoutNode::Split {
            direction,
            ratio,
            children,
        } => control::LayoutNode::Split {
            direction: *direction,
            ratio: *ratio,
            children: children.iter().map(map_layout_node).collect(),
        },
    }
}

fn map_session_snapshot(
    session: &RuntimeSessionSnapshot,
    active_session_id: &SessionId,
) -> control::SessionSummary {
    control::SessionSummary {
        session_id: session.session_id.clone(),
        session_name: session.session_name.clone(),
        session_state: session.session_state,
        is_active: session.session_id == *active_session_id,
        active_tab_id: session.active_tab_id.clone(),
        tab_count: session.tabs.len(),
        tabs: session
            .tabs
            .iter()
            .map(|tab| map_tab_snapshot(tab, &session.active_tab_id))
            .collect(),
    }
}

fn map_tab_snapshot(tab: &RuntimeTabSnapshot, active_tab_id: &TabId) -> control::TabSummary {
    control::TabSummary {
        tab_id: tab.tab_id.clone(),
        tab_title: tab.tab_title.clone(),
        is_active: tab.tab_id == *active_tab_id,
        active_pane_id: tab.active_pane_id.clone(),
        zoomed_pane_id: tab.zoomed_pane_id.clone(),
        pane_count: tab.panes.len(),
        layout: map_layout_node(&tab.layout),
        panes: tab
            .panes
            .iter()
            .map(|pane| map_pane_snapshot(pane, &tab.active_pane_id, tab.zoomed_pane_id.as_ref()))
            .collect(),
    }
}

fn map_pane_snapshot(
    pane: &SessionPaneSnapshot,
    active_pane_id: &PaneId,
    zoomed_pane_id: Option<&PaneId>,
) -> control::PaneSummary {
    control::PaneSummary {
        pane_id: pane.pane_id.clone(),
        is_active: pane.pane_id == *active_pane_id,
        is_zoomed: zoomed_pane_id == Some(&pane.pane_id),
        lease_holder_client_id: pane
            .writer_lease
            .as_ref()
            .map(|lease| lease.client_id.clone()),
    }
}

fn collect_session_pane_ids(session: &RuntimeSessionSnapshot) -> Vec<PaneId> {
    session
        .tabs
        .iter()
        .flat_map(collect_tab_pane_ids)
        .collect()
}

fn collect_tab_pane_ids(tab: &RuntimeTabSnapshot) -> Vec<PaneId> {
    tab.panes.iter().map(|pane| pane.pane_id.clone()).collect()
}

fn normalize_string(value: Option<String>) -> Option<String> {
    value
        .map(|item| item.trim().to_owned())
        .filter(|item| !item.is_empty())
}

async fn healthz() -> &'static str {
    "ok"
}

async fn meta(State(state): State<AppState>) -> Json<ServerMetadata> {
    Json(state.metadata)
}

async fn control_socket(
    State(state): State<AppState>,
    websocket: WebSocketUpgrade,
) -> impl IntoResponse {
    websocket.on_upgrade(move |socket| handle_control_socket(socket, state))
}

async fn terminal_socket(
    State(state): State<AppState>,
    websocket: WebSocketUpgrade,
) -> impl IntoResponse {
    websocket.on_upgrade(move |socket| handle_terminal_socket(socket, state))
}

async fn handle_control_socket(mut socket: WebSocket, state: AppState) {
    let hello = control::ServerMessage::Hello {
        protocol_version: state.metadata.protocol_version.clone(),
        write_lease_model: "single-active-writer".to_owned(),
    };

    if send_json_message(&mut socket, &hello).await.is_err() {
        return;
    }

    if let Some(runtime) = state.runtime.as_ref() {
        if send_workspace_snapshot(&mut socket, runtime).await.is_err() {
            return;
        }
    }

    while let Some(message) = socket.next().await {
        match message {
            Ok(Message::Text(text)) if text.trim() == "ping" => {
                if socket.send(Message::Text("pong".into())).await.is_err() {
                    break;
                }
            }
            Ok(Message::Text(text)) => {
                let Ok(command) = serde_json::from_str::<control::ClientMessage>(&text) else {
                    continue;
                };

                match command {
                    control::ClientMessage::Authenticate { .. } => {}
                    control::ClientMessage::SubscribeWorkspace => {
                        if let Some(runtime) = state.runtime.as_ref() {
                            if send_workspace_snapshot(&mut socket, runtime).await.is_err() {
                                break;
                            }
                        }
                    }
                    control::ClientMessage::RequestDiagnostics => {
                        let snapshot = control::ServerMessage::DiagnosticsSnapshot {
                            runtime_status: state
                                .runtime
                                .as_ref()
                                .map(|runtime| runtime.diagnostics_status())
                                .unwrap_or_else(|| "bootstrap-only".to_owned()),
                        };
                        if send_json_message(&mut socket, &snapshot).await.is_err() {
                            break;
                        }
                    }
                    control::ClientMessage::RequestInspect { scope } => {
                        if let Some(runtime) = state.runtime.as_ref() {
                            let snapshot = control::ServerMessage::InspectSnapshot {
                                snapshot: runtime.inspect_snapshot(scope),
                            };
                            if send_json_message(&mut socket, &snapshot).await.is_err() {
                                break;
                            }
                        }
                    }
                    control::ClientMessage::SplitPane { pane_id, direction } => {
                        if handle_control_command(&mut socket, state.runtime.as_ref(), |runtime| {
                            runtime.split_pane(&pane_id, direction).map(|_| ())
                        })
                        .await
                        .is_err()
                        {
                            break;
                        }
                    }
                    control::ClientMessage::FocusPane { pane_id } => {
                        if handle_control_command(&mut socket, state.runtime.as_ref(), |runtime| {
                            runtime.focus_pane(&pane_id)
                        })
                        .await
                        .is_err()
                        {
                            break;
                        }
                    }
                    control::ClientMessage::ClosePane { pane_id } => {
                        if handle_control_command(&mut socket, state.runtime.as_ref(), |runtime| {
                            runtime.close_pane(&pane_id).map(|_| ())
                        })
                        .await
                        .is_err()
                        {
                            break;
                        }
                    }
                    control::ClientMessage::TogglePaneZoom { pane_id } => {
                        if handle_control_command(&mut socket, state.runtime.as_ref(), |runtime| {
                            runtime.toggle_zoom(&pane_id)
                        })
                        .await
                        .is_err()
                        {
                            break;
                        }
                    }
                    control::ClientMessage::CreateSession { session_name } => {
                        if handle_control_command(&mut socket, state.runtime.as_ref(), |runtime| {
                            runtime.create_session(session_name).map(|_| ())
                        })
                        .await
                        .is_err()
                        {
                            break;
                        }
                    }
                    control::ClientMessage::SelectSession { session_id } => {
                        if handle_control_command(&mut socket, state.runtime.as_ref(), |runtime| {
                            runtime.select_session(&session_id)
                        })
                        .await
                        .is_err()
                        {
                            break;
                        }
                    }
                    control::ClientMessage::RenameSession {
                        session_id,
                        session_name,
                    } => {
                        if handle_control_command(&mut socket, state.runtime.as_ref(), |runtime| {
                            runtime.rename_session(&session_id, session_name)
                        })
                        .await
                        .is_err()
                        {
                            break;
                        }
                    }
                    control::ClientMessage::CloseSession { session_id } => {
                        if handle_control_command(&mut socket, state.runtime.as_ref(), |runtime| {
                            runtime.close_session(&session_id).map(|_| ())
                        })
                        .await
                        .is_err()
                        {
                            break;
                        }
                    }
                    control::ClientMessage::CreateTab {
                        session_id,
                        tab_title,
                    } => {
                        if handle_control_command(&mut socket, state.runtime.as_ref(), |runtime| {
                            runtime.create_tab(&session_id, tab_title).map(|_| ())
                        })
                        .await
                        .is_err()
                        {
                            break;
                        }
                    }
                    control::ClientMessage::SelectTab { tab_id } => {
                        if handle_control_command(&mut socket, state.runtime.as_ref(), |runtime| {
                            runtime.select_tab(&tab_id)
                        })
                        .await
                        .is_err()
                        {
                            break;
                        }
                    }
                    control::ClientMessage::RenameTab { tab_id, tab_title } => {
                        if handle_control_command(&mut socket, state.runtime.as_ref(), |runtime| {
                            runtime.rename_tab(&tab_id, tab_title)
                        })
                        .await
                        .is_err()
                        {
                            break;
                        }
                    }
                    control::ClientMessage::CloseTab { tab_id } => {
                        if handle_control_command(&mut socket, state.runtime.as_ref(), |runtime| {
                            runtime.close_tab(&tab_id).map(|_| ())
                        })
                        .await
                        .is_err()
                        {
                            break;
                        }
                    }
                }
            }
            Ok(Message::Close(_)) | Err(_) => break,
            _ => {}
        }
    }
}

async fn handle_control_command<F>(
    socket: &mut WebSocket,
    runtime: Option<&Arc<WorkspaceRuntime>>,
    operation: F,
) -> Result<(), axum::Error>
where
    F: FnOnce(&WorkspaceRuntime) -> Result<(), RuntimeError>,
{
    let Some(runtime) = runtime else {
        return Ok(());
    };

    match operation(runtime) {
        Ok(()) => send_workspace_snapshot(socket, runtime).await,
        Err(error) => {
            let rejected = control::ServerMessage::CommandRejected {
                reason: error.to_string(),
            };
            send_json_message(socket, &rejected).await
        }
    }
}

async fn send_workspace_snapshot(
    socket: &mut WebSocket,
    runtime: &WorkspaceRuntime,
) -> Result<(), axum::Error> {
    let snapshot = control::ServerMessage::WorkspaceSnapshot {
        summary: runtime.workspace_summary(),
    };
    send_json_message(socket, &snapshot).await
}

async fn handle_terminal_socket(mut socket: WebSocket, state: AppState) {
    let Some(runtime) = state.runtime.clone() else {
        let hello = terminal::ServerMessage::Hello {
            protocol_version: state.metadata.protocol_version,
            pane_id: None,
        };
        let _ = send_json_message(&mut socket, &hello).await;
        return;
    };

    let mut attached_pane_id: Option<PaneId> = None;
    let mut attached_client_id: Option<String> = None;
    let mut runtime_updates: Option<broadcast::Receiver<RuntimeUpdate>> = None;

    loop {
        tokio::select! {
            update = recv_runtime_update(runtime_updates.as_mut()), if runtime_updates.is_some() => {
                match update {
                    Some(RuntimeStreamMessage::Event(event)) => {
                        if send_json_message(&mut socket, &event).await.is_err() {
                            break;
                        }
                    }
                    Some(RuntimeStreamMessage::Resync) => {
                        let Some(pane_id) = attached_pane_id.as_ref() else {
                            continue;
                        };
                        let Ok(snapshot) = runtime.snapshot_message(pane_id) else {
                            break;
                        };
                        if send_json_message(&mut socket, &snapshot).await.is_err() {
                            break;
                        }
                    }
                    None => break,
                }
            }
            message = socket.next() => {
                match message {
                    Some(Ok(Message::Text(text))) if text.trim() == "ping" => {
                        if socket.send(Message::Text("pong".into())).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Text(text))) => {
                        let Ok(command) = serde_json::from_str::<terminal::ClientMessage>(&text) else {
                            continue;
                        };

                        match command {
                            terminal::ClientMessage::Attach { pane_id, mode, size } => {
                                if let Some(previous_pane_id) = attached_pane_id.as_ref() {
                                    runtime.detach(previous_pane_id, attached_client_id.as_deref());
                                }

                                let Ok(attachment) = runtime.attach(&pane_id, mode, size) else {
                                    break;
                                };
                                let Ok(receiver) = runtime.subscribe(&pane_id) else {
                                    break;
                                };
                                attached_pane_id = Some(pane_id.clone());
                                attached_client_id = attachment.client_id.clone();
                                runtime_updates = Some(receiver);

                                if send_json_message(&mut socket, &attachment.hello).await.is_err() {
                                    break;
                                }
                                if send_json_message(&mut socket, &attachment.snapshot).await.is_err() {
                                    break;
                                }
                                if send_json_message(&mut socket, &attachment.lease_state).await.is_err() {
                                    break;
                                }
                                if let Some(exit) = attachment.exit {
                                    if send_json_message(&mut socket, &exit).await.is_err() {
                                        break;
                                    }
                                }
                            }
                            terminal::ClientMessage::Input { data_base64 } => {
                                let Some(pane_id) = attached_pane_id.as_ref() else {
                                    continue;
                                };
                                match runtime.write_input(pane_id, &data_base64, attached_client_id.as_deref()) {
                                    Ok(()) => {}
                                    Err(RuntimeError::WriteLeaseUnavailable { current_client_id, .. }) => {
                                        let lease_state = terminal::ServerMessage::LeaseState {
                                            client_id: current_client_id,
                                        };
                                        if send_json_message(&mut socket, &lease_state).await.is_err() {
                                            break;
                                        }
                                    }
                                    Err(_) => break,
                                }
                            }
                            terminal::ClientMessage::Resize { size } => {
                                let Some(pane_id) = attached_pane_id.as_ref() else {
                                    continue;
                                };
                                if runtime.resize(pane_id, size).is_err() {
                                    break;
                                }
                                if send_json_message(&mut socket, &terminal::ServerMessage::ResizeConfirmed { size }).await.is_err() {
                                    break;
                                }
                            }
                            terminal::ClientMessage::RequestSnapshot => {
                                let Some(pane_id) = attached_pane_id.as_ref() else {
                                    continue;
                                };
                                let Ok(snapshot) = runtime.snapshot_message(pane_id) else {
                                    break;
                                };
                                if send_json_message(&mut socket, &snapshot).await.is_err() {
                                    break;
                                }
                            }
                        }
                    }
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    _ => {}
                }
            }
        }
    }

    if let Some(pane_id) = attached_pane_id.as_ref() {
        runtime.detach(pane_id, attached_client_id.as_deref());
    }
}

enum RuntimeStreamMessage {
    Event(terminal::ServerMessage),
    Resync,
}

async fn recv_runtime_update(
    receiver: Option<&mut broadcast::Receiver<RuntimeUpdate>>,
) -> Option<RuntimeStreamMessage> {
    let receiver = match receiver {
        Some(receiver) => receiver,
        None => return pending::<Option<RuntimeStreamMessage>>().await,
    };

    match receiver.recv().await {
        Ok(RuntimeUpdate::Output {
            sequence,
            chunk_base64,
        }) => Some(RuntimeStreamMessage::Event(
            terminal::ServerMessage::Stream {
                sequence,
                chunk_base64,
            },
        )),
        Ok(RuntimeUpdate::Exit { exit_code }) => {
            Some(RuntimeStreamMessage::Event(terminal::ServerMessage::Exit {
                exit_code,
            }))
        }
        Err(broadcast::error::RecvError::Lagged(_)) => Some(RuntimeStreamMessage::Resync),
        Err(broadcast::error::RecvError::Closed) => None,
    }
}

async fn send_json_message<T: Serialize>(
    socket: &mut WebSocket,
    payload: &T,
) -> Result<(), axum::Error> {
    let json = serde_json::to_string(payload).expect("websocket payload must serialize");
    socket.send(Message::Text(json.into())).await
}

#[cfg(test)]
mod tests {
    use axum::http::StatusCode;
    use http_body_util::BodyExt;
    use remux_protocol::terminal::ClientMode;
    use remux_pty::PtyCommand;
    use tower::util::ServiceExt;

    use super::*;

    #[test]
    fn config_uses_defaults_when_sources_are_empty() {
        let config = ServerConfig::from_sources(
            ServerConfigOverrides::default(),
            ServerConfigEnvironment::default(),
        )
        .expect("default config should resolve");

        assert_eq!(
            config,
            ServerConfig {
                host: "127.0.0.1".to_owned(),
                port: 3737,
                public_base_url: None,
            }
        );
    }

    #[test]
    fn config_prefers_cli_over_environment() {
        let config = ServerConfig::from_sources(
            ServerConfigOverrides {
                host: Some("0.0.0.0".to_owned()),
                port: Some(4040),
                public_base_url: Some("https://remux.example".to_owned()),
            },
            ServerConfigEnvironment {
                host: Some("127.0.0.1".to_owned()),
                port: Some("3737".to_owned()),
                public_base_url: Some("https://old.example".to_owned()),
            },
        )
        .expect("override config should resolve");

        assert_eq!(config.host, "0.0.0.0");
        assert_eq!(config.port, 4040);
        assert_eq!(
            config.public_base_url.as_deref(),
            Some("https://remux.example")
        );
    }

    #[test]
    fn config_rejects_invalid_environment_port() {
        let error = ServerConfig::from_sources(
            ServerConfigOverrides::default(),
            ServerConfigEnvironment {
                port: Some("not-a-port".to_owned()),
                ..ServerConfigEnvironment::default()
            },
        )
        .expect_err("invalid port should fail");

        assert_eq!(error, ConfigError::InvalidPort("not-a-port".to_owned()));
    }

    #[tokio::test]
    async fn healthz_route_returns_ok() {
        let response = build_router(ServerConfig {
            host: "127.0.0.1".to_owned(),
            port: 3737,
            public_base_url: None,
        })
        .oneshot(
            axum::http::Request::get("/healthz")
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .expect("healthz response");

        assert_eq!(response.status(), StatusCode::OK);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(std::str::from_utf8(&body).unwrap(), "ok");
    }

    #[tokio::test]
    async fn meta_route_exposes_v2_endpoints() {
        let response = build_router(ServerConfig {
            host: "127.0.0.1".to_owned(),
            port: 3737,
            public_base_url: Some("https://public.example".to_owned()),
        })
        .oneshot(
            axum::http::Request::get("/v2/meta")
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .expect("meta response");

        assert_eq!(response.status(), StatusCode::OK);
        let payload = response.into_body().collect().await.unwrap().to_bytes();
        let metadata: ServerMetadata = serde_json::from_slice(&payload).expect("json metadata");
        assert_eq!(metadata.protocol_version, RUNTIME_V2_PROTOCOL_VERSION);
        assert_eq!(metadata.control_websocket_path, "/v2/control");
        assert_eq!(metadata.terminal_websocket_path, "/v2/terminal");
        assert_eq!(
            metadata.public_base_url.as_deref(),
            Some("https://public.example")
        );
    }

    #[tokio::test]
    async fn runtime_split_creates_new_pane_and_updates_workspace_summary() {
        let runtime = WorkspaceRuntime::spawn_with_command(test_runtime_command())
            .expect("test runtime should spawn");
        let original_pane = runtime.pane_id();

        let new_pane = runtime
            .split_pane(&original_pane, SplitDirection::Vertical)
            .expect("split should succeed");
        let summary = runtime.workspace_summary();

        assert_eq!(summary.pane_count, 2);
        assert_eq!(summary.active_pane_id, Some(new_pane.clone()));
        assert_eq!(summary.zoomed_pane_id, None);
        assert_eq!(
            summary.layout,
            control::LayoutNode::Split {
                direction: SplitDirection::Vertical,
                ratio: 50,
                children: vec![
                    control::LayoutNode::Leaf {
                        pane_id: original_pane,
                    },
                    control::LayoutNode::Leaf { pane_id: new_pane },
                ],
            }
        );

        runtime.shutdown();
    }

    #[tokio::test]
    async fn interactive_attach_acquires_write_lease_for_the_pane() {
        let runtime = WorkspaceRuntime::spawn_with_command(test_runtime_command())
            .expect("test runtime should spawn");
        let pane_id = runtime.pane_id();

        let attachment = runtime
            .attach(&pane_id, ClientMode::Interactive, TerminalSize::new(80, 24))
            .expect("interactive attach should succeed");
        let summary = runtime.workspace_summary();

        assert_eq!(summary.lease_holder_client_id, attachment.client_id.clone());
        assert_eq!(
            attachment.lease_state,
            terminal::ServerMessage::LeaseState {
                client_id: attachment.client_id.clone(),
            }
        );

        runtime.detach(&pane_id, attachment.client_id.as_deref());
        assert_eq!(runtime.workspace_summary().lease_holder_client_id, None);
        runtime.shutdown();
    }

    #[tokio::test]
    async fn runtime_creates_sessions_and_tabs_with_real_root_panes() {
        let runtime = WorkspaceRuntime::spawn_with_command(test_runtime_command())
            .expect("test runtime should spawn");

        let second_session = runtime
            .create_session("Ops")
            .expect("session create should succeed");
        let second_tab = runtime
            .create_tab(&second_session, "Logs")
            .expect("tab create should succeed");
        let summary = runtime.workspace_summary();

        assert_eq!(summary.session_count, 2);
        assert_eq!(summary.tab_count, 2);
        assert_eq!(summary.active_session_id, Some(second_session));
        assert_eq!(summary.active_tab_id, Some(second_tab));
        assert_eq!(summary.sessions.len(), 2);

        runtime.shutdown();
    }

    fn test_runtime_command() -> PtyCommand {
        PtyCommand::default_shell().env("TERM", "xterm-256color")
    }
}

#![forbid(unsafe_code)]

use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::future::pending;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use futures_util::StreamExt;
use remux_core::{
    PaneId, SessionId, SplitDirection, TabId, TerminalSize, RUNTIME_V2_PROTOCOL_VERSION,
};
use remux_inspect::build_pane_inspect_view;
use remux_protocol::{control, terminal};
use remux_pty::{PortablePtyProcess, PtyCommand, PtyError, PtyEvent};
use remux_session::{
    LayoutNode as SessionLayoutNode, LeaseMode, PaneSnapshot as SessionPaneSnapshot,
    SessionSnapshot as RuntimeSessionSnapshot, SinglePaneWorkspace,
    TabSnapshot as RuntimeTabSnapshot, WorkspaceError,
};
use remux_terminal::{
    TerminalPatch as RuntimeTerminalPatch, TerminalPatchChunk as RuntimeTerminalPatchChunk,
    TerminalPatchLine as RuntimeTerminalPatchLine, TerminalPatchSource as RuntimeTerminalPatchSource,
    TerminalSnapshot, TerminalState,
};
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
    pub version: String,
    pub protocol_version: String,
    pub control_websocket_path: String,
    pub terminal_websocket_path: String,
    pub public_base_url: Option<String>,
    pub git_branch: Option<String>,
    pub git_commit_sha: Option<String>,
    pub git_dirty: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RuntimeIdentity {
    version: String,
    git_branch: Option<String>,
    git_commit_sha: Option<String>,
    git_dirty: Option<bool>,
}

#[derive(Clone)]
struct AppState {
    metadata: ServerMetadata,
    runtime: Option<Arc<WorkspaceRuntime>>,
}

#[derive(Debug, Clone)]
enum RuntimeUpdate {
    Output {
        sequence: u64,
        chunk: Vec<u8>,
        patch: RuntimeTerminalPatch,
    },
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
    terminal_recovered_after_poison: AtomicBool,
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
    workspace_updates: broadcast::Sender<()>,
    terminal_client_sequence: AtomicU64,
    default_command: PtyCommand,
}

impl PaneRuntime {
    fn lock_terminal(&self) -> MutexGuard<'_, TerminalState> {
        match self.terminal.lock() {
            Ok(guard) => guard,
            Err(poisoned) => {
                let mut guard = poisoned.into_inner();
                if !self
                    .terminal_recovered_after_poison
                    .swap(true, Ordering::Relaxed)
                {
                    eprintln!(
                        "[remux-server] runtime terminal lock poisoned; resetting pane state"
                    );
                    guard.recover_from_poison();
                }
                guard
            }
        }
    }

    fn spawn(command: PtyCommand, size: TerminalSize) -> Result<Arc<Self>, PtyError> {
        let process = PortablePtyProcess::spawn(command, size)?;
        let (updates, _) = broadcast::channel(256);

        let pane = Arc::new(Self {
            process,
            terminal: Mutex::new(TerminalState::new(size, 10_000)),
            terminal_recovered_after_poison: AtomicBool::new(false),
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
                let patch = {
                    let mut terminal = self.lock_terminal();
                    terminal.ingest(&chunk);
                    terminal.build_patch(RuntimeTerminalPatchSource::Stream)
                };
                let sequence = self.sequence.fetch_add(1, Ordering::Relaxed) + 1;
                let _ = self.updates.send(RuntimeUpdate::Output {
                    sequence,
                    chunk,
                    patch,
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
        self.lock_terminal().resize(size);
        Ok(())
    }

    fn size(&self) -> Result<TerminalSize, PtyError> {
        self.process.size()
    }

    fn write_all(&self, bytes: &[u8]) -> Result<(), PtyError> {
        self.process.write_all(bytes)
    }

    fn inspect_snapshot(&self, scope: control::InspectScope) -> control::InspectSnapshot {
        let mut terminal = self.lock_terminal();
        let inspect = build_pane_inspect_view(&mut terminal);

        control::InspectSnapshot {
            scope,
            precision: inspect.precision,
            summary: inspect.summary,
            preview_text: inspect.preview_text,
            inspect_rows: inspect.inspect_rows,
            visible_rows: inspect.visible_rows,
            byte_count: inspect.byte_count,
            size: inspect.size,
        }
    }

    fn snapshot_message(&self) -> terminal::ServerMessage {
        let snapshot = self.lock_terminal().snapshot();
        build_terminal_snapshot_message(&snapshot, self.sequence.load(Ordering::Relaxed))
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
        Self::spawn_with_command(
            PtyCommand::default_shell()
                .env("TERM", "xterm-256color")
                .env("COLORTERM", "truecolor"),
        )
    }

    fn spawn_with_command(default_command: PtyCommand) -> Result<Arc<Self>, PtyError> {
        let mut workspace = SinglePaneWorkspace::new("Main", "Shell");
        let root_pane_id = workspace.pane_id().clone();
        let root_pane = PaneRuntime::spawn(default_command.clone(), TerminalSize::new(80, 24))?;
        workspace.mark_live();

        let mut panes = BTreeMap::new();
        panes.insert(root_pane_id, root_pane);
        let (workspace_updates, _) = broadcast::channel(64);

        Ok(Arc::new(Self {
            workspace: Mutex::new(workspace),
            panes: Mutex::new(panes),
            workspace_updates,
            terminal_client_sequence: AtomicU64::new(0),
            default_command,
        }))
    }

    fn subscribe_workspace(&self) -> broadcast::Receiver<()> {
        self.workspace_updates.subscribe()
    }

    fn notify_workspace_changed(&self) {
        let _ = self.workspace_updates.send(());
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
                self.notify_workspace_changed();
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
        self.notify_workspace_changed();
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
        self.notify_workspace_changed();
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

        self.notify_workspace_changed();
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
                self.notify_workspace_changed();
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
        self.notify_workspace_changed();
        Ok(())
    }

    fn rename_tab(&self, tab_id: &TabId, tab_title: impl Into<String>) -> Result<(), RuntimeError> {
        self.workspace
            .lock()
            .expect("runtime workspace lock poisoned")
            .rename_tab(tab_id, tab_title)?;
        self.notify_workspace_changed();
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

        self.notify_workspace_changed();
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
        self.notify_workspace_changed();
        Ok(new_pane_id)
    }

    fn focus_pane(&self, pane_id: &PaneId) -> Result<(), RuntimeError> {
        self.workspace
            .lock()
            .expect("runtime workspace lock poisoned")
            .focus_pane(pane_id)?;
        self.notify_workspace_changed();
        Ok(())
    }

    fn toggle_zoom(&self, pane_id: &PaneId) -> Result<(), RuntimeError> {
        self.workspace
            .lock()
            .expect("runtime workspace lock poisoned")
            .toggle_zoom(pane_id)?;
        self.notify_workspace_changed();
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

        self.notify_workspace_changed();
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
        let mut lease_changed = false;
        match requested_client_id.as_ref() {
            Some(client_id) => {
                let mut workspace = self
                    .workspace
                    .lock()
                    .expect("runtime workspace lock poisoned");
                match workspace.acquire_writer_lease(pane_id, client_id, LeaseMode::Interactive) {
                    Ok(()) => {
                        lease_changed = true;
                    }
                    Err(WorkspaceError::LeaseConflict { .. }) => {}
                    Err(error) => return Err(error.into()),
                }
            }
            None => {}
        }
        let lease_holder = self.current_lease_holder(pane_id);
        if lease_changed {
            self.notify_workspace_changed();
        }

        Ok(TerminalAttachment {
            client_id: requested_client_id,
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
            let released = self
                .workspace
                .lock()
                .expect("runtime workspace lock poisoned")
                .release_writer_lease(pane_id, client_id)
                .is_ok();
            if released {
                self.notify_workspace_changed();
            }
        }
    }

    fn write_input(
        &self,
        pane_id: &PaneId,
        data_base64: &str,
        client_id: Option<&str>,
    ) -> Result<(), RuntimeError> {
        let bytes = BASE64.decode(data_base64).map_err(RuntimeError::Decode)?;
        self.write_input_bytes(pane_id, &bytes, client_id)
    }

    fn write_input_bytes(
        &self,
        pane_id: &PaneId,
        bytes: &[u8],
        client_id: Option<&str>,
    ) -> Result<(), RuntimeError> {
        if let Some(client_id) = client_id {
            let lease_changed = {
                let mut workspace = self
                    .workspace
                    .lock()
                    .expect("runtime workspace lock poisoned");
                workspace.take_writer_lease(pane_id, client_id, LeaseMode::Interactive)?
            };
            if lease_changed {
                self.notify_workspace_changed();
            }
        }

        self.ensure_write_lease(pane_id, client_id)?;
        self.pane_runtime(pane_id)?
            .write_all(bytes)
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
        let identity = discover_runtime_identity();
        ServerMetadata {
            service: "remuxd".to_owned(),
            version: identity.version,
            protocol_version: RUNTIME_V2_PROTOCOL_VERSION.to_owned(),
            control_websocket_path: "/v2/control".to_owned(),
            terminal_websocket_path: "/v2/terminal".to_owned(),
            public_base_url: self.public_base_url.clone(),
            git_branch: identity.git_branch,
            git_commit_sha: identity.git_commit_sha,
            git_dirty: identity.git_dirty,
        }
    }
}

fn discover_runtime_identity() -> RuntimeIdentity {
    let cwd = env::current_dir().ok();
    let version = cwd
        .as_deref()
        .and_then(package_version_from_dir)
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_owned());
    let git_branch = env::var("REMUX_RUNTIME_BRANCH")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            cwd.as_deref()
                .and_then(|dir| run_git(dir, &["rev-parse", "--abbrev-ref", "HEAD"]))
        })
        .filter(|value| value != "HEAD");
    let git_commit_sha = cwd
        .as_deref()
        .and_then(|dir| run_git(dir, &["rev-parse", "HEAD"]));
    let git_dirty = cwd.as_deref().and_then(git_dirty_state);

    RuntimeIdentity {
        version,
        git_branch,
        git_commit_sha,
        git_dirty,
    }
}

fn package_version_from_dir(dir: &Path) -> Option<String> {
    let package_path = find_repo_package_json(dir)?;
    let raw = fs::read_to_string(package_path).ok()?;
    let json = serde_json::from_str::<serde_json::Value>(&raw).ok()?;
    json.get("version")?.as_str().map(ToOwned::to_owned)
}

fn build_terminal_snapshot_message(
    snapshot: &TerminalSnapshot,
    sequence: u64,
) -> terminal::ServerMessage {
    terminal::ServerMessage::Snapshot {
        size: snapshot.size,
        source_size: snapshot.source_size,
        cursor: terminal::CursorPosition {
            row: snapshot.cursor.row,
            col: snapshot.cursor.col,
        },
        scrollback_row_wraps: snapshot.scrollback_row_wraps.clone(),
        visible_row_wraps: snapshot.visible_row_wraps.clone(),
        sequence,
        content_base64: BASE64.encode(&snapshot.formatted_state),
        replay_base64: Some(BASE64.encode(&snapshot.replay_formatted)),
    }
}

fn build_terminal_patch_message(
    pane_id: &PaneId,
    patch: &RuntimeTerminalPatch,
    view_revision: u64,
    epoch: u64,
    data_base64: String,
) -> terminal::ServerMessage {
    terminal::ServerMessage::TerminalPatch {
        pane_id: pane_id.clone(),
        epoch,
        view_revision,
        revision: patch.revision,
        base_revision: patch.base_revision,
        reset: patch.reset,
        source: match patch.source {
            RuntimeTerminalPatchSource::Snapshot => terminal::TerminalPatchSource::Snapshot,
            RuntimeTerminalPatchSource::Stream => terminal::TerminalPatchSource::Stream,
        },
        cols: patch.cols,
        rows: patch.rows,
        data_base64,
        payload: Some(terminal::TerminalPatchPayload {
            visible_row_base: patch.visible_row_base,
            chunks: patch
                .chunks
                .iter()
                .map(map_runtime_patch_chunk)
                .collect(),
        }),
    }
}

fn map_runtime_patch_chunk(chunk: &RuntimeTerminalPatchChunk) -> terminal::TerminalPatchChunk {
    terminal::TerminalPatchChunk {
        start_row: chunk.start_row,
        lines: chunk.lines.iter().map(map_runtime_patch_line).collect(),
    }
}

fn map_runtime_patch_line(line: &RuntimeTerminalPatchLine) -> terminal::TerminalPatchLine {
    terminal::TerminalPatchLine {
        text: line.text.clone(),
        wrapped: line.wrapped,
    }
}

fn find_repo_package_json(dir: &Path) -> Option<PathBuf> {
    for ancestor in dir.ancestors() {
        let candidate = ancestor.join("package.json");
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn run_git(dir: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }

    let value = String::from_utf8(output.stdout).ok()?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_owned())
    }
}

fn git_dirty_state(dir: &Path) -> Option<bool> {
    let output = Command::new("git")
        .args(["status", "--porcelain", "--untracked-files=no"])
        .current_dir(dir)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }

    Some(!output.stdout.is_empty())
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
    session.tabs.iter().flat_map(collect_tab_pane_ids).collect()
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
    let mut workspace_updates = state
        .runtime
        .as_ref()
        .map(|runtime| runtime.subscribe_workspace());
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

    loop {
        tokio::select! {
            update = recv_workspace_update(workspace_updates.as_mut()), if workspace_updates.is_some() => {
                match update {
                    Some(()) => {
                        if let Some(runtime) = state.runtime.as_ref() {
                            if send_workspace_snapshot(&mut socket, runtime).await.is_err() {
                                break;
                            }
                        }
                    }
                    None => break,
                }
            }
            message = socket.next() => {
                let Some(message) = message else {
                    break;
                };
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
        Ok(()) => Ok(()),
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
    let snapshot = control::ServerMessage::RuntimeSnapshot {
        summary: runtime.workspace_summary(),
    };
    send_json_message(socket, &snapshot).await
}

async fn recv_workspace_update(receiver: Option<&mut broadcast::Receiver<()>>) -> Option<()> {
    let receiver = match receiver {
        Some(receiver) => receiver,
        None => return None,
    };

    match receiver.recv().await {
        Ok(()) => Some(()),
        Err(broadcast::error::RecvError::Lagged(_)) => Some(()),
        Err(broadcast::error::RecvError::Closed) => None,
    }
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
    let terminal_epoch: u64 = 0;
    let terminal_view_revision: u64 = 0;

    loop {
        tokio::select! {
            update = recv_runtime_update(runtime_updates.as_mut()), if runtime_updates.is_some() => {
                match update {
                    Some(RuntimeStreamMessage::Stream {
                        sequence,
                        chunk,
                        patch,
                    }) => {
                        // Binary stream frame: [8-byte BE u64 sequence][raw PTY data]
                        let mut frame = Vec::with_capacity(8 + chunk.len());
                        frame.extend_from_slice(&sequence.to_be_bytes());
                        frame.extend_from_slice(&chunk);
                        if socket.send(Message::Binary(frame.into())).await.is_err() {
                            break;
                        }
                        if let Some(pane_id) = attached_pane_id.as_ref() {
                            let patch_message = build_terminal_patch_message(
                                pane_id,
                                &patch,
                                terminal_view_revision,
                                terminal_epoch,
                                BASE64.encode(&chunk),
                            );
                            if send_json_message(&mut socket, &patch_message).await.is_err() {
                                break;
                            }
                        }
                    }
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
                    Some(Ok(Message::Binary(bytes))) => {
                        let Some(pane_id) = attached_pane_id.as_ref() else {
                            continue;
                        };
                        match runtime.write_input_bytes(pane_id, &bytes, attached_client_id.as_deref()) {
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
    Stream {
        sequence: u64,
        chunk: Vec<u8>,
        patch: RuntimeTerminalPatch,
    },
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
            chunk,
            patch,
        }) => Some(RuntimeStreamMessage::Stream {
            sequence,
            chunk,
            patch,
        }),
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
    use std::panic::{catch_unwind, AssertUnwindSafe};
    use std::time::Duration;

    use axum::http::StatusCode;
    use http_body_util::BodyExt;
    use remux_protocol::terminal::ClientMode;
    use remux_pty::PtyCommand;
    use tokio::time::timeout;
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
        assert!(!metadata.version.is_empty());
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
    async fn poisoned_terminal_lock_recovers_without_freezing_the_runtime() {
        let runtime = WorkspaceRuntime::spawn_with_command(test_runtime_command())
            .expect("test runtime should spawn");
        let pane_id = runtime.pane_id();
        let pane = runtime
            .pane_runtime(&pane_id)
            .expect("active pane runtime should exist");

        let _ = catch_unwind(AssertUnwindSafe(|| {
            let _guard = pane.terminal.lock().expect("terminal lock");
            panic!("poison terminal mutex");
        }));

        pane.handle_process_event(PtyEvent::Output(b"after-poison\r\nready".to_vec()));

        let inspect = pane.inspect_snapshot(control::InspectScope::Pane {
            pane_id: pane_id.clone(),
        });

        assert_eq!(inspect.precision, remux_core::InspectPrecision::Partial);
        assert!(inspect.preview_text.contains("after-poison"));
        assert!(inspect.preview_text.contains("ready"));

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
    async fn snapshot_message_includes_terminal_reflow_metadata() {
        let snapshot = TerminalSnapshot {
            size: TerminalSize::new(12, 4),
            source_size: TerminalSize::new(12, 4),
            cursor: remux_terminal::TerminalCursor { row: 2, col: 5 },
            scrollback_row_wraps: vec![false, true],
            visible_row_wraps: vec![true, false, false, false],
            formatted_state: b"terminal-state".to_vec(),
            replay_formatted: b"replay-state".to_vec(),
            scrollback_rows: vec!["row-1".to_owned(), "row-2".to_owned()],
            visible_text: "visible".to_owned(),
            visible_rows: vec![
                "a".to_owned(),
                "b".to_owned(),
                "c".to_owned(),
                "d".to_owned(),
            ],
            byte_count: 14,
            precision: remux_core::InspectPrecision::Precise,
        };

        let message = build_terminal_snapshot_message(&snapshot, 17);
        let json = serde_json::to_value(&message).expect("snapshot message should serialize");

        assert_eq!(json["type"], "snapshot");
        assert_eq!(json["size"]["cols"], 12);
        assert_eq!(json["source_size"]["rows"], 4);
        assert_eq!(json["cursor"]["row"], 2);
        assert_eq!(json["cursor"]["col"], 5);
        assert_eq!(
            json["scrollback_row_wraps"],
            serde_json::json!([false, true])
        );
        assert_eq!(
            json["visible_row_wraps"],
            serde_json::json!([true, false, false, false])
        );
        assert_eq!(json["sequence"], 17);
        assert_eq!(json["content_base64"], BASE64.encode("terminal-state"));
        assert_eq!(
            json["replay_base64"],
            serde_json::json!(BASE64.encode("replay-state"))
        );
    }

    #[tokio::test]
    async fn terminal_patch_message_includes_payload_and_legacy_data_base64() {
        let patch = RuntimeTerminalPatch {
            revision: 8,
            base_revision: Some(7),
            reset: false,
            source: RuntimeTerminalPatchSource::Stream,
            cols: 12,
            rows: 4,
            source_size: TerminalSize::new(12, 4),
            cursor: remux_terminal::TerminalCursor { row: 2, col: 5 },
            visible_row_base: 10,
            chunks: vec![RuntimeTerminalPatchChunk {
                start_row: 1,
                lines: vec![RuntimeTerminalPatchLine {
                    text: "patched-line".to_owned(),
                    wrapped: false,
                }],
            }],
        };

        let message = build_terminal_patch_message(
            &PaneId("pane_test".to_owned()),
            &patch,
            15,
            2,
            BASE64.encode("legacy-stream"),
        );
        let json = serde_json::to_value(&message).expect("terminal patch should serialize");

        assert_eq!(json["type"], "terminal_patch");
        assert_eq!(json["paneId"], "pane_test");
        assert_eq!(json["epoch"], 2);
        assert_eq!(json["viewRevision"], 15);
        assert_eq!(json["revision"], 8);
        assert_eq!(json["baseRevision"], 7);
        assert_eq!(json["reset"], false);
        assert_eq!(json["source"], "stream");
        assert_eq!(json["cols"], 12);
        assert_eq!(json["rows"], 4);
        assert_eq!(json["dataBase64"], BASE64.encode("legacy-stream"));
        assert_eq!(json["payload"]["visibleRowBase"], 10);
        assert_eq!(json["payload"]["chunks"][0]["startRow"], 1);
        assert_eq!(json["payload"]["chunks"][0]["lines"][0]["text"], "patched-line");
    }

    #[tokio::test]
    async fn later_interactive_clients_claim_write_access_when_they_send_input() {
        let runtime = WorkspaceRuntime::spawn_with_command(test_runtime_command())
            .expect("test runtime should spawn");
        let pane_id = runtime.pane_id();

        let first = runtime
            .attach(&pane_id, ClientMode::Interactive, TerminalSize::new(80, 24))
            .expect("first interactive attach should succeed");
        let second = runtime
            .attach(&pane_id, ClientMode::Interactive, TerminalSize::new(80, 24))
            .expect("second interactive attach should also succeed");

        assert_eq!(
            second.lease_state,
            terminal::ServerMessage::LeaseState {
                client_id: first.client_id.clone(),
            }
        );
        assert_eq!(
            runtime.workspace_summary().lease_holder_client_id,
            first.client_id.clone()
        );

        runtime
            .write_input(
                &pane_id,
                &BASE64.encode("echo lease handoff\r"),
                second.client_id.as_deref(),
            )
            .expect("second client input should claim the lease and succeed");

        assert_eq!(
            runtime.workspace_summary().lease_holder_client_id,
            second.client_id.clone()
        );

        runtime.detach(&pane_id, first.client_id.as_deref());
        assert_eq!(
            runtime.workspace_summary().lease_holder_client_id,
            second.client_id.clone()
        );

        runtime.detach(&pane_id, second.client_id.as_deref());
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

    #[tokio::test]
    async fn workspace_mutations_broadcast_updates_to_all_subscribers() {
        let runtime = WorkspaceRuntime::spawn_with_command(test_runtime_command())
            .expect("test runtime should spawn");
        let mut subscriber_a = runtime.subscribe_workspace();
        let mut subscriber_b = runtime.subscribe_workspace();

        runtime
            .create_session("Shared")
            .expect("session create should succeed");

        timeout(Duration::from_secs(1), subscriber_a.recv())
            .await
            .expect("subscriber A should receive an update")
            .expect("subscriber A update should be readable");
        timeout(Duration::from_secs(1), subscriber_b.recv())
            .await
            .expect("subscriber B should receive an update")
            .expect("subscriber B update should be readable");

        assert_eq!(runtime.workspace_summary().session_count, 2);
        runtime.shutdown();
    }

    #[tokio::test]
    #[ignore = "diagnostic"]
    async fn debug_real_shell_printf_loop_snapshot_tail() {
        let size = TerminalSize::new(177, 31);
        let runtime = WorkspaceRuntime::spawn_with_command(test_runtime_command())
            .expect("test runtime should spawn");
        let pane_id = runtime.pane_id();
        let attachment = runtime
            .attach(&pane_id, ClientMode::Interactive, size)
            .expect("attach should succeed");
        let client_id = attachment.client_id.as_deref();
        let mut updates = runtime
            .subscribe(&pane_id)
            .expect("subscribe should succeed");
        let command =
            "for i in $(seq 1 120); do printf \"RUST-%03d\\n\" \"$i\"; sleep 0.01; done\r";

        tokio::time::sleep(Duration::from_millis(500)).await;
        while let Ok(Ok(RuntimeUpdate::Output { .. })) =
            timeout(Duration::from_millis(50), updates.recv()).await
        {}

        runtime
            .write_input_bytes(&pane_id, command.as_bytes(), client_id)
            .expect("write should succeed");

        let mut live = String::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
        loop {
            if tokio::time::Instant::now() >= deadline {
                break;
            }

            match timeout(Duration::from_millis(500), updates.recv()).await {
                Ok(Ok(RuntimeUpdate::Output { chunk, .. })) => {
                    live.push_str(&String::from_utf8_lossy(&chunk));
                    if live.contains("RUST-120") {
                        break;
                    }
                }
                Ok(Ok(RuntimeUpdate::Exit { .. })) => break,
                Ok(Err(_)) | Err(_) => {}
            }
        }

        tokio::time::sleep(Duration::from_millis(800)).await;

        let inspect = runtime.inspect_snapshot(control::InspectScope::Pane {
            pane_id: pane_id.clone(),
        });
        let inspect_rows = inspect
            .inspect_rows
            .iter()
            .chain(inspect.visible_rows.iter())
            .filter_map(|row| {
                let trimmed = row.trim_end().to_owned();
                if trimmed.is_empty() {
                    None
                } else {
                    Some(trimmed)
                }
            })
            .collect::<Vec<_>>();
        let rust_rows = inspect_rows
            .iter()
            .filter(|row| row.contains("RUST-"))
            .cloned()
            .collect::<Vec<_>>();
        let live_rows = live
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .filter(|line| line.contains("RUST-"))
            .map(ToOwned::to_owned)
            .collect::<Vec<_>>();

        eprintln!(
            "live_has_120={} live_count={} live_tail={:?} inspect_count={} inspect_tail={:?} live_preview={:?}",
            live.contains("RUST-120"),
            live_rows.len(),
            live_rows
                .iter()
                .rev()
                .take(15)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<Vec<_>>(),
            rust_rows.len(),
            rust_rows
                .iter()
                .rev()
                .take(15)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<Vec<_>>(),
            live.chars().rev().take(240).collect::<String>().chars().rev().collect::<String>(),
        );

        runtime.detach(&pane_id, client_id);
        runtime.shutdown();
    }

    #[tokio::test]
    #[ignore = "diagnostic"]
    async fn debug_real_shell_two_printf_loops_snapshot_tail() {
        let size = TerminalSize::new(177, 31);
        let runtime = WorkspaceRuntime::spawn_with_command(test_runtime_command())
            .expect("test runtime should spawn");
        let pane_id = runtime.pane_id();
        let attachment = runtime
            .attach(&pane_id, ClientMode::Interactive, size)
            .expect("attach should succeed");
        let client_id = attachment.client_id.as_deref();
        let mut updates = runtime
            .subscribe(&pane_id)
            .expect("subscribe should succeed");
        tokio::time::sleep(Duration::from_millis(500)).await;
        while let Ok(Ok(RuntimeUpdate::Output { .. })) =
            timeout(Duration::from_millis(50), updates.recv()).await
        {}

        for (prefix, label) in [("MARK", "mark"), ("PROBE", "probe")] {
            let command = format!(
                "for i in $(seq 1 120); do printf \"{prefix}-%03d\\n\" \"$i\"; sleep 0.01; done\r"
            );
            runtime
                .write_input_bytes(&pane_id, command.as_bytes(), client_id)
                .expect("write should succeed");

            let mut live = String::new();
            let target = format!("{prefix}-120");
            let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
            loop {
                if tokio::time::Instant::now() >= deadline {
                    break;
                }

                match timeout(Duration::from_millis(500), updates.recv()).await {
                    Ok(Ok(RuntimeUpdate::Output { chunk, .. })) => {
                        live.push_str(&String::from_utf8_lossy(&chunk));
                        if live.contains(&target) {
                            break;
                        }
                    }
                    Ok(Ok(RuntimeUpdate::Exit { .. })) => break,
                    Ok(Err(_)) | Err(_) => {}
                }
            }

            tokio::time::sleep(Duration::from_millis(800)).await;

            let inspect = runtime.inspect_snapshot(control::InspectScope::Pane {
                pane_id: pane_id.clone(),
            });
            let inspect_rows = inspect
                .inspect_rows
                .iter()
                .chain(inspect.visible_rows.iter())
                .filter_map(|row| {
                    let trimmed = row.trim_end().to_owned();
                    if trimmed.is_empty() {
                        None
                    } else {
                        Some(trimmed)
                    }
                })
                .collect::<Vec<_>>();
            let matched_rows = inspect_rows
                .iter()
                .filter(|row| row.contains(prefix))
                .cloned()
                .collect::<Vec<_>>();
            eprintln!(
                "{label} live_has_120={} inspect_count={} inspect_tail={:?}",
                live.contains(&target),
                matched_rows.len(),
                matched_rows
                    .iter()
                    .rev()
                    .take(15)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect::<Vec<_>>(),
            );
        }

        runtime.detach(&pane_id, client_id);
        runtime.shutdown();
    }

    #[tokio::test]
    #[ignore = "diagnostic"]
    async fn debug_reattach_after_complete_history() {
        let size = TerminalSize::new(177, 31);
        let runtime = WorkspaceRuntime::spawn_with_command(test_runtime_command())
            .expect("test runtime should spawn");
        let pane_id = runtime.pane_id();
        let initial = runtime
            .attach(&pane_id, ClientMode::Interactive, size)
            .expect("initial attach should succeed");
        let client_id = initial.client_id.as_deref();
        let mut updates = runtime
            .subscribe(&pane_id)
            .expect("subscribe should succeed");
        tokio::time::sleep(Duration::from_millis(500)).await;
        while let Ok(Ok(RuntimeUpdate::Output { .. })) =
            timeout(Duration::from_millis(50), updates.recv()).await
        {}

        let command =
            "for i in $(seq 1 120); do printf \"REATTACH-%03d\\n\" \"$i\"; sleep 0.01; done\r";
        runtime
            .write_input_bytes(&pane_id, command.as_bytes(), client_id)
            .expect("write should succeed");

        let target = "REATTACH-120";
        let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
        let mut live = String::new();
        loop {
            if tokio::time::Instant::now() >= deadline {
                break;
            }

            match timeout(Duration::from_millis(500), updates.recv()).await {
                Ok(Ok(RuntimeUpdate::Output { chunk, .. })) => {
                    live.push_str(&String::from_utf8_lossy(&chunk));
                    if live.contains(target) {
                        break;
                    }
                }
                Ok(Ok(RuntimeUpdate::Exit { .. })) => break,
                Ok(Err(_)) | Err(_) => {}
            }
        }

        tokio::time::sleep(Duration::from_millis(800)).await;

        let collect_rows = |inspect: control::InspectSnapshot| {
            inspect
                .inspect_rows
                .iter()
                .chain(inspect.visible_rows.iter())
                .filter_map(|row| {
                    let trimmed = row.trim_end().to_owned();
                    if trimmed.is_empty() || !trimmed.contains("REATTACH-") {
                        None
                    } else {
                        Some(trimmed)
                    }
                })
                .collect::<Vec<_>>()
        };

        let before = collect_rows(runtime.inspect_snapshot(control::InspectScope::Pane {
            pane_id: pane_id.clone(),
        }));
        let reattach = runtime
            .attach(&pane_id, ClientMode::ReadOnly, size)
            .expect("reattach should succeed");
        tokio::time::sleep(Duration::from_millis(800)).await;
        let after = collect_rows(runtime.inspect_snapshot(control::InspectScope::Pane {
            pane_id: pane_id.clone(),
        }));

        eprintln!(
            "before_count={} before_tail={:?} reattach_snapshot_is_snapshot={} after_count={} after_tail={:?}",
            before.len(),
            before
                .iter()
                .rev()
                .take(15)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<Vec<_>>(),
            matches!(reattach.snapshot, terminal::ServerMessage::Snapshot { .. }),
            after.len(),
            after
                .iter()
                .rev()
                .take(15)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<Vec<_>>(),
        );

        runtime.detach(&pane_id, client_id);
        runtime.shutdown();
    }

    #[tokio::test]
    #[ignore = "diagnostic"]
    async fn debug_workspace_tab_switch_after_complete_history() {
        let size = TerminalSize::new(177, 31);
        let runtime = WorkspaceRuntime::spawn_with_command(test_runtime_command())
            .expect("test runtime should spawn");
        let summary = runtime.workspace_summary();
        let original_session = summary
            .active_session_id
            .clone()
            .expect("active session should exist");
        let original_tab = summary
            .active_tab_id
            .clone()
            .expect("active tab should exist");
        let pane_id = runtime.pane_id();
        let attachment = runtime
            .attach(&pane_id, ClientMode::Interactive, size)
            .expect("attach should succeed");
        let client_id = attachment.client_id.as_deref();
        let mut updates = runtime
            .subscribe(&pane_id)
            .expect("subscribe should succeed");
        tokio::time::sleep(Duration::from_millis(500)).await;
        while let Ok(Ok(RuntimeUpdate::Output { .. })) =
            timeout(Duration::from_millis(50), updates.recv()).await
        {}

        let command =
            "for i in $(seq 1 120); do printf \"TABSW-%03d\\n\" \"$i\"; sleep 0.01; done\r";
        runtime
            .write_input_bytes(&pane_id, command.as_bytes(), client_id)
            .expect("write should succeed");

        let target = "TABSW-120";
        let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
        let mut live = String::new();
        loop {
            if tokio::time::Instant::now() >= deadline {
                break;
            }

            match timeout(Duration::from_millis(500), updates.recv()).await {
                Ok(Ok(RuntimeUpdate::Output { chunk, .. })) => {
                    live.push_str(&String::from_utf8_lossy(&chunk));
                    if live.contains(target) {
                        break;
                    }
                }
                Ok(Ok(RuntimeUpdate::Exit { .. })) => break,
                Ok(Err(_)) | Err(_) => {}
            }
        }

        tokio::time::sleep(Duration::from_millis(800)).await;

        let collect_rows = |runtime: &WorkspaceRuntime| {
            runtime
                .inspect_snapshot(control::InspectScope::Pane {
                    pane_id: pane_id.clone(),
                })
                .inspect_rows
                .into_iter()
                .chain(
                    runtime
                        .inspect_snapshot(control::InspectScope::Pane {
                            pane_id: pane_id.clone(),
                        })
                        .visible_rows
                        .into_iter(),
                )
                .filter_map(|row| {
                    let trimmed = row.trim_end().to_owned();
                    if trimmed.is_empty() || !trimmed.contains("TABSW-") {
                        None
                    } else {
                        Some(trimmed)
                    }
                })
                .collect::<Vec<_>>()
        };

        let before = collect_rows(&runtime);
        let other_tab = runtime
            .create_tab(&original_session, "Scratch")
            .expect("create tab should succeed");
        runtime
            .select_tab(&other_tab)
            .expect("select other tab should succeed");
        runtime
            .select_tab(&original_tab)
            .expect("select original tab should succeed");
        let after = collect_rows(&runtime);

        eprintln!(
            "live_has_120={} before_count={} after_count={} after_tail={:?}",
            live.contains(target),
            before.len(),
            after.len(),
            after
                .iter()
                .rev()
                .take(15)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<Vec<_>>(),
        );

        runtime.detach(&pane_id, client_id);
        runtime.shutdown();
    }

    fn test_runtime_command() -> PtyCommand {
        PtyCommand::default_shell()
            .env("TERM", "xterm-256color")
            .env("COLORTERM", "truecolor")
    }
}

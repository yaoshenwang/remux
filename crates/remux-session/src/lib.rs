#![forbid(unsafe_code)]

use std::collections::BTreeMap;

use remux_core::{PaneId, SessionId, SessionLifecycleState, SplitDirection, TabId};
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum LayoutNode {
    Leaf(PaneId),
    Split {
        direction: SplitDirection,
        ratio: u8,
        children: Vec<LayoutNode>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LeaseMode {
    Interactive,
    ReadOnly,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WriterLease {
    pub client_id: String,
    pub mode: LeaseMode,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PaneSnapshot {
    pub pane_id: PaneId,
    pub writer_lease: Option<WriterLease>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TabSnapshot {
    pub tab_id: TabId,
    pub tab_title: String,
    pub active_pane_id: PaneId,
    pub zoomed_pane_id: Option<PaneId>,
    pub layout: LayoutNode,
    pub panes: Vec<PaneSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionSnapshot {
    pub session_id: SessionId,
    pub session_state: SessionLifecycleState,
    pub session_name: String,
    pub active_tab_id: TabId,
    pub tabs: Vec<TabSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSnapshot {
    pub active_session_id: SessionId,
    pub sessions: Vec<SessionSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkspaceState {
    active_session_id: SessionId,
    sessions: Vec<SessionState>,
}

pub type SinglePaneWorkspace = WorkspaceState;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct SessionState {
    session_id: SessionId,
    session_state: SessionLifecycleState,
    session_name: String,
    active_tab_id: TabId,
    tabs: Vec<TabState>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct TabState {
    tab_id: TabId,
    tab_title: String,
    active_pane_id: PaneId,
    zoomed_pane_id: Option<PaneId>,
    layout: LayoutNode,
    panes: BTreeMap<PaneId, PaneState>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
struct PaneState {
    writer_lease: Option<WriterLease>,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum WorkspaceError {
    #[error("unknown session id: {0}")]
    UnknownSession(SessionId),
    #[error("unknown tab id: {0}")]
    UnknownTab(TabId),
    #[error("unknown pane id: {0}")]
    UnknownPane(PaneId),
    #[error("cannot close the last remaining session")]
    CannotCloseLastSession,
    #[error("cannot close the last remaining tab in a session")]
    CannotCloseLastTab,
    #[error("cannot close the last remaining pane")]
    CannotCloseLastPane,
    #[error("pane {pane_id} is already leased by {current_client_id}")]
    LeaseConflict {
        pane_id: PaneId,
        current_client_id: String,
    },
    #[error("pane {pane_id} does not hold a lease for {client_id}")]
    LeaseNotHeld {
        pane_id: PaneId,
        client_id: String,
    },
}

impl WorkspaceState {
    #[must_use]
    pub fn new(session_name: impl Into<String>, tab_title: impl Into<String>) -> Self {
        let session = SessionState::new(session_name.into(), tab_title.into());
        let active_session_id = session.session_id.clone();

        Self {
            active_session_id,
            sessions: vec![session],
        }
    }

    #[must_use]
    pub fn session_id(&self) -> &SessionId {
        &self.active_session().session_id
    }

    #[must_use]
    pub fn tab_id(&self) -> &TabId {
        &self.active_session().active_tab().tab_id
    }

    #[must_use]
    pub fn pane_id(&self) -> &PaneId {
        &self.active_session().active_tab().active_pane_id
    }

    #[must_use]
    pub fn active_pane_id(&self) -> &PaneId {
        self.pane_id()
    }

    #[must_use]
    pub fn zoomed_pane_id(&self) -> Option<&PaneId> {
        self.active_session().active_tab().zoomed_pane_id.as_ref()
    }

    #[must_use]
    pub fn session_state(&self) -> SessionLifecycleState {
        self.active_session().session_state
    }

    #[must_use]
    pub fn session_name(&self) -> &str {
        &self.active_session().session_name
    }

    #[must_use]
    pub fn tab_title(&self) -> &str {
        &self.active_session().active_tab().tab_title
    }

    #[must_use]
    pub fn session_count(&self) -> usize {
        self.sessions.len()
    }

    #[must_use]
    pub fn tab_count(&self) -> usize {
        self.active_session().tabs.len()
    }

    #[must_use]
    pub fn pane_count(&self) -> usize {
        self.active_session().active_tab().panes.len()
    }

    #[must_use]
    pub fn pane_ids(&self) -> Vec<PaneId> {
        self.active_session().active_tab().layout.leaf_ids()
    }

    #[must_use]
    pub fn layout(&self) -> &LayoutNode {
        &self.active_session().active_tab().layout
    }

    #[must_use]
    pub fn writer_lease(&self, pane_id: &PaneId) -> Option<&WriterLease> {
        self.find_pane_location(pane_id).and_then(|(session_index, tab_index)| {
            self.sessions[session_index].tabs[tab_index]
                .panes
                .get(pane_id)
                .and_then(|pane| pane.writer_lease.as_ref())
        })
    }

    #[must_use]
    pub fn snapshot(&self) -> WorkspaceSnapshot {
        WorkspaceSnapshot {
            active_session_id: self.active_session_id.clone(),
            sessions: self.sessions.iter().map(SessionState::snapshot).collect(),
        }
    }

    pub fn mark_live(&mut self) {
        self.active_session_mut().session_state = SessionLifecycleState::Live;
    }

    pub fn mark_degraded(&mut self) {
        self.active_session_mut().session_state = SessionLifecycleState::Degraded;
    }

    pub fn mark_stopped(&mut self) {
        self.active_session_mut().session_state = SessionLifecycleState::Stopped;
    }

    pub fn create_session(
        &mut self,
        session_name: impl Into<String>,
    ) -> Result<SessionId, WorkspaceError> {
        let session = SessionState::new(session_name.into(), "Shell".to_owned());
        let session_id = session.session_id.clone();
        self.active_session_id = session_id.clone();
        self.sessions.push(session);
        Ok(session_id)
    }

    pub fn select_session(&mut self, session_id: &SessionId) -> Result<(), WorkspaceError> {
        self.find_session_index(session_id)
            .ok_or_else(|| WorkspaceError::UnknownSession(session_id.clone()))?;
        self.active_session_id = session_id.clone();
        Ok(())
    }

    pub fn rename_session(
        &mut self,
        session_id: &SessionId,
        new_name: impl Into<String>,
    ) -> Result<(), WorkspaceError> {
        let session = self.session_mut_by_id(session_id)?;
        session.session_name = new_name.into();
        Ok(())
    }

    pub fn close_session(&mut self, session_id: &SessionId) -> Result<SessionId, WorkspaceError> {
        let session_index = self
            .find_session_index(session_id)
            .ok_or_else(|| WorkspaceError::UnknownSession(session_id.clone()))?;
        if self.sessions.len() == 1 {
            return Err(WorkspaceError::CannotCloseLastSession);
        }

        self.sessions.remove(session_index);
        if self.active_session_id == *session_id {
            let fallback_index = session_index.min(self.sessions.len() - 1);
            self.active_session_id = self.sessions[fallback_index].session_id.clone();
        }

        Ok(self.active_session_id.clone())
    }

    pub fn create_tab(
        &mut self,
        session_id: &SessionId,
        tab_title: impl Into<String>,
    ) -> Result<TabId, WorkspaceError> {
        let session_index = self
            .find_session_index(session_id)
            .ok_or_else(|| WorkspaceError::UnknownSession(session_id.clone()))?;
        let tab = TabState::new(tab_title.into());
        let tab_id = tab.tab_id.clone();
        self.sessions[session_index].active_tab_id = tab_id.clone();
        self.active_session_id = session_id.clone();
        self.sessions[session_index].tabs.push(tab);
        Ok(tab_id)
    }

    pub fn select_tab(&mut self, tab_id: &TabId) -> Result<(), WorkspaceError> {
        let (session_index, tab_index) = self
            .find_tab_location(tab_id)
            .ok_or_else(|| WorkspaceError::UnknownTab(tab_id.clone()))?;
        self.active_session_id = self.sessions[session_index].session_id.clone();
        self.sessions[session_index].active_tab_id =
            self.sessions[session_index].tabs[tab_index].tab_id.clone();
        Ok(())
    }

    pub fn rename_tab(
        &mut self,
        tab_id: &TabId,
        new_title: impl Into<String>,
    ) -> Result<(), WorkspaceError> {
        let (session_index, tab_index) = self
            .find_tab_location(tab_id)
            .ok_or_else(|| WorkspaceError::UnknownTab(tab_id.clone()))?;
        self.sessions[session_index].tabs[tab_index].tab_title = new_title.into();
        Ok(())
    }

    pub fn close_tab(&mut self, tab_id: &TabId) -> Result<TabId, WorkspaceError> {
        let (session_index, tab_index) = self
            .find_tab_location(tab_id)
            .ok_or_else(|| WorkspaceError::UnknownTab(tab_id.clone()))?;
        let session = &mut self.sessions[session_index];
        if session.tabs.len() == 1 {
            return Err(WorkspaceError::CannotCloseLastTab);
        }

        session.tabs.remove(tab_index);
        if session.active_tab_id == *tab_id {
            let fallback_index = tab_index.min(session.tabs.len() - 1);
            session.active_tab_id = session.tabs[fallback_index].tab_id.clone();
        }
        self.active_session_id = session.session_id.clone();
        Ok(session.active_tab_id.clone())
    }

    pub fn split_pane(
        &mut self,
        pane_id: &PaneId,
        direction: SplitDirection,
    ) -> Result<PaneId, WorkspaceError> {
        let (session_index, tab_index) = self
            .find_pane_location(pane_id)
            .ok_or_else(|| WorkspaceError::UnknownPane(pane_id.clone()))?;
        self.active_session_id = self.sessions[session_index].session_id.clone();
        self.sessions[session_index].active_tab_id =
            self.sessions[session_index].tabs[tab_index].tab_id.clone();
        self.sessions[session_index].tabs[tab_index].split_pane(pane_id, direction)
    }

    pub fn focus_pane(&mut self, pane_id: &PaneId) -> Result<(), WorkspaceError> {
        let (session_index, tab_index) = self
            .find_pane_location(pane_id)
            .ok_or_else(|| WorkspaceError::UnknownPane(pane_id.clone()))?;
        self.active_session_id = self.sessions[session_index].session_id.clone();
        self.sessions[session_index].active_tab_id =
            self.sessions[session_index].tabs[tab_index].tab_id.clone();
        self.sessions[session_index].tabs[tab_index].focus_pane(pane_id)
    }

    pub fn toggle_zoom(&mut self, pane_id: &PaneId) -> Result<(), WorkspaceError> {
        let (session_index, tab_index) = self
            .find_pane_location(pane_id)
            .ok_or_else(|| WorkspaceError::UnknownPane(pane_id.clone()))?;
        self.active_session_id = self.sessions[session_index].session_id.clone();
        self.sessions[session_index].active_tab_id =
            self.sessions[session_index].tabs[tab_index].tab_id.clone();
        self.sessions[session_index].tabs[tab_index].toggle_zoom(pane_id)
    }

    pub fn close_pane(&mut self, pane_id: &PaneId) -> Result<PaneId, WorkspaceError> {
        let (session_index, tab_index) = self
            .find_pane_location(pane_id)
            .ok_or_else(|| WorkspaceError::UnknownPane(pane_id.clone()))?;
        self.active_session_id = self.sessions[session_index].session_id.clone();
        self.sessions[session_index].active_tab_id =
            self.sessions[session_index].tabs[tab_index].tab_id.clone();
        self.sessions[session_index].tabs[tab_index].close_pane(pane_id)
    }

    pub fn acquire_writer_lease(
        &mut self,
        pane_id: &PaneId,
        client_id: impl Into<String>,
        mode: LeaseMode,
    ) -> Result<(), WorkspaceError> {
        let client_id = client_id.into();
        let (_, _, pane) = self.pane_state_mut(pane_id)?;

        match pane.writer_lease.as_ref() {
            Some(lease) if lease.client_id != client_id => Err(WorkspaceError::LeaseConflict {
                pane_id: pane_id.clone(),
                current_client_id: lease.client_id.clone(),
            }),
            _ => {
                pane.writer_lease = Some(WriterLease { client_id, mode });
                Ok(())
            }
        }
    }

    pub fn take_writer_lease(
        &mut self,
        pane_id: &PaneId,
        client_id: impl Into<String>,
        mode: LeaseMode,
    ) -> Result<bool, WorkspaceError> {
        let client_id = client_id.into();
        let (_, _, pane) = self.pane_state_mut(pane_id)?;
        let changed = pane.writer_lease.as_ref()
            != Some(&WriterLease {
                client_id: client_id.clone(),
                mode: mode.clone(),
            });
        pane.writer_lease = Some(WriterLease { client_id, mode });
        Ok(changed)
    }

    pub fn release_writer_lease(
        &mut self,
        pane_id: &PaneId,
        client_id: &str,
    ) -> Result<(), WorkspaceError> {
        let (_, _, pane) = self.pane_state_mut(pane_id)?;

        match pane.writer_lease.as_ref() {
            Some(lease) if lease.client_id == client_id => {
                pane.writer_lease = None;
                Ok(())
            }
            _ => Err(WorkspaceError::LeaseNotHeld {
                pane_id: pane_id.clone(),
                client_id: client_id.to_owned(),
            }),
        }
    }

    fn active_session(&self) -> &SessionState {
        let session_index = self
            .find_session_index(&self.active_session_id)
            .expect("active session must exist");
        &self.sessions[session_index]
    }

    fn active_session_mut(&mut self) -> &mut SessionState {
        let session_index = self
            .find_session_index(&self.active_session_id)
            .expect("active session must exist");
        &mut self.sessions[session_index]
    }

    fn find_session_index(&self, session_id: &SessionId) -> Option<usize> {
        self.sessions
            .iter()
            .position(|session| session.session_id == *session_id)
    }

    fn find_tab_location(&self, tab_id: &TabId) -> Option<(usize, usize)> {
        for (session_index, session) in self.sessions.iter().enumerate() {
            if let Some(tab_index) = session.tabs.iter().position(|tab| tab.tab_id == *tab_id) {
                return Some((session_index, tab_index));
            }
        }
        None
    }

    fn find_pane_location(&self, pane_id: &PaneId) -> Option<(usize, usize)> {
        for (session_index, session) in self.sessions.iter().enumerate() {
            for (tab_index, tab) in session.tabs.iter().enumerate() {
                if tab.panes.contains_key(pane_id) {
                    return Some((session_index, tab_index));
                }
            }
        }
        None
    }

    fn session_mut_by_id(&mut self, session_id: &SessionId) -> Result<&mut SessionState, WorkspaceError> {
        let session_index = self
            .find_session_index(session_id)
            .ok_or_else(|| WorkspaceError::UnknownSession(session_id.clone()))?;
        Ok(&mut self.sessions[session_index])
    }

    fn pane_state_mut(
        &mut self,
        pane_id: &PaneId,
    ) -> Result<(usize, usize, &mut PaneState), WorkspaceError> {
        let (session_index, tab_index) = self
            .find_pane_location(pane_id)
            .ok_or_else(|| WorkspaceError::UnknownPane(pane_id.clone()))?;
        let pane = self.sessions[session_index].tabs[tab_index]
            .panes
            .get_mut(pane_id)
            .expect("pane must exist after location lookup");
        Ok((session_index, tab_index, pane))
    }
}

impl SessionState {
    fn new(session_name: String, tab_title: String) -> Self {
        let tab = TabState::new(tab_title);
        let active_tab_id = tab.tab_id.clone();

        Self {
            session_id: SessionId::new(),
            session_state: SessionLifecycleState::Starting,
            session_name,
            active_tab_id,
            tabs: vec![tab],
        }
    }

    fn active_tab(&self) -> &TabState {
        let tab_index = self
            .tabs
            .iter()
            .position(|tab| tab.tab_id == self.active_tab_id)
            .expect("active tab must exist");
        &self.tabs[tab_index]
    }

    fn snapshot(&self) -> SessionSnapshot {
        SessionSnapshot {
            session_id: self.session_id.clone(),
            session_state: self.session_state,
            session_name: self.session_name.clone(),
            active_tab_id: self.active_tab_id.clone(),
            tabs: self.tabs.iter().map(TabState::snapshot).collect(),
        }
    }
}

impl TabState {
    fn new(tab_title: String) -> Self {
        let pane_id = PaneId::new();
        let mut panes = BTreeMap::new();
        panes.insert(pane_id.clone(), PaneState::default());

        Self {
            tab_id: TabId::new(),
            tab_title,
            active_pane_id: pane_id.clone(),
            zoomed_pane_id: None,
            layout: LayoutNode::Leaf(pane_id),
            panes,
        }
    }

    fn snapshot(&self) -> TabSnapshot {
        TabSnapshot {
            tab_id: self.tab_id.clone(),
            tab_title: self.tab_title.clone(),
            active_pane_id: self.active_pane_id.clone(),
            zoomed_pane_id: self.zoomed_pane_id.clone(),
            layout: self.layout.clone(),
            panes: self
                .layout
                .leaf_ids()
                .into_iter()
                .map(|pane_id| PaneSnapshot {
                    writer_lease: self
                        .panes
                        .get(&pane_id)
                        .and_then(|pane| pane.writer_lease.clone()),
                    pane_id,
                })
                .collect(),
        }
    }

    fn split_pane(
        &mut self,
        pane_id: &PaneId,
        direction: SplitDirection,
    ) -> Result<PaneId, WorkspaceError> {
        self.ensure_pane_exists(pane_id)?;

        let new_pane_id = PaneId::new();
        self.layout
            .split_leaf(pane_id, direction, new_pane_id.clone());
        self.panes.insert(new_pane_id.clone(), PaneState::default());
        self.active_pane_id = new_pane_id.clone();

        Ok(new_pane_id)
    }

    fn focus_pane(&mut self, pane_id: &PaneId) -> Result<(), WorkspaceError> {
        self.ensure_pane_exists(pane_id)?;
        self.active_pane_id = pane_id.clone();
        Ok(())
    }

    fn toggle_zoom(&mut self, pane_id: &PaneId) -> Result<(), WorkspaceError> {
        self.ensure_pane_exists(pane_id)?;
        if self.zoomed_pane_id.as_ref() == Some(pane_id) {
            self.zoomed_pane_id = None;
        } else {
            self.zoomed_pane_id = Some(pane_id.clone());
        }
        Ok(())
    }

    fn close_pane(&mut self, pane_id: &PaneId) -> Result<PaneId, WorkspaceError> {
        self.ensure_pane_exists(pane_id)?;
        let fallback_pane = self.layout.fallback_after_closing(pane_id);

        let Some(next_layout) = remove_pane_from_layout(&self.layout, pane_id) else {
            return Err(WorkspaceError::CannotCloseLastPane);
        };

        self.layout = next_layout;
        self.panes.remove(pane_id);

        if self.zoomed_pane_id.as_ref() == Some(pane_id) {
            self.zoomed_pane_id = None;
        }

        if self.active_pane_id == *pane_id {
            self.active_pane_id = fallback_pane
                .or_else(|| self.layout.first_leaf())
                .expect("layout must retain one pane after close");
        }

        Ok(self.active_pane_id.clone())
    }

    fn ensure_pane_exists(&self, pane_id: &PaneId) -> Result<(), WorkspaceError> {
        if self.panes.contains_key(pane_id) {
            Ok(())
        } else {
            Err(WorkspaceError::UnknownPane(pane_id.clone()))
        }
    }
}

impl LayoutNode {
    fn split_leaf(&mut self, target: &PaneId, direction: SplitDirection, new_pane_id: PaneId) {
        match self {
            Self::Leaf(pane_id) if pane_id == target => {
                let existing_pane_id = pane_id.clone();
                *self = Self::Split {
                    direction,
                    ratio: 50,
                    children: vec![Self::Leaf(existing_pane_id), Self::Leaf(new_pane_id)],
                };
            }
            Self::Split { children, .. } => {
                for child in children {
                    child.split_leaf(target, direction, new_pane_id.clone());
                }
            }
            Self::Leaf(_) => {}
        }
    }

    fn leaf_ids(&self) -> Vec<PaneId> {
        match self {
            Self::Leaf(pane_id) => vec![pane_id.clone()],
            Self::Split { children, .. } => children.iter().flat_map(Self::leaf_ids).collect(),
        }
    }

    fn first_leaf(&self) -> Option<PaneId> {
        match self {
            Self::Leaf(pane_id) => Some(pane_id.clone()),
            Self::Split { children, .. } => children.iter().find_map(Self::first_leaf),
        }
    }

    fn contains_pane(&self, target: &PaneId) -> bool {
        match self {
            Self::Leaf(pane_id) => pane_id == target,
            Self::Split { children, .. } => children.iter().any(|child| child.contains_pane(target)),
        }
    }

    fn fallback_after_closing(&self, target: &PaneId) -> Option<PaneId> {
        match self {
            Self::Leaf(_) => None,
            Self::Split { children, .. } => {
                for (index, child) in children.iter().enumerate() {
                    if !child.contains_pane(target) {
                        continue;
                    }

                    if let Some(fallback) = child.fallback_after_closing(target) {
                        return Some(fallback);
                    }

                    return children
                        .iter()
                        .enumerate()
                        .find(|(other_index, _)| *other_index != index)
                        .and_then(|(_, sibling)| sibling.first_leaf());
                }

                None
            }
        }
    }
}

fn remove_pane_from_layout(node: &LayoutNode, pane_id: &PaneId) -> Option<LayoutNode> {
    match node {
        LayoutNode::Leaf(existing) if existing == pane_id => None,
        LayoutNode::Leaf(existing) => Some(LayoutNode::Leaf(existing.clone())),
        LayoutNode::Split {
            direction,
            ratio,
            children,
        } => {
            let mut survivors = children
                .iter()
                .filter_map(|child| remove_pane_from_layout(child, pane_id))
                .collect::<Vec<_>>();

            match survivors.len() {
                0 => None,
                1 => Some(survivors.remove(0)),
                _ => Some(LayoutNode::Split {
                    direction: *direction,
                    ratio: *ratio,
                    children: survivors,
                }),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use remux_core::{SessionLifecycleState, SplitDirection};

    use super::*;

    #[test]
    fn single_pane_workspace_starts_with_one_session_tab_and_pane() {
        let workspace = SinglePaneWorkspace::new("Main", "Shell");

        assert!(workspace.session_id().0.starts_with("session_"));
        assert!(workspace.tab_id().0.starts_with("tab_"));
        assert!(workspace.pane_id().0.starts_with("pane_"));
        assert_eq!(workspace.session_state(), SessionLifecycleState::Starting);
        assert_eq!(workspace.session_name(), "Main");
        assert_eq!(workspace.tab_title(), "Shell");
    }

    #[test]
    fn single_pane_workspace_updates_lifecycle_state() {
        let mut workspace = SinglePaneWorkspace::new("Main", "Shell");

        workspace.mark_live();
        assert_eq!(workspace.session_state(), SessionLifecycleState::Live);

        workspace.mark_degraded();
        assert_eq!(workspace.session_state(), SessionLifecycleState::Degraded);

        workspace.mark_stopped();
        assert_eq!(workspace.session_state(), SessionLifecycleState::Stopped);
    }

    #[test]
    fn workspace_split_creates_a_new_pane_and_layout_branch() {
        let mut workspace = SinglePaneWorkspace::new("Main", "Shell");
        let original_pane = workspace.pane_id().clone();

        let new_pane = workspace
            .split_pane(&original_pane, SplitDirection::Vertical)
            .expect("split should succeed");

        assert_eq!(workspace.pane_count(), 2);
        assert_eq!(workspace.active_pane_id(), &new_pane);
        assert_eq!(
            workspace.layout(),
            &LayoutNode::Split {
                direction: SplitDirection::Vertical,
                ratio: 50,
                children: vec![
                    LayoutNode::Leaf(original_pane.clone()),
                    LayoutNode::Leaf(new_pane.clone()),
                ],
            }
        );
        assert_eq!(workspace.pane_ids(), vec![original_pane, new_pane]);
    }

    #[test]
    fn workspace_focus_close_and_zoom_preserve_layout_invariants() {
        let mut workspace = SinglePaneWorkspace::new("Main", "Shell");
        let root_pane = workspace.pane_id().clone();
        let second_pane = workspace
            .split_pane(&root_pane, SplitDirection::Vertical)
            .expect("first split should succeed");
        let third_pane = workspace
            .split_pane(&second_pane, SplitDirection::Horizontal)
            .expect("second split should succeed");

        workspace
            .focus_pane(&second_pane)
            .expect("focus should succeed");
        assert_eq!(workspace.active_pane_id(), &second_pane);

        workspace
            .toggle_zoom(&second_pane)
            .expect("zoom should succeed");
        assert_eq!(workspace.zoomed_pane_id(), Some(&second_pane));

        let fallback_pane = workspace
            .close_pane(&second_pane)
            .expect("close should succeed");

        assert_eq!(fallback_pane, third_pane);
        assert_eq!(workspace.pane_count(), 2);
        assert_eq!(workspace.active_pane_id(), &fallback_pane);
        assert_eq!(workspace.zoomed_pane_id(), None);
        assert_eq!(
            workspace.layout(),
            &LayoutNode::Split {
                direction: SplitDirection::Vertical,
                ratio: 50,
                children: vec![
                    LayoutNode::Leaf(root_pane),
                    LayoutNode::Leaf(fallback_pane),
                ],
            }
        );
    }

    #[test]
    fn workspace_rejects_closing_the_last_remaining_pane() {
        let mut workspace = SinglePaneWorkspace::new("Main", "Shell");
        let only_pane = workspace.pane_id().clone();

        let error = workspace
            .close_pane(&only_pane)
            .expect_err("closing the last pane must fail");

        assert_eq!(error, WorkspaceError::CannotCloseLastPane);
    }

    #[test]
    fn workspace_tracks_writer_lease_per_pane() {
        let mut workspace = SinglePaneWorkspace::new("Main", "Shell");
        let pane_id = workspace.pane_id().clone();

        workspace
            .acquire_writer_lease(&pane_id, "client-a", LeaseMode::Interactive)
            .expect("first lease should succeed");
        assert_eq!(
            workspace.writer_lease(&pane_id),
            Some(&WriterLease {
                client_id: "client-a".to_owned(),
                mode: LeaseMode::Interactive,
            })
        );

        let error = workspace
            .acquire_writer_lease(&pane_id, "client-b", LeaseMode::Interactive)
            .expect_err("second client should not preempt the lease");
        assert_eq!(
            error,
            WorkspaceError::LeaseConflict {
                pane_id: pane_id.clone(),
                current_client_id: "client-a".to_owned(),
            }
        );

        workspace
            .acquire_writer_lease(&pane_id, "client-a", LeaseMode::Interactive)
            .expect("same client should be able to refresh the lease");
        workspace
            .release_writer_lease(&pane_id, "client-a")
            .expect("lease release should succeed");
        assert_eq!(workspace.writer_lease(&pane_id), None);
    }

    #[test]
    fn workspace_can_transfer_writer_lease_to_a_new_client() {
        let mut workspace = SinglePaneWorkspace::new("Main", "Shell");
        let pane_id = workspace.pane_id().clone();

        workspace
            .acquire_writer_lease(&pane_id, "client-a", LeaseMode::Interactive)
            .expect("first lease should succeed");

        let changed = workspace
            .take_writer_lease(&pane_id, "client-b", LeaseMode::Interactive)
            .expect("lease takeover should succeed");
        assert!(changed);
        assert_eq!(
            workspace.writer_lease(&pane_id),
            Some(&WriterLease {
                client_id: "client-b".to_owned(),
                mode: LeaseMode::Interactive,
            })
        );
    }

    #[test]
    fn workspace_manages_session_registry_and_selection() {
        let mut workspace = SinglePaneWorkspace::new("Main", "Shell");
        let first_session = workspace.session_id().clone();

        let second_session = workspace
            .create_session("Ops")
            .expect("session create should succeed");

        assert_eq!(workspace.session_count(), 2);
        assert_eq!(workspace.session_id(), &second_session);
        assert_eq!(workspace.session_name(), "Ops");

        workspace
            .rename_session(&second_session, "Prod")
            .expect("rename should succeed");
        assert_eq!(workspace.session_name(), "Prod");

        workspace
            .select_session(&first_session)
            .expect("session select should succeed");
        assert_eq!(workspace.session_id(), &first_session);
        assert_eq!(workspace.session_name(), "Main");

        let fallback_session = workspace
            .close_session(&first_session)
            .expect("session close should succeed");
        assert_eq!(fallback_session, second_session);
        assert_eq!(workspace.session_count(), 1);
        assert_eq!(workspace.session_id(), &second_session);
        assert_eq!(workspace.session_name(), "Prod");
    }

    #[test]
    fn workspace_manages_tabs_within_a_session() {
        let mut workspace = SinglePaneWorkspace::new("Main", "Shell");
        let session_id = workspace.session_id().clone();
        let first_tab = workspace.tab_id().clone();

        let second_tab = workspace
            .create_tab(&session_id, "Logs")
            .expect("tab create should succeed");

        assert_eq!(workspace.tab_count(), 2);
        assert_eq!(workspace.tab_id(), &second_tab);
        assert_eq!(workspace.tab_title(), "Logs");

        workspace
            .rename_tab(&second_tab, "Build")
            .expect("tab rename should succeed");
        assert_eq!(workspace.tab_title(), "Build");

        workspace
            .select_tab(&first_tab)
            .expect("tab select should succeed");
        assert_eq!(workspace.tab_id(), &first_tab);
        assert_eq!(workspace.tab_title(), "Shell");

        let fallback_tab = workspace
            .close_tab(&first_tab)
            .expect("tab close should succeed");
        assert_eq!(fallback_tab, second_tab);
        assert_eq!(workspace.tab_count(), 1);
        assert_eq!(workspace.tab_id(), &second_tab);
        assert_eq!(workspace.tab_title(), "Build");
    }

    #[test]
    fn focusing_a_pane_promotes_its_parent_session_and_tab() {
        let mut workspace = SinglePaneWorkspace::new("Main", "Shell");
        let first_session = workspace.session_id().clone();
        let second_session = workspace
            .create_session("Ops")
            .expect("session create should succeed");
        let second_pane = workspace.pane_id().clone();

        workspace
            .select_session(&first_session)
            .expect("session select should succeed");
        workspace
            .focus_pane(&second_pane)
            .expect("pane focus should succeed");

        assert_eq!(workspace.session_id(), &second_session);
        assert_eq!(workspace.pane_id(), &second_pane);
    }
}

#![forbid(unsafe_code)]

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use remux_core::{PaneId, TerminalSize};
use remux_session::RuntimeSnapshot;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

pub const CRATE_NAME: &str = "remux-store";
pub const PERSISTENCE_ENVELOPE_VERSION_V1: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeLifecycleMarkerKind {
    RuntimeStarted,
    WorkspaceSaved,
    PaneResized,
    PaneExited,
    RuntimeStopped,
    RuntimeCrashed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeLifecycleMarker {
    pub marker_id: String,
    pub marker_kind: RuntimeLifecycleMarkerKind,
    pub at_ms: u64,
    pub pane_id: Option<PaneId>,
    pub size: Option<TerminalSize>,
    pub exit_code: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecordingSegmentMetadata {
    pub segment_id: String,
    pub pane_id: PaneId,
    pub started_at_ms: u64,
    pub ended_at_ms: Option<u64>,
    pub chunk_count: u64,
    pub byte_count: u64,
    pub first_sequence: Option<u64>,
    pub last_sequence: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceMetadata {
    pub saved_at_ms: u64,
    pub snapshot: RuntimeSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PersistenceEnvelopeV1 {
    pub schema_version: u32,
    pub updated_at_ms: u64,
    pub workspace: Option<WorkspaceMetadata>,
    pub recording_segments: Vec<RecordingSegmentMetadata>,
    pub lifecycle_markers: Vec<RuntimeLifecycleMarker>,
}

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("store io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("store json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("unsupported persistence envelope schema version {found}; expected {expected}")]
    UnsupportedSchemaVersion { found: u32, expected: u32 },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistenceSchemaProbe {
    schema_version: u32,
}

impl PersistenceEnvelopeV1 {
    #[must_use]
    pub fn new_empty() -> Self {
        Self {
            schema_version: PERSISTENCE_ENVELOPE_VERSION_V1,
            updated_at_ms: now_ms(),
            workspace: None,
            recording_segments: Vec::new(),
            lifecycle_markers: Vec::new(),
        }
    }

    pub fn append_marker(&mut self, marker: RuntimeLifecycleMarker) {
        let marker_at_ms = marker.at_ms;
        self.lifecycle_markers.push(marker);
        self.updated_at_ms = marker_at_ms;
    }

    pub fn set_workspace_snapshot(&mut self, saved_at_ms: u64, snapshot: RuntimeSnapshot) {
        self.workspace = Some(WorkspaceMetadata {
            saved_at_ms,
            snapshot,
        });
        self.updated_at_ms = saved_at_ms;
    }

    pub fn record_pane_output(
        &mut self,
        pane_id: &PaneId,
        sequence: u64,
        bytes: usize,
        at_ms: u64,
    ) {
        let bytes = u64::try_from(bytes).unwrap_or(u64::MAX);
        let segment = self
            .recording_segments
            .iter_mut()
            .find(|segment| segment.pane_id == *pane_id && segment.ended_at_ms.is_none());
        if let Some(segment) = segment {
            segment.chunk_count = segment.chunk_count.saturating_add(1);
            segment.byte_count = segment.byte_count.saturating_add(bytes);
            segment.first_sequence.get_or_insert(sequence);
            segment.last_sequence = Some(sequence);
            self.updated_at_ms = at_ms;
            return;
        }

        self.recording_segments.push(RecordingSegmentMetadata {
            segment_id: format!("segment_{}", Uuid::new_v4().simple()),
            pane_id: pane_id.clone(),
            started_at_ms: at_ms,
            ended_at_ms: None,
            chunk_count: 1,
            byte_count: bytes,
            first_sequence: Some(sequence),
            last_sequence: Some(sequence),
        });
        self.updated_at_ms = at_ms;
    }

    pub fn close_open_segment(&mut self, pane_id: &PaneId, at_ms: u64) {
        if let Some(segment) = self
            .recording_segments
            .iter_mut()
            .rev()
            .find(|segment| segment.pane_id == *pane_id && segment.ended_at_ms.is_none())
        {
            segment.ended_at_ms = Some(at_ms);
        }
        self.updated_at_ms = at_ms;
    }

    #[must_use]
    pub fn previous_runtime_closed_cleanly(&self) -> bool {
        match self
            .lifecycle_markers
            .last()
            .map(|marker| &marker.marker_kind)
        {
            Some(RuntimeLifecycleMarkerKind::RuntimeStopped)
            | Some(RuntimeLifecycleMarkerKind::RuntimeCrashed)
            | None => true,
            Some(_) => false,
        }
    }
}

#[must_use]
pub fn default_store_path_from_home(home: &Path) -> PathBuf {
    home.join(".remux").join("runtime-v2").join("state-v1.json")
}

pub fn load_envelope(path: &Path) -> Result<Option<PersistenceEnvelopeV1>, StoreError> {
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read(path)?;
    let probe: PersistenceSchemaProbe = serde_json::from_slice(&raw)?;
    if probe.schema_version != PERSISTENCE_ENVELOPE_VERSION_V1 {
        return Err(StoreError::UnsupportedSchemaVersion {
            found: probe.schema_version,
            expected: PERSISTENCE_ENVELOPE_VERSION_V1,
        });
    }

    let envelope = serde_json::from_slice::<PersistenceEnvelopeV1>(&raw)?;
    Ok(Some(envelope))
}

pub fn save_envelope(path: &Path, envelope: &PersistenceEnvelopeV1) -> Result<(), StoreError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let temp_path = path.with_extension("json.tmp");
    let payload = serde_json::to_vec_pretty(envelope)?;
    fs::write(&temp_path, payload)?;
    fs::rename(temp_path, path)?;
    Ok(())
}

#[must_use]
pub fn new_marker(
    marker_kind: RuntimeLifecycleMarkerKind,
    at_ms: u64,
    pane_id: Option<PaneId>,
    size: Option<TerminalSize>,
    exit_code: Option<i32>,
) -> RuntimeLifecycleMarker {
    RuntimeLifecycleMarker {
        marker_id: format!("marker_{}", Uuid::new_v4().simple()),
        marker_kind,
        at_ms,
        pane_id,
        size,
        exit_code,
    }
}

#[must_use]
pub fn now_ms() -> u64 {
    let since_epoch = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    u64::try_from(since_epoch.as_millis()).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use remux_core::{PaneId, SessionId, SessionLifecycleState, SplitDirection, TabId};
    use remux_session::{LayoutNode, PaneSnapshot, RuntimeSnapshot, SessionSnapshot, TabSnapshot};

    use super::*;

    fn sample_snapshot() -> RuntimeSnapshot {
        let pane_id = PaneId("pane_test".to_owned());
        let tab_id = TabId("tab_test".to_owned());
        let session_id = SessionId("session_test".to_owned());
        RuntimeSnapshot {
            active_session_id: session_id.clone(),
            sessions: vec![SessionSnapshot {
                session_id,
                session_state: SessionLifecycleState::Recoverable,
                session_name: "Recovered".to_owned(),
                active_tab_id: tab_id.clone(),
                tabs: vec![TabSnapshot {
                    tab_id,
                    tab_title: "Shell".to_owned(),
                    active_pane_id: pane_id.clone(),
                    zoomed_pane_id: None,
                    layout: LayoutNode::Split {
                        direction: SplitDirection::Vertical,
                        ratio: 50,
                        children: vec![LayoutNode::Leaf(pane_id.clone())],
                    },
                    panes: vec![PaneSnapshot {
                        pane_id,
                        writer_lease: None,
                    }],
                }],
            }],
        }
    }

    #[test]
    fn envelope_roundtrip_preserves_workspace_segments_and_markers() {
        let temp = std::env::temp_dir().join(format!(
            "remux-store-envelope-roundtrip-{}.json",
            Uuid::new_v4().simple()
        ));
        let pane_id = PaneId("pane_test".to_owned());
        let mut envelope = PersistenceEnvelopeV1::new_empty();
        envelope.set_workspace_snapshot(10, sample_snapshot());
        envelope.record_pane_output(&pane_id, 3, 128, 11);
        envelope.close_open_segment(&pane_id, 12);
        envelope.append_marker(new_marker(
            RuntimeLifecycleMarkerKind::RuntimeStarted,
            9,
            None,
            None,
            None,
        ));
        envelope.append_marker(new_marker(
            RuntimeLifecycleMarkerKind::PaneExited,
            12,
            Some(pane_id),
            None,
            Some(0),
        ));

        save_envelope(&temp, &envelope).expect("save envelope");
        let loaded = load_envelope(&temp)
            .expect("load envelope")
            .expect("envelope should exist");

        assert_eq!(loaded.schema_version, PERSISTENCE_ENVELOPE_VERSION_V1);
        assert_eq!(loaded.workspace, envelope.workspace);
        assert_eq!(loaded.recording_segments, envelope.recording_segments);
        assert_eq!(loaded.lifecycle_markers, envelope.lifecycle_markers);

        fs::remove_file(temp).ok();
    }

    #[test]
    fn loading_mismatched_schema_returns_unsupported_version_error() {
        let temp = std::env::temp_dir().join(format!(
            "remux-store-envelope-version-mismatch-{}.json",
            Uuid::new_v4().simple()
        ));
        fs::write(
            &temp,
            r#"{"schemaVersion":999,"workspace":null,"recordingSegments":[],"lifecycleMarkers":[]}"#,
        )
        .expect("write test fixture");

        let error = load_envelope(&temp).expect_err("should reject unsupported schema");
        match error {
            StoreError::UnsupportedSchemaVersion { found, expected } => {
                assert_eq!(found, 999);
                assert_eq!(expected, PERSISTENCE_ENVELOPE_VERSION_V1);
            }
            _ => panic!("unexpected error: {error}"),
        }

        fs::remove_file(temp).ok();
    }

    #[test]
    fn previous_runtime_closed_cleanly_detects_unclean_shutdown() {
        let mut envelope = PersistenceEnvelopeV1::new_empty();
        envelope.append_marker(new_marker(
            RuntimeLifecycleMarkerKind::RuntimeStarted,
            1,
            None,
            None,
            None,
        ));
        assert!(!envelope.previous_runtime_closed_cleanly());

        envelope.append_marker(new_marker(
            RuntimeLifecycleMarkerKind::RuntimeStopped,
            2,
            None,
            None,
            None,
        ));
        assert!(envelope.previous_runtime_closed_cleanly());
    }

    #[test]
    fn default_store_path_uses_runtime_v2_state_v1_location() {
        let path = default_store_path_from_home(Path::new("/tmp/remux-home"));
        assert_eq!(
            path,
            PathBuf::from("/tmp/remux-home/.remux/runtime-v2/state-v1.json")
        );
    }
}

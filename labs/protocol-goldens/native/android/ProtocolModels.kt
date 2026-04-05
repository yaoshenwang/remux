package remux.protocol

data class ProtocolCapabilities(
    val envelope: Boolean,
    val inspectV2: Boolean,
    val deviceTrust: Boolean,
)

data class AuthPayload(
    val token: String,
    val password: String?,
    val cols: Int?,
    val rows: Int?,
    val capabilities: ProtocolCapabilities?,
)

data class AuthOkPayload(
    val capabilities: ProtocolCapabilities,
)

data class AuthErrorPayload(
    val reason: String,
)

data class InspectContentPayload(
    val content: String,
)

data class RemuxEnvelope<T>(
    val domain: String,
    val type: String,
    val version: Int,
    val requestId: String?,
    val emittedAt: String,
    val source: String,
    val payload: T,
)

data class WorkspacePane(
    val id: String,
    val focused: Boolean,
    val title: String,
    val command: String?,
    val cwd: String?,
    val rows: Int,
    val cols: Int,
    val x: Int,
    val y: Int,
)

data class WorkspaceTab(
    val index: Int,
    val name: String,
    val active: Boolean,
    val isFullscreen: Boolean,
    val hasBell: Boolean,
    val panes: List<WorkspacePane>,
)

data class WorkspaceState(
    val session: String,
    val tabs: List<WorkspaceTab>,
    val activeTabIndex: Int,
)

data class InspectHighlight(
    val start: Int,
    val end: Int,
)

data class InspectDescriptor(
    val scope: String,
    val source: String,
    val precision: String,
    val staleness: String,
    val capturedAt: String,
    val paneId: String?,
    val tabIndex: Int?,
    val totalItems: Int?,
)

data class InspectItem(
    val type: String,
    val content: String,
    val lineNumber: Int?,
    val timestamp: String,
    val paneId: String?,
    val highlights: List<InspectHighlight>?,
)

data class InspectSnapshot(
    val descriptor: InspectDescriptor,
    val items: List<InspectItem>,
    val cursor: String?,
    val truncated: Boolean,
)

data class InspectRequest(
    val scope: String,
    val paneId: String?,
    val tabIndex: Int?,
    val cursor: String?,
    val query: String?,
    val limit: Int?,
)

data class BandwidthStats(
    val rawBytesPerSec: Double,
    val compressedBytesPerSec: Double,
    val savedPercent: Double,
    val fullSnapshotsSent: Int,
    val diffUpdatesSent: Int,
    val avgChangedRowsPerDiff: Double,
    val totalRawBytes: Int,
    val totalCompressedBytes: Int,
    val totalSavedBytes: Int,
    val rttMs: Int?,
    val protocolName: String,
)

data class BandwidthStatsPayload(
    val stats: BandwidthStats,
)

data class LegacyAuthOk(
    val type: String,
    val capabilities: ProtocolCapabilities,
)

data class LegacyAuth(
    val type: String,
    val token: String,
    val password: String?,
    val cols: Int?,
    val rows: Int?,
    val capabilities: ProtocolCapabilities?,
)

data class LegacyAuthError(
    val type: String,
    val reason: String,
)

data class LegacyErrorMessage(
    val type: String,
    val code: Int?,
    val message: String,
)

data class LegacyPong(
    val type: String,
    val timestamp: Double,
)

data class LegacyWorkspaceState(
    val type: String,
    val session: String,
    val tabs: List<WorkspaceTab>,
    val activeTabIndex: Int,
)

data class LegacyInspectRequest(
    val type: String,
    val scope: String,
    val paneId: String?,
    val tabIndex: Int?,
    val cursor: String?,
    val query: String?,
    val limit: Int?,
)

data class LegacyInspectSnapshot(
    val type: String,
    val descriptor: InspectDescriptor,
    val items: List<InspectItem>,
    val cursor: String?,
    val truncated: Boolean,
)

data class LegacyBandwidthStats(
    val type: String,
    val stats: BandwidthStats,
)

data class LegacyInspectContent(
    val type: String,
    val content: String,
)

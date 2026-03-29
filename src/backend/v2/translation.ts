import type {
  ClientView,
  ControlServerMessage,
  SessionState,
  TabState,
  RuntimeSnapshot,
} from "../../shared/protocol.js";
import type {
  RuntimeV2InspectPrecision,
  RuntimeV2InspectSnapshot,
  RuntimeV2SessionState,
  RuntimeV2TabSummary,
  RuntimeV2WorkspaceSummary,
} from "./types.js";

const mapLifecycle = (state: RuntimeV2SessionState): "live" | "exited" =>
  state === "stopped" ? "exited" : "live";

const splitPreviewRows = (snapshot: RuntimeV2InspectSnapshot): string[] =>
  snapshot.previewText
    .split(/\r?\n/)
    .map((row) => row.trimEnd())
    .filter((row, index, rows) => row.length > 0 || index < rows.length - 1);

const collectInspectRows = (
  snapshot: RuntimeV2InspectSnapshot,
  lines: number,
): string[] => {
  const combinedRows = [...(snapshot.inspectRows ?? snapshot.scrollbackRows ?? []), ...snapshot.visibleRows];
  const rows = combinedRows.length > 0 ? combinedRows : splitPreviewRows(snapshot);
  if (lines <= 0 || rows.length <= lines) {
    return rows;
  }
  return rows.slice(-lines);
};

export const renderInspectText = (
  snapshot: RuntimeV2InspectSnapshot,
  lines: number,
): string => collectInspectRows(snapshot, lines).join("\n").trimEnd();

const findActiveSession = (summary: RuntimeV2WorkspaceSummary) =>
  summary.sessions.find((session) => session.isActive)
  ?? summary.sessions.find((session) => session.sessionId === summary.activeSessionId)
  ?? summary.sessions[0];

const findActiveTab = (summary: RuntimeV2WorkspaceSummary) => {
  const session = findActiveSession(summary);
  if (!session) {
    return undefined;
  }
  return session.tabs.find((tab) => tab.isActive)
    ?? session.tabs.find((tab) => tab.tabId === session.activeTabId)
    ?? session.tabs[0];
};

const resolvePaneDimension = (
  value: number | null | undefined,
  fallback: number,
): number => typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;

const resolvePaneCommand = (command: string | null | undefined): string => {
  const normalized = command?.trim();
  return normalized ? normalized : "shell";
};

const resolvePanePath = (currentPath: string | null | undefined): string => currentPath ?? "";

export const buildRuntimeSnapshot = (
  summary: RuntimeV2WorkspaceSummary,
): RuntimeSnapshot => ({
  capturedAt: new Date().toISOString(),
  sessions: summary.sessions.map((session) => ({
    name: session.sessionName,
    attached: session.isActive,
    tabCount: session.tabs.length,
    lifecycle: mapLifecycle(session.sessionState),
    tabs: session.tabs.map((tab, tabIndex) => ({
      index: tabIndex,
      id: tab.tabId,
      name: tab.tabTitle,
      active: tab.isActive,
      paneCount: tab.panes.length,
      panes: tab.panes.map((pane, paneIndex) => ({
        index: paneIndex,
        id: pane.paneId,
        currentCommand: resolvePaneCommand(pane.command),
        active: pane.isActive,
        width: resolvePaneDimension(pane.width, 80),
        height: resolvePaneDimension(pane.height, 24),
        zoomed: pane.isZoomed,
        currentPath: resolvePanePath(pane.currentPath),
      })),
    })),
  })),
});

export const buildLegacyClientView = (
  summary: RuntimeV2WorkspaceSummary,
  followBackendFocus: boolean,
): ClientView => {
  const session = findActiveSession(summary);
  const tab = findActiveTab(summary);
  const tabIndex = session?.tabs.findIndex((candidate) => candidate.tabId === tab?.tabId) ?? -1;

  return {
    sessionName: session?.sessionName ?? summary.sessionName,
    tabIndex: tabIndex >= 0 ? tabIndex : 0,
    paneId: tab?.activePaneId ?? summary.activePaneId ?? summary.paneId,
    followBackendFocus,
  };
};

export const resolveLegacyAttachedSession = (
  summary: RuntimeV2WorkspaceSummary,
): string => findActiveSession(summary)?.sessionName ?? summary.sessionName;

export const findLegacySession = (
  summary: RuntimeV2WorkspaceSummary,
  sessionName: string,
): SessionState | undefined => buildRuntimeSnapshot(summary).sessions.find((session) => session.name === sessionName);

export const findRuntimeTabByLegacyIndex = (
  summary: RuntimeV2WorkspaceSummary,
  sessionName: string,
  tabIndex: number,
): RuntimeV2TabSummary | undefined => summary.sessions.find((session) => session.sessionName === sessionName)?.tabs[tabIndex];

export const buildLegacyTabHistory = (
  summary: RuntimeV2WorkspaceSummary,
  sessionName: string,
  tabIndex: number,
  lines: number,
  snapshots: RuntimeV2InspectSnapshot[],
  viewRevision = 1,
): Extract<ControlServerMessage, { type: "tab_history" }> => {
  const tab = findRuntimeTabByLegacyIndex(summary, sessionName, tabIndex);
  if (!tab) {
    throw new Error(`tab not found: ${sessionName}:${tabIndex}`);
  }

  const capturedAt = new Date().toISOString();
  const precision = snapshots.some((snapshot) => snapshot.precision !== "precise")
    ? "approximate"
    : "precise";

  return {
    type: "tab_history",
    viewRevision,
    sessionName,
    tabIndex,
    tabName: tab.tabTitle,
    lines,
    source: "server_tab_history",
    precision,
    capturedAt,
    panes: tab.panes.map((pane, paneIndex) => {
      const snapshot = snapshots[paneIndex];
      const text = snapshot ? renderInspectText(snapshot, lines) : "";
      return {
        paneId: pane.paneId,
        paneIndex,
        command: "shell",
        title: `Pane ${paneIndex} · ${pane.paneId}`,
        text,
        paneWidth: snapshot?.size.cols ?? 80,
        isApproximate: snapshot ? snapshot.precision !== "precise" : true,
        archived: false,
        capturedAt,
        lines,
      };
    }),
    events: [],
  };
};

/** Builds a legacy "scrollback" wire message. The type: "scrollback" value is kept for wire compat. */
export const buildLegacyInspectContent = (
  paneId: string,
  lines: number,
  snapshot: RuntimeV2InspectSnapshot,
): Extract<ControlServerMessage, { type: "scrollback" }> => ({
  type: "scrollback",
  paneId,
  lines,
  text: renderInspectText(snapshot, lines),
  paneWidth: snapshot.size.cols,
  isApproximate: snapshot.precision !== "precise",
});

export const mapInspectPrecision = (
  snapshots: RuntimeV2InspectSnapshot[],
): RuntimeV2InspectPrecision =>
  snapshots.some((snapshot) => snapshot.precision !== "precise")
    ? "approximate"
    : "precise";

export const findLegacyActivePane = (
  snapshot: RuntimeSnapshot,
  clientView: ClientView,
): TabState["panes"][number] | undefined =>
  snapshot.sessions
    .find((session) => session.name === clientView.sessionName)
    ?.tabs[clientView.tabIndex]
    ?.panes.find((pane) => pane.id === clientView.paneId);

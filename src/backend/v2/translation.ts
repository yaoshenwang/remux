import type {
  ClientView,
  ControlServerMessage,
  SessionState,
  TabState,
  WorkspaceSnapshot,
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

const renderInspectText = (snapshot: RuntimeV2InspectSnapshot): string => {
  const preview = snapshot.previewText.trimEnd();
  if (preview) {
    return preview;
  }
  return snapshot.visibleRows.join("\n").trimEnd();
};

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

export const buildLegacyWorkspaceSnapshot = (
  summary: RuntimeV2WorkspaceSummary,
): WorkspaceSnapshot => ({
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
        currentCommand: "shell",
        active: pane.isActive,
        width: 80,
        height: 24,
        zoomed: pane.isZoomed,
        currentPath: "",
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
): SessionState | undefined => buildLegacyWorkspaceSnapshot(summary).sessions.find((session) => session.name === sessionName);

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
    sessionName,
    tabIndex,
    tabName: tab.tabTitle,
    lines,
    source: "server_tab_history",
    precision,
    capturedAt,
    panes: tab.panes.map((pane, paneIndex) => {
      const snapshot = snapshots[paneIndex];
      const text = snapshot ? renderInspectText(snapshot) : "";
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

export const buildLegacyScrollback = (
  paneId: string,
  lines: number,
  snapshot: RuntimeV2InspectSnapshot,
): Extract<ControlServerMessage, { type: "scrollback" }> => ({
  type: "scrollback",
  paneId,
  lines,
  text: renderInspectText(snapshot),
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
  snapshot: WorkspaceSnapshot,
  clientView: ClientView,
): TabState["panes"][number] | undefined =>
  snapshot.sessions
    .find((session) => session.name === clientView.sessionName)
    ?.tabs[clientView.tabIndex]
    ?.panes.find((pane) => pane.id === clientView.paneId);

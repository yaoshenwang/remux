import { ansiToHtml } from "./ansi-to-html";
import type { ControlServerMessage, TabHistoryEvent, TabHistoryPane, TabState } from "../shared/protocol";

export type InspectPrecision = "precise" | "approximate" | "partial";
export type InspectSource = "backend_capture" | "server_tab_history";

export interface PaneInspectCapture {
  paneId: string;
  text: string;
  paneWidth: number;
  isApproximate: boolean;
}

export interface InspectSection {
  paneId: string;
  title: string;
  command: string;
  html: string;
  rawText: string;
  paneWidth: number;
  precision: Exclude<InspectPrecision, "partial">;
}

export interface TabInspectSnapshot {
  scope: "tab";
  source: InspectSource;
  precision: InspectPrecision;
  capturedAt: string;
  sessionName: string;
  tabIndex: number;
  tabName: string;
  sections: InspectSection[];
  missingPaneIds: string[];
  events: TabHistoryEvent[];
}

export interface InspectFilterOptions {
  paneId: string;
  query: string;
}

interface BuildTabInspectSnapshotOptions {
  sessionName: string;
  tab: TabState;
  captures: Record<string, PaneInspectCapture>;
  capturedAt: string;
}

export const buildTabInspectSnapshot = ({
  sessionName,
  tab,
  captures,
  capturedAt
}: BuildTabInspectSnapshotOptions): TabInspectSnapshot => {
  const sections: InspectSection[] = [];
  const missingPaneIds: string[] = [];

  for (const pane of tab.panes) {
    const capture = captures[pane.id];
    if (!capture) {
      missingPaneIds.push(pane.id);
      continue;
    }

    sections.push({
      paneId: pane.id,
      title: `Pane ${pane.index} · ${pane.currentCommand} · ${pane.id}`,
      command: pane.currentCommand,
      html: ansiToHtml(capture.text),
      rawText: capture.text,
      paneWidth: capture.paneWidth,
      precision: capture.isApproximate ? "approximate" : "precise"
    });
  }

  let precision: InspectPrecision = "precise";
  if (missingPaneIds.length > 0) {
    precision = "partial";
  } else if (sections.some((section) => section.precision === "approximate")) {
    precision = "approximate";
  }

  return {
    scope: "tab",
    source: "backend_capture",
    precision,
    capturedAt,
    sessionName,
    tabIndex: tab.index,
    tabName: tab.name,
    sections,
    missingPaneIds,
    events: []
  };
};

export const buildInspectSnapshotFromServerHistory = (
  payload: Extract<ControlServerMessage, { type: "tab_history" }>
): TabInspectSnapshot => ({
  scope: "tab",
  source: payload.source,
  precision: payload.precision,
  capturedAt: payload.capturedAt,
  sessionName: payload.sessionName,
  tabIndex: payload.tabIndex,
  tabName: payload.tabName,
  sections: payload.panes.map((pane: TabHistoryPane) => ({
    paneId: pane.paneId,
    title: pane.archived ? `${pane.title} · archived` : pane.title,
    command: pane.command,
    html: ansiToHtml(pane.text),
    rawText: pane.text,
    paneWidth: pane.paneWidth,
    precision: pane.isApproximate ? "approximate" : "precise"
  })),
  missingPaneIds: [],
  events: payload.events
});

export const filterInspectSections = (
  snapshot: TabInspectSnapshot,
  options: InspectFilterOptions
): InspectSection[] => {
  const normalizedQuery = options.query.trim().toLowerCase();

  return snapshot.sections.filter((section) => {
    if (options.paneId !== "all" && section.paneId !== options.paneId) {
      return false;
    }
    if (!normalizedQuery) {
      return true;
    }

    const haystacks = [
      section.title,
      section.command,
      section.rawText
    ].map((value) => value.toLowerCase());

    return haystacks.some((value) => value.includes(normalizedQuery));
  });
};

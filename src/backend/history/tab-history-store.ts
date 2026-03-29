import type {
  ClientDiagnosticDetails,
  TabHistoryEvent,
  TabHistoryPane,
  TabState,
  RuntimeSnapshot
} from "../../shared/protocol.js";

interface RecordEventOptions {
  sessionName: string;
  tabIndex: number;
  tabName: string;
  text: string;
  paneId?: string;
  at?: string;
  kind?: TabHistoryEvent["kind"];
  diagnostic?: ClientDiagnosticDetails;
}

interface RecordPaneCaptureOptions extends Omit<TabHistoryPane, "capturedAt"> {
  sessionName: string;
  tabIndex: number;
  tabName: string;
  capturedAt?: string;
}

interface RecordDiagnosticOptions {
  sessionName: string;
  tabIndex: number;
  tabName: string;
  paneId?: string;
  issue: ClientDiagnosticDetails["issue"];
  severity: ClientDiagnosticDetails["severity"];
  status: ClientDiagnosticDetails["status"];
  summary: string;
  sample: ClientDiagnosticDetails["sample"];
  recentActions: ClientDiagnosticDetails["recentActions"];
  recentSamples?: ClientDiagnosticDetails["recentSamples"];
  at?: string;
}

interface BuildTabHistoryOptions {
  sessionName: string;
  tab: TabState;
  lines: number;
  paneCaptures: TabHistoryPane[];
}

interface StoredTabHistory {
  tabName: string;
  events: TabHistoryEvent[];
  captures: Map<string, TabHistoryPane>;
}

const MAX_TAB_EVENTS = 120;

const keyForTab = (sessionName: string, tabIndex: number): string => `${sessionName}:${tabIndex}`;

export class TabHistoryStore {
  private readonly tabs = new Map<string, StoredTabHistory>();
  private previousSnapshot?: RuntimeSnapshot;
  private nextEventId = 1;

  recordSnapshot(snapshot: RuntimeSnapshot): void {
    this.syncTabMetadata(snapshot);

    if (!this.previousSnapshot) {
      this.previousSnapshot = snapshot;
      return;
    }

    for (const prevSession of this.previousSnapshot.sessions) {
      const currentSession = snapshot.sessions.find((session) => session.name === prevSession.name);
      for (const prevTab of prevSession.tabs) {
        const currentTab = currentSession?.tabs.find((tab) => tab.index === prevTab.index);
        if (!currentTab) {
          this.recordEvent({
            sessionName: prevSession.name,
            tabIndex: prevTab.index,
            tabName: prevTab.name,
            text: `Tab closed: ${prevTab.name}`
          });
          continue;
        }

        if (currentTab.name !== prevTab.name) {
          this.recordEvent({
            sessionName: prevSession.name,
            tabIndex: prevTab.index,
            tabName: currentTab.name,
            text: `Tab renamed to ${currentTab.name}`
          });
        }

        const previousPaneIds = new Set(prevTab.panes.map((pane) => pane.id));
        const currentPaneIds = new Set(currentTab.panes.map((pane) => pane.id));

        for (const pane of currentTab.panes) {
          if (!previousPaneIds.has(pane.id)) {
            this.recordEvent({
              sessionName: prevSession.name,
              tabIndex: prevTab.index,
              tabName: currentTab.name,
              text: `Pane added: ${pane.id}`,
              paneId: pane.id
            });
          }
        }

        for (const pane of prevTab.panes) {
          if (!currentPaneIds.has(pane.id)) {
            this.markPaneArchived(prevSession.name, prevTab.index, pane.id);
            this.recordEvent({
              sessionName: prevSession.name,
              tabIndex: prevTab.index,
              tabName: currentTab.name,
              text: `Pane removed: ${pane.id}`,
              paneId: pane.id
            });
          }
        }
      }
    }

    for (const session of snapshot.sessions) {
      const previousSession = this.previousSnapshot.sessions.find((candidate) => candidate.name === session.name);
      for (const tab of session.tabs) {
        const previousTab = previousSession?.tabs.find((candidate) => candidate.index === tab.index);
        if (!previousTab) {
          this.recordEvent({
            sessionName: session.name,
            tabIndex: tab.index,
            tabName: tab.name,
            text: `Tab created: ${tab.name}`
          });
        }
      }
    }

    this.previousSnapshot = snapshot;
  }

  recordEvent(options: RecordEventOptions): void {
    const entry = this.getOrCreateTabEntry(options.sessionName, options.tabIndex, options.tabName);
    entry.events.push({
      id: `evt-${this.nextEventId++}`,
      at: options.at ?? new Date().toISOString(),
      text: options.text,
      kind: options.kind ?? "event",
      paneId: options.paneId,
      diagnostic: options.diagnostic,
    });
    if (entry.events.length > MAX_TAB_EVENTS) {
      entry.events.splice(0, entry.events.length - MAX_TAB_EVENTS);
    }
  }

  recordDiagnostic(options: RecordDiagnosticOptions): void {
    const issueLabel = options.issue.replace(/_/g, " ");
    const prefix = options.status === "resolved" ? "Redline resolved" : "Redline opened";
    this.recordEvent({
      sessionName: options.sessionName,
      tabIndex: options.tabIndex,
      tabName: options.tabName,
      paneId: options.paneId,
      at: options.at,
      kind: "diagnostic",
      text: `${prefix}: ${issueLabel} - ${options.summary}`,
      diagnostic: {
        issue: options.issue,
        severity: options.severity,
        status: options.status,
        summary: options.summary,
        sample: options.sample,
        recentActions: options.recentActions,
        recentSamples: options.recentSamples,
      }
    });
  }

  recordPaneCapture(options: RecordPaneCaptureOptions): void {
    const entry = this.getOrCreateTabEntry(options.sessionName, options.tabIndex, options.tabName);
    entry.captures.set(options.paneId, {
      paneId: options.paneId,
      paneIndex: options.paneIndex,
      command: options.command,
      title: options.title,
      text: options.text,
      paneWidth: options.paneWidth,
      isApproximate: options.isApproximate,
      archived: options.archived,
      capturedAt: options.capturedAt ?? new Date().toISOString(),
      lines: options.lines
    });
  }

  buildTabHistory(options: BuildTabHistoryOptions): {
    sessionName: string;
    tabIndex: number;
    tabName: string;
    lines: number;
    source: "server_tab_history";
    precision: "precise" | "approximate" | "partial";
    capturedAt: string;
    panes: TabHistoryPane[];
    events: TabHistoryEvent[];
  } {
    const entry = this.getOrCreateTabEntry(options.sessionName, options.tab.index, options.tab.name);
    const currentPaneIds = new Set(options.tab.panes.map((pane) => pane.id));

    for (const paneCapture of options.paneCaptures) {
      entry.captures.set(paneCapture.paneId, {
        ...paneCapture,
        archived: false
      });
    }

    for (const [paneId, capture] of entry.captures) {
      if (!currentPaneIds.has(paneId)) {
        entry.captures.set(paneId, { ...capture, archived: true });
      }
    }

    const archivedPanes = Array.from(entry.captures.values())
      .filter((capture) => capture.archived && !currentPaneIds.has(capture.paneId));

    const panes = [...options.paneCaptures, ...archivedPanes]
      .sort((left, right) => left.paneIndex - right.paneIndex || left.title.localeCompare(right.title));

    const currentCaptureIds = new Set(options.paneCaptures.map((pane) => pane.paneId));
    let precision: "precise" | "approximate" | "partial" = "precise";
    if (options.tab.panes.some((pane) => !currentCaptureIds.has(pane.id))) {
      precision = "partial";
    } else if (panes.some((pane) => pane.isApproximate)) {
      precision = "approximate";
    }

    return {
      sessionName: options.sessionName,
      tabIndex: options.tab.index,
      tabName: options.tab.name,
      lines: options.lines,
      source: "server_tab_history",
      precision,
      capturedAt: new Date().toISOString(),
      panes,
      events: [...entry.events]
    };
  }

  private syncTabMetadata(snapshot: RuntimeSnapshot): void {
    for (const session of snapshot.sessions) {
      for (const tab of session.tabs) {
        const entry = this.getOrCreateTabEntry(session.name, tab.index, tab.name);
        entry.tabName = tab.name;
        const currentPaneIds = new Set(tab.panes.map((pane) => pane.id));
        for (const pane of tab.panes) {
          const existing = entry.captures.get(pane.id);
          if (existing) {
            entry.captures.set(pane.id, {
              ...existing,
              paneIndex: pane.index,
              command: pane.currentCommand,
              title: `Pane ${pane.index} · ${pane.currentCommand} · ${pane.id}`,
              archived: false
            });
          }
        }
        for (const [paneId, capture] of entry.captures) {
          if (!currentPaneIds.has(paneId)) {
            entry.captures.set(paneId, { ...capture, archived: true });
          }
        }
      }
    }
  }

  private markPaneArchived(sessionName: string, tabIndex: number, paneId: string): void {
    const entry = this.tabs.get(keyForTab(sessionName, tabIndex));
    const capture = entry?.captures.get(paneId);
    if (!entry || !capture) {
      return;
    }
    entry.captures.set(paneId, { ...capture, archived: true });
  }

  private getOrCreateTabEntry(sessionName: string, tabIndex: number, tabName: string): StoredTabHistory {
    const key = keyForTab(sessionName, tabIndex);
    let entry = this.tabs.get(key);
    if (!entry) {
      entry = {
        tabName,
        events: [],
        captures: new Map()
      };
      this.tabs.set(key, entry);
    } else if (entry.tabName !== tabName) {
      entry.tabName = tabName;
    }
    return entry;
  }
}

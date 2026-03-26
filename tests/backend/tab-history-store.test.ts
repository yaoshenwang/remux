import { describe, expect, test } from "vitest";
import { TabHistoryStore } from "../../src/backend/history/tab-history-store.js";
import type { WorkspaceSnapshot } from "../../src/shared/protocol.js";

const buildSnapshot = (paneIds: string[], options?: { tabName?: string; activePaneId?: string }): WorkspaceSnapshot => ({
  capturedAt: "2026-03-26T00:00:00.000Z",
  sessions: [
    {
      name: "main",
      attached: true,
      tabCount: 1,
      tabs: [
        {
          index: 0,
          name: options?.tabName ?? "shell",
          active: true,
          paneCount: paneIds.length,
          panes: paneIds.map((paneId, index) => ({
            index,
            id: paneId,
            currentCommand: index === 0 ? "bash" : "tail",
            active: (options?.activePaneId ?? paneIds[0]) === paneId,
            width: 120,
            height: 40,
            zoomed: false,
            currentPath: "/tmp"
          }))
        }
      ]
    }
  ]
});

describe("TabHistoryStore", () => {
  test("records tab and pane lifecycle events from snapshot diffs", () => {
    const store = new TabHistoryStore();

    store.recordSnapshot(buildSnapshot(["%1"]));
    store.recordSnapshot(buildSnapshot(["%1", "%2"]));
    store.recordSnapshot(buildSnapshot(["%2"], { tabName: "build" }));

    const history = store.buildTabHistory({
      sessionName: "main",
      tab: buildSnapshot(["%2"], { tabName: "build" }).sessions[0]!.tabs[0]!,
      lines: 1000,
      paneCaptures: [
        {
          paneId: "%2",
          paneIndex: 0,
          command: "tail",
          title: "Pane 0 · tail · %2",
          text: "live",
          paneWidth: 120,
          isApproximate: false,
          archived: false,
          capturedAt: "2026-03-26T00:00:05.000Z",
          lines: 1000
        }
      ]
    });

    expect(history.events.map((entry) => entry.text)).toContain("Pane added: %2");
    expect(history.events.map((entry) => entry.text)).toContain("Tab renamed to build");
    expect(history.events.map((entry) => entry.text)).toContain("Pane removed: %1");
  });

  test("keeps archived pane captures after a pane disappears from the tab", () => {
    const store = new TabHistoryStore();

    const initial = buildSnapshot(["%1", "%2"]);
    store.recordSnapshot(initial);
    store.recordPaneCapture({
      sessionName: "main",
      tabIndex: 0,
      tabName: "shell",
      paneId: "%1",
      paneIndex: 0,
      command: "bash",
      title: "Pane 0 · bash · %1",
      text: "old left output",
      paneWidth: 120,
      isApproximate: false,
      archived: false,
      lines: 1000
    });
    store.recordPaneCapture({
      sessionName: "main",
      tabIndex: 0,
      tabName: "shell",
      paneId: "%2",
      paneIndex: 1,
      command: "tail",
      title: "Pane 1 · tail · %2",
      text: "old right output",
      paneWidth: 120,
      isApproximate: false,
      archived: false,
      lines: 1000
    });

    const afterClose = buildSnapshot(["%2"]);
    store.recordSnapshot(afterClose);

    const history = store.buildTabHistory({
      sessionName: "main",
      tab: afterClose.sessions[0]!.tabs[0]!,
      lines: 1000,
      paneCaptures: [
        {
          paneId: "%2",
          paneIndex: 0,
          command: "tail",
          title: "Pane 0 · tail · %2",
          text: "current output",
          paneWidth: 120,
          isApproximate: false,
          archived: false,
          capturedAt: "2026-03-26T00:00:06.000Z",
          lines: 1000
        }
      ]
    });

    const archivedPane = history.panes.find((pane) => pane.paneId === "%1");
    expect(archivedPane?.archived).toBe(true);
    expect(archivedPane?.text).toContain("old left output");
  });
});

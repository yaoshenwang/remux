import { describe, expect, test } from "vitest";
import {
  buildLegacyClientView,
  buildLegacyScrollback,
  buildLegacyTabHistory,
  buildLegacyWorkspaceSnapshot,
} from "../../src/backend/v2/translation.js";
import type {
  RuntimeV2InspectSnapshot,
  RuntimeV2WorkspaceSummary,
} from "../../src/backend/v2/types.js";

const workspaceSummary: RuntimeV2WorkspaceSummary = {
  sessionId: "session-1",
  tabId: "tab-1",
  paneId: "pane-1",
  sessionName: "main",
  tabTitle: "Shell",
  sessionState: "live",
  sessionCount: 2,
  tabCount: 2,
  paneCount: 2,
  activeSessionId: "session-1",
  activeTabId: "tab-1",
  activePaneId: "pane-1",
  zoomedPaneId: null,
  layout: {
    type: "split",
    direction: "right",
    ratio: 50,
    children: [
      { type: "leaf", paneId: "pane-1" },
      { type: "leaf", paneId: "pane-2" },
    ],
  },
  leaseHolderClientId: "terminal-client-1",
  sessions: [
    {
      sessionId: "session-1",
      sessionName: "main",
      sessionState: "live",
      isActive: true,
      activeTabId: "tab-1",
      tabCount: 2,
      tabs: [
        {
          tabId: "tab-1",
          tabTitle: "Shell",
          isActive: true,
          activePaneId: "pane-1",
          zoomedPaneId: null,
          paneCount: 2,
          layout: {
            type: "split",
            direction: "right",
            ratio: 50,
            children: [
              { type: "leaf", paneId: "pane-1" },
              { type: "leaf", paneId: "pane-2" },
            ],
          },
          panes: [
            {
              paneId: "pane-1",
              isActive: true,
              isZoomed: false,
              leaseHolderClientId: "terminal-client-1",
            },
            {
              paneId: "pane-2",
              isActive: false,
              isZoomed: false,
              leaseHolderClientId: null,
            },
          ],
        },
        {
          tabId: "tab-2",
          tabTitle: "Logs",
          isActive: false,
          activePaneId: "pane-3",
          zoomedPaneId: null,
          paneCount: 1,
          layout: { type: "leaf", paneId: "pane-3" },
          panes: [
            {
              paneId: "pane-3",
              isActive: true,
              isZoomed: false,
              leaseHolderClientId: null,
            },
          ],
        },
      ],
    },
    {
      sessionId: "session-2",
      sessionName: "ops",
      sessionState: "stopped",
      isActive: false,
      activeTabId: "tab-3",
      tabCount: 1,
      tabs: [
        {
          tabId: "tab-3",
          tabTitle: "Alerts",
          isActive: true,
          activePaneId: "pane-4",
          zoomedPaneId: "pane-4",
          paneCount: 1,
          layout: { type: "leaf", paneId: "pane-4" },
          panes: [
            {
              paneId: "pane-4",
              isActive: true,
              isZoomed: true,
              leaseHolderClientId: null,
            },
          ],
        },
      ],
    },
  ],
};

const inspectSnapshots: RuntimeV2InspectSnapshot[] = [
  {
    scope: { type: "pane", paneId: "pane-1" },
    precision: "precise",
    summary: "pane one",
    previewText: "echo one",
    visibleRows: ["echo one", "done"],
    byteCount: 8,
    size: { cols: 120, rows: 40 },
  },
  {
    scope: { type: "pane", paneId: "pane-2" },
    precision: "approximate",
    summary: "pane two",
    previewText: "tail -f",
    visibleRows: ["tail -f logs"],
    byteCount: 12,
    size: { cols: 80, rows: 24 },
  },
];

describe("runtime v2 translation", () => {
  test("maps a runtime v2 workspace summary to the legacy workspace snapshot", () => {
    const snapshot = buildLegacyWorkspaceSnapshot(workspaceSummary);

    expect(snapshot.sessions).toHaveLength(2);
    expect(snapshot.sessions[0]).toMatchObject({
      name: "main",
      attached: true,
      lifecycle: "live",
    });
    expect(snapshot.sessions[0]?.tabs[0]).toMatchObject({
      index: 0,
      id: "tab-1",
      name: "Shell",
      active: true,
      paneCount: 2,
    });
    expect(snapshot.sessions[0]?.tabs[0]?.panes[0]).toMatchObject({
      index: 0,
      id: "pane-1",
      active: true,
      zoomed: false,
      currentCommand: "shell",
      currentPath: "",
    });
    expect(snapshot.sessions[1]).toMatchObject({
      name: "ops",
      attached: false,
      lifecycle: "exited",
    });
  });

  test("builds a legacy client view from the active runtime selection", () => {
    expect(buildLegacyClientView(workspaceSummary, true)).toEqual({
      sessionName: "main",
      tabIndex: 0,
      paneId: "pane-1",
      followBackendFocus: true,
    });
  });

  test("builds a legacy tab history payload from pane inspect snapshots", () => {
    const payload = buildLegacyTabHistory(workspaceSummary, "main", 0, 200, inspectSnapshots);

    expect(payload).toMatchObject({
      type: "tab_history",
      sessionName: "main",
      tabIndex: 0,
      tabName: "Shell",
      lines: 200,
      source: "server_tab_history",
      precision: "approximate",
    });
    expect(payload.panes).toHaveLength(2);
    expect(payload.panes[0]).toMatchObject({
      paneId: "pane-1",
      paneIndex: 0,
      text: "echo one",
      paneWidth: 120,
      isApproximate: false,
    });
    expect(payload.panes[1]).toMatchObject({
      paneId: "pane-2",
      paneIndex: 1,
      text: "tail -f",
      paneWidth: 80,
      isApproximate: true,
    });
  });

  test("builds a legacy scrollback payload from inspect output", () => {
    expect(buildLegacyScrollback("pane-2", 64, inspectSnapshots[1]!)).toMatchObject({
      type: "scrollback",
      paneId: "pane-2",
      lines: 64,
      text: "tail -f",
      paneWidth: 80,
      isApproximate: true,
    });
  });
});

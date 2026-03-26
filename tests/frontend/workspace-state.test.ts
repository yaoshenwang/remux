import { describe, expect, test } from "vitest";
import type { ClientView, SessionState, WorkspaceSnapshot } from "../../src/shared/protocol.js";
import {
  createInitialWorkspaceState,
  deriveWorkspaceStateView,
  reduceWorkspaceState,
} from "../../src/frontend/hooks/useWorkspaceState.js";

const buildWorkspace = (sessions: SessionState[]): WorkspaceSnapshot => ({
  sessions,
  capturedAt: "2026-03-26T00:00:00.000Z",
});

const buildSession = (
  name: string,
  options: {
    activeTabIndex?: number;
    activePaneId?: string;
    attached?: boolean;
  } = {},
): SessionState => {
  const tabIndex = options.activeTabIndex ?? 0;
  const paneId = options.activePaneId ?? `%${name}-0`;

  return {
    name,
    attached: options.attached ?? false,
    tabCount: 2,
    tabs: [
      {
        index: 0,
        name: "shell",
        active: tabIndex === 0,
        paneCount: 2,
        panes: [
          {
            index: 0,
            id: `%${name}-0`,
            currentCommand: "bash",
            active: paneId === `%${name}-0`,
            width: 120,
            height: 40,
            zoomed: false,
            currentPath: "/tmp",
          },
          {
            index: 1,
            id: `%${name}-1`,
            currentCommand: "bash",
            active: paneId === `%${name}-1`,
            width: 80,
            height: 40,
            zoomed: false,
            currentPath: "/tmp",
          },
        ],
      },
      {
        index: 1,
        name: "logs",
        active: tabIndex === 1,
        paneCount: 1,
        panes: [
          {
            index: 0,
            id: `%${name}-2`,
            currentCommand: "tail",
            active: paneId === `%${name}-2`,
            width: 120,
            height: 40,
            zoomed: false,
            currentPath: "/var/log",
          },
        ],
      },
    ],
  };
};

describe("workspace state reducer", () => {
  test("attached action clears picker and transient local selection", () => {
    const state = {
      ...createInitialWorkspaceState(),
      sessionChoices: [{ name: "work", attached: false, tabCount: 2 }],
      pendingSessionAttachment: "work",
      selectedWindowIndex: 1,
      selectedPaneId: "%work-2",
    };

    const next = reduceWorkspaceState(state, {
      type: "attached",
      sessionName: "work",
    });

    expect(next.attachedSession).toBe("work");
    expect(next.pendingSessionAttachment).toBeNull();
    expect(next.sessionChoices).toBeNull();
    expect(next.selectedWindowIndex).toBeNull();
    expect(next.selectedPaneId).toBeNull();
  });

  test("session picker action drops stale attached session and local selection", () => {
    const state = {
      ...createInitialWorkspaceState(),
      attachedSession: "main",
      selectedWindowIndex: 1,
      selectedPaneId: "%main-2",
    };

    const next = reduceWorkspaceState(state, {
      type: "session_picker",
      sessions: [{ name: "work", attached: false, tabCount: 2 }],
    });

    expect(next.attachedSession).toBe("");
    expect(next.sessionChoices).toEqual([{ name: "work", attached: false, tabCount: 2 }]);
    expect(next.selectedWindowIndex).toBeNull();
    expect(next.selectedPaneId).toBeNull();
  });

  test("workspace_state infers attached session from client view and clears pending attach", () => {
    const workspace = buildWorkspace([
      buildSession("main", { attached: true }),
      buildSession("work", { attached: false, activeTabIndex: 1, activePaneId: "%work-2" }),
    ]);
    const clientView: ClientView = {
      sessionName: "work",
      tabIndex: 1,
      paneId: "%work-2",
      followBackendFocus: false,
    };

    const state = {
      ...createInitialWorkspaceState(),
      pendingSessionAttachment: "work",
      sessionChoices: [{ name: "work", attached: false, tabCount: 2 }],
    };

    const next = reduceWorkspaceState(state, {
      type: "workspace_state",
      workspace,
      clientView,
    });

    expect(next.attachedSession).toBe("work");
    expect(next.clientView).toEqual(clientView);
    expect(next.pendingSessionAttachment).toBeNull();
    expect(next.sessionChoices).toBeNull();
  });

  test("local tab and pane selection win until the snapshot invalidates them", () => {
    const state = reduceWorkspaceState(
      {
        ...createInitialWorkspaceState(),
        snapshot: buildWorkspace([buildSession("main", { attached: true })]),
        attachedSession: "main",
      },
      {
        type: "local_selection",
        tabIndex: 1,
        paneId: "%main-2",
      },
    );

    const derived = deriveWorkspaceStateView(state, {
      sessions: [],
      tabsBySession: {},
    });

    expect(derived.activeSession?.name).toBe("main");
    expect(derived.activeTab?.index).toBe(1);
    expect(derived.activePane?.id).toBe("%main-2");
  });

  test("derived view falls back to server-active tab when local selection no longer exists", () => {
    const state = {
      ...createInitialWorkspaceState(),
      snapshot: buildWorkspace([buildSession("main", { attached: true, activeTabIndex: 0 })]),
      attachedSession: "main",
      selectedWindowIndex: 9,
      selectedPaneId: "%missing",
    };

    const derived = deriveWorkspaceStateView(state, {
      sessions: [],
      tabsBySession: {},
    });

    expect(derived.activeTab?.index).toBe(0);
    expect(derived.activePane?.id).toBe("%main-0");
  });
});

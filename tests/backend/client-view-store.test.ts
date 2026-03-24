import { describe, expect, test } from "vitest";
import { ClientViewStore } from "../../src/backend/view/client-view-store.js";
import type { WorkspaceSnapshot } from "../../src/shared/protocol.js";

const makeSnapshot = (overrides?: Partial<WorkspaceSnapshot>): WorkspaceSnapshot => ({
  sessions: [
    {
      name: "main",
      attached: true,
      tabCount: 2,
      tabs: [
        {
          index: 0,
          name: "shell",
          active: true,
          paneCount: 1,
          panes: [
            { index: 0, id: "terminal_0", currentCommand: "bash", active: true, width: 120, height: 40, zoomed: false, currentPath: "/tmp" }
          ]
        },
        {
          index: 1,
          name: "editor",
          active: false,
          paneCount: 2,
          panes: [
            { index: 0, id: "terminal_1", currentCommand: "vim", active: true, width: 60, height: 40, zoomed: false, currentPath: "/tmp" },
            { index: 1, id: "terminal_2", currentCommand: "bash", active: false, width: 60, height: 40, zoomed: false, currentPath: "/tmp" }
          ]
        }
      ]
    }
  ],
  capturedAt: "2025-01-01T00:00:00.000Z",
  ...overrides,
});

describe("ClientViewStore", () => {
  test("initView selects active tab and pane", () => {
    const store = new ClientViewStore();
    const snapshot = makeSnapshot();
    const view = store.initView("client-1", "main", snapshot);
    expect(view.sessionName).toBe("main");
    expect(view.tabIndex).toBe(0);
    expect(view.paneId).toBe("terminal_0");
    expect(view.followBackendFocus).toBe(false);
  });

  test("selectTab updates tab and resets pane to active", () => {
    const store = new ClientViewStore();
    const snapshot = makeSnapshot();
    store.initView("client-1", "main", snapshot);
    store.selectTab("client-1", 1, snapshot);
    const view = store.getView("client-1")!;
    expect(view.tabIndex).toBe(1);
    expect(view.paneId).toBe("terminal_1");
  });

  test("selectPane updates pane", () => {
    const store = new ClientViewStore();
    const snapshot = makeSnapshot();
    store.initView("client-1", "main", snapshot);
    store.selectTab("client-1", 1, snapshot);
    store.selectPane("client-1", "terminal_2");
    expect(store.getView("client-1")!.paneId).toBe("terminal_2");
  });

  test("reconcile falls back when pane is killed", () => {
    const store = new ClientViewStore();
    const snapshot = makeSnapshot();
    store.initView("client-1", "main", snapshot);
    store.selectTab("client-1", 1, snapshot);
    store.selectPane("client-1", "terminal_2");

    // terminal_2 is gone
    const updated = makeSnapshot({
      sessions: [{
        name: "main", attached: true, tabCount: 2,
        tabs: [
          snapshot.sessions[0].tabs[0],
          { index: 1, name: "editor", active: false, paneCount: 1,
            panes: [{ index: 0, id: "terminal_1", currentCommand: "vim", active: true, width: 60, height: 40, zoomed: false, currentPath: "/tmp" }]
          }
        ]
      }]
    });
    store.reconcile(updated);
    expect(store.getView("client-1")!.paneId).toBe("terminal_1");
  });

  test("reconcile falls back when tab is killed", () => {
    const store = new ClientViewStore();
    const snapshot = makeSnapshot();
    store.initView("client-1", "main", snapshot);
    store.selectTab("client-1", 1, snapshot);

    const updated = makeSnapshot({
      sessions: [{
        name: "main", attached: true, tabCount: 1,
        tabs: [snapshot.sessions[0].tabs[0]]
      }]
    });
    store.reconcile(updated);
    const view = store.getView("client-1")!;
    expect(view.tabIndex).toBe(0);
    expect(view.paneId).toBe("terminal_0");
  });

  test("renameSession updates all views", () => {
    const store = new ClientViewStore();
    const snapshot = makeSnapshot();
    store.initView("client-1", "main", snapshot);
    store.initView("client-2", "main", snapshot);
    store.renameSession("main", "primary");
    expect(store.getView("client-1")!.sessionName).toBe("primary");
    expect(store.getView("client-2")!.sessionName).toBe("primary");
  });

  test("multi-client isolation", () => {
    const store = new ClientViewStore();
    const snapshot = makeSnapshot();
    store.initView("client-1", "main", snapshot);
    store.initView("client-2", "main", snapshot);
    store.selectTab("client-1", 1, snapshot);
    expect(store.getView("client-1")!.tabIndex).toBe(1);
    expect(store.getView("client-2")!.tabIndex).toBe(0);
  });

  test("removeClient cleans up", () => {
    const store = new ClientViewStore();
    const snapshot = makeSnapshot();
    store.initView("client-1", "main", snapshot);
    store.removeClient("client-1");
    expect(store.getView("client-1")).toBeUndefined();
  });

  test("followBackendFocus syncs view on reconcile", () => {
    const store = new ClientViewStore();
    const snapshot = makeSnapshot();
    store.initView("client-1", "main", snapshot);
    store.setFollowFocus("client-1", true);

    // Backend active tab changes to index 1
    const updated = makeSnapshot({
      sessions: [{
        name: "main", attached: true, tabCount: 2,
        tabs: [
          { ...snapshot.sessions[0].tabs[0], active: false },
          { ...snapshot.sessions[0].tabs[1], active: true }
        ]
      }]
    });
    store.reconcile(updated);
    const view = store.getView("client-1")!;
    expect(view.tabIndex).toBe(1);
    expect(view.paneId).toBe("terminal_1");
  });
});

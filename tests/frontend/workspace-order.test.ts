import { describe, expect, test } from "vitest";
import type { SessionState, TabState } from "../../src/shared/protocol.js";
import {
  getTabOrderKey,
  moveSessionOrder,
  moveSessionTabOrder,
  normalizeWorkspaceOrder,
  orderSessions,
  orderTabs,
  reorderSessionState,
  reorderSessionTabs
} from "../../src/frontend/workspace-order.js";

const buildTab = (index: number, name: string): TabState => ({
  index,
  name,
  active: index === 0,
  paneCount: 1,
  panes: [{
    index: 0,
    id: `%${name}`,
    currentCommand: "bash",
    active: true,
    width: 120,
    height: 40,
    zoomed: false,
    currentPath: "/tmp"
  }]
});

const buildSession = (name: string, tabs: TabState[]): SessionState => ({
  name,
  attached: false,
  tabCount: tabs.length,
  tabs
});

describe("workspace order helpers", () => {
  test("normalizes persisted state", () => {
    expect(normalizeWorkspaceOrder({
      sessions: ["work", "main"],
      tabsBySession: { main: ["1:logs"] }
    })).toEqual({
      sessions: ["work", "main"],
      tabsBySession: { main: ["1:logs"] }
    });
  });

  test("orders sessions and tabs from persisted preferences", () => {
    const sessions = [
      buildSession("main", [buildTab(0, "shell"), buildTab(1, "logs")]),
      buildSession("work", [buildTab(0, "editor")])
    ];
    const orderedSessions = orderSessions(sessions, {
      sessions: ["work", "main"],
      tabsBySession: {
        main: [getTabOrderKey(buildTab(1, "logs")), getTabOrderKey(buildTab(0, "shell"))]
      }
    });

    expect(orderedSessions.map((session) => session.name)).toEqual(["work", "main"]);
    expect(orderTabs("main", sessions[0].tabs, {
      sessions: [],
      tabsBySession: {
        main: ["1:logs", "0:shell"]
      }
    }).map((tab) => tab.name)).toEqual(["logs", "shell"]);
  });

  test("reorders session and tab preferences immutably", () => {
    const state = {
      sessions: ["main", "work", "ops"],
      tabsBySession: {
        main: ["0:shell", "1:logs"]
      }
    };

    expect(reorderSessionState(state, "ops", "main").sessions).toEqual(["ops", "main", "work"]);
    expect(reorderSessionTabs(state, "main", "1:logs", "0:shell").tabsBySession.main).toEqual([
      "1:logs",
      "0:shell"
    ]);
  });

  test("moves sessions and tabs one step at a time", () => {
    const state = {
      sessions: ["main", "work", "ops"],
      tabsBySession: {
        main: ["0:shell", "1:logs", "2:ops"]
      }
    };

    expect(moveSessionOrder(state, "work", -1).sessions).toEqual(["work", "main", "ops"]);
    expect(moveSessionOrder(state, "main", -1).sessions).toEqual(["main", "work", "ops"]);
    expect(moveSessionTabOrder(state, "main", "1:logs", 1).tabsBySession.main).toEqual([
      "0:shell",
      "2:ops",
      "1:logs"
    ]);
    expect(moveSessionTabOrder(state, "main", "2:ops", 1).tabsBySession.main).toEqual([
      "0:shell",
      "1:logs",
      "2:ops"
    ]);
  });
});

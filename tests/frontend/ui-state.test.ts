import { describe, expect, test } from "vitest";
import type { SessionState } from "../../src/shared/protocol.js";
import {
  inferAttachedSessionFromWorkspace,
  isAwaitingSessionAttachment,
  isAwaitingSessionSelection,
  resolveActiveSession,
  shouldUsePaneViewportCols
} from "../../src/frontend/ui-state.js";

const buildSession = (name: string, attached = false): SessionState => ({
  name,
  attached,
  tabCount: 1,
  tabs: [
    {
      index: 0,
      name: "shell",
      active: true,
      paneCount: 1,
      panes: [
        {
          index: 0,
          id: `%${name}`,
          currentCommand: "bash",
          active: true,
          width: 120,
          height: 40,
          zoomed: false,
          currentPath: "/tmp"
        }
      ]
    }
  ]
});

describe("frontend ui state helpers", () => {
  test("treats session picker without an attached session as awaiting selection", () => {
    expect(isAwaitingSessionSelection([{ name: "work" }], "")).toBe(true);
    expect(isAwaitingSessionSelection([{ name: "work" }], "work")).toBe(false);
    expect(isAwaitingSessionSelection(null, "")).toBe(false);
  });

  test("does not fall back to another attached session while picker is open", () => {
    const sessions = [buildSession("main"), buildSession("work", true)];
    expect(resolveActiveSession(sessions, "", true)).toBeUndefined();
  });

  test("does not fall back to another session while attach is still pending", () => {
    const sessions = [buildSession("main"), buildSession("work", true)];
    expect(resolveActiveSession(sessions, "", false, true)).toBeUndefined();
  });

  test("still resolves the attached session when picker is not blocking selection", () => {
    const sessions = [buildSession("main"), buildSession("work", true)];
    expect(resolveActiveSession(sessions, "", false)?.name).toBe("work");
  });

  test("prefers the client view session over backend attached markers", () => {
    const sessions = [buildSession("main"), buildSession("work", true)];
    expect(resolveActiveSession(sessions, "", false, false, {
      sessionName: "main",
      tabIndex: 0,
      paneId: "%main",
      followBackendFocus: false
    })?.name).toBe("main");
  });

  test("treats pending session creation as awaiting attachment until attached lands", () => {
    expect(isAwaitingSessionAttachment("pending", "")).toBe(true);
    expect(isAwaitingSessionAttachment("pending", "pending")).toBe(false);
    expect(isAwaitingSessionAttachment(null, "")).toBe(false);
  });

  test("infers attached session from client view when workspace has already converged", () => {
    const sessions = [buildSession("main"), buildSession("work", true)];
    expect(
      inferAttachedSessionFromWorkspace(sessions, {
        sessionName: "main",
        tabIndex: 0,
        paneId: "%main",
        followBackendFocus: false
      })
    ).toBe("main");
  });

  test("does not infer an attached session from stale client view data", () => {
    const sessions = [buildSession("main"), buildSession("work", true)];
    expect(
      inferAttachedSessionFromWorkspace(sessions, {
        sessionName: "missing",
        tabIndex: 0,
        paneId: "%missing",
        followBackendFocus: false
      })
    ).toBe("");
  });

  test("uses real pane viewport sizing for zellij only", () => {
    expect(shouldUsePaneViewportCols("zellij")).toBe(true);
    expect(shouldUsePaneViewportCols("tmux")).toBe(false);
    expect(shouldUsePaneViewportCols("conpty")).toBe(false);
    expect(shouldUsePaneViewportCols(undefined)).toBe(false);
  });
});

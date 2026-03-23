import { describe, expect, test } from "vitest";
import { deriveContext, formatContext } from "../../src/frontend/context-label";
import type { TmuxPaneState } from "../../src/shared/protocol";

const makePane = (overrides: Partial<TmuxPaneState> = {}): TmuxPaneState => ({
  index: 0,
  id: "%0",
  currentCommand: "bash",
  active: true,
  width: 120,
  height: 40,
  zoomed: false,
  currentPath: "/Users/user/dev/remux",
  ...overrides
});

describe("deriveContext", () => {
  test("extracts project name from workspace marker path", () => {
    const ctx = deriveContext([makePane({ currentPath: "/Users/user/dev/remux/src" })]);
    expect(ctx).toEqual({ project: "remux", activity: "" });
  });

  test("uses last path component when no marker found", () => {
    const ctx = deriveContext([makePane({ currentPath: "/opt/services/my-app/logs" })]);
    expect(ctx).toEqual({ project: "logs", activity: "" });
  });

  test("shows activity for non-shell commands", () => {
    const ctx = deriveContext([makePane({ currentCommand: "vim", currentPath: "/Users/user/dev/remux" })]);
    expect(ctx).toEqual({ project: "remux", activity: "vim" });
  });

  test("hides activity for shell commands", () => {
    const ctx = deriveContext([makePane({ currentCommand: "zsh", currentPath: "/Users/user/dev/remux" })]);
    expect(ctx).toEqual({ project: "remux", activity: "" });
  });

  test("returns tilde for short home-like paths", () => {
    const ctx = deriveContext([makePane({ currentPath: "/Users/user" })]);
    expect(ctx).toEqual({ project: "~", activity: "" });
  });

  test("returns slash for root", () => {
    const ctx = deriveContext([makePane({ currentPath: "/" })]);
    expect(ctx).toEqual({ project: "/", activity: "" });
  });

  test("returns null for empty panes array", () => {
    expect(deriveContext([])).toBeNull();
  });

  test("uses active pane when multiple panes exist", () => {
    const panes = [
      makePane({ active: false, currentPath: "/tmp" }),
      makePane({ active: true, currentPath: "/Users/user/dev/my-project", currentCommand: "npm" })
    ];
    const ctx = deriveContext(panes);
    expect(ctx).toEqual({ project: "my-project", activity: "npm" });
  });
});

describe("formatContext", () => {
  test("returns empty string for null", () => {
    expect(formatContext(null)).toBe("");
  });

  test("shows only project when no activity", () => {
    expect(formatContext({ project: "remux", activity: "" })).toBe("remux");
  });

  test("shows activity and project together", () => {
    expect(formatContext({ project: "remux", activity: "vim" })).toBe("vim · remux");
  });
});

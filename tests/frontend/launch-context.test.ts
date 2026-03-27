import { describe, expect, test } from "vitest";
import { buildControlAuthHint, parseLaunchContext } from "../../src/frontend/launch-context.js";

describe("frontend launch context", () => {
  test("parses session, tab, and pane hints from the URL", () => {
    expect(parseLaunchContext(new URLSearchParams("session=work&tab=2&pane=%252"))).toEqual({
      session: "work",
      tabIndex: 2,
      paneId: "%2"
    });
  });

  test("ignores invalid tab hint and requires a session", () => {
    expect(parseLaunchContext(new URLSearchParams("tab=abc&pane=%252"))).toBeNull();
    expect(parseLaunchContext(new URLSearchParams("session=work&tab=-1"))).toEqual({
      session: "work"
    });
  });

  test("prefers initial launch context and otherwise falls back to attached session", () => {
    expect(buildControlAuthHint("main", { session: "work", tabIndex: 2, paneId: "%2" }, { cols: 140, rows: 40 })).toEqual({
      session: "work",
      tabIndex: 2,
      paneId: "%2",
      cols: 140,
      rows: 40
    });
    expect(buildControlAuthHint("main", null, { cols: 132, rows: 38 })).toEqual({
      session: "main",
      cols: 132,
      rows: 38
    });
    expect(buildControlAuthHint("", null)).toBeNull();
  });

  test("still includes terminal dimensions before a session is attached", () => {
    expect(buildControlAuthHint("", null, { cols: 128, rows: 36 })).toEqual({
      cols: 128,
      rows: 36
    });
  });
});

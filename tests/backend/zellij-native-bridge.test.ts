import { describe, expect, test } from "vitest";

import {
  compareZellijVersions,
  isSupportedZellijVersion,
  parseZellijBridgeEventLine,
  parseZellijVersion
} from "../../src/backend/zellij/native-bridge.js";

describe("zellij native bridge helpers", () => {
  test("parses zellij semantic versions from CLI output", () => {
    expect(parseZellijVersion("zellij 0.44.0")).toEqual({
      major: 0,
      minor: 44,
      patch: 0
    });
    expect(parseZellijVersion("0.44.3")).toEqual({
      major: 0,
      minor: 44,
      patch: 3
    });
    expect(parseZellijVersion("zellij dev-build")).toBeNull();
  });

  test("compares versions and enforces the native bridge minimum", () => {
    const min = parseZellijVersion("0.44.0");
    const older = parseZellijVersion("0.43.9");
    const newer = parseZellijVersion("0.44.1");

    expect(min).not.toBeNull();
    expect(older).not.toBeNull();
    expect(newer).not.toBeNull();

    expect(compareZellijVersions(older!, min!)).toBeLessThan(0);
    expect(compareZellijVersions(newer!, min!)).toBeGreaterThan(0);
    expect(isSupportedZellijVersion(min!)).toBe(true);
    expect(isSupportedZellijVersion(older!)).toBe(false);
  });

  test("parses pane render bridge events", () => {
    expect(parseZellijBridgeEventLine(JSON.stringify({
      type: "pane_render",
      paneId: "terminal_2",
      viewport: ["one", "two"],
      scrollback: ["zero"],
      isInitial: true
    }))).toEqual({
      type: "pane_render",
      paneId: "terminal_2",
      viewport: ["one", "two"],
      scrollback: ["zero"],
      isInitial: true
    });

    expect(parseZellijBridgeEventLine(JSON.stringify({
      type: "hello",
      version: "0.1.0",
      zellijVersion: "0.44.0"
    }))).toEqual({
      type: "hello",
      version: "0.1.0",
      zellijVersion: "0.44.0"
    });
  });

  test("rejects malformed or unknown bridge events", () => {
    expect(() => parseZellijBridgeEventLine("not-json")).toThrow(/invalid/i);
    expect(() => parseZellijBridgeEventLine(JSON.stringify({
      type: "pane_render",
      paneId: "terminal_1",
      viewport: "oops"
    }))).toThrow(/invalid/i);
    expect(() => parseZellijBridgeEventLine(JSON.stringify({
      type: "mystery"
    }))).toThrow(/unknown/i);
  });
});

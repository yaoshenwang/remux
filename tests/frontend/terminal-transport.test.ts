import { describe, expect, test } from "vitest";
import {
  decodeTerminalPatchData,
  parseTerminalPatchMessage,
  shouldApplyTerminalPatch,
} from "../../src/frontend/terminal-transport.js";

describe("terminal transport helpers", () => {
  test("parses a valid terminal_patch payload and decodes its bytes", () => {
    const payload = JSON.stringify({
      type: "terminal_patch",
      paneId: "pane-1",
      viewRevision: 2,
      revision: 7,
      baseRevision: 6,
      reset: true,
      source: "snapshot",
      dataBase64: "aGVsbG8NCg==",
    });

    const message = parseTerminalPatchMessage(payload);
    expect(message).toMatchObject({
      type: "terminal_patch",
      paneId: "pane-1",
      viewRevision: 2,
      revision: 7,
      baseRevision: 6,
      reset: true,
      source: "snapshot",
    });
    expect(new TextDecoder().decode(decodeTerminalPatchData(message!))).toBe("hello\r\n");
  });

  test("rejects malformed or unrelated text frames", () => {
    expect(parseTerminalPatchMessage("plain terminal output")).toBeNull();
    expect(parseTerminalPatchMessage("{")).toBeNull();
    expect(parseTerminalPatchMessage(JSON.stringify({ type: "ping" }))).toBeNull();
    expect(parseTerminalPatchMessage(JSON.stringify({
      type: "terminal_patch",
      paneId: "pane-1",
      viewRevision: 1,
      revision: 2,
      reset: false,
      source: "stream",
    }))).toBeNull();
  });

  test("applies patches only when the tagged view revision matches the active view", () => {
    const message = parseTerminalPatchMessage(JSON.stringify({
      type: "terminal_patch",
      paneId: "pane-1",
      viewRevision: 3,
      revision: 9,
      baseRevision: 8,
      reset: false,
      source: "stream",
      dataBase64: "QQ==",
    }));

    expect(message).not.toBeNull();
    expect(shouldApplyTerminalPatch(message!, 3)).toBe(true);
    expect(shouldApplyTerminalPatch(message!, 2)).toBe(false);
  });
});

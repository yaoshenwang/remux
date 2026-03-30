import { describe, expect, test } from "vitest";
import {
  buildTerminalPatchDropDiagnostic,
  decodeTerminalPatchData,
  parseTerminalPatchMessage,
  resolveTerminalBaseRevision,
  resolveTerminalPatchDisposition,
  shouldApplyTerminalPatch,
} from "../../src/frontend/terminal-transport.js";

describe("terminal transport helpers", () => {
  test("parses a valid terminal_patch payload and decodes its bytes", () => {
    const payload = JSON.stringify({
      type: "terminal_patch",
      paneId: "pane-1",
      epoch: 3,
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
      epoch: 3,
      viewRevision: 2,
      revision: 7,
      baseRevision: 6,
      reset: true,
      source: "snapshot",
    });
    expect(new TextDecoder().decode(decodeTerminalPatchData(message!))).toBe("hello\r\n");
  });

  test("parses a structured terminal_patch payload without legacy dataBase64", () => {
    const payload = JSON.stringify({
      type: "terminal_patch",
      paneId: "pane-structured",
      epoch: 9,
      viewRevision: 4,
      revision: 11,
      baseRevision: 10,
      reset: false,
      source: "stream",
      payload: {
        encoding: "base64_chunks_v1",
        chunksBase64: ["aGVsbG8=", "DQp3b3JsZA=="],
      },
    });

    const message = parseTerminalPatchMessage(payload);
    expect(message).toMatchObject({
      type: "terminal_patch",
      paneId: "pane-structured",
      epoch: 9,
      viewRevision: 4,
      revision: 11,
      baseRevision: 10,
      reset: false,
      source: "stream",
      payload: {
        encoding: "base64_chunks_v1",
        chunksBase64: ["aGVsbG8=", "DQp3b3JsZA=="],
      },
    });
    expect(new TextDecoder().decode(decodeTerminalPatchData(message!))).toBe("hello\r\nworld");
  });

  test("prefers structured payload chunks over legacy dataBase64 when both are present", () => {
    const payload = JSON.stringify({
      type: "terminal_patch",
      paneId: "pane-dual",
      epoch: 9,
      viewRevision: 4,
      revision: 11,
      baseRevision: 10,
      reset: false,
      source: "stream",
      dataBase64: "TEVHQUNZ",
      payload: {
        encoding: "base64_chunks_v1",
        chunksBase64: ["U1RSVUNUVVJFRA=="],
      },
    });

    const message = parseTerminalPatchMessage(payload);
    expect(message).not.toBeNull();
    expect(new TextDecoder().decode(decodeTerminalPatchData(message!))).toBe("STRUCTURED");
  });

  test("rejects malformed or unrelated text frames", () => {
    expect(parseTerminalPatchMessage("plain terminal output")).toBeNull();
    expect(parseTerminalPatchMessage("{")).toBeNull();
    expect(parseTerminalPatchMessage(JSON.stringify({ type: "ping" }))).toBeNull();
    expect(parseTerminalPatchMessage(JSON.stringify({
      type: "terminal_patch",
      paneId: "pane-1",
      epoch: 1,
      viewRevision: 1,
      revision: 2,
      baseRevision: 1,
      reset: false,
      source: "stream",
      payload: {
        encoding: "base64_chunks_v1",
        chunksBase64: [123],
      },
    }))).toBeNull();
    expect(parseTerminalPatchMessage(JSON.stringify({
      type: "terminal_patch",
      paneId: "pane-1",
      epoch: 1,
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
      epoch: 4,
      viewRevision: 3,
      revision: 9,
      baseRevision: 8,
      reset: false,
      source: "stream",
      dataBase64: "QQ==",
    }));

    expect(message).not.toBeNull();
    expect(shouldApplyTerminalPatch(message!, 3, 4, 8)).toBe(true);
    expect(shouldApplyTerminalPatch(message!, 2, 4, 8)).toBe(false);
  });

  test("rejects stream patches when the base revision does not match the local terminal state", () => {
    const message = parseTerminalPatchMessage(JSON.stringify({
      type: "terminal_patch",
      paneId: "pane-1",
      epoch: 4,
      viewRevision: 3,
      revision: 9,
      baseRevision: 7,
      reset: false,
      source: "stream",
      dataBase64: "QQ==",
    }));

    expect(message).not.toBeNull();
    expect(resolveTerminalPatchDisposition(message!, 3, 4, 8)).toEqual({
      apply: false,
      reason: "revision_gap",
    });
  });

  test("rejects stream patches when the transport epoch no longer matches the local terminal state", () => {
    const message = parseTerminalPatchMessage(JSON.stringify({
      type: "terminal_patch",
      paneId: "pane-1",
      epoch: 7,
      viewRevision: 3,
      revision: 9,
      baseRevision: 8,
      reset: false,
      source: "stream",
      dataBase64: "QQ==",
    }));

    expect(message).not.toBeNull();
    expect(resolveTerminalPatchDisposition(message!, 3, 6, 8)).toEqual({
      apply: false,
      reason: "epoch_gap",
    });
  });

  test("accepts reset patches even when the previous revision is unknown", () => {
    const message = parseTerminalPatchMessage(JSON.stringify({
      type: "terminal_patch",
      paneId: "pane-1",
      epoch: 5,
      viewRevision: 4,
      revision: 12,
      baseRevision: null,
      reset: true,
      source: "snapshot",
      dataBase64: "QQ==",
    }));

    expect(message).not.toBeNull();
    expect(resolveTerminalPatchDisposition(message!, 4, null, null)).toEqual({
      apply: true,
      reason: "ok",
    });
  });

  test("reuses the last applied revision only when it matches the active view", () => {
    expect(resolveTerminalBaseRevision(3, 3, 9)).toBe(9);
    expect(resolveTerminalBaseRevision(4, 3, 9)).toBeUndefined();
    expect(resolveTerminalBaseRevision(3, 3, null)).toBeUndefined();
  });

  test("builds a client diagnostic payload for dropped terminal patches", () => {
    const message = parseTerminalPatchMessage(JSON.stringify({
      type: "terminal_patch",
      paneId: "pane-1",
      epoch: 7,
      viewRevision: 5,
      revision: 13,
      baseRevision: 12,
      reset: false,
      source: "stream",
      dataBase64: "QQ==",
      cols: 132,
      rows: 40,
    }));

    expect(message).not.toBeNull();
    expect(buildTerminalPatchDropDiagnostic(message!, "revision_gap", 5, 7)).toMatchObject({
      issue: "revision_mismatch",
      severity: "error",
      status: "open",
      sample: {
        viewRevision: 5,
        terminalEpoch: 7,
        backendCols: 132,
        backendRows: 40,
      },
      recentSamples: expect.arrayContaining([
        expect.objectContaining({
          viewRevision: 5,
          terminalEpoch: 7,
          backendCols: 132,
          backendRows: 40,
        }),
      ]),
    });
  });
});

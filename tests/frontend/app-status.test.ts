import { describe, expect, test } from "vitest";
import { deriveTopStatus, formatBytes } from "../../src/frontend/app-status.js";

describe("deriveTopStatus", () => {
  test("prefers explicit error state", () => {
    expect(deriveTopStatus({
      authReady: true,
      awaitingSessionAttachment: false,
      awaitingSessionSelection: false,
      errorMessage: "boom",
      pendingSessionAttachment: null,
      statusMessage: "connected"
    })).toEqual({ kind: "error", label: "boom" });
  });

  test("shows pending attachment status", () => {
    expect(deriveTopStatus({
      authReady: false,
      awaitingSessionAttachment: true,
      awaitingSessionSelection: false,
      errorMessage: "",
      pendingSessionAttachment: "main",
      statusMessage: ""
    })).toEqual({ kind: "pending", label: "attaching: main" });
  });

  test("classifies reconnect as warning", () => {
    expect(deriveTopStatus({
      authReady: true,
      awaitingSessionAttachment: false,
      awaitingSessionSelection: false,
      errorMessage: "",
      pendingSessionAttachment: null,
      statusMessage: "reconnecting in 1s..."
    })).toEqual({ kind: "warn", label: "reconnecting in 1s..." });
  });

  test("falls back to connected when authed and idle", () => {
    expect(deriveTopStatus({
      authReady: true,
      awaitingSessionAttachment: false,
      awaitingSessionSelection: false,
      errorMessage: "",
      pendingSessionAttachment: null,
      statusMessage: ""
    })).toEqual({ kind: "ok", label: "connected" });
  });
});

describe("formatBytes", () => {
  test("formats byte units compactly", () => {
    expect(formatBytes(12)).toBe("12B");
    expect(formatBytes(1536)).toBe("1.5KB");
    expect(formatBytes(1048576)).toBe("1.0MB");
  });
});

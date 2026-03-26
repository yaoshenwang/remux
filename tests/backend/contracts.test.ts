/**
 * Contract tests for protocol domain types and ServerCapabilities.
 *
 * These tests verify the structural contracts that clients (web, iOS, future)
 * depend on. Breaking a contract test means a protocol change that could
 * break native clients.
 */

import { describe, expect, it } from "vitest";
import {
  PROTOCOL_VERSION,
  type ServerCapabilities,
  type RemuxMessageEnvelope,
  type WorkspaceCapabilities,
  type NotificationCapabilities,
  type TransportCapabilities,
  type SemanticCapabilitySummary,
  type SemanticAdapterHealthSummary
} from "../../src/shared/contracts/core.js";
import type {
  SessionSummary,
  PaneState,
  TabState,
  SessionState,
  WorkspaceSnapshot,
  BackendCapabilities,
  ClientView,
  TabHistoryEvent,
  TabHistoryPane
} from "../../src/shared/contracts/workspace.js";
import type {
  SemanticCapabilities,
  SemanticSessionState,
  SemanticEvent,
  SemanticAdapterMode
} from "../../src/shared/contracts/semantic.js";
import type {
  DeviceIdentity,
  PairingState,
  TrustState
} from "../../src/shared/contracts/device.js";
import type {
  TerminalOpenPayload,
  TerminalResizePayload,
  TerminalClosedPayload
} from "../../src/shared/contracts/terminal.js";

// ── Protocol version ──

describe("protocol version", () => {
  it("should be a positive integer", () => {
    expect(Number.isInteger(PROTOCOL_VERSION)).toBe(true);
    expect(PROTOCOL_VERSION).toBeGreaterThan(0);
  });

  it("should be 1 for the initial version", () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});

// ── ServerCapabilities contract ──

describe("ServerCapabilities contract", () => {
  const validCapabilities: ServerCapabilities = {
    protocolVersion: 1,
    workspace: {
      supportsPaneFocusById: true,
      supportsTabRename: true,
      supportsSessionRename: true,
      supportsPreciseScrollback: true,
      supportsFloatingPanes: false,
      supportsFullscreenPane: true,
      supportsUpload: true,
      supportsTerminalSnapshots: true,
    },
    notifications: {
      supportsPushNotifications: false,
    },
    transport: {
      supportsTrustedReconnect: false,
      supportsPairingBootstrap: false,
      supportsDeviceIdentity: false,
    },
    semantic: {
      adaptersAvailable: [],
      adapterHealth: [],
      supportsEventStream: false,
    },
  };

  it("should have all required top-level fields", () => {
    expect(validCapabilities).toHaveProperty("protocolVersion");
    expect(validCapabilities).toHaveProperty("workspace");
    expect(validCapabilities).toHaveProperty("notifications");
    expect(validCapabilities).toHaveProperty("transport");
    expect(validCapabilities).toHaveProperty("semantic");
  });

  it("workspace capabilities should include upload support", () => {
    expect(validCapabilities.workspace).toHaveProperty("supportsUpload");
  });

  it("semantic capabilities should list available adapters", () => {
    expect(Array.isArray(validCapabilities.semantic.adaptersAvailable)).toBe(true);
    expect(Array.isArray(validCapabilities.semantic.adapterHealth)).toBe(true);
  });

  it("should be JSON-serializable", () => {
    const json = JSON.stringify(validCapabilities);
    const parsed = JSON.parse(json) as ServerCapabilities;
    expect(parsed).toEqual(validCapabilities);
  });
});

// ── RemuxMessageEnvelope contract ──

describe("RemuxMessageEnvelope contract", () => {
  it("should support all domain types", () => {
    const domains = ["core", "workspace", "terminal", "semantic", "notifications", "device"];
    for (const domain of domains) {
      const envelope: RemuxMessageEnvelope = {
        domain: domain as RemuxMessageEnvelope["domain"],
        type: "test",
        version: PROTOCOL_VERSION,
        emittedAt: new Date().toISOString(),
        payload: {},
      };
      expect(envelope.domain).toBe(domain);
    }
  });

  it("should include optional requestId", () => {
    const envelope: RemuxMessageEnvelope = {
      domain: "core",
      type: "hello",
      version: 1,
      requestId: "req-123",
      emittedAt: new Date().toISOString(),
      payload: { clientVersion: "1.0" },
    };
    expect(envelope.requestId).toBe("req-123");
  });
});

// ── Workspace domain contracts ──

describe("workspace domain contracts", () => {
  it("WorkspaceSnapshot should contain sessions and timestamp", () => {
    const snapshot: WorkspaceSnapshot = {
      sessions: [],
      capturedAt: new Date().toISOString(),
    };
    expect(snapshot.sessions).toEqual([]);
    expect(typeof snapshot.capturedAt).toBe("string");
  });

  it("SessionState should extend SessionSummary with tabs", () => {
    const session: SessionState = {
      name: "main",
      attached: true,
      tabCount: 1,
      tabs: [{
        index: 0,
        name: "bash",
        active: true,
        paneCount: 1,
        panes: [{
          index: 0,
          id: "%0",
          currentCommand: "bash",
          active: true,
          width: 80,
          height: 24,
          zoomed: false,
          currentPath: "/home/user",
        }],
      }],
    };
    expect(session.tabs).toHaveLength(1);
    expect(session.tabs[0].panes).toHaveLength(1);
  });

  it("ClientView should track navigation state", () => {
    const view: ClientView = {
      sessionName: "main",
      tabIndex: 0,
      paneId: "%0",
      followBackendFocus: true,
    };
    expect(view.followBackendFocus).toBe(true);
  });

  it("BackendCapabilities should be a subset of WorkspaceCapabilities", () => {
    const backend: BackendCapabilities = {
      supportsPaneFocusById: true,
      supportsTabRename: true,
      supportsSessionRename: true,
      supportsPreciseScrollback: true,
      supportsFloatingPanes: false,
      supportsFullscreenPane: true,
    };
    const workspace: WorkspaceCapabilities = {
      ...backend,
      supportsUpload: true,
      supportsTerminalSnapshots: true,
    };
    expect(workspace.supportsUpload).toBe(true);
    expect(workspace.supportsTerminalSnapshots).toBe(true);
    expect(workspace.supportsPaneFocusById).toBe(backend.supportsPaneFocusById);
  });
});

// ── Semantic domain contracts ──

describe("semantic domain contracts", () => {
  it("SemanticCapabilities should list all boolean flags", () => {
    const caps: SemanticCapabilities = {
      supportsThreads: false,
      supportsTurnHistory: false,
      supportsToolEvents: false,
      supportsApprovals: false,
      supportsImageAttachments: false,
      supportsGitActions: false,
      supportsWorktreeActions: false,
      supportsRuntimeModes: false,
      supportsReasoningControls: false,
      supportsFollowUpQueue: false,
    };
    const keys = Object.keys(caps);
    expect(keys).toHaveLength(10);
    for (const key of keys) {
      expect(typeof caps[key as keyof SemanticCapabilities]).toBe("boolean");
    }
  });

  it("SemanticEvent should have required fields", () => {
    const event: SemanticEvent = {
      adapterId: "codex",
      eventId: "evt-1",
      sessionId: "sess-1",
      kind: "tool_start",
      emittedAt: new Date().toISOString(),
      payload: { tool: "bash", command: "npm test" },
    };
    expect(event.kind).toBe("tool_start");
    expect(event.payload).toHaveProperty("tool");
  });

  it("SemanticAdapterMode should accept valid values", () => {
    const modes: SemanticAdapterMode[] = ["none", "passive", "active"];
    expect(modes).toHaveLength(3);
  });
});

// ── Device domain contracts ──

describe("device domain contracts", () => {
  it("DeviceIdentity should track platform", () => {
    const device: DeviceIdentity = {
      deviceId: "dev-1",
      deviceName: "iPhone 15",
      platform: "ios",
      firstSeenAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    };
    expect(device.platform).toBe("ios");
  });

  it("PairingState should support lifecycle transitions", () => {
    const states: PairingState["status"][] = ["pending", "paired", "expired", "revoked"];
    expect(states).toHaveLength(4);
  });

  it("TrustState should track grant time", () => {
    const trust: TrustState = {
      trusted: true,
      deviceId: "dev-1",
      grantedAt: new Date().toISOString(),
    };
    expect(trust.trusted).toBe(true);
    expect(trust.grantedAt).toBeDefined();
  });
});

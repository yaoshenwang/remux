import { describe, expect, test } from "vitest";
import { AdapterRegistry } from "../../src/backend/adapters/registry.js";
import { createGenericShellAdapter } from "../../src/backend/adapters/generic-shell-adapter.js";
import { buildServerCapabilities } from "../../src/backend/server/client-capabilities.js";
import { SemanticEventBroadcaster } from "../../src/backend/server/semantic-event-transport.js";
import type { BackendCapabilities } from "../../src/shared/contracts/workspace.js";

const backendCapabilities: BackendCapabilities = {
  supportsPaneFocusById: true,
  supportsTabRename: true,
  supportsSessionRename: true,
  supportsPreciseScrollback: true,
  supportsFloatingPanes: false,
  supportsFullscreenPane: true,
};

describe("buildServerCapabilities", () => {
  test("returns conservative defaults when optional transports are absent", () => {
    const capabilities = buildServerCapabilities({
      backendCapabilities,
      supportsUpload: true,
    });

    expect(capabilities.workspace.supportsUpload).toBe(true);
    expect(capabilities.workspace.supportsTerminalSnapshots).toBe(false);
    expect(capabilities.notifications.supportsPushNotifications).toBe(false);
    expect(capabilities.transport.supportsTrustedReconnect).toBe(false);
    expect(capabilities.transport.supportsPairingBootstrap).toBe(false);
    expect(capabilities.transport.supportsDeviceIdentity).toBe(false);
    expect(capabilities.semantic.adaptersAvailable).toEqual([]);
    expect(capabilities.semantic.adapterHealth).toEqual([]);
    expect(capabilities.semantic.supportsEventStream).toBe(false);
  });

  test("derives semantic and device capabilities from wired dependencies", () => {
    const registry = new AdapterRegistry();
    registry.register(createGenericShellAdapter());
    const semanticTransport = new SemanticEventBroadcaster();

    const capabilities = buildServerCapabilities({
      backendCapabilities,
      supportsUpload: true,
      notificationTransport: {
        supportsPushNotifications: () => true,
      },
      device: {
        identityStore: {},
        pairingService: {},
        trustedReconnectEnabled: false,
      },
      adapterRegistry: registry,
      semanticTransport,
    });

    expect(capabilities.workspace.supportsTerminalSnapshots).toBe(false);
    expect(capabilities.notifications.supportsPushNotifications).toBe(true);
    expect(capabilities.transport.supportsDeviceIdentity).toBe(true);
    expect(capabilities.transport.supportsPairingBootstrap).toBe(true);
    expect(capabilities.transport.supportsTrustedReconnect).toBe(false);
    expect(capabilities.semantic.adaptersAvailable).toEqual(["generic-shell"]);
    expect(capabilities.semantic.adapterHealth).toEqual([
      { adapterId: "generic-shell", available: true, healthy: true },
    ]);
    expect(capabilities.semantic.supportsEventStream).toBe(true);
  });

  test("marks terminal snapshots available when extensions are wired", () => {
    const capabilities = buildServerCapabilities({
      backendCapabilities,
      supportsUpload: true,
      extensions: {
        notificationRoutes: {} as never,
        onSessionCreated: () => {},
        onTerminalData: () => {},
        onSessionExit: () => {},
        onSessionResize: () => {},
        getSnapshot: () => null,
        getDiff: () => null,
        getScrollback: () => [],
        getGastownInfo: () => ({}),
        gastownDetected: false,
        getEventWatcher: () => {
          throw new Error("not implemented in test");
        },
        recordRawBytes: () => {},
        recordCompressedBytes: () => {},
        setRtt: () => {},
        getBandwidthStats: () => ({
          rawBytesPerSec: 0,
          compressedBytesPerSec: 0,
          savedPercent: 0,
          fullSnapshotsSent: 0,
          diffUpdatesSent: 0,
          avgChangedRowsPerDiff: 0,
          totalRawBytes: 0,
          totalCompressedBytes: 0,
          totalSavedBytes: 0,
          rttMs: null,
          protocol: "ws",
        }),
        dispose: () => {},
      },
    });

    expect(capabilities.workspace.supportsTerminalSnapshots).toBe(true);
  });
});

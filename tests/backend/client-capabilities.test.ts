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
        pairingBootstrapEnabled: true,
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

  test("keeps pairing bootstrap disabled until it is explicitly enabled", () => {
    const capabilities = buildServerCapabilities({
      backendCapabilities,
      supportsUpload: true,
      device: {
        identityStore: {},
        pairingService: {},
      },
    });

    expect(capabilities.transport.supportsPairingBootstrap).toBe(false);
  });

  test("marks terminal snapshots available when explicitly enabled", () => {
    const capabilities = buildServerCapabilities({
      backendCapabilities,
      supportsUpload: true,
      supportsTerminalSnapshots: true,
    });

    expect(capabilities.workspace.supportsTerminalSnapshots).toBe(true);
  });
});

import { PROTOCOL_VERSION, type ServerCapabilities } from "../../shared/contracts/core.js";
import type { BackendCapabilities } from "../../shared/contracts/workspace.js";

export interface DeviceCapabilityDependencies {
  identityStore?: unknown;
  trustStore?: unknown;
  pairingService?: unknown;
  pairingBootstrapEnabled?: boolean;
  pushRegistrationService?: unknown;
  trustedReconnectEnabled?: boolean;
}

export interface NotificationTransport {
  supportsPushNotifications(): boolean;
}

interface AdapterRegistrySummary {
  listAdapterIds(): string[];
  listAdapterHealth(): Array<{ adapterId: string; available: boolean; healthy: boolean }>;
}

interface SemanticTransportSummary {
  supportsEventStream?(): boolean;
}

export interface BuildServerCapabilitiesOptions {
  backendCapabilities: BackendCapabilities;
  supportsUpload: boolean;
  supportsTerminalSnapshots?: boolean;
  notificationTransport?: NotificationTransport;
  device?: DeviceCapabilityDependencies;
  adapterRegistry?: AdapterRegistrySummary;
  semanticTransport?: SemanticTransportSummary;
}

export const buildServerCapabilities = (
  options: BuildServerCapabilitiesOptions,
): ServerCapabilities => {
  const adapterRegistry = options.adapterRegistry;
  const adaptersAvailable = adapterRegistry?.listAdapterIds() ?? [];
  const adapterHealth = adapterRegistry?.listAdapterHealth() ?? [];

  return {
    protocolVersion: PROTOCOL_VERSION,
    workspace: {
      ...options.backendCapabilities,
      supportsUpload: options.supportsUpload,
      supportsTerminalSnapshots: Boolean(options.supportsTerminalSnapshots),
    },
    notifications: {
      supportsPushNotifications: options.notificationTransport?.supportsPushNotifications() ?? false,
    },
    transport: {
      supportsTrustedReconnect: Boolean(
        options.device?.trustedReconnectEnabled
          && options.device.identityStore
          && options.device.trustStore,
      ),
      supportsPairingBootstrap: Boolean(
        options.device?.pairingBootstrapEnabled
          && options.device?.pairingService,
      ),
      supportsDeviceIdentity: Boolean(options.device?.identityStore),
    },
    semantic: {
      adaptersAvailable,
      adapterHealth,
      supportsEventStream: options.semanticTransport?.supportsEventStream?.() ?? Boolean(options.semanticTransport),
    },
  };
};

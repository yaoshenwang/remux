import { PROTOCOL_VERSION, type ServerCapabilities } from "../../shared/contracts/core.js";
import type { BackendCapabilities } from "../../shared/contracts/workspace.js";
import type { AdapterRegistry } from "../adapters/registry.js";
import type { Extensions } from "../extensions.js";
import type { SemanticEventTransport } from "./semantic-event-transport.js";

export interface DeviceCapabilityDependencies {
  identityStore?: unknown;
  trustStore?: unknown;
  pairingService?: unknown;
  pushRegistrationService?: unknown;
  trustedReconnectEnabled?: boolean;
}

export interface NotificationTransport {
  supportsPushNotifications(): boolean;
}

export interface BuildServerCapabilitiesOptions {
  backendCapabilities: BackendCapabilities;
  supportsUpload: boolean;
  extensions?: Extensions;
  notificationTransport?: NotificationTransport;
  device?: DeviceCapabilityDependencies;
  adapterRegistry?: Pick<AdapterRegistry, "listAdapterIds" | "listAdapterHealth">;
  semanticTransport?: SemanticEventTransport;
}

export const buildServerCapabilities = (
  options: BuildServerCapabilitiesOptions,
): ServerCapabilities => {
  const adapterRegistry = options.adapterRegistry;
  const adaptersAvailable = adapterRegistry?.listAdapterIds() ?? [];
  const adapterHealth = adapterRegistry?.listAdapterHealth() ?? [];
  const notificationTransport = options.notificationTransport;
  const supportsPushNotifications = notificationTransport
    ? notificationTransport.supportsPushNotifications()
    : Boolean(options.extensions);

  return {
    protocolVersion: PROTOCOL_VERSION,
    workspace: {
      ...options.backendCapabilities,
      supportsUpload: options.supportsUpload,
      supportsTerminalSnapshots: Boolean(options.extensions),
    },
    notifications: {
      supportsPushNotifications,
    },
    transport: {
      supportsTrustedReconnect: Boolean(
        options.device?.trustedReconnectEnabled
          && options.device.identityStore
          && options.device.trustStore,
      ),
      supportsPairingBootstrap: Boolean(options.device?.pairingService),
      supportsDeviceIdentity: Boolean(options.device?.identityStore),
    },
    semantic: {
      adaptersAvailable,
      adapterHealth,
      supportsEventStream: Boolean(options.semanticTransport),
    },
  };
};

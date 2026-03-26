// ── Core domain types ──

import type { BackendCapabilities } from "./workspace.js";

/** Protocol version. Increment on breaking changes. */
export const PROTOCOL_VERSION = 1;

// ── Server capabilities ──

export interface WorkspaceCapabilities extends BackendCapabilities {
  supportsUpload: boolean;
}

export interface NotificationCapabilities {
  supportsPushNotifications: boolean;
}

export interface TransportCapabilities {
  supportsTrustedReconnect: boolean;
  supportsPairingBootstrap: boolean;
  supportsDeviceIdentity: boolean;
}

export interface SemanticAdapterHealthSummary {
  adapterId: string;
  available: boolean;
  healthy: boolean;
}

export interface SemanticCapabilitySummary {
  adaptersAvailable: string[];
  adapterHealth: SemanticAdapterHealthSummary[];
  supportsEventStream: boolean;
}

export interface ServerCapabilities {
  protocolVersion: number;
  workspace: WorkspaceCapabilities;
  notifications: NotificationCapabilities;
  transport: TransportCapabilities;
  semantic: SemanticCapabilitySummary;
}

// ── Message envelope ──

export type MessageDomain =
  | "core"
  | "workspace"
  | "terminal"
  | "semantic"
  | "notifications"
  | "device";

export interface RemuxMessageEnvelope<TPayload = unknown> {
  domain: MessageDomain;
  type: string;
  version: number;
  requestId?: string;
  emittedAt: string;
  payload: TPayload;
}

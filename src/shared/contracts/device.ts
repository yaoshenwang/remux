// ── Device domain types ──
// Types for device identity, pairing, and trust.

export interface DeviceIdentity {
  deviceId: string;
  deviceName: string;
  platform: "ios" | "android" | "web" | "unknown";
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface PairingState {
  status: "pending" | "paired" | "expired" | "revoked";
  pairingCode?: string;
  expiresAt?: string;
  deviceId?: string;
}

export interface TrustState {
  trusted: boolean;
  deviceId: string;
  grantedAt?: string;
  expiresAt?: string;
}

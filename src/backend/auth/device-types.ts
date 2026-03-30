export type DeviceTrustLevel = "trusted" | "revoked";

export interface DeviceIdentity {
  deviceId: string;
  publicKey: string;
  displayName: string;
  platform: string;
  lastSeenAt: string;
  trustLevel: DeviceTrustLevel;
  revokedAt?: string | null;
  revokeReason?: string | null;
}

export interface PairingSession {
  pairingSessionId: string;
  token: string;
  expiresAt: string;
  redeemed: boolean;
  redeemedBy: string | null;
  redeemedAt?: string | null;
  expiredAt?: string | null;
}

export interface PairingPayloadV2 {
  url: string;
  token: string;
  pairingSessionId: string;
  expiresAt: string;
  protocolVersion: 2;
  serverVersion: string;
}

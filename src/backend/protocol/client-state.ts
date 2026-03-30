export const CLIENT_MODES = ["active", "observer"] as const;

export type ClientMode = (typeof CLIENT_MODES)[number];

export interface ConnectedClientInfo {
  clientId: string;
  connectTime: string;
  deviceName: string;
  platform: string;
  lastActivityAt: string;
  mode: ClientMode;
}

export interface ClientsChangedPayload {
  selfClientId: string;
  clients: ConnectedClientInfo[];
}

export const normalizeClientMode = (value: unknown): ClientMode => {
  return value === "observer" ? "observer" : "active";
};

export const normalizeClientPlatform = (value: unknown): string => {
  if (typeof value !== "string") {
    return "unknown";
  }

  const normalized = value.trim().toLowerCase();
  return normalized ? normalized.slice(0, 32) : "unknown";
};

export const normalizeDeviceName = (value: unknown, platform: string): string => {
  if (typeof value === "string") {
    const normalized = value.trim();
    if (normalized) {
      return normalized.slice(0, 80);
    }
  }

  if (platform === "web") {
    return "This Browser";
  }

  return "Unknown Device";
};

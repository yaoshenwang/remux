import crypto from "node:crypto";
import { randomToken } from "../util/random.js";
import { DeviceStore } from "./device-store.js";
import type { DeviceIdentity, PairingPayloadV2, PairingSession } from "./device-types.js";

export interface AuthPayload {
  token?: string;
  password?: string;
  resumeToken?: string;
  /** Set by middleware when request arrived through an Entra-authenticated tunnel. */
  tunnelAuthenticated?: boolean;
}

export interface AuthServiceOptions {
  password?: string;
  token?: string;
  /**
   * When true, skip password verification for requests that arrived
   * through an Entra-authenticated DevTunnel. The token is still required.
   */
  trustEntraTunnel?: boolean;
  deviceStore?: DeviceStore;
}

export interface AuthVerifyResult {
  ok: boolean;
  reason?: string;
  device?: DeviceIdentity;
}

interface ResumeTokenPayload {
  deviceId: string;
  exp: number;
  iat: number;
}

interface CreatePairingSessionOptions {
  ttlMs?: number;
  baseUrl: string;
  serverVersion?: string;
}

interface RedeemPairingSessionInput {
  pairingSessionId: string;
  token: string;
  publicKey: string;
  displayName?: string;
  platform?: string;
}

interface PairingSessionResult {
  session: PairingSession;
  payload: PairingPayloadV2;
}

interface RedeemPairingSessionResult {
  device: DeviceIdentity;
  resumeToken: string;
  expiresAt: string;
}

const DEFAULT_PAIRING_TTL_MS = 5 * 60 * 1000;
const DEFAULT_RESUME_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SERVER_SECRET_METADATA_KEY = "server_secret";

const safeEqual = (a: string, b: string): boolean => {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
};

export class DeviceTrustError extends Error {
  public readonly code: string;
  public readonly statusCode: number;

  public constructor(message: string, code: string, statusCode: number) {
    super(message);
    this.name = "DeviceTrustError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class AuthService {
  public readonly token: string;
  private readonly password?: string;
  private readonly trustEntraTunnel: boolean;
  private readonly deviceStore: DeviceStore;
  private readonly serverSecret: string;

  public constructor(options?: string | AuthServiceOptions) {
    if (typeof options === "string" || options === undefined) {
      // Backward-compatible: single password argument.
      this.password = options;
      this.token = randomToken();
      this.trustEntraTunnel = false;
      this.deviceStore = new DeviceStore(resolveDefaultDeviceStoreOptions());
    } else {
      this.password = options.password;
      this.token = options.token ?? randomToken();
      this.trustEntraTunnel = options.trustEntraTunnel ?? false;
      this.deviceStore = options.deviceStore ?? new DeviceStore(resolveDefaultDeviceStoreOptions());
    }

    this.serverSecret = this.deviceStore.getOrCreateMetadata(
      SERVER_SECRET_METADATA_KEY,
      () => crypto.randomBytes(32).toString("hex"),
    );
  }

  public dispose(): void {
    this.deviceStore.close();
  }

  public requiresPassword(): boolean {
    return Boolean(this.password);
  }

  public verifyTokenOnly(token?: string): AuthVerifyResult {
    if (!token || !safeEqual(token, this.token)) {
      return { ok: false, reason: "invalid token" };
    }

    return { ok: true };
  }

  public verify(payload: AuthPayload): AuthVerifyResult {
    if (payload.resumeToken) {
      return this.verifyResumeToken(payload.resumeToken);
    }

    const tokenVerification = this.verifyTokenOnly(payload.token);
    if (!tokenVerification.ok) {
      return tokenVerification;
    }

    // If request came through Entra-authenticated tunnel and we trust it,
    // skip password verification.
    if (this.trustEntraTunnel && payload.tunnelAuthenticated) {
      return { ok: true };
    }

    if (this.password && (!payload.password || !safeEqual(payload.password, this.password))) {
      return { ok: false, reason: "invalid password" };
    }

    return { ok: true };
  }

  public createPairingSession(options: CreatePairingSessionOptions): PairingSessionResult {
    const expiresAt = new Date(Date.now() + (options.ttlMs ?? DEFAULT_PAIRING_TTL_MS)).toISOString();
    const session: PairingSession = {
      pairingSessionId: crypto.randomUUID(),
      token: randomToken(32),
      expiresAt,
      redeemed: false,
      redeemedBy: null,
      redeemedAt: null,
      expiredAt: null,
    };
    this.deviceStore.savePairingSession(session);

    return {
      session,
      payload: {
        url: `${options.baseUrl}/pair`,
        token: session.token,
        pairingSessionId: session.pairingSessionId,
        expiresAt: session.expiresAt,
        protocolVersion: 2,
        serverVersion: options.serverVersion ?? "0.0.0",
      },
    };
  }

  public cleanupExpiredPairingSessions(now = new Date()): number {
    return this.deviceStore.markExpiredPairingSessions(now.toISOString());
  }

  public redeemPairingSession(input: RedeemPairingSessionInput): RedeemPairingSessionResult {
    const pairing = this.deviceStore.getPairingSession(input.pairingSessionId);
    if (!pairing || !safeEqual(pairing.token, input.token)) {
      throw new DeviceTrustError("invalid pairing session", "invalid_pairing_session", 404);
    }
    if (pairing.expiredAt || new Date(pairing.expiresAt).getTime() <= Date.now()) {
      throw new DeviceTrustError("pairing session expired", "pairing_session_expired", 410);
    }
    if (pairing.redeemed) {
      throw new DeviceTrustError("pairing session already redeemed", "pairing_session_redeemed", 409);
    }

    const nowIso = new Date().toISOString();
    const device: DeviceIdentity = {
      deviceId: crypto.randomUUID(),
      publicKey: input.publicKey,
      displayName: normalizeDisplayName(input.displayName, input.platform),
      platform: normalizePlatform(input.platform),
      lastSeenAt: nowIso,
      trustLevel: "trusted",
      revokedAt: null,
      revokeReason: null,
    };
    this.deviceStore.saveDevice(device);
    this.deviceStore.markPairingSessionRedeemed(pairing.pairingSessionId, device.deviceId, nowIso);

    return {
      device,
      resumeToken: this.issueResumeToken(device.deviceId),
      expiresAt: new Date(Date.now() + DEFAULT_RESUME_TOKEN_TTL_MS).toISOString(),
    };
  }

  public listDevices(): DeviceIdentity[] {
    return this.deviceStore.listDevices();
  }

  public revokeDevice(deviceId: string, reason: string): DeviceIdentity {
    const revokedAt = new Date().toISOString();
    const device = this.deviceStore.revokeDevice(deviceId, revokedAt, reason);
    if (!device) {
      throw new DeviceTrustError("device not found", "device_not_found", 404);
    }
    return device;
  }

  private verifyResumeToken(token: string): AuthVerifyResult {
    try {
      const segments = token.split(".");
      if (segments.length !== 3) {
        return { ok: false, reason: "invalid resume token" };
      }

      const [encodedHeader, encodedPayload, signature] = segments;
      const expectedSignature = signJwtSegment(
        `${encodedHeader}.${encodedPayload}`,
        this.serverSecret,
      );
      if (!safeEqual(signature, expectedSignature)) {
        return { ok: false, reason: "invalid resume token" };
      }

      const payload = JSON.parse(base64UrlDecode(encodedPayload)) as ResumeTokenPayload;
      if (typeof payload.deviceId !== "string" || typeof payload.exp !== "number") {
        return { ok: false, reason: "invalid resume token" };
      }
      if (payload.exp <= Math.floor(Date.now() / 1000)) {
        return { ok: false, reason: "resume token expired" };
      }

      const device = this.deviceStore.getDevice(payload.deviceId);
      if (!device) {
        return { ok: false, reason: "device not found" };
      }
      if (device.trustLevel === "revoked" || device.revokedAt) {
        return { ok: false, reason: "device revoked" };
      }

      const lastSeenAt = new Date().toISOString();
      this.deviceStore.updateDeviceLastSeen(device.deviceId, lastSeenAt);
      return {
        ok: true,
        device: {
          ...device,
          lastSeenAt,
        },
      };
    } catch {
      return { ok: false, reason: "invalid resume token" };
    }
  }

  private issueResumeToken(deviceId: string, ttlMs = DEFAULT_RESUME_TOKEN_TTL_MS): string {
    const header = {
      alg: "HS256",
      typ: "JWT",
    };
    const nowInSeconds = Math.floor(Date.now() / 1000);
    const payload: ResumeTokenPayload = {
      deviceId,
      iat: nowInSeconds,
      exp: nowInSeconds + Math.floor(ttlMs / 1000),
    };

    const encodedHeader = base64UrlEncode(JSON.stringify(header));
    const encodedPayload = base64UrlEncode(JSON.stringify(payload));
    const unsignedToken = `${encodedHeader}.${encodedPayload}`;
    const signature = signJwtSegment(unsignedToken, this.serverSecret);
    return `${unsignedToken}.${signature}`;
  }
}

const normalizeDisplayName = (displayName: string | undefined, platform: string | undefined): string => {
  const normalized = displayName?.trim();
  if (normalized) {
    return normalized.slice(0, 80);
  }
  if (platform === "ios") {
    return "iPhone";
  }
  if (platform === "android") {
    return "Android Device";
  }
  return "Trusted Device";
};

const normalizePlatform = (platform: string | undefined): string => {
  const normalized = platform?.trim().toLowerCase();
  return normalized ? normalized.slice(0, 32) : "unknown";
};

const base64UrlEncode = (value: string): string => {
  return Buffer.from(value, "utf8")
    .toString("base64url");
};

const base64UrlDecode = (value: string): string => {
  return Buffer.from(value, "base64url").toString("utf8");
};

const signJwtSegment = (value: string, secret: string): string => {
  return crypto
    .createHmac("sha256", secret)
    .update(value)
    .digest("base64url");
};

const resolveDefaultDeviceStoreOptions = (): { dbPath?: string } => {
  if (process.env.NODE_ENV === "test") {
    return { dbPath: ":memory:" };
  }
  return {};
};

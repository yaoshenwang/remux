import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import type { DeviceIdentity, PairingSession } from "./device-types.js";

interface DeviceStoreOptions {
  dbPath?: string;
}

interface DeviceRow {
  device_id: string;
  public_key: string;
  display_name: string;
  platform: string;
  last_seen_at: string;
  trust_level: string;
  revoked_at: string | null;
  revoke_reason: string | null;
}

interface PairingSessionRow {
  pairing_session_id: string;
  token: string;
  expires_at: string;
  redeemed: number;
  redeemed_by: string | null;
  redeemed_at: string | null;
  expired_at: string | null;
}

export class DeviceStore {
  private readonly db: Database.Database;

  public constructor(options: DeviceStoreOptions = {}) {
    const dbPath = options.dbPath ?? path.join(os.homedir(), ".remux", "devices.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath, {
      timeout: 5_000,
    });
    this.db.pragma("busy_timeout = 5000");
    try {
      this.db.pragma("journal_mode = WAL");
    } catch {
      // Another process may already hold the lock while running tests.
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS devices (
        device_id TEXT PRIMARY KEY,
        public_key TEXT NOT NULL,
        display_name TEXT NOT NULL,
        platform TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        trust_level TEXT NOT NULL,
        revoked_at TEXT,
        revoke_reason TEXT
      );

      CREATE TABLE IF NOT EXISTS pairing_sessions (
        pairing_session_id TEXT PRIMARY KEY,
        token TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        redeemed INTEGER NOT NULL DEFAULT 0,
        redeemed_by TEXT,
        redeemed_at TEXT,
        expired_at TEXT
      );

      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  public close(): void {
    this.db.close();
  }

  public listDevices(): DeviceIdentity[] {
    const rows = this.db.prepare(`
      SELECT device_id, public_key, display_name, platform, last_seen_at, trust_level, revoked_at, revoke_reason
      FROM devices
      ORDER BY datetime(last_seen_at) DESC
    `).all() as DeviceRow[];
    return rows.map(toDeviceIdentity);
  }

  public getDevice(deviceId: string): DeviceIdentity | null {
    const row = this.db.prepare(`
      SELECT device_id, public_key, display_name, platform, last_seen_at, trust_level, revoked_at, revoke_reason
      FROM devices
      WHERE device_id = ?
    `).get(deviceId) as DeviceRow | undefined;
    return row ? toDeviceIdentity(row) : null;
  }

  public saveDevice(device: DeviceIdentity): DeviceIdentity {
    this.db.prepare(`
      INSERT INTO devices (
        device_id, public_key, display_name, platform, last_seen_at, trust_level, revoked_at, revoke_reason
      ) VALUES (
        @device_id, @public_key, @display_name, @platform, @last_seen_at, @trust_level, @revoked_at, @revoke_reason
      )
      ON CONFLICT(device_id) DO UPDATE SET
        public_key = excluded.public_key,
        display_name = excluded.display_name,
        platform = excluded.platform,
        last_seen_at = excluded.last_seen_at,
        trust_level = excluded.trust_level,
        revoked_at = excluded.revoked_at,
        revoke_reason = excluded.revoke_reason
    `).run({
      device_id: device.deviceId,
      public_key: device.publicKey,
      display_name: device.displayName,
      platform: device.platform,
      last_seen_at: device.lastSeenAt,
      trust_level: device.trustLevel,
      revoked_at: device.revokedAt ?? null,
      revoke_reason: device.revokeReason ?? null,
    });
    return device;
  }

  public updateDeviceLastSeen(deviceId: string, lastSeenAt: string): void {
    this.db.prepare(`
      UPDATE devices
      SET last_seen_at = ?
      WHERE device_id = ?
    `).run(lastSeenAt, deviceId);
  }

  public revokeDevice(deviceId: string, revokedAt: string, reason: string): DeviceIdentity | null {
    this.db.prepare(`
      UPDATE devices
      SET trust_level = 'revoked',
          revoked_at = ?,
          revoke_reason = ?
      WHERE device_id = ?
    `).run(revokedAt, reason, deviceId);
    return this.getDevice(deviceId);
  }

  public savePairingSession(session: PairingSession): PairingSession {
    this.db.prepare(`
      INSERT INTO pairing_sessions (
        pairing_session_id, token, expires_at, redeemed, redeemed_by, redeemed_at, expired_at
      ) VALUES (
        @pairing_session_id, @token, @expires_at, @redeemed, @redeemed_by, @redeemed_at, @expired_at
      )
      ON CONFLICT(pairing_session_id) DO UPDATE SET
        token = excluded.token,
        expires_at = excluded.expires_at,
        redeemed = excluded.redeemed,
        redeemed_by = excluded.redeemed_by,
        redeemed_at = excluded.redeemed_at,
        expired_at = excluded.expired_at
    `).run({
      pairing_session_id: session.pairingSessionId,
      token: session.token,
      expires_at: session.expiresAt,
      redeemed: session.redeemed ? 1 : 0,
      redeemed_by: session.redeemedBy,
      redeemed_at: session.redeemedAt ?? null,
      expired_at: session.expiredAt ?? null,
    });
    return session;
  }

  public getPairingSession(pairingSessionId: string): PairingSession | null {
    const row = this.db.prepare(`
      SELECT pairing_session_id, token, expires_at, redeemed, redeemed_by, redeemed_at, expired_at
      FROM pairing_sessions
      WHERE pairing_session_id = ?
    `).get(pairingSessionId) as PairingSessionRow | undefined;
    return row ? toPairingSession(row) : null;
  }

  public markPairingSessionRedeemed(
    pairingSessionId: string,
    redeemedBy: string,
    redeemedAt: string,
  ): PairingSession | null {
    this.db.prepare(`
      UPDATE pairing_sessions
      SET redeemed = 1,
          redeemed_by = ?,
          redeemed_at = ?
      WHERE pairing_session_id = ?
    `).run(redeemedBy, redeemedAt, pairingSessionId);
    return this.getPairingSession(pairingSessionId);
  }

  public markExpiredPairingSessions(nowIso: string): number {
    const result = this.db.prepare(`
      UPDATE pairing_sessions
      SET expired_at = ?
      WHERE redeemed = 0
        AND expired_at IS NULL
        AND datetime(expires_at) <= datetime(?)
    `).run(nowIso, nowIso);
    return result.changes;
  }

  public getOrCreateMetadata(key: string, factory: () => string): string {
    const existing = this.db.prepare(`
      SELECT value
      FROM metadata
      WHERE key = ?
    `).get(key) as { value: string } | undefined;
    if (existing) {
      return existing.value;
    }

    const created = factory();
    this.db.prepare(`
      INSERT INTO metadata (key, value)
      VALUES (?, ?)
    `).run(key, created);
    return created;
  }
}

const toDeviceIdentity = (row: DeviceRow): DeviceIdentity => {
  return {
    deviceId: row.device_id,
    publicKey: row.public_key,
    displayName: row.display_name,
    platform: row.platform,
    lastSeenAt: row.last_seen_at,
    trustLevel: row.trust_level === "revoked" ? "revoked" : "trusted",
    revokedAt: row.revoked_at,
    revokeReason: row.revoke_reason,
  };
};

const toPairingSession = (row: PairingSessionRow): PairingSession => {
  return {
    pairingSessionId: row.pairing_session_id,
    token: row.token,
    expiresAt: row.expires_at,
    redeemed: row.redeemed === 1,
    redeemedBy: row.redeemed_by,
    redeemedAt: row.redeemed_at,
    expiredAt: row.expired_at,
  };
};

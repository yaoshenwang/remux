/**
 * SQLite persistence store for Remux.
 * Uses better-sqlite3 with WAL mode at ~/.remux/remux.db.
 * Manages sessions, tabs (scrollback as BLOB), and device trust.
 *
 * Adapted from better-sqlite3 best practices:
 * https://github.com/WiseLibs/better-sqlite3/blob/master/docs/performance.md
 */

import Database from "better-sqlite3";
import path from "path";
import { homedir } from "os";
import fs from "fs";
import crypto from "crypto";

// ── Database path ───────────────────────────────────────────────

const REMUX_DIR = path.join(homedir(), ".remux");
const PORT = process.env.PORT || 8767;
const PERSIST_ID = process.env.REMUX_INSTANCE_ID || `port-${PORT}`;

export function getDbPath(): string {
  return path.join(REMUX_DIR, `remux-${PERSIST_ID}.db`);
}

// ── Database singleton ──────────────────────────────────────────

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  if (!fs.existsSync(REMUX_DIR)) {
    fs.mkdirSync(REMUX_DIR, { recursive: true });
  }

  _db = new Database(getDbPath());
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");

  // Create tables
  _db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      name TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tabs (
      id INTEGER PRIMARY KEY,
      session_name TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT 'Tab',
      scrollback BLOB,
      ended INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (session_name) REFERENCES sessions(name) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      trust TEXT NOT NULL DEFAULT 'untrusted',
      created_at INTEGER NOT NULL,
      last_seen INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pair_codes (
      code TEXT PRIMARY KEY,
      created_by TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      FOREIGN KEY (created_by) REFERENCES devices(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      device_id TEXT PRIMARY KEY,
      endpoint TEXT NOT NULL,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);

  return _db;
}

/**
 * Close the database connection (for clean shutdown / testing).
 */
export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

/**
 * Reset singleton for testing -- allows re-init with a different path.
 */
export function _resetDbForTest(testDb: Database.Database): void {
  _db = testDb;
}

// ── Device types ────────────────────────────────────────────────

export type TrustLevel = "trusted" | "untrusted" | "blocked";

export interface Device {
  id: string;
  name: string;
  fingerprint: string;
  trust: TrustLevel;
  createdAt: number;
  lastSeen: number;
}

// ── Session / Tab persistence ───────────────────────────────────

export interface PersistedSession {
  name: string;
  createdAt: number;
}

export interface PersistedTab {
  id: number;
  sessionName: string;
  title: string;
  scrollback: Buffer | null;
  ended: boolean;
}

/**
 * Upsert a session record.
 */
export function upsertSession(name: string, createdAt: number): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO sessions (name, created_at) VALUES (?, ?)
     ON CONFLICT(name) DO UPDATE SET created_at = excluded.created_at`,
  ).run(name, createdAt);
}

/**
 * Upsert a tab record (scrollback as BLOB).
 */
export function upsertTab(tab: PersistedTab): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO tabs (id, session_name, title, scrollback, ended) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       session_name = excluded.session_name,
       title = excluded.title,
       scrollback = excluded.scrollback,
       ended = excluded.ended`,
  ).run(
    tab.id,
    tab.sessionName,
    tab.title,
    tab.scrollback,
    tab.ended ? 1 : 0,
  );
}

/**
 * Load all persisted sessions with their tabs.
 */
export function loadSessions(): Array<{
  name: string;
  createdAt: number;
  tabs: Array<{
    id: number;
    title: string;
    scrollback: Buffer | null;
    ended: boolean;
  }>;
}> {
  const db = getDb();
  const sessions = db
    .prepare("SELECT name, created_at FROM sessions ORDER BY created_at")
    .all() as Array<{ name: string; created_at: number }>;

  return sessions.map((s) => {
    const tabs = db
      .prepare(
        "SELECT id, title, scrollback, ended FROM tabs WHERE session_name = ? ORDER BY id",
      )
      .all(s.name) as Array<{
      id: number;
      title: string;
      scrollback: Buffer | null;
      ended: number;
    }>;

    return {
      name: s.name,
      createdAt: s.created_at,
      tabs: tabs.map((t) => ({
        id: t.id,
        title: t.title,
        scrollback: t.scrollback,
        ended: t.ended === 1,
      })),
    };
  });
}

/**
 * Remove tabs that no longer exist in the live session map.
 */
export function removeStaleTab(tabId: number): void {
  const db = getDb();
  db.prepare("DELETE FROM tabs WHERE id = ?").run(tabId);
}

/**
 * Remove a session and its tabs from the store.
 */
export function removeSession(name: string): void {
  const db = getDb();
  db.prepare("DELETE FROM sessions WHERE name = ?").run(name);
}

// ── Device CRUD ─────────────────────────────────────────────────

/**
 * Generate a random 16-char hex device ID.
 */
export function generateDeviceId(): string {
  return crypto.randomBytes(8).toString("hex");
}

/**
 * Compute device fingerprint from request headers.
 * SHA-256 of user-agent + accept-language, truncated to 16 chars.
 */
export function computeFingerprint(
  userAgent: string,
  acceptLanguage: string,
): string {
  const raw = `${userAgent}|${acceptLanguage}`;
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

/**
 * Check if any devices exist (for bootstrap trust logic).
 */
export function hasAnyDevice(): boolean {
  const db = getDb();
  const row = db
    .prepare("SELECT COUNT(*) as cnt FROM devices")
    .get() as { cnt: number };
  return row.cnt > 0;
}

/**
 * Create a new device. Returns the created device.
 */
export function createDevice(
  fingerprint: string,
  trust: TrustLevel = "untrusted",
  name?: string,
): Device {
  const db = getDb();
  const id = generateDeviceId();
  const now = Date.now();
  const deviceName = name || `Device-${id.slice(0, 4).toUpperCase()}`;

  db.prepare(
    `INSERT INTO devices (id, name, fingerprint, trust, created_at, last_seen)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, deviceName, fingerprint, trust, now, now);

  return {
    id,
    name: deviceName,
    fingerprint,
    trust,
    createdAt: now,
    lastSeen: now,
  };
}

/**
 * Find a device by fingerprint.
 */
export function findDeviceByFingerprint(
  fingerprint: string,
): Device | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM devices WHERE fingerprint = ?")
    .get(fingerprint) as any;
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    fingerprint: row.fingerprint,
    trust: row.trust as TrustLevel,
    createdAt: row.created_at,
    lastSeen: row.last_seen,
  };
}

/**
 * Find a device by ID.
 */
export function findDeviceById(id: string): Device | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM devices WHERE id = ?")
    .get(id) as any;
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    fingerprint: row.fingerprint,
    trust: row.trust as TrustLevel,
    createdAt: row.created_at,
    lastSeen: row.last_seen,
  };
}

/**
 * List all devices.
 */
export function listDevices(): Device[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM devices ORDER BY last_seen DESC")
    .all() as any[];
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    fingerprint: r.fingerprint,
    trust: r.trust as TrustLevel,
    createdAt: r.created_at,
    lastSeen: r.last_seen,
  }));
}

/**
 * Update device trust level.
 */
export function updateDeviceTrust(id: string, trust: TrustLevel): boolean {
  const db = getDb();
  const result = db
    .prepare("UPDATE devices SET trust = ? WHERE id = ?")
    .run(trust, id);
  return result.changes > 0;
}

/**
 * Rename a device.
 */
export function renameDevice(id: string, name: string): boolean {
  const db = getDb();
  const result = db
    .prepare("UPDATE devices SET name = ? WHERE id = ?")
    .run(name, id);
  return result.changes > 0;
}

/**
 * Update device last_seen timestamp.
 */
export function touchDevice(id: string): void {
  const db = getDb();
  db.prepare("UPDATE devices SET last_seen = ? WHERE id = ?").run(
    Date.now(),
    id,
  );
}

/**
 * Delete a device record.
 */
export function deleteDevice(id: string): boolean {
  const db = getDb();
  const result = db.prepare("DELETE FROM devices WHERE id = ?").run(id);
  return result.changes > 0;
}

// ── Pair codes ──────────────────────────────────────────────────

export interface PairCode {
  code: string;
  createdBy: string;
  expiresAt: number;
}

/**
 * Generate a random 6-digit pairing code (valid for 5 minutes).
 */
export function createPairCode(createdBy: string): PairCode {
  const db = getDb();
  // Random 6-digit code
  const code = String(crypto.randomInt(100000, 999999));
  const expiresAt = Date.now() + 5 * 60 * 1000;

  // Clean expired codes first
  db.prepare("DELETE FROM pair_codes WHERE expires_at < ?").run(Date.now());

  db.prepare(
    "INSERT INTO pair_codes (code, created_by, expires_at) VALUES (?, ?, ?)",
  ).run(code, createdBy, expiresAt);

  return { code, createdBy, expiresAt };
}

/**
 * Validate and consume a pairing code (one-time use).
 * Returns the device ID that created it, or null if invalid/expired.
 */
export function consumePairCode(code: string): string | null {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT created_by, expires_at FROM pair_codes WHERE code = ?",
    )
    .get(code) as { created_by: string; expires_at: number } | undefined;

  if (!row || row.expires_at < Date.now()) {
    // Clean up expired
    db.prepare("DELETE FROM pair_codes WHERE code = ?").run(code);
    return null;
  }

  // Consume (delete) the code
  db.prepare("DELETE FROM pair_codes WHERE code = ?").run(code);
  return row.created_by;
}

// ── Settings KV ────────────────────────────────────────────────

/**
 * Get a setting value by key.
 */
export function getSetting(key: string): string | null {
  const db = getDb();
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

/**
 * Set a setting value (upsert).
 */
export function setSetting(key: string, value: string): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

// ── Push Subscriptions ─────────────────────────────────────────

export interface PushSubscriptionRecord {
  deviceId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  createdAt: number;
}

/**
 * Save a push subscription for a device (upsert).
 */
export function savePushSubscription(
  deviceId: string,
  endpoint: string,
  p256dh: string,
  auth: string,
): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO push_subscriptions (device_id, endpoint, p256dh, auth, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(device_id) DO UPDATE SET
       endpoint = excluded.endpoint,
       p256dh = excluded.p256dh,
       auth = excluded.auth,
       created_at = excluded.created_at`,
  ).run(deviceId, endpoint, p256dh, auth, Date.now());
}

/**
 * Remove a push subscription for a device.
 */
export function removePushSubscription(deviceId: string): boolean {
  const db = getDb();
  const result = db
    .prepare("DELETE FROM push_subscriptions WHERE device_id = ?")
    .run(deviceId);
  return result.changes > 0;
}

/**
 * Get a push subscription for a specific device.
 */
export function getPushSubscription(
  deviceId: string,
): PushSubscriptionRecord | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM push_subscriptions WHERE device_id = ?")
    .get(deviceId) as any;
  if (!row) return null;
  return {
    deviceId: row.device_id,
    endpoint: row.endpoint,
    p256dh: row.p256dh,
    auth: row.auth,
    createdAt: row.created_at,
  };
}

/**
 * List all push subscriptions.
 */
export function listPushSubscriptions(): PushSubscriptionRecord[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM push_subscriptions ORDER BY created_at DESC")
    .all() as any[];
  return rows.map((r) => ({
    deviceId: r.device_id,
    endpoint: r.endpoint,
    p256dh: r.p256dh,
    auth: r.auth,
    createdAt: r.created_at,
  }));
}

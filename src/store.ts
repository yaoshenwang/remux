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

    CREATE TABLE IF NOT EXISTS topics (
      id TEXT PRIMARY KEY,
      session_name TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      topic_id TEXT REFERENCES topics(id),
      session_name TEXT NOT NULL,
      tab_id INTEGER,
      command TEXT,
      exit_code INTEGER,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      status TEXT DEFAULT 'running'
    );

    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      run_id TEXT REFERENCES runs(id),
      topic_id TEXT REFERENCES topics(id),
      type TEXT NOT NULL,
      title TEXT,
      content TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      run_id TEXT REFERENCES runs(id),
      topic_id TEXT REFERENCES topics(id),
      title TEXT NOT NULL,
      description TEXT,
      status TEXT DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      resolved_at INTEGER
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

// ── Workspace: Topics ─────────────────────────────────────────────

export interface Topic {
  id: string;
  sessionName: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Create a new topic (conversation thread) within a session.
 */
export function createTopic(sessionName: string, title: string): Topic {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = Date.now();
  db.prepare(
    "INSERT INTO topics (id, session_name, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(id, sessionName, title, now, now);
  return { id, sessionName, title, createdAt: now, updatedAt: now };
}

/**
 * Update a topic's title.
 */
export function updateTopic(id: string, title: string): boolean {
  const db = getDb();
  const now = Date.now();
  const result = db
    .prepare("UPDATE topics SET title = ?, updated_at = ? WHERE id = ?")
    .run(title, now, id);
  return result.changes > 0;
}

/**
 * List topics, optionally filtered by session name.
 */
export function listTopics(sessionName?: string): Topic[] {
  const db = getDb();
  let rows: any[];
  if (sessionName) {
    rows = db
      .prepare(
        "SELECT * FROM topics WHERE session_name = ? ORDER BY created_at",
      )
      .all(sessionName) as any[];
  } else {
    rows = db
      .prepare("SELECT * FROM topics ORDER BY created_at")
      .all() as any[];
  }
  return rows.map((r) => ({
    id: r.id,
    sessionName: r.session_name,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

/**
 * Delete a topic by ID.
 */
export function deleteTopic(id: string): boolean {
  const db = getDb();
  const result = db.prepare("DELETE FROM topics WHERE id = ?").run(id);
  return result.changes > 0;
}

// ── Workspace: Runs ───────────────────────────────────────────────

export interface Run {
  id: string;
  topicId: string | null;
  sessionName: string;
  tabId: number | null;
  command: string | null;
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
  status: "running" | "completed" | "failed";
}

/**
 * Create a new run (command execution tracked within a topic).
 */
export function createRun(params: {
  topicId?: string;
  sessionName: string;
  tabId?: number;
  command?: string;
}): Run {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO runs (id, topic_id, session_name, tab_id, command, started_at, status)
     VALUES (?, ?, ?, ?, ?, ?, 'running')`,
  ).run(
    id,
    params.topicId ?? null,
    params.sessionName,
    params.tabId ?? null,
    params.command ?? null,
    now,
  );
  return {
    id,
    topicId: params.topicId ?? null,
    sessionName: params.sessionName,
    tabId: params.tabId ?? null,
    command: params.command ?? null,
    exitCode: null,
    startedAt: now,
    endedAt: null,
    status: "running",
  };
}

/**
 * Update a run's exit code, status, and/or end time.
 */
export function updateRun(
  id: string,
  params: { exitCode?: number; status?: string },
): boolean {
  const db = getDb();
  const now = Date.now();
  const sets: string[] = [];
  const values: any[] = [];

  if (params.exitCode !== undefined) {
    sets.push("exit_code = ?");
    values.push(params.exitCode);
  }
  if (params.status !== undefined) {
    sets.push("status = ?");
    values.push(params.status);
  }
  if (
    params.status === "completed" ||
    params.status === "failed" ||
    params.exitCode !== undefined
  ) {
    sets.push("ended_at = ?");
    values.push(now);
  }

  if (sets.length === 0) return false;
  values.push(id);

  const result = db
    .prepare(`UPDATE runs SET ${sets.join(", ")} WHERE id = ?`)
    .run(...values);
  return result.changes > 0;
}

/**
 * List runs, optionally filtered by topic ID.
 */
export function listRuns(topicId?: string): Run[] {
  const db = getDb();
  let rows: any[];
  if (topicId) {
    rows = db
      .prepare("SELECT * FROM runs WHERE topic_id = ? ORDER BY started_at")
      .all(topicId) as any[];
  } else {
    rows = db
      .prepare("SELECT * FROM runs ORDER BY started_at")
      .all() as any[];
  }
  return rows.map((r) => ({
    id: r.id,
    topicId: r.topic_id,
    sessionName: r.session_name,
    tabId: r.tab_id,
    command: r.command,
    exitCode: r.exit_code,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    status: r.status,
  }));
}

// ── Workspace: Artifacts ──────────────────────────────────────────

export interface Artifact {
  id: string;
  runId: string | null;
  topicId: string | null;
  type: "snapshot" | "command-card" | "note";
  title: string | null;
  content: string | null;
  createdAt: number;
}

/**
 * Create an artifact (snapshot, command card, or note).
 */
export function createArtifact(params: {
  runId?: string;
  topicId?: string;
  type: string;
  title?: string;
  content?: string;
}): Artifact {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO artifacts (id, run_id, topic_id, type, title, content, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    params.runId ?? null,
    params.topicId ?? null,
    params.type,
    params.title ?? null,
    params.content ?? null,
    now,
  );
  return {
    id,
    runId: params.runId ?? null,
    topicId: params.topicId ?? null,
    type: params.type as Artifact["type"],
    title: params.title ?? null,
    content: params.content ?? null,
    createdAt: now,
  };
}

/**
 * List artifacts, optionally filtered by topic or run.
 */
export function listArtifacts(params: {
  topicId?: string;
  runId?: string;
}): Artifact[] {
  const db = getDb();
  let rows: any[];
  if (params.topicId) {
    rows = db
      .prepare(
        "SELECT * FROM artifacts WHERE topic_id = ? ORDER BY created_at",
      )
      .all(params.topicId) as any[];
  } else if (params.runId) {
    rows = db
      .prepare("SELECT * FROM artifacts WHERE run_id = ? ORDER BY created_at")
      .all(params.runId) as any[];
  } else {
    rows = db
      .prepare("SELECT * FROM artifacts ORDER BY created_at")
      .all() as any[];
  }
  return rows.map((r) => ({
    id: r.id,
    runId: r.run_id,
    topicId: r.topic_id,
    type: r.type,
    title: r.title,
    content: r.content,
    createdAt: r.created_at,
  }));
}

// ── Workspace: Approvals ──────────────────────────────────────────

export interface Approval {
  id: string;
  runId: string | null;
  topicId: string | null;
  title: string;
  description: string | null;
  status: "pending" | "approved" | "rejected";
  createdAt: number;
  resolvedAt: number | null;
}

/**
 * Create an approval request (pending human review).
 */
export function createApproval(params: {
  runId?: string;
  topicId?: string;
  title: string;
  description?: string;
}): Approval {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO approvals (id, run_id, topic_id, title, description, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
  ).run(
    id,
    params.runId ?? null,
    params.topicId ?? null,
    params.title,
    params.description ?? null,
    now,
  );
  return {
    id,
    runId: params.runId ?? null,
    topicId: params.topicId ?? null,
    title: params.title,
    description: params.description ?? null,
    status: "pending",
    createdAt: now,
    resolvedAt: null,
  };
}

/**
 * List approvals, optionally filtered by status.
 */
export function listApprovals(
  status?: "pending" | "approved" | "rejected",
): Approval[] {
  const db = getDb();
  let rows: any[];
  if (status) {
    rows = db
      .prepare(
        "SELECT * FROM approvals WHERE status = ? ORDER BY created_at DESC",
      )
      .all(status) as any[];
  } else {
    rows = db
      .prepare("SELECT * FROM approvals ORDER BY created_at DESC")
      .all() as any[];
  }
  return rows.map((r) => ({
    id: r.id,
    runId: r.run_id,
    topicId: r.topic_id,
    title: r.title,
    description: r.description,
    status: r.status,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
  }));
}

/**
 * Resolve an approval (approve or reject).
 */
export function resolveApproval(
  id: string,
  status: "approved" | "rejected",
): boolean {
  const db = getDb();
  const now = Date.now();
  const result = db
    .prepare(
      "UPDATE approvals SET status = ?, resolved_at = ? WHERE id = ?",
    )
    .run(status, now, id);
  return result.changes > 0;
}

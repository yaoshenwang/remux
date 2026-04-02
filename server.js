#!/usr/bin/env node
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/store.ts
import Database from "better-sqlite3";
import path from "path";
import { homedir } from "os";
import fs from "fs";
import crypto from "crypto";
function getDbPath() {
  return path.join(REMUX_DIR, `remux-${PERSIST_ID}.db`);
}
function getDb() {
  if (_db) return _db;
  if (!fs.existsSync(REMUX_DIR)) {
    fs.mkdirSync(REMUX_DIR, { recursive: true });
  }
  _db = new Database(getDbPath());
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
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
      session_name TEXT,
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

    CREATE VIRTUAL TABLE IF NOT EXISTS fts_index USING fts5(
      entity_type, entity_id, title, content,
      tokenize='porter unicode61'
    );

    CREATE TABLE IF NOT EXISTS memory_notes (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      pinned INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS commands (
      id TEXT PRIMARY KEY,
      session_name TEXT NOT NULL,
      tab_id INTEGER NOT NULL,
      command TEXT,
      exit_code INTEGER,
      cwd TEXT,
      started_at INTEGER NOT NULL,
      ended_at INTEGER
    );

    -- Step 2: workspace_head (multi-device shared focus state)
    CREATE TABLE IF NOT EXISTS workspace_head (
      id TEXT PRIMARY KEY DEFAULT 'global',
      session_name TEXT NOT NULL,
      tab_id INTEGER NOT NULL,
      topic_id TEXT,
      view TEXT NOT NULL DEFAULT 'live',
      revision INTEGER NOT NULL DEFAULT 0,
      updated_by_device TEXT,
      updated_at INTEGER NOT NULL
    );

    -- Step 4: durable stream tables
    CREATE TABLE IF NOT EXISTS tab_stream_chunks (
      tab_id INTEGER NOT NULL,
      seq_from INTEGER NOT NULL,
      seq_to INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      data BLOB NOT NULL,
      PRIMARY KEY (tab_id, seq_from)
    );

    CREATE TABLE IF NOT EXISTS tab_snapshots (
      tab_id INTEGER NOT NULL,
      seq INTEGER NOT NULL,
      cols INTEGER NOT NULL,
      rows INTEGER NOT NULL,
      snapshot BLOB NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (tab_id, seq)
    );

    CREATE TABLE IF NOT EXISTS device_tab_cursors (
      device_id TEXT NOT NULL,
      tab_id INTEGER NOT NULL,
      last_acked_seq INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (device_id, tab_id)
    );
  `);
  const artifactCols = _db.prepare("PRAGMA table_info(artifacts)").all();
  if (!artifactCols.find((c) => c.name === "session_name")) {
    _db.exec("ALTER TABLE artifacts ADD COLUMN session_name TEXT");
  }
  const noteCols = _db.prepare("PRAGMA table_info(memory_notes)").all();
  if (!noteCols.find((c) => c.name === "session_name")) {
    _db.exec("ALTER TABLE memory_notes ADD COLUMN session_name TEXT");
  }
  return _db;
}
function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}
function upsertSession(name, createdAt) {
  const db = getDb();
  db.prepare(
    `INSERT INTO sessions (name, created_at) VALUES (?, ?)
     ON CONFLICT(name) DO UPDATE SET created_at = excluded.created_at`
  ).run(name, createdAt);
}
function upsertTab(tab) {
  const db = getDb();
  db.prepare(
    `INSERT INTO tabs (id, session_name, title, scrollback, ended) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       session_name = excluded.session_name,
       title = excluded.title,
       scrollback = excluded.scrollback,
       ended = excluded.ended`
  ).run(
    tab.id,
    tab.sessionName,
    tab.title,
    tab.scrollback,
    tab.ended ? 1 : 0
  );
}
function loadSessions() {
  const db = getDb();
  const sessions = db.prepare("SELECT name, created_at FROM sessions ORDER BY created_at").all();
  return sessions.map((s) => {
    const tabs = db.prepare(
      "SELECT id, title, scrollback, ended FROM tabs WHERE session_name = ? ORDER BY id"
    ).all(s.name);
    return {
      name: s.name,
      createdAt: s.created_at,
      tabs: tabs.map((t) => ({
        id: t.id,
        title: t.title,
        scrollback: t.scrollback,
        ended: t.ended === 1
      }))
    };
  });
}
function removeStaleTab(tabId) {
  const db = getDb();
  db.prepare("DELETE FROM tabs WHERE id = ?").run(tabId);
}
function removeSession(name) {
  const db = getDb();
  db.prepare("DELETE FROM sessions WHERE name = ?").run(name);
}
function generateDeviceId() {
  return crypto.randomBytes(8).toString("hex");
}
function computeFingerprint(userAgent, acceptLanguage) {
  const raw = `${userAgent}|${acceptLanguage}`;
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
}
function hasAnyDevice() {
  const db = getDb();
  const row = db.prepare("SELECT COUNT(*) as cnt FROM devices").get();
  return row.cnt > 0;
}
function createDevice(fingerprint, trust = "untrusted", name, explicitId) {
  const db = getDb();
  const id = explicitId || generateDeviceId();
  const now = Date.now();
  const deviceName = name || `Device-${id.slice(0, 8).toUpperCase()}`;
  db.prepare(
    `INSERT INTO devices (id, name, fingerprint, trust, created_at, last_seen)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, deviceName, fingerprint, trust, now, now);
  return {
    id,
    name: deviceName,
    fingerprint,
    trust,
    createdAt: now,
    lastSeen: now
  };
}
function findDeviceByFingerprint(fingerprint) {
  const db = getDb();
  const row = db.prepare("SELECT * FROM devices WHERE fingerprint = ?").get(fingerprint);
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    fingerprint: row.fingerprint,
    trust: row.trust,
    createdAt: row.created_at,
    lastSeen: row.last_seen
  };
}
function findDeviceById(id) {
  const db = getDb();
  const row = db.prepare("SELECT * FROM devices WHERE id = ?").get(id);
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    fingerprint: row.fingerprint,
    trust: row.trust,
    createdAt: row.created_at,
    lastSeen: row.last_seen
  };
}
function listDevices() {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM devices ORDER BY last_seen DESC").all();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    fingerprint: r.fingerprint,
    trust: r.trust,
    createdAt: r.created_at,
    lastSeen: r.last_seen
  }));
}
function updateDeviceTrust(id, trust) {
  const db = getDb();
  const result = db.prepare("UPDATE devices SET trust = ? WHERE id = ?").run(trust, id);
  return result.changes > 0;
}
function renameDevice(id, name) {
  const db = getDb();
  const result = db.prepare("UPDATE devices SET name = ? WHERE id = ?").run(name, id);
  return result.changes > 0;
}
function touchDevice(id) {
  const db = getDb();
  db.prepare("UPDATE devices SET last_seen = ? WHERE id = ?").run(
    Date.now(),
    id
  );
}
function deleteDevice(id) {
  const db = getDb();
  const result = db.prepare("DELETE FROM devices WHERE id = ?").run(id);
  return result.changes > 0;
}
function createPairCode(createdBy) {
  const db = getDb();
  const code = String(crypto.randomInt(1e5, 999999));
  const expiresAt = Date.now() + 5 * 60 * 1e3;
  db.prepare("DELETE FROM pair_codes WHERE expires_at < ?").run(Date.now());
  db.prepare(
    "INSERT INTO pair_codes (code, created_by, expires_at) VALUES (?, ?, ?)"
  ).run(code, createdBy, expiresAt);
  return { code, createdBy, expiresAt };
}
function consumePairCode(code) {
  const db = getDb();
  const row = db.prepare(
    "SELECT created_by, expires_at FROM pair_codes WHERE code = ?"
  ).get(code);
  if (!row || row.expires_at < Date.now()) {
    db.prepare("DELETE FROM pair_codes WHERE code = ?").run(code);
    return null;
  }
  db.prepare("DELETE FROM pair_codes WHERE code = ?").run(code);
  return row.created_by;
}
function getSetting(key) {
  const db = getDb();
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row?.value ?? null;
}
function setSetting(key, value) {
  const db = getDb();
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
}
function savePushSubscription(deviceId, endpoint, p256dh, auth) {
  const db = getDb();
  db.prepare(
    `INSERT INTO push_subscriptions (device_id, endpoint, p256dh, auth, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(device_id) DO UPDATE SET
       endpoint = excluded.endpoint,
       p256dh = excluded.p256dh,
       auth = excluded.auth,
       created_at = excluded.created_at`
  ).run(deviceId, endpoint, p256dh, auth, Date.now());
}
function removePushSubscription(deviceId) {
  const db = getDb();
  const result = db.prepare("DELETE FROM push_subscriptions WHERE device_id = ?").run(deviceId);
  return result.changes > 0;
}
function getPushSubscription(deviceId) {
  const db = getDb();
  const row = db.prepare("SELECT * FROM push_subscriptions WHERE device_id = ?").get(deviceId);
  if (!row) return null;
  return {
    deviceId: row.device_id,
    endpoint: row.endpoint,
    p256dh: row.p256dh,
    auth: row.auth,
    createdAt: row.created_at
  };
}
function listPushSubscriptions() {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM push_subscriptions ORDER BY created_at DESC").all();
  return rows.map((r) => ({
    deviceId: r.device_id,
    endpoint: r.endpoint,
    p256dh: r.p256dh,
    auth: r.auth,
    createdAt: r.created_at
  }));
}
function createTopic(sessionName, title) {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = Date.now();
  db.prepare(
    "INSERT INTO topics (id, session_name, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
  ).run(id, sessionName, title, now, now);
  indexEntity("topic", id, title, title);
  return { id, sessionName, title, createdAt: now, updatedAt: now };
}
function listTopics(sessionName) {
  const db = getDb();
  let rows;
  if (sessionName) {
    rows = db.prepare(
      "SELECT * FROM topics WHERE session_name = ? ORDER BY created_at"
    ).all(sessionName);
  } else {
    rows = db.prepare("SELECT * FROM topics ORDER BY created_at").all();
  }
  return rows.map((r) => ({
    id: r.id,
    sessionName: r.session_name,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }));
}
function deleteTopic(id) {
  const db = getDb();
  const txn = db.transaction(() => {
    const result = db.prepare("DELETE FROM topics WHERE id = ?").run(id);
    if (result.changes > 0) removeFromIndex(id);
    return result.changes > 0;
  });
  return txn();
}
function createRun(params) {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO runs (id, topic_id, session_name, tab_id, command, started_at, status)
     VALUES (?, ?, ?, ?, ?, ?, 'running')`
  ).run(
    id,
    params.topicId ?? null,
    params.sessionName,
    params.tabId ?? null,
    params.command ?? null,
    now
  );
  if (params.command) {
    indexEntity("run", id, params.command, params.command);
  }
  return {
    id,
    topicId: params.topicId ?? null,
    sessionName: params.sessionName,
    tabId: params.tabId ?? null,
    command: params.command ?? null,
    exitCode: null,
    startedAt: now,
    endedAt: null,
    status: "running"
  };
}
function updateRun(id, params) {
  const db = getDb();
  const now = Date.now();
  const sets = [];
  const values = [];
  if (params.exitCode !== void 0) {
    sets.push("exit_code = ?");
    values.push(params.exitCode);
  }
  if (params.status !== void 0) {
    sets.push("status = ?");
    values.push(params.status);
  }
  if (params.status === "completed" || params.status === "failed" || params.exitCode !== void 0) {
    sets.push("ended_at = ?");
    values.push(now);
  }
  if (sets.length === 0) return false;
  values.push(id);
  const result = db.prepare(`UPDATE runs SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  return result.changes > 0;
}
function listRuns(topicId, sessionName) {
  const db = getDb();
  let rows;
  if (topicId && sessionName) {
    rows = db.prepare("SELECT * FROM runs WHERE topic_id = ? AND session_name = ? ORDER BY started_at").all(topicId, sessionName);
  } else if (topicId) {
    rows = db.prepare("SELECT * FROM runs WHERE topic_id = ? ORDER BY started_at").all(topicId);
  } else if (sessionName) {
    rows = db.prepare("SELECT * FROM runs WHERE session_name = ? ORDER BY started_at").all(sessionName);
  } else {
    rows = db.prepare("SELECT * FROM runs ORDER BY started_at").all();
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
    status: r.status
  }));
}
function createArtifact(params) {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO artifacts (id, run_id, topic_id, session_name, type, title, content, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    params.runId ?? null,
    params.topicId ?? null,
    params.sessionName ?? null,
    params.type,
    params.title ?? null,
    params.content ?? null,
    now
  );
  const ftsTitle = params.title || params.type;
  const ftsContent = [params.title, params.content].filter(Boolean).join(" ");
  if (ftsContent) {
    indexEntity("artifact", id, ftsTitle, ftsContent);
  }
  return {
    id,
    runId: params.runId ?? null,
    topicId: params.topicId ?? null,
    type: params.type,
    title: params.title ?? null,
    content: params.content ?? null,
    createdAt: now
  };
}
function listArtifacts(params) {
  const db = getDb();
  let rows;
  if (params.topicId) {
    rows = db.prepare(
      "SELECT * FROM artifacts WHERE topic_id = ? ORDER BY created_at"
    ).all(params.topicId);
  } else if (params.runId) {
    rows = db.prepare("SELECT * FROM artifacts WHERE run_id = ? ORDER BY created_at").all(params.runId);
  } else if (params.sessionName) {
    rows = db.prepare("SELECT * FROM artifacts WHERE session_name = ? ORDER BY created_at").all(params.sessionName);
  } else {
    rows = db.prepare("SELECT * FROM artifacts ORDER BY created_at").all();
  }
  return rows.map((r) => ({
    id: r.id,
    runId: r.run_id,
    topicId: r.topic_id,
    type: r.type,
    title: r.title,
    content: r.content,
    createdAt: r.created_at
  }));
}
function createApproval(params) {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO approvals (id, run_id, topic_id, title, description, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?)`
  ).run(
    id,
    params.runId ?? null,
    params.topicId ?? null,
    params.title,
    params.description ?? null,
    now
  );
  return {
    id,
    runId: params.runId ?? null,
    topicId: params.topicId ?? null,
    title: params.title,
    description: params.description ?? null,
    status: "pending",
    createdAt: now,
    resolvedAt: null
  };
}
function listApprovals(status) {
  const db = getDb();
  let rows;
  if (status) {
    rows = db.prepare(
      "SELECT * FROM approvals WHERE status = ? ORDER BY created_at DESC"
    ).all(status);
  } else {
    rows = db.prepare("SELECT * FROM approvals ORDER BY created_at DESC").all();
  }
  return rows.map((r) => ({
    id: r.id,
    runId: r.run_id,
    topicId: r.topic_id,
    title: r.title,
    description: r.description,
    status: r.status,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at
  }));
}
function resolveApproval(id, status) {
  const db = getDb();
  const now = Date.now();
  const result = db.prepare(
    "UPDATE approvals SET status = ?, resolved_at = ? WHERE id = ?"
  ).run(status, now, id);
  return result.changes > 0;
}
function indexEntity(entityType, entityId, title, content) {
  const db = getDb();
  db.prepare("DELETE FROM fts_index WHERE entity_id = ?").run(entityId);
  db.prepare(
    "INSERT INTO fts_index (entity_type, entity_id, title, content) VALUES (?, ?, ?, ?)"
  ).run(entityType, entityId, title, content);
}
function searchEntities(query, limit = 20) {
  const db = getDb();
  if (!query.trim()) return [];
  const safeQuery = query.replace(/"/g, '""').replace(/[*^]/g, "");
  try {
    const rows = db.prepare(
      `SELECT entity_type, entity_id, title, content, rank
         FROM fts_index WHERE fts_index MATCH ?
         ORDER BY rank LIMIT ?`
    ).all(`"${safeQuery}"`, limit);
    return rows.map((r) => ({
      entityType: r.entity_type,
      entityId: r.entity_id,
      title: r.title,
      content: r.content,
      rank: r.rank
    }));
  } catch {
    return [];
  }
}
function removeFromIndex(entityId) {
  const db = getDb();
  db.prepare("DELETE FROM fts_index WHERE entity_id = ?").run(entityId);
}
function createNote(content, sessionName) {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = Date.now();
  db.prepare(
    "INSERT INTO memory_notes (id, content, pinned, created_at, updated_at, session_name) VALUES (?, ?, 0, ?, ?, ?)"
  ).run(id, content, now, now, sessionName ?? null);
  return { id, content, pinned: false, createdAt: now, updatedAt: now };
}
function listNotes(sessionName) {
  const db = getDb();
  let rows;
  if (sessionName) {
    rows = db.prepare(
      "SELECT * FROM memory_notes WHERE session_name = ? OR session_name IS NULL ORDER BY pinned DESC, updated_at DESC"
    ).all(sessionName);
  } else {
    rows = db.prepare(
      "SELECT * FROM memory_notes ORDER BY pinned DESC, updated_at DESC"
    ).all();
  }
  return rows.map((r) => ({
    id: r.id,
    content: r.content,
    pinned: r.pinned === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }));
}
function updateNote(id, content) {
  const db = getDb();
  const now = Date.now();
  const result = db.prepare("UPDATE memory_notes SET content = ?, updated_at = ? WHERE id = ?").run(content, now, id);
  return result.changes > 0;
}
function deleteNote(id) {
  const db = getDb();
  const txn = db.transaction(() => {
    const result = db.prepare("DELETE FROM memory_notes WHERE id = ?").run(id);
    if (result.changes > 0) removeFromIndex(id);
    return result.changes > 0;
  });
  return txn();
}
function togglePinNote(id) {
  const db = getDb();
  const result = db.prepare(
    "UPDATE memory_notes SET pinned = CASE WHEN pinned = 0 THEN 1 ELSE 0 END, updated_at = ? WHERE id = ?"
  ).run(Date.now(), id);
  return result.changes > 0;
}
function createCommand(params) {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO commands (id, session_name, tab_id, command, cwd, started_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, params.sessionName, params.tabId, params.command ?? null, params.cwd ?? null, now);
  return {
    id,
    sessionName: params.sessionName,
    tabId: params.tabId,
    command: params.command ?? null,
    exitCode: null,
    cwd: params.cwd ?? null,
    startedAt: now,
    endedAt: null
  };
}
function completeCommand(id, exitCode) {
  const db = getDb();
  const now = Date.now();
  const result = db.prepare("UPDATE commands SET exit_code = ?, ended_at = ? WHERE id = ?").run(exitCode, now, id);
  return result.changes > 0;
}
function listCommands(tabId, limit = 50) {
  const db = getDb();
  const rows = db.prepare(
    "SELECT * FROM commands WHERE tab_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?"
  ).all(tabId, limit);
  return rows.map((r) => ({
    id: r.id,
    sessionName: r.session_name,
    tabId: r.tab_id,
    command: r.command,
    exitCode: r.exit_code,
    cwd: r.cwd,
    startedAt: r.started_at,
    endedAt: r.ended_at
  }));
}
function getChunksSince(tabId, sinceSeq) {
  const db = getDb();
  const rows = db.prepare(
    "SELECT * FROM tab_stream_chunks WHERE tab_id = ? AND seq_to > ? ORDER BY seq_from"
  ).all(tabId, sinceSeq);
  return rows.map((r) => ({
    tabId: r.tab_id,
    seqFrom: r.seq_from,
    seqTo: r.seq_to,
    createdAt: r.created_at,
    data: r.data
  }));
}
function updateDeviceCursor(deviceId, tabId, lastAckedSeq) {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO device_tab_cursors (device_id, tab_id, last_acked_seq, updated_at)
     VALUES (?, ?, ?, ?)`
  ).run(deviceId, tabId, lastAckedSeq, Date.now());
}
function getDeviceCursor(deviceId, tabId) {
  const db = getDb();
  const row = db.prepare(
    "SELECT last_acked_seq, updated_at FROM device_tab_cursors WHERE device_id = ? AND tab_id = ?"
  ).get(deviceId, tabId);
  if (!row) return null;
  return {
    lastAckedSeq: row.last_acked_seq,
    updatedAt: row.updated_at
  };
}
var REMUX_DIR, PORT, PERSIST_ID, _db;
var init_store = __esm({
  "src/store.ts"() {
    "use strict";
    REMUX_DIR = path.join(homedir(), ".remux");
    PORT = process.env.PORT || 8767;
    PERSIST_ID = process.env.REMUX_INSTANCE_ID || `port-${PORT}`;
    _db = null;
  }
});

// src/auth.ts
import crypto2 from "crypto";
function addPasswordToken(token) {
  passwordTokens.set(token, Date.now() + PASSWORD_TOKEN_TTL_MS);
}
function parseCliPassword(argv) {
  const idx = argv.indexOf("--password");
  return idx !== -1 && idx + 1 < argv.length ? argv[idx + 1] : null;
}
function resolveAuth(argv) {
  const PASSWORD2 = process.env.REMUX_PASSWORD || parseCliPassword(argv) || null;
  const TOKEN2 = process.env.REMUX_TOKEN || (PASSWORD2 ? null : crypto2.randomBytes(16).toString("hex"));
  return { TOKEN: TOKEN2, PASSWORD: PASSWORD2 };
}
function generateToken() {
  return crypto2.randomBytes(16).toString("hex");
}
function validateToken(token, TOKEN2) {
  if (TOKEN2 && token.length === TOKEN2.length) {
    const equal = crypto2.timingSafeEqual(Buffer.from(token), Buffer.from(TOKEN2));
    if (equal) return true;
  }
  const entry = passwordTokens.get(token);
  if (entry && Date.now() < entry) return true;
  return false;
}
function registerDevice(req, clientDeviceId) {
  if (clientDeviceId) {
    const existing2 = findDeviceById(clientDeviceId);
    if (existing2) {
      touchDevice(existing2.id);
      return { device: existing2, isNew: false };
    }
    const isFirst2 = !hasAnyDevice();
    const trust2 = isFirst2 ? "trusted" : "untrusted";
    const device2 = createDevice(clientDeviceId, trust2, void 0, clientDeviceId);
    return { device: device2, isNew: true };
  }
  const ua = req.headers["user-agent"] || "";
  const lang = req.headers["accept-language"] || "";
  const fingerprint = computeFingerprint(ua, lang);
  const existing = findDeviceByFingerprint(fingerprint);
  if (existing) {
    touchDevice(existing.id);
    return { device: existing, isNew: false };
  }
  const isFirst = !hasAnyDevice();
  const trust = isFirst ? "trusted" : "untrusted";
  const device = createDevice(fingerprint, trust);
  return { device, isNew: true };
}
var PASSWORD_TOKEN_TTL_MS, passwordTokens, PASSWORD_PAGE;
var init_auth = __esm({
  "src/auth.ts"() {
    "use strict";
    init_store();
    PASSWORD_TOKEN_TTL_MS = 24 * 60 * 60 * 1e3;
    passwordTokens = /* @__PURE__ */ new Map();
    setInterval(() => {
      const now = Date.now();
      for (const [token, expiresAt] of passwordTokens) {
        if (now >= expiresAt) passwordTokens.delete(token);
      }
    }, 10 * 60 * 1e3).unref();
    PASSWORD_PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Remux \u2014 Login</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #1e1e1e; color: #ccc; height: 100vh; display: flex;
      align-items: center; justify-content: center; }
    .login { background: #252526; border-radius: 8px; padding: 32px; width: 320px;
      box-shadow: 0 4px 24px rgba(0,0,0,.4); }
    .login h1 { font-size: 18px; color: #e5e5e5; margin-bottom: 20px; text-align: center; }
    .login input { width: 100%; padding: 10px 12px; font-size: 14px; background: #1e1e1e;
      border: 1px solid #3a3a3a; border-radius: 4px; color: #d4d4d4;
      font-family: inherit; outline: none; margin-bottom: 12px; }
    .login input:focus { border-color: #007acc; }
    .login button { width: 100%; padding: 10px; font-size: 14px; background: #007acc;
      border: none; border-radius: 4px; color: #fff; cursor: pointer;
      font-family: inherit; font-weight: 500; }
    .login button:hover { background: #0098ff; }
    .login .error { color: #f14c4c; font-size: 12px; margin-bottom: 12px; display: none; text-align: center; }
  </style>
</head>
<body>
  <form class="login" method="POST" action="/auth">
    <h1>Remux</h1>
    <div class="error" id="error">Incorrect password</div>
    <input type="password" name="password" placeholder="Password" autofocus required />
    <button type="submit">Login</button>
  </form>
  <script>
    if (location.search.includes('error=1')) document.getElementById('error').style.display = 'block';
  </script>
</body>
</html>`;
  }
});

// src/vt-tracker.ts
import fs2 from "fs";
async function initGhosttyVt(wasmPath2) {
  const wasmBytes = fs2.readFileSync(wasmPath2);
  const result = await WebAssembly.instantiate(wasmBytes, {
    env: { log: () => {
    } }
  });
  wasmExports = result.instance.exports;
  wasmMemory = wasmExports.memory;
  console.log("[ghostty-vt] WASM loaded for server-side VT tracking");
}
function createVtTerminal(cols, rows) {
  if (!wasmExports) return null;
  const handle = wasmExports.ghostty_terminal_new(cols, rows);
  if (!handle) return null;
  return {
    handle,
    consume(data) {
      if (!this.handle) return;
      const bytes = typeof data === "string" ? Buffer.from(data) : data;
      const ptr = wasmExports.ghostty_wasm_alloc_u8_array(bytes.length);
      new Uint8Array(wasmMemory.buffer).set(bytes, ptr);
      wasmExports.ghostty_terminal_write(handle, ptr, bytes.length);
      wasmExports.ghostty_wasm_free_u8_array(ptr, bytes.length);
    },
    resize(cols2, rows2) {
      if (!this.handle) return;
      wasmExports.ghostty_terminal_resize(handle, cols2, rows2);
    },
    isAltScreen() {
      if (!this.handle) return false;
      return !!wasmExports.ghostty_terminal_is_alternate_screen(handle);
    },
    snapshot() {
      if (!this.handle) return null;
      wasmExports.ghostty_render_state_update(handle);
      const cols2 = wasmExports.ghostty_render_state_get_cols(handle);
      const rows2 = wasmExports.ghostty_render_state_get_rows(handle);
      const cellSize = 16;
      const bufSize = cols2 * rows2 * cellSize;
      const bufPtr = wasmExports.ghostty_wasm_alloc_u8_array(bufSize);
      const count = wasmExports.ghostty_render_state_get_viewport(
        handle,
        bufPtr,
        bufSize
      );
      const view = new DataView(wasmMemory.buffer);
      let out = "\x1B[H\x1B[2J";
      let lastFg = null;
      let lastBg = null;
      let lastFlags = 0;
      for (let row = 0; row < rows2; row++) {
        if (row > 0) out += "\r\n";
        for (let col = 0; col < cols2; col++) {
          const off = bufPtr + (row * cols2 + col) * cellSize;
          const cp = view.getUint32(off, true);
          const fg_r = view.getUint8(off + 4);
          const fg_g = view.getUint8(off + 5);
          const fg_b = view.getUint8(off + 6);
          const bg_r = view.getUint8(off + 7);
          const bg_g = view.getUint8(off + 8);
          const bg_b = view.getUint8(off + 9);
          const flags = view.getUint8(off + 10);
          const width = view.getUint8(off + 11);
          if (width === 0) continue;
          const fgKey = fg_r << 16 | fg_g << 8 | fg_b;
          const bgKey = bg_r << 16 | bg_g << 8 | bg_b;
          let sgr = "";
          if (flags !== lastFlags) {
            sgr += "\x1B[0m";
            if (flags & 1) sgr += "\x1B[1m";
            if (flags & 2) sgr += "\x1B[3m";
            if (flags & 4) sgr += "\x1B[4m";
            if (flags & 128) sgr += "\x1B[2m";
            lastFg = null;
            lastBg = null;
            lastFlags = flags;
          }
          if (fgKey !== lastFg && fgKey !== 0) {
            sgr += `\x1B[38;2;${fg_r};${fg_g};${fg_b}m`;
            lastFg = fgKey;
          }
          if (bgKey !== lastBg && bgKey !== 0) {
            sgr += `\x1B[48;2;${bg_r};${bg_g};${bg_b}m`;
            lastBg = bgKey;
          }
          out += sgr;
          out += cp > 0 ? String.fromCodePoint(cp) : " ";
        }
      }
      const cx = wasmExports.ghostty_render_state_get_cursor_x(handle);
      const cy = wasmExports.ghostty_render_state_get_cursor_y(handle);
      out += `\x1B[0m\x1B[${cy + 1};${cx + 1}H`;
      wasmExports.ghostty_wasm_free_u8_array(bufPtr, bufSize);
      return out;
    },
    textSnapshot() {
      if (!this.handle) return { text: "", cols: 0, rows: 0 };
      wasmExports.ghostty_render_state_update(handle);
      const cols2 = wasmExports.ghostty_render_state_get_cols(handle);
      const rows2 = wasmExports.ghostty_render_state_get_rows(handle);
      const cellSize = 16;
      const bufSize = cols2 * rows2 * cellSize;
      const bufPtr = wasmExports.ghostty_wasm_alloc_u8_array(bufSize);
      wasmExports.ghostty_render_state_get_viewport(handle, bufPtr, bufSize);
      const view = new DataView(wasmMemory.buffer);
      const lines = [];
      for (let row = 0; row < rows2; row++) {
        let line = "";
        for (let col = 0; col < cols2; col++) {
          const off = bufPtr + (row * cols2 + col) * cellSize;
          const cp = view.getUint32(off, true);
          const width = view.getUint8(off + 11);
          if (width === 0) continue;
          line += cp > 0 ? String.fromCodePoint(cp) : " ";
        }
        lines.push(line.trimEnd());
      }
      wasmExports.ghostty_wasm_free_u8_array(bufPtr, bufSize);
      while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
      return { text: lines.join("\n"), cols: cols2, rows: rows2 };
    },
    dispose() {
      if (this.handle === 0) return;
      wasmExports.ghostty_terminal_free(handle);
      this.handle = 0;
    }
  };
}
var wasmExports, wasmMemory;
var init_vt_tracker = __esm({
  "src/vt-tracker.ts"() {
    "use strict";
    wasmExports = null;
    wasmMemory = null;
  }
});

// src/push.ts
import webpush from "web-push";
function initPush() {
  let pubKey = getSetting(VAPID_PUBLIC_KEY);
  let privKey = getSetting(VAPID_PRIVATE_KEY);
  if (!pubKey || !privKey) {
    const keys = webpush.generateVAPIDKeys();
    pubKey = keys.publicKey;
    privKey = keys.privateKey;
    setSetting(VAPID_PUBLIC_KEY, pubKey);
    setSetting(VAPID_PRIVATE_KEY, privKey);
    console.log("[push] generated new VAPID keys");
  } else {
    console.log("[push] loaded VAPID keys from store");
  }
  webpush.setVapidDetails(VAPID_SUBJECT, pubKey, privKey);
  vapidPublicKey = pubKey;
  vapidReady = true;
}
function getVapidPublicKey() {
  return vapidPublicKey;
}
async function sendPushNotification(deviceId, title, body) {
  if (!vapidReady) return false;
  const sub = getPushSubscription(deviceId);
  if (!sub) return false;
  const payload = JSON.stringify({ title, body, tag: "notification" });
  try {
    await webpush.sendNotification(
      {
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth }
      },
      payload
    );
    return true;
  } catch (err) {
    if (err.statusCode === 404 || err.statusCode === 410) {
      removePushSubscription(deviceId);
      console.log(
        `[push] removed stale subscription for device ${deviceId} (${err.statusCode})`
      );
    } else {
      console.error(`[push] failed to send to device ${deviceId}:`, err.message);
    }
    return false;
  }
}
async function broadcastPush(title, body, excludeDeviceIds = []) {
  if (!vapidReady) return;
  const subs = listPushSubscriptions();
  const excludeSet = new Set(excludeDeviceIds);
  const promises = subs.filter((s) => !excludeSet.has(s.deviceId)).map((s) => sendPushNotification(s.deviceId, title, body));
  await Promise.allSettled(promises);
}
var VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, vapidPublicKey, vapidReady;
var init_push = __esm({
  "src/push.ts"() {
    "use strict";
    init_store();
    VAPID_PUBLIC_KEY = "vapid_public_key";
    VAPID_PRIVATE_KEY = "vapid_private_key";
    VAPID_SUBJECT = "mailto:remux@localhost";
    vapidPublicKey = null;
    vapidReady = false;
  }
});

// src/pty-daemon.ts
import net from "net";
import pty from "node-pty";
import { parseArgs } from "util";
function encodeFrame(tag, payload) {
  const data = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  const frame = Buffer.alloc(5 + data.length);
  frame[0] = tag;
  frame.writeUInt32BE(data.length, 1);
  data.copy(frame, 5);
  return frame;
}
function parseCliArgs() {
  const { values } = parseArgs({
    options: {
      socket: { type: "string" },
      shell: { type: "string" },
      cols: { type: "string" },
      rows: { type: "string" },
      cwd: { type: "string" },
      "tab-id": { type: "string" }
    },
    strict: true
  });
  if (!values.socket || !values.shell) {
    console.error("Usage: pty-daemon --socket <path> --shell <shell> [--cols N] [--rows N] [--cwd dir] [--tab-id id]");
    process.exit(1);
  }
  return {
    socket: values.socket,
    shell: values.shell,
    cols: parseInt(values.cols || "80", 10),
    rows: parseInt(values.rows || "24", 10),
    cwd: values.cwd || process.env.HOME || "/",
    tabId: values["tab-id"] || "0"
  };
}
function main() {
  const args = parseCliArgs();
  let seq = 0;
  if (typeof process.disconnect === "function") {
    try {
      process.disconnect();
    } catch {
    }
  }
  const ptyProcess = pty.spawn(args.shell, [], {
    name: "xterm-256color",
    cols: args.cols,
    rows: args.rows,
    cwd: args.cwd,
    env: {
      ...process.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor"
    }
  });
  const scrollback = new RingBuffer();
  const clients = /* @__PURE__ */ new Set();
  let alive = true;
  console.log(`[pty-daemon] started: pid=${ptyProcess.pid} socket=${args.socket} tab-id=${args.tabId}`);
  ptyProcess.onData((data) => {
    seq++;
    scrollback.write(data);
    const frame = encodeFrame(TAG_PTY_OUTPUT, data);
    for (const client of clients) {
      try {
        client.write(frame);
      } catch {
      }
    }
  });
  ptyProcess.onExit(({ exitCode }) => {
    alive = false;
    console.log(`[pty-daemon] PTY exited: code=${exitCode} tab-id=${args.tabId}`);
    const exitMsg = `\r
\x1B[33mShell exited (code: ${exitCode})\x1B[0m\r
`;
    const frame = encodeFrame(TAG_PTY_OUTPUT, exitMsg);
    for (const client of clients) {
      try {
        client.write(frame);
      } catch {
      }
    }
    setTimeout(() => {
      for (const client of clients) {
        try {
          client.end();
        } catch {
        }
      }
      cleanup();
    }, 2e3);
  });
  const server = net.createServer((socket) => {
    clients.add(socket);
    console.log(`[pty-daemon] client connected (total: ${clients.size})`);
    const parser = new FrameParser((tag, payload) => {
      switch (tag) {
        case TAG_CLIENT_INPUT:
          if (alive) {
            ptyProcess.write(payload.toString("utf8"));
          }
          break;
        case TAG_RESIZE: {
          try {
            const { cols, rows } = JSON.parse(payload.toString("utf8"));
            if (alive && cols > 0 && rows > 0) {
              ptyProcess.resize(
                Math.max(1, Math.min(cols, 500)),
                Math.max(1, Math.min(rows, 200))
              );
            }
          } catch {
          }
          break;
        }
        case TAG_STATUS_REQ: {
          const status = JSON.stringify({
            pid: ptyProcess.pid,
            cols: args.cols,
            rows: args.rows,
            alive,
            cwd: args.cwd,
            tabId: args.tabId,
            seq
          });
          socket.write(encodeFrame(TAG_STATUS_RES, status));
          break;
        }
        case TAG_SNAPSHOT_REQ: {
          const data = scrollback.read();
          socket.write(encodeFrame(TAG_SNAPSHOT_RES, data));
          break;
        }
        case TAG_SCROLLBACK_REQ: {
          const data = scrollback.read();
          socket.write(encodeFrame(TAG_SCROLLBACK_RES, data));
          break;
        }
        case TAG_SHUTDOWN:
          console.log(`[pty-daemon] shutdown requested`);
          if (alive) {
            try {
              ptyProcess.kill();
            } catch {
            }
          }
          for (const c of clients) {
            try {
              c.end();
            } catch {
            }
          }
          cleanup();
          break;
      }
    });
    socket.on("data", (data) => {
      parser.feed(Buffer.isBuffer(data) ? data : Buffer.from(data));
    });
    socket.on("close", () => {
      clients.delete(socket);
      console.log(`[pty-daemon] client disconnected (total: ${clients.size})`);
    });
    socket.on("error", (err) => {
      console.error(`[pty-daemon] client socket error:`, err.message);
      clients.delete(socket);
    });
  });
  try {
    const fs8 = __require("fs");
    if (fs8.existsSync(args.socket)) {
      fs8.unlinkSync(args.socket);
    }
  } catch {
  }
  server.listen(args.socket, () => {
    console.log(`[pty-daemon] listening on ${args.socket}`);
  });
  server.on("error", (err) => {
    console.error(`[pty-daemon] server error:`, err.message);
    cleanup();
  });
  function cleanup() {
    try {
      const fs8 = __require("fs");
      if (fs8.existsSync(args.socket)) {
        fs8.unlinkSync(args.socket);
      }
    } catch {
    }
    server.close();
    process.exit(0);
  }
  process.on("SIGTERM", () => {
    console.log(`[pty-daemon] SIGTERM received`);
    if (alive) {
      try {
        ptyProcess.kill();
      } catch {
      }
    }
    cleanup();
  });
  process.on("SIGINT", () => {
  });
}
var TAG_PTY_OUTPUT, TAG_CLIENT_INPUT, TAG_RESIZE, TAG_STATUS_REQ, TAG_STATUS_RES, TAG_SNAPSHOT_REQ, TAG_SNAPSHOT_RES, TAG_SCROLLBACK_REQ, TAG_SCROLLBACK_RES, TAG_SHUTDOWN, FrameParser, RingBuffer, isMainEntry;
var init_pty_daemon = __esm({
  "src/pty-daemon.ts"() {
    "use strict";
    TAG_PTY_OUTPUT = 1;
    TAG_CLIENT_INPUT = 2;
    TAG_RESIZE = 3;
    TAG_STATUS_REQ = 4;
    TAG_STATUS_RES = 5;
    TAG_SNAPSHOT_REQ = 6;
    TAG_SNAPSHOT_RES = 7;
    TAG_SCROLLBACK_REQ = 8;
    TAG_SCROLLBACK_RES = 9;
    TAG_SHUTDOWN = 255;
    FrameParser = class {
      buffer = Buffer.alloc(0);
      onFrame;
      constructor(onFrame) {
        this.onFrame = onFrame;
      }
      feed(data) {
        this.buffer = Buffer.concat([this.buffer, data]);
        while (this.buffer.length >= 5) {
          const tag = this.buffer[0];
          const length = this.buffer.readUInt32BE(1);
          if (this.buffer.length < 5 + length) break;
          const payload = this.buffer.subarray(5, 5 + length);
          this.buffer = this.buffer.subarray(5 + length);
          this.onFrame(tag, payload);
        }
      }
    };
    RingBuffer = class {
      buf;
      maxBytes;
      writePos;
      length;
      constructor(maxBytes = 10 * 1024 * 1024) {
        this.buf = Buffer.alloc(maxBytes);
        this.maxBytes = maxBytes;
        this.writePos = 0;
        this.length = 0;
      }
      write(data) {
        const bytes = typeof data === "string" ? Buffer.from(data) : data;
        if (bytes.length >= this.maxBytes) {
          bytes.copy(this.buf, 0, bytes.length - this.maxBytes);
          this.writePos = 0;
          this.length = this.maxBytes;
          return;
        }
        const space = this.maxBytes - this.writePos;
        if (bytes.length <= space) {
          bytes.copy(this.buf, this.writePos);
        } else {
          bytes.copy(this.buf, this.writePos, 0, space);
          bytes.copy(this.buf, 0, space);
        }
        this.writePos = (this.writePos + bytes.length) % this.maxBytes;
        this.length = Math.min(this.length + bytes.length, this.maxBytes);
      }
      read() {
        if (this.length === 0) return Buffer.alloc(0);
        if (this.length < this.maxBytes) {
          return Buffer.from(this.buf.subarray(this.writePos - this.length, this.writePos));
        }
        return Buffer.concat([
          this.buf.subarray(this.writePos),
          this.buf.subarray(0, this.writePos)
        ]);
      }
    };
    isMainEntry = process.argv[1]?.includes("pty-daemon") || process.argv.includes("--socket");
    if (isMainEntry) {
      main();
    }
  }
});

// src/session.ts
import fs3 from "fs";
import path2 from "path";
import net2 from "net";
import { homedir as homedir2 } from "os";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import pty2 from "node-pty";
function getShell() {
  if (process.platform === "win32") return process.env.COMSPEC || "cmd.exe";
  if (process.env.SHELL) return process.env.SHELL;
  try {
    fs3.accessSync("/bin/zsh", fs3.constants.X_OK);
    return "/bin/zsh";
  } catch {
  }
  return "/bin/bash";
}
function getDaemonScriptPath() {
  return path2.join(__dirname, "pty-daemon.js");
}
function buildSocketPath(tabId) {
  return `/tmp/remux-pty-${tabId}-${process.pid}.sock`;
}
function spawnDaemon(tabId, shell, cols, rows, cwd) {
  const socketPath = buildSocketPath(tabId);
  const daemonScript = getDaemonScriptPath();
  const child = spawn(process.execPath, [
    daemonScript,
    "--socket",
    socketPath,
    "--shell",
    shell,
    "--cols",
    String(cols),
    "--rows",
    String(rows),
    "--cwd",
    cwd,
    "--tab-id",
    String(tabId)
  ], {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
  console.log(`[session] spawned daemon for tab ${tabId}: pid=${child.pid} socket=${socketPath}`);
  return socketPath;
}
function connectToDaemon(socketPath, retries = 20, delayMs = 100) {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    function tryConnect() {
      attempt++;
      const socket = net2.createConnection({ path: socketPath }, () => {
        resolve(socket);
      });
      socket.on("error", (err) => {
        socket.destroy();
        if (attempt < retries) {
          setTimeout(tryConnect, delayMs);
        } else {
          reject(new Error(`Failed to connect to daemon at ${socketPath} after ${retries} attempts: ${err.message}`));
        }
      });
    }
    tryConnect();
  });
}
function wireDaemonToTab(tab, daemonSocket, sessionName) {
  const parser = new FrameParser((tag, payload) => {
    if (tag === TAG_PTY_OUTPUT) {
      const data = payload.toString("utf8");
      tab.scrollback.write(data);
      if (tab.vt) tab.vt.consume(data);
      for (const ws of tab.clients) {
        sendData(ws, data);
      }
      if (_bufferTabOutputFn) _bufferTabOutputFn(tab.id, data);
      processShellIntegration(data, tab, sessionName);
      try {
        const { adapterRegistry: adapterRegistry2 } = (init_server(), __toCommonJS(server_exports));
        adapterRegistry2?.dispatchTerminalData(sessionName, data);
      } catch {
      }
      const now = Date.now();
      const wasIdle = isIdle || now - lastOutputTimestamp > IDLE_THRESHOLD_MS;
      if (now - lastOutputTimestamp > IDLE_THRESHOLD_MS) {
        isIdle = true;
      }
      if (wasIdle && isIdle) {
        isIdle = false;
        const connectedDeviceIds = [];
        for (const ws of controlClients) {
          if (ws._remuxDeviceId) connectedDeviceIds.push(ws._remuxDeviceId);
        }
        broadcastPush(
          "Terminal Activity",
          `New output in "${sessionName}" after idle`,
          connectedDeviceIds
        ).catch(() => {
        });
      }
      lastOutputTimestamp = now;
    }
  });
  daemonSocket.on("data", (data) => {
    parser.feed(data);
  });
  daemonSocket.on("close", () => {
    console.log(`[session] daemon connection closed for tab ${tab.id}`);
    tab.daemonClient = null;
    if (!tab.ended) {
      tab.ended = true;
      if (tab.vt) {
        tab.vt.dispose();
        tab.vt = null;
      }
      const msg = `\r
\x1B[33mDaemon connection lost\x1B[0m\r
`;
      for (const ws of tab.clients) {
        sendData(ws, msg);
      }
      broadcastState();
    }
  });
  daemonSocket.on("error", (err) => {
    console.error(`[session] daemon socket error for tab ${tab.id}:`, err.message);
  });
}
async function reviveTab(tab, session) {
  if (!tab.restored) return false;
  const shell = getShell();
  const socketPath = spawnDaemon(tab.id, shell, tab.cols, tab.rows, homedir2());
  try {
    const client = await connectToDaemon(socketPath);
    tab.daemonSocket = socketPath;
    tab.daemonClient = client;
    tab.restored = false;
    tab.ended = false;
    tab.vt = createVtTerminal(tab.cols, tab.rows);
    wireDaemonToTab(tab, client, session.name);
    console.log(`[session] revived tab ${tab.id} in session "${session.name}"`);
    broadcastState();
    return true;
  } catch (err) {
    console.error(`[session] failed to revive tab ${tab.id}:`, err.message);
    return false;
  }
}
function processShellIntegration(data, tab, sessionName) {
  const si = tab.shellIntegration;
  const osc7Re = /\x1b\]7;file:\/\/[^/]*([^\x07\x1b]*?)(?:\x07|\x1b\\)/g;
  let m7;
  while ((m7 = osc7Re.exec(data)) !== null) {
    const cwdPath = decodeURIComponent(m7[1]);
    if (cwdPath) si.cwd = cwdPath;
  }
  const osc133Re = /\x1b\]133;([ABCD])(?:;([^\x07\x1b]*?))?(?:\x07|\x1b\\)/g;
  let m;
  while ((m = osc133Re.exec(data)) !== null) {
    const marker = m[1];
    const params = m[2] || "";
    switch (marker) {
      case "A":
        si.phase = "prompt";
        si.commandBuffer = "";
        break;
      case "B":
        si.phase = "command";
        si.commandBuffer = "";
        break;
      case "C": {
        const bIdx = data.indexOf("\x1B]133;B");
        const cIdx = data.indexOf("\x1B]133;C");
        if (bIdx >= 0 && cIdx > bIdx) {
          const bEnd = data.indexOf("\x07", bIdx);
          const bEnd2 = data.indexOf("\x1B\\", bIdx);
          const bEndPos = bEnd >= 0 && bEnd < cIdx ? bEnd + 1 : bEnd2 >= 0 && bEnd2 < cIdx ? bEnd2 + 2 : bIdx + 9;
          const cmdText = data.slice(bEndPos, cIdx).trim();
          if (cmdText) si.commandBuffer = cmdText;
        }
        si.phase = "output";
        const cmd = createCommand({
          sessionName,
          tabId: tab.id,
          command: si.commandBuffer || void 0,
          cwd: si.cwd || void 0
        });
        si.activeCommandId = cmd.id;
        break;
      }
      case "D": {
        const exitCode = params ? parseInt(params, 10) : 0;
        if (si.activeCommandId) {
          completeCommand(
            si.activeCommandId,
            isNaN(exitCode) ? 0 : exitCode
          );
          si.activeCommandId = null;
        }
        si.phase = "idle";
        si.commandBuffer = "";
        break;
      }
    }
  }
}
function createTab(session, cols = 80, rows = 24) {
  const id = tabIdCounter++;
  const shell = getShell();
  const daemonScript = getDaemonScriptPath();
  const useDaemon = fs3.existsSync(daemonScript);
  let ptyProcess = null;
  let socketPath = null;
  const vtTerminal = createVtTerminal(cols, rows);
  const tab = {
    id,
    pty: null,
    scrollback: new RingBuffer2(),
    vt: vtTerminal,
    clients: /* @__PURE__ */ new Set(),
    cols,
    rows,
    ended: false,
    title: `Tab ${session.tabs.length + 1}`,
    shellIntegration: {
      phase: "idle",
      commandBuffer: "",
      cwd: null,
      activeCommandId: null
    },
    daemonSocket: null,
    daemonClient: null,
    restored: false
  };
  if (useDaemon) {
    socketPath = spawnDaemon(id, shell, cols, rows, homedir2());
    tab.daemonSocket = socketPath;
    connectToDaemon(socketPath).then((client) => {
      tab.daemonClient = client;
      wireDaemonToTab(tab, client, session.name);
      console.log(`[tab] daemon connected for id=${id} in session "${session.name}"`);
    }).catch((err) => {
      console.error(`[tab] failed to connect to daemon for id=${id}:`, err.message);
      spawnDirectPty(tab, session, shell, cols, rows);
    });
  } else {
    spawnDirectPty(tab, session, shell, cols, rows);
  }
  session.tabs.push(tab);
  console.log(
    `[tab] created id=${id} in session "${session.name}" (mode=${useDaemon ? "daemon" : "direct"})`
  );
  return tab;
}
function spawnDirectPty(tab, session, shell, cols, rows) {
  const ptyProcess = pty2.spawn(shell, [], {
    name: "xterm-256color",
    cols,
    rows,
    cwd: homedir2(),
    env: {
      ...process.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor"
    }
  });
  tab.pty = ptyProcess;
  ptyProcess.onData((data) => {
    tab.scrollback.write(data);
    if (tab.vt) tab.vt.consume(data);
    for (const ws of tab.clients) {
      sendData(ws, data);
    }
    if (_bufferTabOutputFn) _bufferTabOutputFn(tab.id, data);
    processShellIntegration(data, tab, session.name);
    try {
      const { adapterRegistry: adapterRegistry2 } = (init_server(), __toCommonJS(server_exports));
      adapterRegistry2?.dispatchTerminalData(session.name, data);
    } catch {
    }
    const now = Date.now();
    const wasIdle = isIdle || now - lastOutputTimestamp > IDLE_THRESHOLD_MS;
    if (now - lastOutputTimestamp > IDLE_THRESHOLD_MS) {
      isIdle = true;
    }
    if (wasIdle && isIdle) {
      isIdle = false;
      const connectedDeviceIds = [];
      for (const ws of controlClients) {
        if (ws._remuxDeviceId) connectedDeviceIds.push(ws._remuxDeviceId);
      }
      broadcastPush(
        "Terminal Activity",
        `New output in "${session.name}" after idle`,
        connectedDeviceIds
      ).catch(() => {
      });
    }
    lastOutputTimestamp = now;
  });
  ptyProcess.onExit(({ exitCode }) => {
    tab.ended = true;
    if (tab.vt) {
      tab.vt.dispose();
      tab.vt = null;
    }
    const msg = `\r
\x1B[33mShell exited (code: ${exitCode})\x1B[0m\r
`;
    for (const ws of tab.clients) {
      sendData(ws, msg);
    }
    broadcastState();
    broadcastPush(
      "Shell Exited",
      `"${session.name}" tab "${tab.title}" exited (code: ${exitCode})`
    ).catch(() => {
    });
  });
}
function createSession(name) {
  if (sessionMap.has(name)) return sessionMap.get(name);
  const session = { name, tabs: [], createdAt: Date.now() };
  sessionMap.set(name, session);
  console.log(`[session] created "${name}"`);
  return session;
}
function deleteSession(name) {
  const session = sessionMap.get(name);
  if (!session) return;
  for (const tab of session.tabs) {
    if (!tab.ended) {
      if (tab.daemonClient) {
        try {
          tab.daemonClient.write(encodeFrame(TAG_SHUTDOWN, Buffer.alloc(0)));
        } catch {
        }
      } else if (tab.pty) {
        tab.pty.kill();
      }
    }
  }
  sessionMap.delete(name);
  removeSession(name);
  console.log(`[session] deleted "${name}"`);
}
function getFirstSessionName() {
  const first = sessionMap.values().next();
  return first.done ? null : first.value.name;
}
function getState() {
  return [...sessionMap.values()].map((s) => ({
    name: s.name,
    tabs: s.tabs.map((t) => ({
      id: t.id,
      title: t.title,
      ended: t.ended,
      clients: t.clients.size,
      restored: t.restored
    })),
    createdAt: s.createdAt
  }));
}
function findTab(tabId) {
  if (tabId == null) return null;
  for (const session of sessionMap.values()) {
    const tab = session.tabs.find((t) => t.id === tabId);
    if (tab) return { session, tab };
  }
  return null;
}
function attachToTab(tab, ws, cols, rows) {
  detachFromTab(ws);
  if (ws.readyState === ws.OPEN) {
    if (tab.vt && !tab.ended) {
      const snapshot = tab.vt.snapshot();
      if (snapshot) sendData(ws, snapshot);
    } else {
      const history = tab.scrollback.read();
      if (history.length > 0) sendData(ws, history.toString("utf8"));
    }
  }
  tab.clients.add(ws);
  ws._remuxTabId = tab.id;
  ws._remuxCols = cols;
  ws._remuxRows = rows;
  recalcTabSize(tab);
  if (tab.restored) {
    const banner = `\r
\x1B[33m[Session restored \u2014 shell has exited. Press Enter to start a new shell.]\x1B[0m\r
`;
    sendData(ws, banner);
  }
  if (!tab.ended && !tab.restored && tab.vt) {
    const { text } = tab.vt.textSnapshot();
    if (text && text.trim().length > 0) {
      setTimeout(() => {
        if (tab.daemonClient) {
          tab.daemonClient.write(encodeFrame(TAG_CLIENT_INPUT, "\f"));
        } else if (tab.pty) {
          tab.pty.write("\f");
        }
      }, 50);
    }
  }
}
function detachFromTab(ws) {
  const prevId = ws._remuxTabId;
  if (prevId == null) return;
  for (const session of sessionMap.values()) {
    const tab = session.tabs.find((t) => t.id === prevId);
    if (tab) {
      tab.clients.delete(ws);
      if (tab.clients.size > 0) recalcTabSize(tab);
      break;
    }
  }
  ws._remuxTabId = null;
}
function recalcTabSize(tab) {
  let minCols = Infinity;
  let minRows = Infinity;
  for (const ws of tab.clients) {
    if (ws._remuxCols) minCols = Math.min(minCols, ws._remuxCols);
    if (ws._remuxRows) minRows = Math.min(minRows, ws._remuxRows);
  }
  if (minCols < Infinity && minRows < Infinity && !tab.ended) {
    minCols = Math.max(1, Math.min(minCols, 500));
    minRows = Math.max(1, Math.min(minRows, 200));
    tab.cols = minCols;
    tab.rows = minRows;
    if (tab.daemonClient) {
      const resizePayload = JSON.stringify({ cols: minCols, rows: minRows });
      tab.daemonClient.write(encodeFrame(TAG_RESIZE, resizePayload));
    } else if (tab.pty) {
      tab.pty.resize(minCols, minRows);
    }
    if (tab.vt) tab.vt.resize(minCols, minRows);
  }
}
function setBroadcastHooks(sendFn, clientListFn, sendDataFn) {
  _sendEnvelopeFn = sendFn;
  _getClientListFn = clientListFn;
  if (sendDataFn) _sendDataFn = sendDataFn;
}
function sendData(ws, data) {
  if (_sendDataFn) {
    _sendDataFn(ws, data);
  } else if (ws.readyState === ws.OPEN) {
    ws.send(data);
  }
}
function setBufferHooks(bufferTabOutputFn, bufferStateFn) {
  _bufferTabOutputFn = bufferTabOutputFn;
  _bufferStateForDisconnectedFn = bufferStateFn;
}
function broadcastState() {
  const state = getState();
  const clients = _getClientListFn ? _getClientListFn() : [];
  for (const ws of controlClients) {
    if (_sendEnvelopeFn) {
      _sendEnvelopeFn(ws, "state", { sessions: state, clients });
    } else {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ v: 1, type: "state", payload: { sessions: state, clients } }));
      }
    }
  }
  if (_bufferStateForDisconnectedFn) _bufferStateForDisconnectedFn();
}
function persistSessions() {
  try {
    for (const session of sessionMap.values()) {
      upsertSession(session.name, session.createdAt);
      for (const tab of session.tabs) {
        upsertTab({
          id: tab.id,
          sessionName: session.name,
          title: tab.title,
          scrollback: tab.ended ? null : tab.scrollback.read(),
          ended: tab.ended
        });
      }
    }
  } catch (e) {
    console.error("[persist] save failed:", e.message);
  }
}
function restoreSessions() {
  try {
    const sessions = loadSessions();
    if (sessions.length === 0) return false;
    console.log(`[persist] restoring ${sessions.length} session(s) from SQLite`);
    return { sessions };
  } catch (e) {
    console.error("[persist] restore failed:", e.message);
    return false;
  }
}
function findAliveDaemonSocket(tabId) {
  const tmpDir = "/tmp";
  try {
    const files = fs3.readdirSync(tmpDir);
    const pattern = `remux-pty-${tabId}-`;
    for (const f of files) {
      if (f.startsWith(pattern) && f.endsWith(".sock")) {
        return path2.join(tmpDir, f);
      }
    }
  } catch {
  }
  return null;
}
function createRestoredTab(session, savedTab) {
  if (savedTab.id >= tabIdCounter) {
    tabIdCounter = savedTab.id + 1;
  }
  const vtTerminal = createVtTerminal(80, 24);
  const tab = {
    id: savedTab.id,
    pty: null,
    scrollback: new RingBuffer2(),
    vt: vtTerminal,
    clients: /* @__PURE__ */ new Set(),
    cols: 80,
    rows: 24,
    ended: savedTab.ended,
    title: savedTab.title || `Tab ${session.tabs.length + 1}`,
    shellIntegration: {
      phase: "idle",
      commandBuffer: "",
      cwd: null,
      activeCommandId: null
    },
    daemonSocket: null,
    daemonClient: null,
    restored: !savedTab.ended
    // only "restored" if not already ended
  };
  if (savedTab.scrollback) {
    tab.scrollback.write(savedTab.scrollback);
    if (tab.vt) tab.vt.consume(savedTab.scrollback);
  }
  session.tabs.push(tab);
  return tab;
}
async function reattachToDaemon(tab, session, socketPath) {
  try {
    const client = await connectToDaemon(socketPath, 3, 50);
    tab.daemonSocket = socketPath;
    tab.daemonClient = client;
    tab.restored = false;
    tab.ended = false;
    wireDaemonToTab(tab, client, session.name);
    console.log(`[session] reattached to daemon for tab ${tab.id} at ${socketPath}`);
    return true;
  } catch (err) {
    console.log(`[session] daemon at ${socketPath} not reachable: ${err.message}`);
    return false;
  }
}
var __filename, __dirname, IDLE_THRESHOLD_MS, lastOutputTimestamp, isIdle, RingBuffer2, tabIdCounter, sessionMap, controlClients, _sendEnvelopeFn, _getClientListFn, _sendDataFn, _bufferTabOutputFn, _bufferStateForDisconnectedFn, PERSIST_INTERVAL_MS;
var init_session = __esm({
  "src/session.ts"() {
    "use strict";
    init_store();
    init_push();
    init_pty_daemon();
    init_vt_tracker();
    __filename = fileURLToPath(import.meta.url);
    __dirname = path2.dirname(__filename);
    IDLE_THRESHOLD_MS = 5 * 60 * 1e3;
    lastOutputTimestamp = Date.now();
    isIdle = false;
    RingBuffer2 = class {
      buf;
      maxBytes;
      writePos;
      length;
      constructor(maxBytes = 10 * 1024 * 1024) {
        this.buf = Buffer.alloc(maxBytes);
        this.maxBytes = maxBytes;
        this.writePos = 0;
        this.length = 0;
      }
      write(data) {
        const bytes = typeof data === "string" ? Buffer.from(data) : data;
        if (bytes.length >= this.maxBytes) {
          bytes.copy(this.buf, 0, bytes.length - this.maxBytes);
          this.writePos = 0;
          this.length = this.maxBytes;
          return;
        }
        const space = this.maxBytes - this.writePos;
        if (bytes.length <= space) {
          bytes.copy(this.buf, this.writePos);
        } else {
          bytes.copy(this.buf, this.writePos, 0, space);
          bytes.copy(this.buf, 0, space);
        }
        this.writePos = (this.writePos + bytes.length) % this.maxBytes;
        this.length = Math.min(this.length + bytes.length, this.maxBytes);
      }
      read() {
        if (this.length === 0) return Buffer.alloc(0);
        if (this.length < this.maxBytes) {
          return Buffer.from(this.buf.subarray(this.writePos - this.length, this.writePos));
        }
        return Buffer.concat([
          this.buf.subarray(this.writePos),
          this.buf.subarray(0, this.writePos)
        ]);
      }
    };
    tabIdCounter = 0;
    sessionMap = /* @__PURE__ */ new Map();
    controlClients = /* @__PURE__ */ new Set();
    _sendEnvelopeFn = null;
    _getClientListFn = null;
    _sendDataFn = null;
    _bufferTabOutputFn = null;
    _bufferStateForDisconnectedFn = null;
    PERSIST_INTERVAL_MS = 8e3;
  }
});

// src/e2ee.ts
import crypto3 from "crypto";
function generateKeyPair() {
  const { publicKey, privateKey } = crypto3.generateKeyPairSync("x25519", {
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" }
  });
  const rawPublic = publicKey.subarray(publicKey.length - 32);
  const rawPrivate = privateKey.subarray(privateKey.length - 32);
  return {
    publicKey: Buffer.from(rawPublic),
    privateKey: Buffer.from(rawPrivate)
  };
}
function deriveSharedSecret(privateKey, peerPublicKey) {
  const privKeyObj = crypto3.createPrivateKey({
    key: buildPkcs8(privateKey),
    format: "der",
    type: "pkcs8"
  });
  const pubKeyObj = crypto3.createPublicKey({
    key: buildSpki(peerPublicKey),
    format: "der",
    type: "spki"
  });
  const rawSecret = crypto3.diffieHellman({
    privateKey: privKeyObj,
    publicKey: pubKeyObj
  });
  const salt = Buffer.from(HKDF_SALT, "utf8");
  const info = Buffer.from(HKDF_INFO, "utf8");
  const derived = crypto3.hkdfSync("sha256", rawSecret, salt, info, AES_KEY_LENGTH);
  return Buffer.from(derived);
}
function buildPkcs8(rawKey) {
  const header = Buffer.from(
    "302e020100300506032b656e04220420",
    "hex"
  );
  return Buffer.concat([header, rawKey]);
}
function buildSpki(rawKey) {
  const header = Buffer.from("302a300506032b656e032100", "hex");
  return Buffer.concat([header, rawKey]);
}
function encrypt(key, plaintext, counter) {
  const iv = Buffer.alloc(IV_LENGTH);
  crypto3.randomFillSync(iv, 0, IV_PREFIX_LENGTH);
  iv.writeBigUInt64BE(counter, IV_PREFIX_LENGTH);
  const cipher = crypto3.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext: encrypted, tag, iv };
}
function decrypt(key, ciphertext, tag, iv) {
  const decipher = crypto3.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
var HKDF_SALT, HKDF_INFO, AES_KEY_LENGTH, IV_LENGTH, IV_PREFIX_LENGTH, AUTH_TAG_LENGTH, E2EESession;
var init_e2ee = __esm({
  "src/e2ee.ts"() {
    "use strict";
    HKDF_SALT = "remux-e2ee-v1";
    HKDF_INFO = "aes-256-gcm";
    AES_KEY_LENGTH = 32;
    IV_LENGTH = 12;
    IV_PREFIX_LENGTH = 4;
    AUTH_TAG_LENGTH = 16;
    E2EESession = class {
      sharedKey = null;
      sendCounter = 0n;
      recvCounter = -1n;
      // last received counter; -1 means none yet
      localKeyPair;
      constructor() {
        this.localKeyPair = generateKeyPair();
      }
      /** Get our public key as a base64-encoded string for transmission. */
      getPublicKey() {
        return this.localKeyPair.publicKey.toString("base64");
      }
      /**
       * Complete the ECDH handshake with the peer's base64-encoded public key.
       * After this, encrypt/decrypt operations become available.
       */
      completeHandshake(peerPublicKeyB64) {
        const peerPublicKey = Buffer.from(peerPublicKeyB64, "base64");
        this.sharedKey = deriveSharedSecret(
          this.localKeyPair.privateKey,
          peerPublicKey
        );
      }
      /**
       * Encrypt a plaintext string for sending.
       * Returns a base64-encoded string containing: iv (12) + ciphertext (variable) + tag (16).
       * Increments the send counter after each call.
       */
      encryptMessage(plaintext) {
        if (!this.sharedKey) {
          throw new Error("E2EE handshake not completed");
        }
        const plaintextBuf = Buffer.from(plaintext, "utf8");
        const { ciphertext, tag, iv } = encrypt(
          this.sharedKey,
          plaintextBuf,
          this.sendCounter
        );
        this.sendCounter++;
        const packed = Buffer.concat([iv, ciphertext, tag]);
        return packed.toString("base64");
      }
      /**
       * Decrypt a base64-encoded encrypted message.
       * Validates that the counter is monotonically increasing (anti-replay).
       */
      decryptMessage(encrypted) {
        if (!this.sharedKey) {
          throw new Error("E2EE handshake not completed");
        }
        const packed = Buffer.from(encrypted, "base64");
        if (packed.length < IV_LENGTH + AUTH_TAG_LENGTH) {
          throw new Error("E2EE message too short");
        }
        const iv = packed.subarray(0, IV_LENGTH);
        const ciphertext = packed.subarray(IV_LENGTH, packed.length - AUTH_TAG_LENGTH);
        const tag = packed.subarray(packed.length - AUTH_TAG_LENGTH);
        const counter = iv.readBigUInt64BE(IV_PREFIX_LENGTH);
        if (counter <= this.recvCounter) {
          throw new Error("E2EE replay detected: counter not monotonically increasing");
        }
        const decrypted = decrypt(this.sharedKey, ciphertext, tag, iv);
        this.recvCounter = counter;
        return decrypted.toString("utf8");
      }
      /** Whether the handshake has been completed and encryption is available. */
      isEstablished() {
        return this.sharedKey !== null;
      }
    };
  }
});

// src/message-buffer.ts
var MessageBuffer, BufferRegistry;
var init_message_buffer = __esm({
  "src/message-buffer.ts"() {
    "use strict";
    MessageBuffer = class {
      buffer = [];
      maxSize;
      maxAgeMs;
      constructor(maxSize = 1e3, maxAgeMs = 10 * 60 * 1e3) {
        this.maxSize = maxSize;
        this.maxAgeMs = maxAgeMs;
      }
      /**
       * Add a message to the buffer.
       * Evicts the oldest message if buffer is at capacity.
       */
      push(data) {
        if (this.buffer.length >= this.maxSize) {
          this.buffer.shift();
        }
        this.buffer.push({ timestamp: Date.now(), data });
      }
      /**
       * Return all messages (optionally since a given timestamp).
       * Filters out expired messages (older than maxAgeMs).
       * Clears returned messages from the buffer.
       */
      drain(since) {
        const now = Date.now();
        const cutoff = now - this.maxAgeMs;
        let result = this.buffer.filter((m) => m.timestamp > cutoff);
        if (since !== void 0) {
          result = result.filter((m) => m.timestamp > since);
        }
        this.buffer = [];
        return result;
      }
      /**
       * Clear all messages from the buffer.
       */
      clear() {
        this.buffer = [];
      }
      /**
       * Number of messages currently in the buffer.
       */
      get size() {
        return this.buffer.length;
      }
      /**
       * Remove messages older than maxAgeMs.
       */
      pruneExpired() {
        const cutoff = Date.now() - this.maxAgeMs;
        this.buffer = this.buffer.filter((m) => m.timestamp > cutoff);
      }
    };
    BufferRegistry = class {
      buffers = /* @__PURE__ */ new Map();
      cleanupInterval = null;
      constructor() {
        this.cleanupInterval = setInterval(() => this.cleanup(), 6e4);
      }
      /**
       * Get or create a MessageBuffer for a device.
       */
      getOrCreate(deviceId) {
        let buf = this.buffers.get(deviceId);
        if (!buf) {
          buf = new MessageBuffer();
          this.buffers.set(deviceId, buf);
        }
        return buf;
      }
      /**
       * Remove the buffer for a device.
       */
      remove(deviceId) {
        this.buffers.delete(deviceId);
      }
      /**
       * Remove empty buffers that have no messages (stale).
       * Prune expired messages in all remaining buffers.
       */
      cleanup() {
        for (const [deviceId, buf] of this.buffers) {
          buf.pruneExpired();
          if (buf.size === 0) {
            this.buffers.delete(deviceId);
          }
        }
      }
      /**
       * Tear down: clear the cleanup interval and all buffers.
       */
      destroy() {
        if (this.cleanupInterval) {
          clearInterval(this.cleanupInterval);
          this.cleanupInterval = null;
        }
        this.buffers.clear();
      }
    };
  }
});

// src/workspace-head.ts
function getHead() {
  const db = getDb();
  const row = db.prepare("SELECT * FROM workspace_head WHERE id = 'global'").get();
  if (!row) return null;
  return {
    id: row.id,
    sessionName: row.session_name,
    tabId: row.tab_id,
    topicId: row.topic_id,
    view: row.view,
    revision: row.revision,
    updatedByDevice: row.updated_by_device,
    updatedAt: row.updated_at
  };
}
function updateHead(fields, deviceId) {
  const db = getDb();
  const now = Date.now();
  const current = getHead();
  if (!current) {
    const head = {
      id: "global",
      sessionName: fields.sessionName || "default",
      tabId: fields.tabId ?? 0,
      topicId: fields.topicId ?? null,
      view: fields.view || "live",
      revision: 1,
      updatedByDevice: deviceId || fields.updatedByDevice || null,
      updatedAt: now
    };
    db.prepare(
      `INSERT INTO workspace_head (id, session_name, tab_id, topic_id, view, revision, updated_by_device, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      head.id,
      head.sessionName,
      head.tabId,
      head.topicId,
      head.view,
      head.revision,
      head.updatedByDevice,
      head.updatedAt
    );
    return head;
  }
  const updated = {
    id: "global",
    sessionName: fields.sessionName ?? current.sessionName,
    tabId: fields.tabId ?? current.tabId,
    topicId: fields.topicId !== void 0 ? fields.topicId : current.topicId,
    view: fields.view ?? current.view,
    revision: current.revision + 1,
    updatedByDevice: deviceId || fields.updatedByDevice || current.updatedByDevice,
    updatedAt: now
  };
  db.prepare(
    `UPDATE workspace_head SET
       session_name = ?,
       tab_id = ?,
       topic_id = ?,
       view = ?,
       revision = ?,
       updated_by_device = ?,
       updated_at = ?
     WHERE id = 'global'`
  ).run(
    updated.sessionName,
    updated.tabId,
    updated.topicId,
    updated.view,
    updated.revision,
    updated.updatedByDevice,
    updated.updatedAt
  );
  return updated;
}
var init_workspace_head = __esm({
  "src/workspace-head.ts"() {
    "use strict";
    init_store();
  }
});

// src/workspace.ts
function captureSnapshot(sessionName, tabId, topicId) {
  const found = findTab(tabId);
  if (!found) return null;
  let text;
  if (found.tab.vt && !found.tab.ended) {
    const snapshot = found.tab.vt.textSnapshot();
    text = snapshot.text;
  } else {
    const rawText = found.tab.scrollback.read().toString("utf8");
    text = rawText.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
  }
  const artifact = createArtifact({
    topicId,
    sessionName,
    type: "snapshot",
    title: `Snapshot: ${found.session.name} / ${found.tab.title}`,
    content: text
  });
  return { artifact, text };
}
function generateHandoffBundle() {
  const now = Date.now();
  const DAY_MS = 24 * 60 * 60 * 1e3;
  const sessions = [];
  for (const session of sessionMap.values()) {
    sessions.push({
      name: session.name,
      activeTabs: session.tabs.filter((t) => !t.ended).length
    });
  }
  const allRuns = listRuns();
  const recentRuns = allRuns.slice(-10).reverse();
  const allTopics = listTopics();
  const activeTopics = allTopics.filter(
    (t) => now - t.updatedAt < DAY_MS
  );
  const pendingApprovals = listApprovals("pending");
  const allArtifacts = listArtifacts({});
  const keyArtifacts = allArtifacts.slice(-20).reverse();
  return {
    timestamp: now,
    sessions,
    recentRuns,
    activeTopics,
    pendingApprovals,
    keyArtifacts
  };
}
var init_workspace = __esm({
  "src/workspace.ts"() {
    "use strict";
    init_store();
    init_session();
  }
});

// src/renderers.ts
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function detectContentType(text) {
  if (!text) return "plain";
  if (/^diff --git /m.test(text)) return "diff";
  if (/^--- .+\n\+\+\+ .+\n@@/m.test(text))
    return "diff";
  if (/\x1b\[[\d;]*m/.test(text)) return "ansi";
  if (/^#{1,6}\s+\S/m.test(text)) return "markdown";
  if (/\*\*[^*]+\*\*/.test(text)) return "markdown";
  if (/```[\s\S]*?```/.test(text)) return "markdown";
  if (/\[[^\]]+\]\([^)]+\)/.test(text)) return "markdown";
  return "plain";
}
function renderDiff(diffText) {
  const lines = diffText.split("\n");
  const out = ['<div class="diff-container">'];
  let oldLine = 0;
  let newLine = 0;
  for (const raw of lines) {
    const escaped = escapeHtml(raw);
    if (raw.startsWith("diff --git") || raw.startsWith("index ") || raw.startsWith("---") || raw.startsWith("+++")) {
      out.push(
        `<div class="diff-header">${escaped}</div>`
      );
    } else if (raw.startsWith("@@")) {
      const m = raw.match(/@@ -(\d+)/);
      if (m) {
        oldLine = parseInt(m[1], 10);
        const m2 = raw.match(/@@ -\d+(?:,\d+)? \+(\d+)/);
        newLine = m2 ? parseInt(m2[1], 10) : oldLine;
      }
      out.push(
        `<div class="diff-hunk">${escaped}</div>`
      );
    } else if (raw.startsWith("+")) {
      out.push(
        `<div class="diff-add"><span class="diff-line-num">${newLine}</span>${escaped}</div>`
      );
      newLine++;
    } else if (raw.startsWith("-")) {
      out.push(
        `<div class="diff-del"><span class="diff-line-num">${oldLine}</span>${escaped}</div>`
      );
      oldLine++;
    } else {
      out.push(
        `<div class="diff-ctx"><span class="diff-line-num">${oldLine}</span>${escaped}</div>`
      );
      oldLine++;
      newLine++;
    }
  }
  out.push("</div>");
  return out.join("\n");
}
function renderMarkdown(md) {
  const lines = md.split("\n");
  const out = ['<div class="rendered-md">'];
  let inCodeBlock = false;
  let codeLang = "";
  let codeLines = [];
  let inList = null;
  let inBlockquote = false;
  let paragraph = [];
  function flushParagraph() {
    if (paragraph.length > 0) {
      const text = paragraph.join(" ");
      out.push(`<p>${inlineFormat(text)}</p>`);
      paragraph = [];
    }
  }
  function flushList() {
    if (inList) {
      out.push(`</${inList}>`);
      inList = null;
    }
  }
  function flushBlockquote() {
    if (inBlockquote) {
      out.push("</blockquote>");
      inBlockquote = false;
    }
  }
  function inlineFormat(raw) {
    const parts = raw.split(/(`[^`]+`)/);
    return parts.map((part) => {
      if (part.startsWith("`") && part.endsWith("`")) {
        const code = part.slice(1, -1);
        return `<code>${escapeHtml(code)}</code>`;
      }
      let escaped = escapeHtml(part);
      escaped = escaped.replace(
        /\*\*([^*]+)\*\*/g,
        "<strong>$1</strong>"
      );
      escaped = escaped.replace(
        /(?<!\*)\*([^*]+)\*(?!\*)/g,
        "<em>$1</em>"
      );
      escaped = escaped.replace(
        /\[([^\]]+)\]\(([^)]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener">$1</a>'
      );
      return escaped;
    }).join("");
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("```")) {
      if (!inCodeBlock) {
        flushParagraph();
        flushList();
        flushBlockquote();
        inCodeBlock = true;
        codeLang = line.slice(3).trim();
        codeLines = [];
        continue;
      } else {
        const langAttr = codeLang ? ` class="language-${escapeHtml(codeLang)}"` : "";
        out.push(
          `<pre><code${langAttr}>${escapeHtml(codeLines.join("\n"))}</code></pre>`
        );
        inCodeBlock = false;
        codeLang = "";
        codeLines = [];
        continue;
      }
    }
    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }
    if (/^---+$/.test(line.trim())) {
      flushParagraph();
      flushList();
      flushBlockquote();
      out.push("<hr>");
      continue;
    }
    const headerMatch = line.match(/^(#{1,6})\s+(.*)/);
    if (headerMatch) {
      flushParagraph();
      flushList();
      flushBlockquote();
      const level = headerMatch[1].length;
      const text = escapeHtml(headerMatch[2]);
      out.push(`<h${level}>${text}</h${level}>`);
      continue;
    }
    if (line.startsWith("> ")) {
      flushParagraph();
      flushList();
      if (!inBlockquote) {
        inBlockquote = true;
        out.push("<blockquote>");
      }
      out.push(inlineFormat(line.slice(2)));
      continue;
    } else if (inBlockquote) {
      flushBlockquote();
    }
    if (/^[-*]\s+/.test(line)) {
      flushParagraph();
      flushBlockquote();
      if (inList !== "ul") {
        flushList();
        inList = "ul";
        out.push("<ul>");
      }
      const text = line.replace(/^[-*]\s+/, "");
      out.push(`<li>${inlineFormat(text)}</li>`);
      continue;
    }
    if (/^\d+\.\s+/.test(line)) {
      flushParagraph();
      flushBlockquote();
      if (inList !== "ol") {
        flushList();
        inList = "ol";
        out.push("<ol>");
      }
      const text = line.replace(/^\d+\.\s+/, "");
      out.push(`<li>${inlineFormat(text)}</li>`);
      continue;
    }
    if (inList && !/^\s*$/.test(line)) {
      flushList();
    }
    if (line.trim() === "") {
      flushParagraph();
      flushList();
      continue;
    }
    paragraph.push(line);
  }
  if (inCodeBlock) {
    const langAttr = codeLang ? ` class="language-${escapeHtml(codeLang)}"` : "";
    out.push(
      `<pre><code${langAttr}>${escapeHtml(codeLines.join("\n"))}</code></pre>`
    );
  }
  flushParagraph();
  flushList();
  flushBlockquote();
  out.push("</div>");
  return out.join("\n");
}
function renderAnsi(ansiText) {
  let cleaned = ansiText.replace(/\x1b\][^\x07]*\x07/g, "");
  cleaned = cleaned.replace(/\x1b\[[\d;]*[A-LN-Za-ln-z]/g, "");
  if (!/\x1b\[[\d;]*m/.test(cleaned)) {
    return escapeHtml(cleaned);
  }
  const state = {
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    fgColor: null
  };
  const parts = [];
  let spanOpen = false;
  const re = /\x1b\[([\d;]*)m/g;
  let lastIndex = 0;
  let match;
  while ((match = re.exec(cleaned)) !== null) {
    const text = cleaned.slice(lastIndex, match.index);
    if (text) {
      parts.push(escapeHtml(text));
    }
    lastIndex = match.index + match[0].length;
    const codes = match[1] ? match[1].split(";").map(Number) : [0];
    for (const code of codes) {
      if (code === 0) {
        if (spanOpen) {
          parts.push("</span>");
          spanOpen = false;
        }
        state.bold = false;
        state.dim = false;
        state.italic = false;
        state.underline = false;
        state.fgColor = null;
      } else if (code === 1) {
        state.bold = true;
      } else if (code === 2) {
        state.dim = true;
      } else if (code === 3) {
        state.italic = true;
      } else if (code === 4) {
        state.underline = true;
      } else if (code >= 30 && code <= 37) {
        state.fgColor = ANSI_COLORS[code] || null;
      } else if (code >= 90 && code <= 97) {
        state.fgColor = ANSI_BRIGHT_COLORS[code] || null;
      }
    }
    if (spanOpen) {
      parts.push("</span>");
      spanOpen = false;
    }
    const classes = [];
    const styles = [];
    if (state.bold) classes.push("ansi-bold");
    if (state.dim) classes.push("ansi-dim");
    if (state.italic) classes.push("ansi-italic");
    if (state.underline) classes.push("ansi-underline");
    if (state.fgColor) styles.push(`color:${state.fgColor}`);
    if (classes.length > 0 || styles.length > 0) {
      let tag = "<span";
      if (classes.length > 0) tag += ` class="${classes.join(" ")}"`;
      if (styles.length > 0) tag += ` style="${styles.join(";")}"`;
      tag += ">";
      parts.push(tag);
      spanOpen = true;
    }
  }
  const remainder = cleaned.slice(lastIndex);
  if (remainder) {
    parts.push(escapeHtml(remainder));
  }
  if (spanOpen) {
    parts.push("</span>");
  }
  return parts.join("");
}
var ANSI_COLORS, ANSI_BRIGHT_COLORS;
var init_renderers = __esm({
  "src/renderers.ts"() {
    "use strict";
    ANSI_COLORS = {
      30: "#000000",
      31: "#cc0000",
      32: "#00cc00",
      33: "#cccc00",
      34: "#0000cc",
      35: "#cc00cc",
      36: "#00cccc",
      37: "#cccccc"
    };
    ANSI_BRIGHT_COLORS = {
      90: "#555555",
      91: "#ff5555",
      92: "#55ff55",
      93: "#ffff55",
      94: "#5555ff",
      95: "#ff55ff",
      96: "#55ffff",
      97: "#ffffff"
    };
  }
});

// src/git-service.ts
var git_service_exports = {};
__export(git_service_exports, {
  compareBranches: () => compareBranches,
  createWorktree: () => createWorktree,
  getGitDiff: () => getGitDiff,
  getGitStatus: () => getGitStatus,
  getWorktrees: () => getWorktrees,
  initGitService: () => initGitService,
  watchGitChanges: () => watchGitChanges
});
import simpleGit from "simple-git";
function assertSafeRef(ref) {
  if (!ref || ref.startsWith("-") || !SAFE_REF_RE.test(ref)) {
    throw new Error(`Invalid git ref: ${ref}`);
  }
}
function initGitService(cwd) {
  git = simpleGit(cwd || process.cwd());
}
function getGit() {
  if (!git) initGitService();
  return git;
}
async function getGitStatus() {
  const g = getGit();
  const status = await g.status();
  const log = await g.log({ maxCount: 10 });
  return {
    branch: status.current || "unknown",
    status,
    recentCommits: log.all.map((c) => ({
      hash: c.hash.substring(0, 7),
      message: c.message,
      date: c.date,
      author: c.author_name
    }))
  };
}
async function getGitDiff(base) {
  const g = getGit();
  const diffBase = base || "HEAD";
  assertSafeRef(diffBase);
  const diffText = await g.diff([diffBase]);
  const diffStat = await g.diffSummary([diffBase]);
  return {
    diff: diffText.substring(0, 1024 * 1024),
    // 1MB limit
    files: diffStat.files.map((f) => ({
      file: f.file,
      insertions: "binary" in f && f.binary ? 0 : f.insertions,
      deletions: "binary" in f && f.binary ? 0 : f.deletions
    }))
  };
}
async function getWorktrees() {
  const g = getGit();
  const result = await g.raw(["worktree", "list", "--porcelain"]);
  const worktrees = [];
  let current = {};
  for (const line of result.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current.path) worktrees.push({
        path: current.path,
        branch: current.branch || "",
        head: current.head || ""
      });
      current = { path: line.replace("worktree ", "") };
    } else if (line.startsWith("HEAD ")) {
      current.head = line.replace("HEAD ", "").substring(0, 7);
    } else if (line.startsWith("branch ")) {
      current.branch = line.replace("branch refs/heads/", "");
    }
  }
  if (current.path) worktrees.push({
    path: current.path,
    branch: current.branch || "",
    head: current.head || ""
  });
  return worktrees;
}
async function createWorktree(branch, worktreePath) {
  assertSafeRef(branch);
  if (worktreePath.includes("..") || worktreePath.startsWith("/")) {
    throw new Error(`Invalid worktree path: ${worktreePath}`);
  }
  const g = getGit();
  await g.raw(["worktree", "add", "-b", branch, worktreePath, "dev"]);
}
async function compareBranches(base, head) {
  assertSafeRef(base);
  assertSafeRef(head);
  const g = getGit();
  const diffStat = await g.diffSummary([`${base}...${head}`]);
  const aheadLog = await g.log({ from: base, to: head });
  const behindLog = await g.log({ from: head, to: base });
  return {
    ahead: aheadLog.total,
    behind: behindLog.total,
    files: diffStat.files.map((f) => ({
      file: f.file,
      insertions: "binary" in f && f.binary ? 0 : f.insertions,
      deletions: "binary" in f && f.binary ? 0 : f.deletions
    }))
  };
}
function watchGitChanges(onChange) {
  const fs8 = __require("fs");
  const path7 = __require("path");
  const gitDir = path7.join(process.cwd(), ".git");
  try {
    const watcher = fs8.watch(
      gitDir,
      { recursive: false },
      (eventType, filename) => {
        if (filename === "HEAD" || filename?.startsWith("refs")) {
          onChange();
        }
      }
    );
    return () => watcher.close();
  } catch {
    return () => {
    };
  }
}
var SAFE_REF_RE, git;
var init_git_service = __esm({
  "src/git-service.ts"() {
    "use strict";
    SAFE_REF_RE = /^[a-zA-Z0-9._\/@{}\[\]:^~-]+$/;
    git = null;
  }
});

// src/adapters/agent-events.ts
var agent_events_exports = {};
__export(agent_events_exports, {
  parseClaudeCodeEvent: () => parseClaudeCodeEvent,
  parseCodexEvent: () => parseCodexEvent
});
function parseClaudeCodeEvent(event) {
  const type = event.type;
  if (!type) return null;
  switch (type) {
    case "assistant": {
      const message = event.message;
      const contentBlocks = message?.content ?? [];
      const textParts = contentBlocks.filter((b) => b.type === "text").map((b) => b.text);
      return {
        role: "assistant",
        content: textParts.join("\n") || "",
        timestamp: (/* @__PURE__ */ new Date()).toISOString()
      };
    }
    case "tool_use": {
      const toolCall = {
        tool: event.name ?? "unknown",
        args: event.input ?? {},
        status: "running"
      };
      return {
        role: "assistant",
        content: "",
        toolCalls: [toolCall],
        timestamp: (/* @__PURE__ */ new Date()).toISOString()
      };
    }
    case "tool_result": {
      const toolCall = {
        tool: event.name ?? "unknown",
        args: {},
        status: "completed",
        output: typeof event.content === "string" ? event.content : JSON.stringify(event.content ?? "")
      };
      return {
        role: "assistant",
        content: "",
        toolCalls: [toolCall],
        timestamp: (/* @__PURE__ */ new Date()).toISOString()
      };
    }
    case "permission_request": {
      const approval = {
        id: event.id ?? `perm-${Date.now()}`,
        tool: event.tool ?? "unknown",
        description: event.description ?? "",
        status: "pending"
      };
      return {
        role: "assistant",
        content: "",
        approvals: [approval],
        timestamp: (/* @__PURE__ */ new Date()).toISOString()
      };
    }
    case "result":
    case "end_turn":
      return {
        role: "assistant",
        content: typeof event.result === "string" ? event.result : "",
        timestamp: (/* @__PURE__ */ new Date()).toISOString()
      };
    case "error":
      return {
        role: "assistant",
        content: `Error: ${event.error ?? "unknown error"}`,
        timestamp: (/* @__PURE__ */ new Date()).toISOString()
      };
    default:
      return null;
  }
}
function parseCodexEvent(event) {
  const type = event.type;
  if (!type) return null;
  switch (type) {
    case "item.created": {
      const item = event.item;
      if (!item) return null;
      const role = item.role === "user" ? "user" : "assistant";
      const contentBlocks = item.content ?? [];
      const textParts = contentBlocks.filter((b) => b.type === "text" || b.type === "output_text").map((b) => b.text ?? b.output ?? "");
      return {
        role,
        content: textParts.join("\n") || "",
        timestamp: (/* @__PURE__ */ new Date()).toISOString()
      };
    }
    case "tool_use": {
      const toolCall = {
        tool: event.name ?? "unknown",
        args: event.input ?? {},
        status: "running"
      };
      return {
        role: "assistant",
        content: "",
        toolCalls: [toolCall],
        timestamp: (/* @__PURE__ */ new Date()).toISOString()
      };
    }
    case "tool_result": {
      const toolCall = {
        tool: event.name ?? "unknown",
        args: {},
        status: "completed",
        output: typeof event.output === "string" ? event.output : JSON.stringify(event.output ?? "")
      };
      return {
        role: "assistant",
        content: "",
        toolCalls: [toolCall],
        timestamp: (/* @__PURE__ */ new Date()).toISOString()
      };
    }
    case "permission_request": {
      const approval = {
        id: event.id ?? `perm-${Date.now()}`,
        tool: event.command ?? "unknown",
        description: event.description ?? "",
        status: "pending"
      };
      return {
        role: "assistant",
        content: "",
        approvals: [approval],
        timestamp: (/* @__PURE__ */ new Date()).toISOString()
      };
    }
    case "turn.started":
      return {
        role: "assistant",
        content: "",
        timestamp: (/* @__PURE__ */ new Date()).toISOString()
      };
    case "turn.completed":
      return {
        role: "assistant",
        content: "",
        timestamp: (/* @__PURE__ */ new Date()).toISOString()
      };
    case "error":
      return {
        role: "assistant",
        content: `Error: ${event.message ?? "unknown error"}`,
        timestamp: (/* @__PURE__ */ new Date()).toISOString()
      };
    default:
      return null;
  }
}
var init_agent_events = __esm({
  "src/adapters/agent-events.ts"() {
    "use strict";
  }
});

// src/ws-handler.ts
import crypto4 from "crypto";
import { WebSocketServer } from "ws";
function bufferForDevice(deviceId, type, payload) {
  if (!disconnectedDevices.has(deviceId)) return;
  const buf = bufferRegistry.getOrCreate(deviceId);
  buf.push(JSON.stringify({ v: 1, type, payload }));
}
function bufferRawForDevice(deviceId, data) {
  if (!disconnectedDevices.has(deviceId)) return;
  const buf = bufferRegistry.getOrCreate(deviceId);
  buf.push(data);
}
function bufferTabOutput(tabId, data) {
  for (const [deviceId, watchingTabId] of disconnectedDeviceTab) {
    if (watchingTabId === tabId) {
      bufferRawForDevice(deviceId, data);
    }
  }
}
function bufferStateForDisconnected() {
  if (disconnectedDevices.size === 0) return;
  const state = getState();
  const clients = getClientList();
  for (const deviceId of disconnectedDevices) {
    bufferForDevice(deviceId, "state", { sessions: state, clients });
  }
}
function sendEnvelope(ws, type, payload) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ v: 1, type, payload }));
  }
}
function unwrapMessage(parsed) {
  if (parsed && parsed.v === 1 && typeof parsed.type === "string") {
    return { type: parsed.type, ...parsed.payload || {} };
  }
  return parsed;
}
function e2eeSend(ws, data) {
  if (ws.readyState !== ws.OPEN) return;
  const session = e2eeSessions.get(ws);
  if (session && session.isEstablished()) {
    const encrypted = session.encryptMessage(data);
    ws.send(JSON.stringify({ v: 1, type: "e2ee_msg", payload: { data: encrypted } }));
  } else {
    ws.send(data);
  }
}
function generateClientId() {
  return crypto4.randomBytes(4).toString("hex");
}
function getActiveClientForTab(tabId) {
  for (const [ws, state] of clientStates) {
    if (state.currentTabId === tabId && state.role === "active") return ws;
  }
  return null;
}
function assignRole(ws, tabId) {
  const state = clientStates.get(ws);
  if (!state) return;
  const existingActive = getActiveClientForTab(tabId);
  if (!existingActive || existingActive === ws) {
    state.role = "active";
    state.lastActiveAt = Date.now();
  } else {
    const activeState = clientStates.get(existingActive);
    const isIdle2 = activeState && Date.now() - activeState.lastActiveAt > ACTIVE_IDLE_TIMEOUT_MS;
    if (isIdle2) {
      activeState.role = "observer";
      sendEnvelope(existingActive, "role_changed", {
        clientId: activeState.clientId,
        role: "observer"
      });
      state.role = "active";
      state.lastActiveAt = Date.now();
    } else {
      state.role = "observer";
    }
  }
  state.currentTabId = tabId;
}
function reassignRolesAfterDetach(tabId, wasActive) {
  if (!wasActive) return;
  for (const [ws, state] of clientStates) {
    if (state.currentTabId === tabId && state.role === "observer" && ws.readyState === ws.OPEN) {
      state.role = "active";
      sendEnvelope(ws, "role_changed", {
        clientId: state.clientId,
        role: "active"
      });
      break;
    }
  }
}
function getClientList() {
  const list = [];
  for (const [ws, state] of clientStates) {
    if (ws.readyState === ws.OPEN) {
      list.push({
        clientId: state.clientId,
        role: state.role,
        session: state.currentSession,
        tabId: state.currentTabId
      });
    }
  }
  return list;
}
function broadcastHead() {
  const head = getHead();
  if (!head) return;
  for (const ws of controlClients) {
    if (ws.readyState === ws.OPEN) {
      sendEnvelope(ws, "workspace_head", head);
    }
  }
}
function setupWebSocket(httpServer2, TOKEN2, PASSWORD2) {
  setBroadcastHooks(sendEnvelope, getClientList, e2eeSend);
  setBufferHooks(bufferTabOutput, bufferStateForDisconnected);
  const wss2 = new WebSocketServer({ noServer: true });
  httpServer2.on("upgrade", (req, socket, head) => {
    if ("setNoDelay" in socket) socket.setNoDelay(true);
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === "/ws") {
      wss2.handleUpgrade(
        req,
        socket,
        head,
        (ws) => wss2.emit("connection", ws, req)
      );
    } else {
      socket.destroy();
    }
  });
  const HEARTBEAT_INTERVAL = 3e4;
  setInterval(() => {
    for (const ws of controlClients) {
      if (ws.readyState === ws.OPEN) sendEnvelope(ws, "ping", {});
    }
  }, HEARTBEAT_INTERVAL);
  wss2.on("connection", (rawWs, req) => {
    const ws = rawWs;
    ws._remuxTabId = null;
    ws._remuxCols = 80;
    ws._remuxRows = 24;
    ws._remuxDeviceId = null;
    const requiresAuth = !!(TOKEN2 || PASSWORD2);
    ws._remuxAuthed = !requiresAuth;
    const clientId = generateClientId();
    const clientState = {
      clientId,
      role: "observer",
      connectedAt: Date.now(),
      lastActiveAt: Date.now(),
      currentSession: null,
      currentTabId: null
    };
    clientStates.set(ws, clientState);
    let deviceInfo = null;
    try {
      const { device } = registerDevice(req);
      deviceInfo = device;
      ws._remuxDeviceId = device.id;
      if (!deviceSockets.has(device.id)) {
        deviceSockets.set(device.id, /* @__PURE__ */ new Set());
      }
      deviceSockets.get(device.id).add(ws);
      if (device.trust === "blocked") {
        sendEnvelope(ws, "auth_error", { reason: "device blocked" });
        ws.close(4003, "device blocked");
        return;
      }
    } catch {
    }
    if (!requiresAuth) controlClients.add(ws);
    ws.on("message", (raw) => {
      const msg = raw.toString("utf8");
      if (!ws._remuxAuthed) {
        try {
          const rawParsed = JSON.parse(msg);
          const parsed = unwrapMessage(rawParsed);
          if (parsed.type === "auth") {
            if (validateToken(parsed.token, TOKEN2)) {
              ws._remuxAuthed = true;
              controlClients.add(ws);
              if (parsed.deviceId) {
                try {
                  if (ws._remuxDeviceId && ws._remuxDeviceId !== parsed.deviceId) {
                    const oldSockets = deviceSockets.get(ws._remuxDeviceId);
                    if (oldSockets) {
                      oldSockets.delete(ws);
                      if (oldSockets.size === 0) deviceSockets.delete(ws._remuxDeviceId);
                    }
                  }
                  const { device } = registerDevice(req, parsed.deviceId);
                  if (device.trust === "blocked") {
                    sendEnvelope(ws, "auth_error", { reason: "device blocked" });
                    ws.close(4003, "device blocked");
                    return;
                  }
                  deviceInfo = device;
                  ws._remuxDeviceId = device.id;
                  if (!deviceSockets.has(device.id)) deviceSockets.set(device.id, /* @__PURE__ */ new Set());
                  deviceSockets.get(device.id).add(ws);
                } catch {
                }
              }
              sendEnvelope(ws, "auth_ok", {
                deviceId: deviceInfo?.id ?? null,
                trust: deviceInfo?.trust ?? null
              });
              const head = getHead();
              sendEnvelope(ws, "bootstrap", {
                head,
                sessions: getState(),
                clients: getClientList()
              });
              sendEnvelope(ws, "state", {
                sessions: getState(),
                clients: getClientList()
              });
              return;
            }
          }
        } catch {
        }
        sendEnvelope(ws, "auth_error", { reason: "invalid token" });
        ws.close(4001, "unauthorized");
        return;
      }
      if (msg.startsWith("{")) {
        try {
          const rawParsed = JSON.parse(msg);
          const p = unwrapMessage(rawParsed);
          if (p.type === "e2ee_init") {
            if (typeof p.publicKey === "string") {
              const session = new E2EESession();
              session.completeHandshake(p.publicKey);
              e2eeSessions.set(ws, session);
              sendEnvelope(ws, "e2ee_init", {
                publicKey: session.getPublicKey()
              });
              sendEnvelope(ws, "e2ee_ready", { established: true });
            }
            return;
          }
          if (p.type === "e2ee_msg") {
            const e2ee = e2eeSessions.get(ws);
            if (!e2ee || !e2ee.isEstablished()) {
              sendEnvelope(ws, "error", { reason: "E2EE not established" });
              return;
            }
            try {
              const decrypted = e2ee.decryptMessage(p.data);
              if (decrypted.startsWith("{")) {
                const innerParsed = JSON.parse(decrypted);
                const inner = unwrapMessage(innerParsed);
                if (inner.type === "input") {
                  if (clientState.role === "active") {
                    clientState.lastActiveAt = Date.now();
                    const found2 = findTab(ws._remuxTabId);
                    if (found2 && !found2.tab.ended) {
                      if (found2.tab.daemonClient) {
                        found2.tab.daemonClient.write(encodeFrame(TAG_CLIENT_INPUT, inner.data));
                      } else if (found2.tab.pty) {
                        found2.tab.pty.write(inner.data);
                      }
                    }
                  }
                  return;
                }
                ws.emit("message", Buffer.from(decrypted, "utf8"));
              } else {
                if (clientState.role === "active") {
                  clientState.lastActiveAt = Date.now();
                  const found2 = findTab(ws._remuxTabId);
                  if (found2 && !found2.tab.ended) {
                    if (found2.tab.daemonClient) {
                      found2.tab.daemonClient.write(encodeFrame(TAG_CLIENT_INPUT, decrypted));
                    } else if (found2.tab.pty) {
                      found2.tab.pty.write(decrypted);
                    }
                  }
                }
              }
            } catch (err) {
              sendEnvelope(ws, "error", {
                reason: "E2EE decrypt failed"
              });
            }
            return;
          }
          if (p.type === "resume") {
            const resumeDeviceId = p.deviceId || ws._remuxDeviceId;
            let totalReplayed = 0;
            if (resumeDeviceId && typeof p.tabId === "number") {
              const cursor = getDeviceCursor(resumeDeviceId, p.tabId);
              const sinceSeq = p.seq ?? cursor?.lastAckedSeq ?? 0;
              if (sinceSeq > 0) {
                const chunks = getChunksSince(p.tabId, sinceSeq);
                for (const chunk of chunks) {
                  if (ws.readyState === ws.OPEN) {
                    ws.send(chunk.data);
                  }
                }
                totalReplayed += chunks.length;
              }
            }
            if (resumeDeviceId && disconnectedDevices.has(resumeDeviceId)) {
              const buf = bufferRegistry.getOrCreate(resumeDeviceId);
              const messages = buf.drain(p.lastTimestamp || void 0);
              for (const m of messages) {
                if (ws.readyState === ws.OPEN) {
                  ws.send(m.data);
                }
              }
              totalReplayed += messages.length;
              disconnectedDevices.delete(resumeDeviceId);
              disconnectedDeviceTab.delete(resumeDeviceId);
              bufferRegistry.remove(resumeDeviceId);
            }
            sendEnvelope(ws, "resume_complete", {
              replayed: totalReplayed
            });
            return;
          }
          if (p.type === "switch_tab") {
            if (typeof p.tabId === "number") {
              const head = updateHead({ tabId: p.tabId }, ws._remuxDeviceId || void 0);
              broadcastHead();
            }
            return;
          }
          if (p.type === "switch_session") {
            if (typeof p.name === "string") {
              const session = sessionMap.get(p.name);
              const firstTab = session?.tabs.find((t) => !t.ended);
              const head = updateHead(
                { sessionName: p.name, tabId: firstTab?.id ?? 0 },
                ws._remuxDeviceId || void 0
              );
              broadcastHead();
            }
            return;
          }
          if (p.type === "switch_view") {
            if (typeof p.view === "string") {
              const head = updateHead({ view: p.view }, ws._remuxDeviceId || void 0);
              broadcastHead();
            }
            return;
          }
          if (p.type === "ack") {
            const deviceId = ws._remuxDeviceId;
            if (deviceId && typeof p.tabId === "number" && typeof p.seq === "number") {
              updateDeviceCursor(deviceId, p.tabId, p.seq);
            }
            return;
          }
          if (p.type === "attach_first") {
            const name = p.session || getFirstSessionName() || "default";
            const session = createSession(name);
            let tab = session.tabs.find((t) => !t.ended);
            if (!tab)
              tab = createTab(
                session,
                p.cols || ws._remuxCols,
                p.rows || ws._remuxRows
              );
            attachToTab(
              tab,
              ws,
              p.cols || ws._remuxCols,
              p.rows || ws._remuxRows
            );
            clientState.currentSession = name;
            assignRole(ws, tab.id);
            broadcastState();
            sendEnvelope(ws, "attached", {
              tabId: tab.id,
              session: name,
              clientId: clientState.clientId,
              role: clientState.role
            });
            return;
          }
          if (p.type === "attach_tab") {
            const found2 = findTab(p.tabId);
            if (found2) {
              attachToTab(
                found2.tab,
                ws,
                p.cols || ws._remuxCols,
                p.rows || ws._remuxRows
              );
              clientState.currentSession = found2.session.name;
              assignRole(ws, found2.tab.id);
              broadcastState();
              sendEnvelope(ws, "attached", {
                tabId: found2.tab.id,
                session: found2.session.name,
                clientId: clientState.clientId,
                role: clientState.role
              });
            }
            return;
          }
          if (p.type === "new_tab") {
            const session = createSession(p.session || "default");
            const tab = createTab(
              session,
              p.cols || ws._remuxCols,
              p.rows || ws._remuxRows
            );
            attachToTab(
              tab,
              ws,
              p.cols || ws._remuxCols,
              p.rows || ws._remuxRows
            );
            clientState.currentSession = session.name;
            assignRole(ws, tab.id);
            broadcastState();
            sendEnvelope(ws, "attached", {
              tabId: tab.id,
              session: session.name,
              clientId: clientState.clientId,
              role: clientState.role
            });
            return;
          }
          if (p.type === "close_tab") {
            const found2 = findTab(p.tabId);
            if (found2) {
              if (!found2.tab.ended) {
                if (found2.tab.daemonClient) {
                  try {
                    found2.tab.daemonClient.write(encodeFrame(255, Buffer.alloc(0)));
                  } catch {
                  }
                } else if (found2.tab.pty) {
                  found2.tab.pty.kill();
                }
              }
              found2.session.tabs = found2.session.tabs.filter(
                (t) => t.id !== p.tabId
              );
              removeStaleTab(p.tabId);
              if (found2.session.tabs.length === 0) {
                removeSession(found2.session.name);
                sessionMap.delete(found2.session.name);
              }
            }
            broadcastState();
            return;
          }
          if (p.type === "new_session") {
            const name = p.name || "session-" + Date.now();
            const session = createSession(name);
            const tab = createTab(
              session,
              p.cols || ws._remuxCols,
              p.rows || ws._remuxRows
            );
            attachToTab(
              tab,
              ws,
              p.cols || ws._remuxCols,
              p.rows || ws._remuxRows
            );
            clientState.currentSession = name;
            assignRole(ws, tab.id);
            broadcastState();
            sendEnvelope(ws, "attached", {
              tabId: tab.id,
              session: name,
              clientId: clientState.clientId,
              role: clientState.role
            });
            return;
          }
          if (p.type === "delete_session") {
            if (p.name) {
              deleteSession(p.name);
              broadcastState();
            }
            return;
          }
          if (p.type === "inspect") {
            const found2 = findTab(ws._remuxTabId);
            if (found2 && found2.tab.vt && !found2.tab.ended) {
              const { text, cols, rows } = found2.tab.vt.textSnapshot();
              sendEnvelope(ws, "inspect_result", {
                text,
                meta: {
                  session: found2.session.name,
                  tabId: found2.tab.id,
                  tabTitle: found2.tab.title,
                  cols,
                  rows,
                  timestamp: Date.now()
                }
              });
            } else {
              const found22 = findTab(ws._remuxTabId);
              const rawText = found22 ? found22.tab.scrollback.read().toString("utf8") : "";
              const text = rawText.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b[PX^_][^\x1b]*\x1b\\/g, "").replace(/\x1b[()][A-Z0-9]/g, "").replace(/\x1b[A-Z=><78]/gi, "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "").replace(/\x7f/g, "");
              const session = found22 ? found22.session : null;
              const tab = found22 ? found22.tab : null;
              sendEnvelope(ws, "inspect_result", {
                text,
                meta: {
                  session: session?.name || "",
                  tabId: tab?.id || null,
                  tabTitle: tab?.title || "",
                  cols: ws._remuxCols || 80,
                  rows: ws._remuxRows || 24,
                  timestamp: Date.now()
                }
              });
            }
            return;
          }
          if (p.type === "rename_tab") {
            const found2 = findTab(p.tabId);
            if (found2 && typeof p.title === "string" && p.title.trim()) {
              found2.tab.title = p.title.trim().slice(0, 32);
              broadcastState();
            }
            return;
          }
          if (p.type === "resize") {
            ws._remuxCols = p.cols;
            ws._remuxRows = p.rows;
            const found2 = findTab(ws._remuxTabId);
            if (found2) recalcTabSize(found2.tab);
            return;
          }
          if (p.type === "request_control") {
            const tabId = ws._remuxTabId;
            if (tabId == null) return;
            const currentActive = getActiveClientForTab(tabId);
            if (currentActive && currentActive !== ws) {
              const activeState = clientStates.get(currentActive);
              if (activeState) {
                activeState.role = "observer";
                sendEnvelope(currentActive, "role_changed", {
                  clientId: activeState.clientId,
                  role: "observer"
                });
              }
            }
            clientState.role = "active";
            clientState.lastActiveAt = Date.now();
            sendEnvelope(ws, "role_changed", {
              clientId: clientState.clientId,
              role: "active"
            });
            broadcastState();
            return;
          }
          if (p.type === "release_control") {
            const tabId = ws._remuxTabId;
            if (tabId == null) return;
            if (clientState.role === "active") {
              clientState.role = "observer";
              sendEnvelope(ws, "role_changed", {
                clientId: clientState.clientId,
                role: "observer"
              });
              for (const [otherWs, otherState] of clientStates) {
                if (otherWs !== ws && otherState.currentTabId === tabId && otherState.role === "observer" && otherWs.readyState === otherWs.OPEN) {
                  otherState.role = "active";
                  sendEnvelope(otherWs, "role_changed", {
                    clientId: otherState.clientId,
                    role: "active"
                  });
                  break;
                }
              }
              broadcastState();
            }
            return;
          }
          if (p.type === "list_devices") {
            const devices = listDevices();
            sendEnvelope(ws, "device_list", { devices });
            return;
          }
          if (p.type === "trust_device") {
            const sender = ws._remuxDeviceId ? findDeviceById(ws._remuxDeviceId) : null;
            if (!sender || sender.trust !== "trusted") {
              sendEnvelope(ws, "error", {
                reason: "only trusted devices can trust others"
              });
              return;
            }
            if (p.deviceId) {
              updateDeviceTrust(p.deviceId, "trusted");
              sendEnvelope(ws, "device_list", { devices: listDevices() });
              broadcastDeviceList();
            }
            return;
          }
          if (p.type === "block_device") {
            const sender = ws._remuxDeviceId ? findDeviceById(ws._remuxDeviceId) : null;
            if (!sender || sender.trust !== "trusted") {
              sendEnvelope(ws, "error", {
                reason: "only trusted devices can block others"
              });
              return;
            }
            if (p.deviceId) {
              updateDeviceTrust(p.deviceId, "blocked");
              forceDisconnectDevice(p.deviceId);
              sendEnvelope(ws, "device_list", { devices: listDevices() });
              broadcastDeviceList();
            }
            return;
          }
          if (p.type === "rename_device") {
            if (p.deviceId && typeof p.name === "string" && p.name.trim()) {
              renameDevice(p.deviceId, p.name.trim().slice(0, 32));
              sendEnvelope(ws, "device_list", { devices: listDevices() });
              broadcastDeviceList();
            }
            return;
          }
          if (p.type === "revoke_device") {
            const sender = ws._remuxDeviceId ? findDeviceById(ws._remuxDeviceId) : null;
            if (!sender || sender.trust !== "trusted") {
              sendEnvelope(ws, "error", {
                reason: "only trusted devices can revoke others"
              });
              return;
            }
            if (p.deviceId) {
              forceDisconnectDevice(p.deviceId);
              deleteDevice(p.deviceId);
              sendEnvelope(ws, "device_list", { devices: listDevices() });
              broadcastDeviceList();
            }
            return;
          }
          if (p.type === "generate_pair_code") {
            const sender = ws._remuxDeviceId ? findDeviceById(ws._remuxDeviceId) : null;
            if (!sender || sender.trust !== "trusted") {
              sendEnvelope(ws, "error", {
                reason: "only trusted devices can generate pair codes"
              });
              return;
            }
            const pairCode = createPairCode(sender.id);
            sendEnvelope(ws, "pair_code", {
              code: pairCode.code,
              expiresAt: pairCode.expiresAt
            });
            return;
          }
          if (p.type === "pair") {
            if (typeof p.code === "string") {
              const createdBy = consumePairCode(p.code);
              if (createdBy && ws._remuxDeviceId) {
                updateDeviceTrust(ws._remuxDeviceId, "trusted");
                deviceInfo = findDeviceById(ws._remuxDeviceId);
                sendEnvelope(ws, "pair_result", {
                  success: true,
                  deviceId: ws._remuxDeviceId
                });
                broadcastDeviceList();
              } else {
                sendEnvelope(ws, "pair_result", {
                  success: false,
                  reason: "invalid or expired code"
                });
              }
            }
            return;
          }
          if (p.type === "get_vapid_key") {
            const publicKey = getVapidPublicKey();
            sendEnvelope(ws, "vapid_key", { publicKey });
            return;
          }
          if (p.type === "subscribe_push") {
            if (ws._remuxDeviceId && p.subscription && typeof p.subscription.endpoint === "string" && p.subscription.keys?.p256dh && p.subscription.keys?.auth) {
              savePushSubscription(
                ws._remuxDeviceId,
                p.subscription.endpoint,
                p.subscription.keys.p256dh,
                p.subscription.keys.auth
              );
              sendEnvelope(ws, "push_subscribed", { success: true });
            } else {
              sendEnvelope(ws, "push_subscribed", {
                success: false,
                reason: "invalid subscription or no device ID"
              });
            }
            return;
          }
          if (p.type === "unsubscribe_push") {
            if (ws._remuxDeviceId) {
              removePushSubscription(ws._remuxDeviceId);
              sendEnvelope(ws, "push_unsubscribed", { success: true });
            }
            return;
          }
          if (p.type === "test_push") {
            if (ws._remuxDeviceId) {
              sendPushNotification(
                ws._remuxDeviceId,
                "Remux Test",
                "Push notifications are working!"
              ).then((sent) => {
                sendEnvelope(ws, "push_test_result", { sent });
              });
            } else {
              sendEnvelope(ws, "push_test_result", { sent: false });
            }
            return;
          }
          if (p.type === "get_push_status") {
            const hasSub = ws._remuxDeviceId ? !!getPushSubscription(ws._remuxDeviceId) : false;
            sendEnvelope(ws, "push_status", { subscribed: hasSub });
            return;
          }
          if (p.type === "create_topic") {
            if (typeof p.title === "string" && p.title.trim()) {
              const topic = createTopic(
                p.sessionName || clientState.currentSession || "default",
                p.title.trim()
              );
              sendEnvelope(ws, "topic_created", topic);
            }
            return;
          }
          if (p.type === "list_topics") {
            const topics = listTopics(p.sessionName || void 0);
            sendEnvelope(ws, "topic_list", { topics });
            return;
          }
          if (p.type === "delete_topic") {
            if (p.topicId) {
              const ok = deleteTopic(p.topicId);
              sendEnvelope(ws, "topic_deleted", {
                topicId: p.topicId,
                success: ok
              });
            }
            return;
          }
          if (p.type === "create_run") {
            const run = createRun({
              topicId: p.topicId || void 0,
              sessionName: p.sessionName || clientState.currentSession || "default",
              tabId: p.tabId,
              command: p.command
            });
            sendEnvelope(ws, "run_created", run);
            return;
          }
          if (p.type === "update_run") {
            if (p.runId) {
              const ok = updateRun(p.runId, {
                exitCode: p.exitCode,
                status: p.status
              });
              sendEnvelope(ws, "run_updated", {
                runId: p.runId,
                success: ok
              });
            }
            return;
          }
          if (p.type === "list_runs") {
            const runs = listRuns(p.topicId || void 0, p.sessionName || void 0);
            sendEnvelope(ws, "run_list", { runs });
            return;
          }
          if (p.type === "capture_snapshot") {
            const tabId = ws._remuxTabId;
            if (tabId != null) {
              const result = captureSnapshot(
                clientState.currentSession || "default",
                tabId,
                p.topicId || void 0
              );
              if (result) {
                const a = result.artifact;
                const contentType = a.content ? detectContentType(a.content) : "plain";
                let renderedHtml;
                if (a.content) {
                  if (contentType === "diff") renderedHtml = renderDiff(a.content);
                  else if (contentType === "markdown") renderedHtml = renderMarkdown(a.content);
                  else if (contentType === "ansi") renderedHtml = '<pre style="margin:0;font-size:11px;line-height:1.5">' + renderAnsi(a.content) + "</pre>";
                }
                sendEnvelope(ws, "snapshot_captured", { ...a, contentType, renderedHtml });
              } else {
                sendEnvelope(ws, "error", {
                  reason: "no tab attached for snapshot"
                });
              }
            }
            return;
          }
          if (p.type === "list_artifacts") {
            const artifacts = listArtifacts({
              topicId: p.topicId || void 0,
              runId: p.runId || void 0,
              sessionName: p.sessionName || clientState.currentSession || void 0
            });
            const enriched = artifacts.map((a) => {
              if (!a.content) return a;
              const contentType = detectContentType(a.content);
              let renderedHtml;
              if (contentType === "diff") renderedHtml = renderDiff(a.content);
              else if (contentType === "markdown") renderedHtml = renderMarkdown(a.content);
              else if (contentType === "ansi") renderedHtml = '<pre style="margin:0;font-size:11px;line-height:1.5">' + renderAnsi(a.content) + "</pre>";
              return { ...a, contentType, renderedHtml };
            });
            sendEnvelope(ws, "artifact_list", { artifacts: enriched });
            return;
          }
          if (p.type === "create_approval") {
            if (typeof p.title === "string" && p.title.trim()) {
              const approval = createApproval({
                runId: p.runId || void 0,
                topicId: p.topicId || void 0,
                title: p.title.trim(),
                description: p.description
              });
              sendEnvelope(ws, "approval_created", approval);
              for (const client of controlClients) {
                if (client !== ws && client.readyState === client.OPEN) {
                  sendEnvelope(client, "approval_created", approval);
                }
              }
            }
            return;
          }
          if (p.type === "list_approvals") {
            const approvals = listApprovals(p.status || void 0);
            sendEnvelope(ws, "approval_list", { approvals });
            return;
          }
          if (p.type === "resolve_approval") {
            if (p.approvalId && (p.status === "approved" || p.status === "rejected")) {
              const ok = resolveApproval(p.approvalId, p.status);
              sendEnvelope(ws, "approval_resolved", {
                approvalId: p.approvalId,
                status: p.status,
                success: ok
              });
              for (const client of controlClients) {
                if (client !== ws && client.readyState === client.OPEN) {
                  sendEnvelope(client, "approval_resolved", {
                    approvalId: p.approvalId,
                    status: p.status,
                    success: ok
                  });
                }
              }
            }
            return;
          }
          if (p.type === "search") {
            if (typeof p.query === "string") {
              const results = searchEntities(p.query, p.limit || 20);
              sendEnvelope(ws, "search_results", { query: p.query, results });
            }
            return;
          }
          if (p.type === "get_handoff") {
            const bundle = generateHandoffBundle();
            sendEnvelope(ws, "handoff_bundle", bundle);
            return;
          }
          if (p.type === "create_note") {
            if (typeof p.content === "string" && p.content.trim()) {
              const note = createNote(p.content.trim(), p.sessionName || void 0);
              sendEnvelope(ws, "note_created", note);
            }
            return;
          }
          if (p.type === "list_notes") {
            const notes = listNotes(p.sessionName || void 0);
            sendEnvelope(ws, "note_list", { notes });
            return;
          }
          if (p.type === "update_note") {
            if (p.noteId && typeof p.content === "string" && p.content.trim()) {
              const ok = updateNote(p.noteId, p.content.trim());
              sendEnvelope(ws, "note_updated", { noteId: p.noteId, success: ok });
            }
            return;
          }
          if (p.type === "delete_note") {
            if (p.noteId) {
              const ok = deleteNote(p.noteId);
              sendEnvelope(ws, "note_deleted", { noteId: p.noteId, success: ok });
            }
            return;
          }
          if (p.type === "pin_note") {
            if (p.noteId) {
              const ok = togglePinNote(p.noteId);
              sendEnvelope(ws, "note_pinned", { noteId: p.noteId, success: ok });
            }
            return;
          }
          if (p.type === "list_commands") {
            const tabId = p.tabId ?? ws._remuxTabId;
            if (tabId != null) {
              const commands = listCommands(tabId, p.limit || 50);
              sendEnvelope(ws, "command_list", { tabId, commands });
            }
            return;
          }
          if (p.type === "git_status") {
            const { getGitStatus: getGitStatus2 } = (init_git_service(), __toCommonJS(git_service_exports));
            getGitStatus2().then((status) => sendEnvelope(ws, "git_status_result", status)).catch(() => {
            });
            return;
          }
          if (p.type === "git_diff") {
            const { getGitDiff: getGitDiff2 } = (init_git_service(), __toCommonJS(git_service_exports));
            getGitDiff2(p.base).then((diff) => sendEnvelope(ws, "git_diff_result", diff)).catch(() => {
            });
            return;
          }
          if (p.type === "git_worktrees") {
            const { getWorktrees: getWorktrees2 } = (init_git_service(), __toCommonJS(git_service_exports));
            getWorktrees2().then((worktrees) => sendEnvelope(ws, "git_worktrees_result", { worktrees })).catch(() => {
            });
            return;
          }
          if (p.type === "git_compare") {
            const { compareBranches: compareBranches2 } = (init_git_service(), __toCommonJS(git_service_exports));
            compareBranches2(p.base || "main", p.head || "HEAD").then((result) => sendEnvelope(ws, "git_compare_result", result)).catch(() => {
            });
            return;
          }
          if (p.type === "request_adapter_state") {
            const { adapterRegistry: adapterRegistry2 } = (init_server(), __toCommonJS(server_exports));
            const states = adapterRegistry2?.getAllStates() ?? [];
            sendEnvelope(ws, "adapter_state", { adapters: states });
            return;
          }
          if (p.type === "request_agent_summary") {
            const { adapterRegistry: adapterRegistry2 } = (init_server(), __toCommonJS(server_exports));
            const { AgentSessionSummary: AgentSessionSummary2 } = (init_agent_events(), __toCommonJS(agent_events_exports));
            const states = adapterRegistry2?.getAllStates() ?? [];
            const summaries = states.map((s) => ({
              agentId: s.adapterId,
              agentName: s.name,
              state: s.currentState,
              currentTurn: void 0,
              recentToolCalls: [],
              pendingApprovals: []
            }));
            sendEnvelope(ws, "agent_summary", { agents: summaries });
            return;
          }
          return;
        } catch (err) {
          if (msg.startsWith("{")) {
            console.error("[remux] JSON handler error:", err);
            return;
          }
        }
      }
      if (clientState.role !== "active") return;
      clientState.lastActiveAt = Date.now();
      if (msg.startsWith("{") && msg.includes('"type"')) return;
      const found = findTab(ws._remuxTabId);
      if (found && found.tab.restored && !found.tab.ended) {
        if (msg.includes("\r") || msg.includes("\n")) {
          reviveTab(found.tab, found.session).then((ok) => {
            if (ok) {
              sendEnvelope(ws, "tab_revived", { tabId: found.tab.id });
              broadcastState();
            }
          }).catch(() => {
          });
        }
        return;
      }
      if (found && !found.tab.ended) {
        if (found.tab.daemonClient) {
          found.tab.daemonClient.write(encodeFrame(TAG_CLIENT_INPUT, msg));
        } else if (found.tab.pty) {
          found.tab.pty.write(msg);
        }
      }
    });
    ws.on("close", () => {
      const tabId = ws._remuxTabId;
      const wasActive = clientState.role === "active";
      if (ws._remuxDeviceId) {
        const sockets = deviceSockets.get(ws._remuxDeviceId);
        if (sockets) {
          sockets.delete(ws);
          if (sockets.size === 0) {
            deviceSockets.delete(ws._remuxDeviceId);
            if (ws._remuxAuthed) {
              disconnectedDevices.add(ws._remuxDeviceId);
              bufferRegistry.getOrCreate(ws._remuxDeviceId);
              if (tabId != null) {
                disconnectedDeviceTab.set(ws._remuxDeviceId, tabId);
              }
            }
          }
        }
      }
      detachFromTab(ws);
      controlClients.delete(ws);
      clientStates.delete(ws);
      e2eeSessions.delete(ws);
      if (tabId != null) {
        reassignRolesAfterDetach(tabId, wasActive);
        broadcastState();
      }
    });
    ws.on("error", (err) => {
      console.error("[ws] error:", err.message);
    });
  });
  function forceDisconnectDevice(deviceId) {
    const sockets = deviceSockets.get(deviceId);
    if (!sockets) return;
    for (const sock of sockets) {
      sendEnvelope(sock, "auth_error", { reason: "device revoked" });
      sock.close(4003, "device revoked");
    }
    deviceSockets.delete(deviceId);
  }
  function broadcastDeviceList() {
    const devices = listDevices();
    for (const client of controlClients) {
      if (client.readyState === client.OPEN) {
        sendEnvelope(client, "device_list", { devices });
      }
    }
  }
  return wss2;
}
var bufferRegistry, disconnectedDevices, disconnectedDeviceTab, ACTIVE_IDLE_TIMEOUT_MS, clientStates, e2eeSessions, deviceSockets;
var init_ws_handler = __esm({
  "src/ws-handler.ts"() {
    "use strict";
    init_e2ee();
    init_message_buffer();
    init_session();
    init_workspace_head();
    init_pty_daemon();
    init_auth();
    init_store();
    init_push();
    init_store();
    init_workspace();
    init_store();
    init_renderers();
    bufferRegistry = new BufferRegistry();
    disconnectedDevices = /* @__PURE__ */ new Set();
    disconnectedDeviceTab = /* @__PURE__ */ new Map();
    ACTIVE_IDLE_TIMEOUT_MS = 12e4;
    clientStates = /* @__PURE__ */ new Map();
    e2eeSessions = /* @__PURE__ */ new Map();
    deviceSockets = /* @__PURE__ */ new Map();
  }
});

// src/adapters/registry.ts
var AdapterRegistry;
var init_registry = __esm({
  "src/adapters/registry.ts"() {
    "use strict";
    AdapterRegistry = class {
      adapters = /* @__PURE__ */ new Map();
      eventSeq = 0;
      listeners = [];
      register(adapter) {
        const existing = this.adapters.get(adapter.id);
        if (existing) existing.stop?.();
        this.adapters.set(adapter.id, adapter);
        adapter.start?.();
      }
      unregister(id) {
        const adapter = this.adapters.get(id);
        adapter?.stop?.();
        this.adapters.delete(id);
      }
      get(id) {
        return this.adapters.get(id);
      }
      getAll() {
        return Array.from(this.adapters.values());
      }
      getAllStates() {
        return this.getAll().map((a) => a.getCurrentState());
      }
      /** Subscribe to adapter events */
      onEvent(listener) {
        this.listeners.push(listener);
        return () => {
          this.listeners = this.listeners.filter((l) => l !== listener);
        };
      }
      /** Emit an event from an adapter */
      emit(adapterId, type, data) {
        const event = {
          type,
          seq: ++this.eventSeq,
          timestamp: (/* @__PURE__ */ new Date()).toISOString(),
          data,
          adapterId
        };
        for (const listener of this.listeners) {
          try {
            listener(event);
          } catch (err) {
            console.error(`[adapter-registry] listener error:`, err);
          }
        }
      }
      /** Stop all adapters and clear state (for clean shutdown). */
      shutdown() {
        for (const adapter of this.adapters.values()) {
          try {
            adapter.stop?.();
          } catch {
          }
        }
        this.adapters.clear();
        this.listeners = [];
      }
      /** Forward terminal data to all passive adapters */
      dispatchTerminalData(sessionName, data) {
        for (const adapter of this.adapters.values()) {
          if (adapter.mode === "passive" && adapter.onTerminalData) {
            try {
              adapter.onTerminalData(sessionName, data);
            } catch (err) {
              console.error(`[adapter:${adapter.id}] onTerminalData error:`, err);
            }
          }
        }
      }
      /** Forward event file data to all passive adapters */
      dispatchEventFile(path7, event) {
        for (const adapter of this.adapters.values()) {
          if (adapter.mode === "passive" && adapter.onEventFile) {
            try {
              adapter.onEventFile(path7, event);
            } catch (err) {
              console.error(`[adapter:${adapter.id}] onEventFile error:`, err);
            }
          }
        }
      }
    };
  }
});

// src/adapters/generic-shell.ts
var GenericShellAdapter;
var init_generic_shell = __esm({
  "src/adapters/generic-shell.ts"() {
    "use strict";
    GenericShellAdapter = class {
      id = "generic-shell";
      name = "Shell";
      mode = "passive";
      capabilities = ["cwd", "last-command", "exit-code"];
      state = {
        adapterId: "generic-shell",
        name: "Shell",
        mode: "passive",
        capabilities: this.capabilities,
        currentState: "idle"
      };
      lastCwd = null;
      lastCommand = null;
      onTerminalData(sessionName, data) {
        const osc7Match = data.match(/\x1b\]7;file:\/\/[^/]*([^\x07\x1b]+)/);
        if (osc7Match) {
          this.lastCwd = decodeURIComponent(osc7Match[1]);
        }
        const osc133B = data.match(/\x1b\]133;B\x07/);
        if (osc133B) {
          this.state.currentState = "running";
        }
        const osc133D = data.match(/\x1b\]133;D;?(\d*)\x07/);
        if (osc133D) {
          this.state.currentState = "idle";
        }
      }
      getCurrentState() {
        return {
          ...this.state,
          lastEvent: this.lastCwd ? {
            type: "cwd",
            seq: 0,
            timestamp: (/* @__PURE__ */ new Date()).toISOString(),
            data: { cwd: this.lastCwd, lastCommand: this.lastCommand },
            adapterId: this.id
          } : void 0
        };
      }
    };
  }
});

// src/adapters/claude-code.ts
import * as fs4 from "fs";
import * as path3 from "path";
import * as os from "os";
var ClaudeCodeAdapter;
var init_claude_code = __esm({
  "src/adapters/claude-code.ts"() {
    "use strict";
    ClaudeCodeAdapter = class {
      id = "claude-code";
      name = "Claude Code";
      mode = "passive";
      capabilities = ["run-status", "conversation-events", "tool-use"];
      state = {
        adapterId: "claude-code",
        name: "Claude Code",
        mode: "passive",
        capabilities: this.capabilities,
        currentState: "idle"
      };
      watcher = null;
      fileSizes = /* @__PURE__ */ new Map();
      eventsDir;
      onEmit;
      constructor(onEmit) {
        this.onEmit = onEmit;
        this.eventsDir = path3.join(os.homedir(), ".claude", "projects");
      }
      start() {
        this.watchForEvents();
      }
      stop() {
        this.watcher?.close();
        this.watcher = null;
      }
      onTerminalData(sessionName, data) {
        if (data.includes("claude") || data.includes("Claude")) {
          if (data.includes("Thinking...") || data.includes("\u23F3")) {
            this.updateState("running");
          } else if (data.includes("Done") || data.includes("\u2713") || data.includes("Complete")) {
            this.updateState("idle");
          } else if (data.includes("Permission") || data.includes("approve") || data.includes("Allow")) {
            this.updateState("waiting_approval");
          }
        }
      }
      getCurrentState() {
        return { ...this.state };
      }
      updateState(newState) {
        if (this.state.currentState !== newState) {
          this.state.currentState = newState;
          if (this.onEmit) {
            this.onEmit({
              type: "state_change",
              seq: Date.now(),
              timestamp: (/* @__PURE__ */ new Date()).toISOString(),
              data: { state: newState },
              adapterId: this.id
            });
          }
        }
      }
      watchForEvents() {
        if (!fs4.existsSync(this.eventsDir)) return;
        try {
          this.watcher = fs4.watch(
            this.eventsDir,
            { recursive: true },
            (eventType, filename) => {
              if (filename && (filename.endsWith("events.jsonl") || filename.endsWith("conversation.jsonl"))) {
                this.processEventFile(path3.join(this.eventsDir, filename));
              }
            }
          );
        } catch {
        }
      }
      processEventFile(filePath) {
        try {
          const stat = fs4.statSync(filePath);
          const lastSize = this.fileSizes.get(filePath) ?? 0;
          if (stat.size <= lastSize) return;
          let newData;
          const fd = fs4.openSync(filePath, "r");
          try {
            newData = Buffer.alloc(stat.size - lastSize);
            fs4.readSync(fd, newData, 0, newData.length, lastSize);
            this.fileSizes.set(filePath, stat.size);
          } finally {
            fs4.closeSync(fd);
          }
          const lines = newData.toString().split("\n").filter((l) => l.trim());
          for (const line of lines) {
            try {
              const event = JSON.parse(line);
              this.handleConversationEvent(event);
            } catch {
            }
          }
        } catch {
        }
      }
      handleConversationEvent(event) {
        const type = event.type;
        if (type === "assistant" || type === "tool_use") {
          this.updateState("running");
        } else if (type === "result" || type === "end_turn") {
          this.updateState("idle");
        } else if (type === "permission_request") {
          this.updateState("waiting_approval");
        } else if (type === "error") {
          this.updateState("error");
        }
      }
    };
  }
});

// src/adapters/codex.ts
import * as fs5 from "fs";
import * as path4 from "path";
import * as os2 from "os";
var CodexAdapter;
var init_codex = __esm({
  "src/adapters/codex.ts"() {
    "use strict";
    CodexAdapter = class {
      id = "codex";
      name = "OpenAI Codex";
      mode = "passive";
      capabilities = ["run-status", "conversation-events", "tool-use"];
      state = {
        adapterId: "codex",
        name: "OpenAI Codex",
        mode: "passive",
        capabilities: this.capabilities,
        currentState: "idle"
      };
      watcher = null;
      fileSizes = /* @__PURE__ */ new Map();
      eventsDir;
      onEmit;
      constructor(onEmit) {
        this.onEmit = onEmit;
        this.eventsDir = path4.join(os2.homedir(), ".codex");
      }
      start() {
        this.watchForEvents();
      }
      stop() {
        this.watcher?.close();
        this.watcher = null;
      }
      onTerminalData(sessionName, data) {
        if (data.includes("Thinking...") || data.includes("Working...") || data.includes("\u280B") || data.includes("\u2819") || data.includes("\u2839") || data.includes("\u2838") || data.includes("\u283C") || data.includes("\u2834") || data.includes("\u2826") || data.includes("\u2827") || data.includes("\u2807") || data.includes("\u280F")) {
          this.updateState("running");
          return;
        }
        if (data.includes("Reading file:") || data.includes("Writing file:") || data.includes("Editing file:") || data.includes("Running:") || data.includes("Patch:") || data.includes("[tool_use]")) {
          this.updateState("running");
          return;
        }
        if (data.includes("Approve?") || data.includes("[y/N]") || data.includes("[y/n]") || data.includes("Allow this?") || data.includes("Run command?")) {
          this.updateState("waiting_approval");
          return;
        }
        if (data.includes("Error:") || data.includes("Failed:")) {
          if (data.includes("codex") || data.includes("Codex") || data.includes("codex>")) {
            this.updateState("error");
            return;
          }
        }
        if (data.includes("codex>") || data.includes("Done")) {
          this.updateState("idle");
          return;
        }
      }
      getCurrentState() {
        return { ...this.state };
      }
      updateState(newState) {
        if (this.state.currentState !== newState) {
          this.state.currentState = newState;
          if (this.onEmit) {
            this.onEmit({
              type: "state_change",
              seq: Date.now(),
              timestamp: (/* @__PURE__ */ new Date()).toISOString(),
              data: { state: newState },
              adapterId: this.id
            });
          }
        }
      }
      watchForEvents() {
        if (!fs5.existsSync(this.eventsDir)) return;
        try {
          this.watcher = fs5.watch(
            this.eventsDir,
            { recursive: true },
            (eventType, filename) => {
              if (filename && (filename.endsWith(".jsonl") || filename.endsWith(".json"))) {
                this.processEventFile(path4.join(this.eventsDir, filename));
              }
            }
          );
        } catch {
        }
      }
      processEventFile(filePath) {
        try {
          const stat = fs5.statSync(filePath);
          const lastSize = this.fileSizes.get(filePath) ?? 0;
          if (stat.size <= lastSize) return;
          let newData;
          const fd = fs5.openSync(filePath, "r");
          try {
            newData = Buffer.alloc(stat.size - lastSize);
            fs5.readSync(fd, newData, 0, newData.length, lastSize);
            this.fileSizes.set(filePath, stat.size);
          } finally {
            fs5.closeSync(fd);
          }
          const lines = newData.toString().split("\n").filter((l) => l.trim());
          for (const line of lines) {
            try {
              const event = JSON.parse(line);
              this.handleSessionEvent(event);
            } catch {
            }
          }
        } catch {
        }
      }
      handleSessionEvent(event) {
        const type = event.type;
        if (type === "item.created" || type === "tool_use" || type === "turn.started") {
          this.updateState("running");
        } else if (type === "turn.completed" || type === "done") {
          this.updateState("idle");
        } else if (type === "permission_request") {
          this.updateState("waiting_approval");
        } else if (type === "error") {
          this.updateState("error");
        }
      }
    };
  }
});

// src/adapters/index.ts
var init_adapters = __esm({
  "src/adapters/index.ts"() {
    "use strict";
    init_registry();
    init_generic_shell();
    init_claude_code();
    init_codex();
    init_agent_events();
  }
});

// src/tunnel.ts
import { spawn as spawn2, execFile } from "child_process";
function parseTunnelArgs(argv) {
  if (argv.includes("--no-tunnel")) return { tunnelMode: "disable" };
  if (argv.includes("--tunnel")) return { tunnelMode: "enable" };
  return { tunnelMode: "auto" };
}
function isCloudflaredAvailable() {
  return new Promise((resolve) => {
    execFile("cloudflared", ["--version"], (err) => {
      resolve(!err);
    });
  });
}
function startTunnel(port, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn2(
      "cloudflared",
      ["tunnel", "--url", `http://localhost:${port}`],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    let resolved = false;
    let output = "";
    const TIMEOUT_MS = 3e4;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        child.kill("SIGTERM");
        reject(new Error("cloudflared tunnel URL not detected within 30s"));
      }
    }, TIMEOUT_MS);
    function handleData(data) {
      output += data.toString();
      const match = output.match(TUNNEL_URL_RE);
      if (match && !resolved) {
        resolved = true;
        clearTimeout(timer);
        child.stderr.removeListener("data", handleData);
        child.stdout.removeListener("data", handleData);
        resolve({ url: match[0], process: child });
      }
    }
    child.stderr.on("data", handleData);
    child.stdout.on("data", handleData);
    child.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        reject(err);
      }
    });
    child.on("close", (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        reject(
          new Error(
            `cloudflared exited with code ${code} before URL was detected`
          )
        );
      }
    });
    if (options.signal) {
      options.signal.addEventListener(
        "abort",
        () => {
          child.kill("SIGTERM");
        },
        { once: true }
      );
    }
  });
}
function buildTunnelAccessUrl(tunnelUrl, token, password) {
  if (password && !token) return tunnelUrl;
  if (token) return `${tunnelUrl}?token=${token}`;
  return tunnelUrl;
}
var TUNNEL_URL_RE;
var init_tunnel = __esm({
  "src/tunnel.ts"() {
    "use strict";
    TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
  }
});

// src/service.ts
import fs6 from "fs";
import path5 from "path";
import { homedir as homedir5 } from "os";
import { execSync } from "child_process";
import { fileURLToPath as fileURLToPath2 } from "url";
function escapeXml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
function generatePlist(options = {}) {
  const { port, args = [] } = options;
  const programArgs = [process.execPath, SERVER_JS, ...args];
  const programArgsXml = programArgs.map((a) => `    <string>${escapeXml(a)}</string>`).join("\n");
  const envVars = {};
  if (port) envVars.PORT = String(port);
  if (process.env.REMUX_TOKEN) envVars.REMUX_TOKEN = process.env.REMUX_TOKEN;
  let envXml = "";
  if (Object.keys(envVars).length > 0) {
    const entries = Object.entries(envVars).map(
      ([k, v]) => `      <key>${escapeXml(k)}</key>
      <string>${escapeXml(v)}</string>`
    ).join("\n");
    envXml = `
  <key>EnvironmentVariables</key>
  <dict>
${entries}
  </dict>`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${programArgsXml}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>${escapeXml(__dirname2)}</string>
  <key>StandardOutPath</key>
  <string>${escapeXml(path5.join(LOG_DIR, "remux.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(path5.join(LOG_DIR, "remux.err"))}</string>${envXml}
</dict>
</plist>
`;
}
function installService(options = {}) {
  fs6.mkdirSync(LOG_DIR, { recursive: true });
  if (fs6.existsSync(PLIST_PATH)) {
    try {
      execSync(`launchctl unload "${PLIST_PATH}"`, { stdio: "pipe" });
    } catch {
    }
  }
  const xml = generatePlist(options);
  fs6.writeFileSync(PLIST_PATH, xml);
  execSync(`launchctl load "${PLIST_PATH}"`, { stdio: "pipe" });
  console.log(`[remux] Service installed and started.`);
  console.log(`[remux]   Plist: ${PLIST_PATH}`);
  console.log(`[remux]   Logs:  ${LOG_DIR}/`);
}
function uninstallService() {
  if (!fs6.existsSync(PLIST_PATH)) {
    console.log(`[remux] Service is not installed.`);
    return;
  }
  try {
    execSync(`launchctl unload "${PLIST_PATH}"`, { stdio: "pipe" });
  } catch {
  }
  fs6.unlinkSync(PLIST_PATH);
  console.log(`[remux] Service uninstalled.`);
}
function serviceStatus() {
  if (!fs6.existsSync(PLIST_PATH)) {
    return { installed: false, running: false };
  }
  try {
    const output = execSync(`launchctl list ${LABEL}`, {
      stdio: "pipe",
      encoding: "utf8"
    });
    const firstLine = output.trim().split("\n").pop();
    const pid = firstLine?.split("	")[0];
    if (pid && pid !== "-" && !isNaN(Number(pid))) {
      return { installed: true, running: true, pid: Number(pid) };
    }
    return { installed: true, running: false };
  } catch {
    return { installed: true, running: false };
  }
}
function handleServiceCommand(argv) {
  if (argv.length < 4 || argv[2] !== "service") return false;
  const subcommand = argv[3];
  switch (subcommand) {
    case "install": {
      const opts = {};
      const portIdx = argv.indexOf("--port");
      if (portIdx !== -1 && argv[portIdx + 1]) {
        opts.port = Number(argv[portIdx + 1]);
      }
      const extra = [];
      for (let i = 4; i < argv.length; i++) {
        if (argv[i] === "--port") {
          i++;
          continue;
        }
        extra.push(argv[i]);
      }
      if (extra.length) opts.args = extra;
      installService(opts);
      return true;
    }
    case "uninstall":
      uninstallService();
      return true;
    case "status": {
      const st = serviceStatus();
      if (!st.installed) {
        console.log("[remux] Service is not installed.");
      } else if (st.running) {
        console.log(`[remux] Service is running (PID ${st.pid}).`);
      } else {
        console.log("[remux] Service is installed but not running.");
      }
      return true;
    }
    default:
      console.error(
        `[remux] Unknown service command: ${subcommand}
Usage: remux service <install|uninstall|status>`
      );
      return true;
  }
}
var __filename2, __dirname2, LABEL, PLIST_DIR, PLIST_PATH, LOG_DIR, SERVER_JS;
var init_service = __esm({
  "src/service.ts"() {
    "use strict";
    __filename2 = fileURLToPath2(import.meta.url);
    __dirname2 = path5.dirname(__filename2);
    LABEL = "com.remux.agent";
    PLIST_DIR = path5.join(homedir5(), "Library", "LaunchAgents");
    PLIST_PATH = path5.join(PLIST_DIR, `${LABEL}.plist`);
    LOG_DIR = path5.join(homedir5(), ".remux", "logs");
    SERVER_JS = path5.join(__dirname2, "server.js");
  }
});

// src/server.ts
var server_exports = {};
__export(server_exports, {
  adapterRegistry: () => adapterRegistry
});
import fs7 from "fs";
import http from "http";
import path6 from "path";
import { createRequire } from "module";
import { fileURLToPath as fileURLToPath3 } from "url";
import qrcode from "qrcode-terminal";
function findGhosttyWeb() {
  const ghosttyWebMain = require2.resolve("ghostty-web");
  const ghosttyWebRoot = ghosttyWebMain.replace(/[/\\]dist[/\\].*$/, "");
  const distPath2 = path6.join(ghosttyWebRoot, "dist");
  const wasmPath2 = path6.join(ghosttyWebRoot, "ghostty-vt.wasm");
  if (fs7.existsSync(path6.join(distPath2, "ghostty-web.js")) && fs7.existsSync(wasmPath2)) {
    return { distPath: distPath2, wasmPath: wasmPath2 };
  }
  console.error("Error: ghostty-web package not found.");
  process.exit(1);
}
async function startup() {
  getDb();
  initPush();
  await initGhosttyVt(wasmPath);
  const saved = restoreSessions();
  if (saved && saved.sessions.length > 0) {
    for (const s of saved.sessions) {
      const session = createSession(s.name);
      for (const t of s.tabs) {
        if (t.ended) continue;
        const daemonSocket = findAliveDaemonSocket(t.id);
        const restoredTab = createRestoredTab(session, t);
        if (daemonSocket) {
          reattachToDaemon(restoredTab, session, daemonSocket).catch(() => {
            console.log(`[startup] daemon reattach failed for tab ${t.id}, staying in restored mode`);
          });
        }
      }
      if (session.tabs.length === 0) createTab(session);
    }
  }
  if (sessionMap.size === 0) {
    const s = createSession("default");
    createTab(s);
  }
  setInterval(persistSessions, PERSIST_INTERVAL_MS);
  initGitService();
  initAdapters();
  startupDone = true;
}
function initAdapters() {
  adapterRegistry.register(new GenericShellAdapter());
  const claudeAdapter = new ClaudeCodeAdapter((event) => {
    adapterRegistry.emit(event.adapterId, event.type, event.data);
  });
  adapterRegistry.register(claudeAdapter);
  const codexAdapter = new CodexAdapter((event) => {
    adapterRegistry.emit(event.adapterId, event.type, event.data);
  });
  adapterRegistry.register(codexAdapter);
}
function serveFile(filePath, res) {
  const ext = path6.extname(filePath);
  fs7.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream"
    });
    res.end(data);
  });
}
async function launchTunnel() {
  if (tunnelMode === "disable") return;
  const available = await isCloudflaredAvailable();
  if (!available) {
    if (tunnelMode === "enable") {
      console.log(
        "\n  [tunnel] cloudflared not found -- install it for tunnel support"
      );
      console.log(
        "  https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/\n"
      );
    }
    return;
  }
  console.log("  [tunnel] starting cloudflare tunnel...");
  try {
    const { url: tunnelUrl, process: child } = await startTunnel(
      Number(PORT2)
    );
    tunnelProcess = child;
    const accessUrl = buildTunnelAccessUrl(tunnelUrl, TOKEN, PASSWORD);
    console.log(`
  Tunnel: ${accessUrl}
`);
    qrcode.generate(accessUrl, { small: true }, (code) => {
      console.log(code);
    });
    child.on("close", (code) => {
      if (code !== null && code !== 0) {
        console.log(`  [tunnel] cloudflared exited (code ${code})`);
      }
      tunnelProcess = null;
    });
  } catch (err) {
    console.log(`  [tunnel] failed to start: ${err.message}`);
    tunnelProcess = null;
  }
}
function shutdown() {
  try {
    persistSessions();
  } catch (e) {
    console.error("[shutdown] persist failed:", e.message);
  }
  closeDb();
  adapterRegistry.shutdown();
  if (tunnelProcess) {
    try {
      tunnelProcess.kill("SIGTERM");
    } catch {
    }
    tunnelProcess = null;
  }
  for (const session of sessionMap.values()) {
    for (const tab of session.tabs) {
      if (tab.vt) {
        tab.vt.dispose();
        tab.vt = null;
      }
      if (!tab.ended && tab.pty) tab.pty.kill();
    }
  }
  process.exit(0);
}
var __filename3, __dirname3, require2, PKG, VERSION, PORT2, TOKEN, PASSWORD, tunnelMode, tunnelProcess, distPath, wasmPath, startupDone, adapterRegistry, HTML_TEMPLATE, SW_SCRIPT, MIME, httpServer, wss;
var init_server = __esm({
  "src/server.ts"() {
    init_auth();
    init_vt_tracker();
    init_store();
    init_push();
    init_session();
    init_ws_handler();
    init_adapters();
    init_git_service();
    init_tunnel();
    init_service();
    __filename3 = fileURLToPath3(import.meta.url);
    __dirname3 = path6.dirname(__filename3);
    if (handleServiceCommand(process.argv)) {
      process.exit(0);
    }
    require2 = createRequire(import.meta.url);
    PKG = JSON.parse(
      fs7.readFileSync(path6.join(__dirname3, "package.json"), "utf8")
    );
    VERSION = PKG.version;
    PORT2 = process.env.PORT || 8767;
    ({ TOKEN, PASSWORD } = resolveAuth(process.argv));
    ({ tunnelMode } = parseTunnelArgs(process.argv));
    tunnelProcess = null;
    ({ distPath, wasmPath } = findGhosttyWeb());
    startupDone = false;
    adapterRegistry = new AdapterRegistry();
    startup().catch((e) => {
      console.error("[startup] fatal:", e);
      if (sessionMap.size === 0) {
        const s = createSession("main");
        createTab(s);
      }
      startupDone = true;
    });
    HTML_TEMPLATE = `<!doctype html>
<html lang="en" data-theme="dark">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
    <title>Remux</title>
    <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>\u2B1B</text></svg>">
    <style>
      /* -- Theme Variables -- */
      [data-theme="dark"] {
        --bg: #1e1e1e;
        --bg-sidebar: #252526;
        --bg-tab-bar: #2d2d2d;
        --bg-tab-active: #1e1e1e;
        --bg-hover: #2a2d2e;
        --bg-active: #37373d;
        --border: #1a1a1a;
        --text: #ccc;
        --text-muted: #888;
        --text-dim: #666;
        --text-bright: #e5e5e5;
        --text-on-active: #fff;
        --accent: #007acc;
        --dot-ok: #27c93f;
        --dot-err: #ff5f56;
        --dot-warn: #ffbd2e;
        --compose-bg: #3a3a3a;
        --compose-border: #555;
        --tab-hover: #383838;
        --view-switch-bg: #1a1a1a;
        --inspect-meta-border: #333;
      }

      [data-theme="light"] {
        --bg: #ffffff;
        --bg-sidebar: #f3f3f3;
        --bg-tab-bar: #e8e8e8;
        --bg-tab-active: #ffffff;
        --bg-hover: #e8e8e8;
        --bg-active: #d6d6d6;
        --border: #d4d4d4;
        --text: #333333;
        --text-muted: #666666;
        --text-dim: #999999;
        --text-bright: #1e1e1e;
        --text-on-active: #000000;
        --accent: #007acc;
        --dot-ok: #16a34a;
        --dot-err: #dc2626;
        --dot-warn: #d97706;
        --compose-bg: #e8e8e8;
        --compose-border: #c0c0c0;
        --tab-hover: #d6d6d6;
        --view-switch-bg: #d4d4d4;
        --inspect-meta-border: #d4d4d4;
      }

      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { height: 100%; overflow: hidden; overscroll-behavior: none; }
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        background: var(--bg); color: var(--text); height: 100vh; height: 100dvh; display: flex; }

      /* -- Sidebar -- */
      .sidebar { width: 220px; min-width: 220px; background: var(--bg-sidebar); border-right: 1px solid var(--border);
        display: flex; flex-direction: column; flex-shrink: 0; transition: margin-left .2s; }
      .sidebar.collapsed { margin-left: -220px; }
      .sidebar-header { padding: 10px 12px; font-size: 11px; font-weight: 600; color: var(--text-muted);
        text-transform: uppercase; letter-spacing: .5px; display: flex; align-items: center;
        justify-content: space-between; }
      .sidebar-header button { background: none; border: none; color: var(--text-dim); cursor: pointer;
        font-size: 18px; line-height: 1; padding: 2px 6px; border-radius: 4px; }
      .sidebar-header button:hover { color: var(--text-bright); background: var(--compose-bg); }

      .session-list { flex: 1; overflow-y: auto; padding: 4px 6px; }
      .session-item { display: flex; align-items: center; gap: 8px; padding: 7px 8px; border-radius: 4px;
        font-size: 13px; cursor: pointer; color: var(--text); border: none; background: none;
        width: 100%; text-align: left; font-family: inherit; min-height: 32px; }
      .session-item:hover { background: var(--bg-hover); color: var(--text-bright); }
      .session-item.active { background: var(--bg-active); color: var(--text-on-active); }
      .session-item .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dot-ok); flex-shrink: 0; }
      .session-item .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .session-item .count { font-size: 10px; color: var(--compose-border); min-width: 16px; text-align: center; }
      .session-item .del { opacity: 0; font-size: 14px; color: var(--text-dim); background: none; border: none;
        cursor: pointer; padding: 0 4px; font-family: inherit; line-height: 1; border-radius: 3px; }
      .session-item:hover .del { opacity: 1; }
      .session-item .del:hover { color: var(--dot-err); background: var(--compose-bg); }

      .sidebar-footer { padding: 8px 12px; border-top: 1px solid var(--border);
        display: flex; flex-direction: column; gap: 6px; }
      .sidebar-footer .version { font-size: 10px; color: var(--text-dim); }
      .sidebar-footer .footer-row { display: flex; align-items: center; gap: 8px; }
      .sidebar-footer .status { font-size: 11px; color: var(--text-muted); display: flex; align-items: center; gap: 6px; }
      .status-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--text-muted); flex-shrink: 0; }
      .status-dot.connected { background: var(--dot-ok); }
      .status-dot.disconnected { background: var(--dot-err); }
      .status-dot.connecting { background: var(--dot-warn); animation: pulse 1s infinite; }
      @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.5} }

      .role-indicator { font-size: 11px; color: var(--text-muted); display: flex; align-items: center; gap: 4px; }
      .role-indicator.active { color: var(--dot-ok); }
      .role-indicator.observer { color: var(--dot-warn); }
      .role-btn { background: none; border: 1px solid var(--border); border-radius: 4px;
        color: var(--text-muted); font-size: 10px; padding: 2px 8px; cursor: pointer; font-family: inherit; }
      .role-btn:hover { color: var(--text-bright); border-color: var(--text-muted); }

      /* -- Theme toggle -- */
      .theme-toggle { background: none; border: none; cursor: pointer; font-size: 16px;
        color: var(--text-muted); padding: 4px 8px; border-radius: 4px; }
      .theme-toggle:hover { color: var(--text-bright); background: var(--bg-hover); }

      /* -- Main -- */
      .main { flex: 1; display: flex; flex-direction: column; min-width: 0; }

      /* -- Tab bar (Chrome-style) -- */
      .tab-bar { background: var(--bg-tab-bar); display: flex; align-items: flex-end; flex-shrink: 0;
        min-height: 36px; padding: 0 0 0 0; position: relative; z-index: 101; }
      .tab-toggle { padding: 8px 10px; background: none; border: none; color: var(--text-muted);
        cursor: pointer; font-size: 16px; flex-shrink: 0; align-self: center; }
      .tab-toggle:hover { color: var(--text-bright); }
      .tab-list { display: flex; flex: 1; min-width: 0; align-items: flex-end; overflow-x: auto;
        -webkit-overflow-scrolling: touch; scrollbar-width: none; }
      .tab-list::-webkit-scrollbar { display: none; }

      .tab { position: relative; display: flex; align-items: center; gap: 0;
        padding: 6px 8px 6px 12px; font-size: 12px; color: var(--text-dim); background: var(--bg-tab-bar);
        border: none; cursor: pointer; white-space: nowrap; font-family: inherit;
        border-top: 2px solid transparent; margin-right: 1px; min-height: 32px; }
      .tab:hover { color: var(--text-bright); background: var(--tab-hover); }
      .tab.active { color: var(--text-on-active); background: var(--bg-tab-active); border-top-color: var(--accent);
        border-radius: 6px 6px 0 0; }
      .tab .title { pointer-events: none; }
      .tab .close { display: flex; align-items: center; justify-content: center;
        width: 18px; height: 18px; margin-left: 6px; font-size: 12px; color: var(--text-dim);
        border-radius: 3px; border: none; background: none; cursor: pointer;
        font-family: inherit; flex-shrink: 0; }
      .tab .close:hover { color: var(--text-on-active); background: var(--compose-border); }
      .tab:not(:hover) .close:not(:focus) { opacity: 0; }
      .tab.active .close { opacity: 1; color: var(--text-muted); }

      .tab .client-count { font-size: 9px; color: var(--text-muted); margin-left: 4px;
        background: var(--bg-hover); border-radius: 8px; padding: 1px 5px; pointer-events: none; }

      .tab-new { display: flex; align-items: center; justify-content: center;
        width: 28px; height: 28px; margin: 0 4px; font-size: 18px; color: var(--text-dim);
        background: none; border: none; cursor: pointer; border-radius: 4px;
        flex-shrink: 0; align-self: center; }
      .tab-new:hover { color: var(--text); background: var(--compose-bg); }

      /* -- Terminal -- */
      #terminal { flex: 1; background: var(--bg); overflow: hidden; position: relative; }
      #terminal canvas { display: block; position: absolute; top: 0; left: 0; }
      #terminal.hidden { display: none; }

      /* -- View switcher -- */
      .view-switch { display: flex; gap: 1px; margin-left: auto; margin-right: 8px;
        align-self: center; background: var(--view-switch-bg); border-radius: 4px; overflow: hidden; }
      .view-switch button { padding: 4px 10px; font-size: 11px; font-family: inherit;
        color: var(--text-muted); background: var(--bg-tab-bar); border: none; cursor: pointer; }
      .view-switch button:hover { color: var(--text); }
      .view-switch button.active { color: var(--text-on-active); background: var(--accent); }

      /* -- Inspect -- */
      #inspect { flex: 1; background: var(--bg); overflow: auto; display: none;
        padding: 12px 16px; -webkit-overflow-scrolling: touch; }
      #inspect.visible { display: block; }

      /* -- Workspace -- */
      #workspace { flex: 1; background: var(--bg); overflow: auto; display: none;
        padding: 12px 16px; -webkit-overflow-scrolling: touch; }
      #workspace.visible { display: block; }
      .ws-section { margin-bottom: 16px; }
      .ws-section-title { font-size: 12px; font-weight: 600; color: var(--text-muted);
        text-transform: uppercase; letter-spacing: .5px; margin-bottom: 8px;
        display: flex; align-items: center; justify-content: space-between; }
      .ws-section-title button { background: none; border: 1px solid var(--border);
        color: var(--text-muted); font-size: 11px; padding: 2px 8px; border-radius: 4px;
        cursor: pointer; font-family: inherit; }
      .ws-section-title button:hover { color: var(--text-bright); border-color: var(--text-muted); }
      .ws-empty { font-size: 12px; color: var(--text-dim); padding: 8px 0; }
      .ws-card { background: var(--bg-sidebar); border: 1px solid var(--border); border-radius: 6px;
        padding: 8px 12px; margin-bottom: 6px; }
      .ws-card-header { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
      .ws-card-title { font-size: 13px; color: var(--text-bright); font-weight: 500; flex: 1;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ws-card-meta { font-size: 10px; color: var(--text-dim); }
      .ws-card-desc { font-size: 12px; color: var(--text-muted); margin-top: 2px; }
      .ws-badge { display: inline-block; font-size: 10px; padding: 1px 6px; border-radius: 8px;
        font-weight: 500; }
      .ws-badge.running { background: #1a3a5c; color: #4da6ff; }
      .ws-badge.completed { background: #1a3c1a; color: #4dff4d; }
      .ws-badge.failed { background: #3c1a1a; color: #ff4d4d; }
      .ws-badge.pending { background: #3c3a1a; color: #ffbd2e; }
      .ws-badge.approved { background: #1a3c1a; color: #4dff4d; }
      .ws-badge.rejected { background: #3c1a1a; color: #ff4d4d; }
      .ws-badge.snapshot { background: #1a2a3c; color: #88bbdd; }
      .ws-badge.command-card { background: #2a1a3c; color: #bb88dd; }
      .ws-badge.note { background: #1a3c2a; color: #88ddbb; }
      .ws-badge.diff { background: #2a2a1a; color: #ddbb55; }
      .ws-badge.markdown { background: #1a2a2a; color: #55bbdd; }
      .ws-badge.ansi { background: #2a1a2a; color: #dd88bb; }
      .ws-card-actions { display: flex; gap: 4px; margin-top: 6px; }
      .ws-card-actions button { background: none; border: 1px solid var(--border);
        color: var(--text-muted); font-size: 11px; padding: 3px 10px; border-radius: 4px;
        cursor: pointer; font-family: inherit; }
      .ws-card-actions button:hover { color: var(--text-bright); border-color: var(--text-muted); }
      .ws-card-actions button.approve { border-color: #27c93f; color: #27c93f; }
      .ws-card-actions button.approve:hover { background: #27c93f22; }
      .ws-card-actions button.reject { border-color: #ff5f56; color: #ff5f56; }
      .ws-card-actions button.reject:hover { background: #ff5f5622; }
      .ws-card .del-topic { opacity: 0; background: none; border: none; color: var(--text-dim);
        cursor: pointer; font-size: 14px; padding: 0 4px; font-family: inherit; border-radius: 3px; }
      .ws-card:hover .del-topic { opacity: 1; }
      .ws-card .del-topic:hover { color: var(--dot-err); }

      /* -- Search bar -- */
      .ws-search { display: flex; gap: 8px; margin-bottom: 16px; }
      .ws-search input { flex: 1; padding: 6px 10px; font-size: 13px; font-family: inherit;
        background: var(--compose-bg); border: 1px solid var(--compose-border); border-radius: 6px;
        color: var(--text-bright); outline: none; }
      .ws-search input:focus { border-color: var(--accent); }
      .ws-search input::placeholder { color: var(--text-dim); }
      .ws-search-results { margin-bottom: 12px; }
      .ws-search-result { padding: 6px 10px; margin-bottom: 4px; background: var(--bg-sidebar);
        border: 1px solid var(--border); border-radius: 4px; cursor: pointer; }
      .ws-search-result:hover { border-color: var(--accent); }
      .ws-search-result .sr-type { font-size: 10px; color: var(--text-dim); text-transform: uppercase; }
      .ws-search-result .sr-title { font-size: 12px; color: var(--text-bright); }

      /* -- Notes -- */
      .ws-note { background: var(--bg-sidebar); border: 1px solid var(--border); border-radius: 6px;
        padding: 8px 12px; margin-bottom: 6px; position: relative; }
      .ws-note.pinned { border-color: var(--accent); }
      .ws-note-content { font-size: 12px; color: var(--text-bright); white-space: pre-wrap; word-break: break-word; }
      .ws-note-actions { display: flex; gap: 4px; margin-top: 4px; }
      .ws-note-actions button { background: none; border: none; color: var(--text-dim);
        font-size: 11px; cursor: pointer; padding: 2px 6px; border-radius: 3px; font-family: inherit; }
      .ws-note-actions button:hover { color: var(--text-bright); background: var(--bg-hover); }
      .ws-note-input { display: flex; gap: 6px; margin-bottom: 8px; }
      .ws-note-input input { flex: 1; padding: 6px 10px; font-size: 12px; font-family: inherit;
        background: var(--compose-bg); border: 1px solid var(--compose-border); border-radius: 4px;
        color: var(--text-bright); outline: none; }
      .ws-note-input input:focus { border-color: var(--accent); }
      .ws-note-input button { padding: 4px 12px; font-size: 12px; font-family: inherit;
        background: var(--accent); color: #fff; border: none; border-radius: 4px; cursor: pointer; }

      /* -- Commands -- */
      .ws-cmd { background: var(--bg-sidebar); border: 1px solid var(--border); border-radius: 6px;
        padding: 6px 12px; margin-bottom: 4px; display: flex; align-items: center; gap: 8px; }
      .ws-cmd-text { font-size: 12px; color: var(--text-bright); font-family: 'Menlo','Monaco',monospace;
        flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ws-cmd-exit { font-size: 11px; font-weight: 600; }
      .ws-cmd-exit.ok { color: #27c93f; }
      .ws-cmd-exit.err { color: #ff5f56; }
      .ws-cmd-meta { font-size: 10px; color: var(--text-dim); white-space: nowrap; }

      /* -- Handoff -- */
      .ws-handoff { background: var(--bg-sidebar); border: 1px solid var(--border); border-radius: 6px;
        padding: 12px; margin-bottom: 12px; display: none; }
      .ws-handoff.visible { display: block; }
      .ws-handoff-section { margin-bottom: 8px; }
      .ws-handoff-label { font-size: 11px; color: var(--text-dim); text-transform: uppercase;
        letter-spacing: .5px; margin-bottom: 4px; }
      .ws-handoff-list { font-size: 12px; color: var(--text-muted); padding-left: 12px; }
      .ws-handoff-list li { margin-bottom: 2px; }

      /* -- Rich content rendering (diff, markdown, ANSI) -- */
      .ws-card-content { margin-top: 6px; font-size: 12px; max-height: 200px; overflow: auto;
        border-top: 1px solid var(--border); padding-top: 6px; }
      .ws-card-content.expanded { max-height: none; }
      .ws-card-toggle { font-size: 11px; color: var(--text-dim); background: none; border: none;
        cursor: pointer; padding: 2px 6px; font-family: inherit; border-radius: 3px; }
      .ws-card-toggle:hover { color: var(--text-bright); background: var(--bg-hover); }

      /* Diff */
      .diff-container { font-family: 'Menlo','Monaco','Courier New',monospace; font-size: 11px;
        line-height: 1.5; overflow-x: auto; }
      .diff-container > div { padding: 0 8px; white-space: pre; }
      .diff-add { background: #1a3a1a; color: #4eff4e; }
      .diff-del { background: #3a1a1a; color: #ff4e4e; }
      .diff-hunk { color: #6a9eff; font-style: italic; }
      .diff-header { color: #888; font-style: italic; }
      .diff-ctx { color: var(--text-muted); }
      .diff-line-num { display: inline-block; width: 32px; text-align: right; margin-right: 8px;
        color: var(--text-dim); user-select: none; }

      /* Markdown */
      .rendered-md { font-size: 13px; line-height: 1.6; color: var(--text-bright); }
      .rendered-md h1 { font-size: 18px; margin: 0.5em 0 0.3em; border-bottom: 1px solid var(--border); padding-bottom: 4px; }
      .rendered-md h2 { font-size: 15px; margin: 0.5em 0 0.3em; }
      .rendered-md h3 { font-size: 13px; margin: 0.5em 0 0.3em; font-weight: 600; }
      .rendered-md p { margin: 0.4em 0; }
      .rendered-md code { background: #2a2a2a; padding: 2px 6px; border-radius: 3px;
        font-family: 'Menlo','Monaco',monospace; font-size: 11px; }
      .rendered-md pre { background: #1e1e1e; padding: 12px; border-radius: 6px;
        overflow-x: auto; margin: 0.4em 0; }
      .rendered-md pre code { background: none; padding: 0; font-size: 11px; }
      .rendered-md blockquote { border-left: 3px solid #555; padding-left: 12px; color: #aaa;
        margin: 0.4em 0; }
      .rendered-md ul, .rendered-md ol { padding-left: 20px; margin: 0.3em 0; }
      .rendered-md li { margin: 0.15em 0; }
      .rendered-md a { color: var(--accent); text-decoration: none; }
      .rendered-md a:hover { text-decoration: underline; }
      .rendered-md hr { border: none; border-top: 1px solid var(--border); margin: 0.5em 0; }
      .rendered-md strong { color: var(--text-on-active); }

      /* ANSI */
      .ansi-bold { font-weight: bold; }
      .ansi-dim { opacity: 0.6; }
      .ansi-italic { font-style: italic; }
      .ansi-underline { text-decoration: underline; }

      /* Light theme overrides */
      [data-theme="light"] .diff-add { background: #e6ffec; color: #1a7f37; }
      [data-theme="light"] .diff-del { background: #ffebe9; color: #cf222e; }
      [data-theme="light"] .diff-hunk { color: #0969da; }
      [data-theme="light"] .diff-header { color: #6e7781; }
      [data-theme="light"] .diff-ctx { color: #57606a; }
      [data-theme="light"] .rendered-md code { background: #eee; }
      [data-theme="light"] .rendered-md pre { background: #f6f8fa; }
      [data-theme="light"] .rendered-md blockquote { border-left-color: #ccc; color: #666; }

      #inspect-content { font-family: 'Menlo','Monaco','Courier New',monospace; font-size: 13px;
        line-height: 1.5; color: var(--text-bright); white-space: pre-wrap; word-break: break-all;
        tab-size: 8; user-select: text; -webkit-user-select: text; }
      #inspect-content mark { background: #ffbd2e; color: #1e1e1e; border-radius: 2px; }
      #inspect-header { font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 11px;
        color: var(--text-dim); padding: 8px 0; border-bottom: 1px solid var(--inspect-meta-border); margin-bottom: 8px;
        display: flex; flex-direction: column; gap: 8px; }
      #inspect-meta { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
      #inspect-meta span { white-space: nowrap; }
      #inspect-meta .inspect-btn { padding: 2px 10px; font-size: 11px; font-family: inherit;
        color: var(--text-bright); background: var(--compose-bg); border: 1px solid var(--compose-border);
        border-radius: 4px; cursor: pointer; white-space: nowrap; }
      #inspect-meta .inspect-btn:hover { background: var(--compose-border); }
      #inspect-search { display: flex; gap: 8px; align-items: center; }
      #inspect-search input { padding: 4px 8px; font-size: 12px; font-family: inherit;
        background: var(--bg); border: 1px solid var(--compose-border); border-radius: 4px;
        color: var(--text); outline: none; flex: 1; max-width: 260px; }
      #inspect-search input:focus { border-color: var(--accent); }
      #inspect-search .match-count { font-size: 11px; color: var(--text-muted); white-space: nowrap; }

      /* -- Compose bar -- */
      .compose-bar { display: none; background: var(--bg-sidebar); border-top: 1px solid var(--border);
        padding: 5px 8px; gap: 5px; flex-shrink: 0; overflow-x: auto; flex-wrap: wrap;
        -webkit-overflow-scrolling: touch; }
      .compose-bar button { padding: 8px 12px; font-size: 14px;
        font-family: 'Menlo','Monaco',monospace; color: var(--text-bright); background: var(--compose-bg);
        border: 1px solid var(--compose-border); border-radius: 5px; cursor: pointer; white-space: nowrap;
        -webkit-tap-highlight-color: transparent; touch-action: manipulation;
        min-width: 40px; text-align: center; user-select: none; }
      .compose-bar button:active { background: var(--compose-border); }
      .compose-bar button.active { background: #4a6a9a; border-color: #6a9ade; }
      @media (hover: none) and (pointer: coarse) { .compose-bar { display: flex; } }

      /* -- Tab rename input -- */
      .tab .rename-input { background: var(--bg); border: 1px solid var(--accent); border-radius: 3px;
        color: var(--text-bright); font-size: 12px; font-family: inherit; padding: 1px 4px;
        outline: none; width: 80px; }

      /* -- Devices section -- */
      .devices-section { border-top: 1px solid var(--border); }
      .devices-header { padding: 8px 12px; font-size: 11px; font-weight: 600; color: var(--text-muted);
        text-transform: uppercase; letter-spacing: .5px; cursor: pointer; display: flex;
        align-items: center; justify-content: space-between; user-select: none; }
      .devices-header:hover { color: var(--text-bright); }
      .devices-toggle { font-size: 8px; transition: transform .2s; }
      .devices-toggle.collapsed { transform: rotate(-90deg); }
      .devices-list { padding: 2px 6px; max-height: 200px; overflow-y: auto; }
      .devices-list.collapsed { display: none; }
      .device-item { display: flex; align-items: center; gap: 6px; padding: 5px 8px; border-radius: 4px;
        font-size: 12px; color: var(--text); }
      .device-item:hover { background: var(--bg-hover); }
      .device-item .device-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
      .device-dot.trusted { background: var(--dot-ok); }
      .device-dot.untrusted { background: var(--dot-warn); }
      .device-dot.blocked { background: var(--dot-err); }
      .device-item .device-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .device-item .device-self { font-size: 9px; color: var(--accent); margin-left: 2px; }
      .device-item .device-actions { display: flex; gap: 2px; opacity: 0; }
      .device-item:hover .device-actions { opacity: 1; }
      .device-actions button { background: none; border: none; color: var(--text-dim); cursor: pointer;
        font-size: 11px; padding: 1px 4px; border-radius: 3px; font-family: inherit; }
      .device-actions button:hover { color: var(--text-bright); background: var(--compose-bg); }
      .devices-actions { padding: 4px 12px 8px; }
      .pair-btn { width: 100%; padding: 5px 8px; font-size: 11px; font-family: inherit;
        color: var(--text-bright); background: var(--compose-bg); border: 1px solid var(--compose-border);
        border-radius: 4px; cursor: pointer; margin-bottom: 4px; }
      .pair-btn:hover { background: var(--compose-border); }
      .pair-code-display { text-align: center; padding: 6px; }
      .pair-code { font-family: 'Menlo','Monaco',monospace; font-size: 24px; font-weight: bold;
        color: var(--accent); letter-spacing: 4px; }
      .pair-expires { display: block; font-size: 10px; color: var(--text-dim); margin-top: 2px; }
      .pair-input-area { display: flex; gap: 4px; }
      .pair-input-area input { flex: 1; min-width: 0; padding: 5px 8px; font-size: 13px; font-family: 'Menlo','Monaco',monospace;
        background: var(--bg); border: 1px solid var(--compose-border); border-radius: 4px;
        color: var(--text); outline: none; text-align: center; letter-spacing: 2px; }
      .pair-input-area input:focus { border-color: var(--accent); }
      .pair-input-area .pair-btn { flex-shrink: 0; width: auto; }

      /* -- Push notification section -- */
      .push-section { padding: 4px 12px 8px; border-top: 1px solid var(--border); }
      .push-toggle { width: 100%; padding: 5px 8px; font-size: 11px; font-family: inherit;
        color: var(--text-bright); background: var(--compose-bg); border: 1px solid var(--compose-border);
        border-radius: 4px; cursor: pointer; display: flex; align-items: center; gap: 6px;
        justify-content: center; }
      .push-toggle:hover { background: var(--compose-border); }
      .push-toggle.subscribed { background: var(--accent); border-color: var(--accent); }
      .push-toggle .push-icon { font-size: 14px; }
      .push-test-btn { width: 100%; padding: 4px 8px; font-size: 10px; font-family: inherit;
        color: var(--text-muted); background: none; border: 1px solid var(--border);
        border-radius: 4px; cursor: pointer; margin-top: 4px; }
      .push-test-btn:hover { color: var(--text-bright); border-color: var(--compose-border); }

      /* -- Mobile -- */
      @media (max-width: 768px) {
        .sidebar { position: fixed; left: 0; top: 0; bottom: 0; z-index: 100;
          width: 260px; margin-left: 0; transform: translateX(-100%); box-shadow: none;
          transition: transform .2s ease, box-shadow .2s ease; overflow-y: auto; }
        .sidebar.open { transform: translateX(0); box-shadow: 4px 0 20px rgba(0,0,0,.5); }
        .sidebar-overlay { display: none; position: fixed; inset: 0;
          background: rgba(0,0,0,.4); z-index: 99; pointer-events: none; }
        .sidebar-overlay.visible { display: block; pointer-events: auto; }
        .main { margin-left: 0 !important; width: 100vw; min-width: 0; }
        .tab-bar { overflow-x: auto; }
        .session-item { min-height: 44px; } /* touch-friendly */
        .tab { min-height: 36px; }
      }
    </style>
  </head>
  <body>
    <div class="sidebar-overlay" id="sidebar-overlay"></div>
    <aside class="sidebar" id="sidebar">
      <div class="sidebar-header">
        <span>Sessions</span>
        <button id="btn-new-session" title="New session">+</button>
      </div>
      <div class="session-list" id="session-list"></div>

      <!-- Devices section (collapsible) -->
      <div class="devices-section" id="devices-section">
        <div class="devices-header" id="devices-header">
          <span>Devices</span>
          <span class="devices-toggle" id="devices-toggle">&#9660;</span>
        </div>
        <div class="devices-list" id="devices-list"></div>
        <div class="devices-actions" id="devices-actions" style="display:none">
          <button class="pair-btn" id="btn-pair">Generate Pair Code</button>
          <div class="pair-code-display" id="pair-code-display" style="display:none">
            <span class="pair-code" id="pair-code-value"></span>
            <span class="pair-expires" id="pair-expires"></span>
          </div>
          <div class="pair-input-area" id="pair-input-area" style="display:none">
            <input type="text" id="pair-code-input" placeholder="Enter 6-digit code" maxlength="6" />
            <button class="pair-btn" id="btn-submit-pair">Pair</button>
          </div>
        </div>
      </div>

      <!-- Push notifications -->
      <div class="push-section" id="push-section" style="display:none">
        <button class="push-toggle" id="btn-push-toggle">
          <span class="push-icon">&#128276;</span>
          <span id="push-label">Enable Notifications</span>
        </button>
        <button class="push-test-btn" id="btn-push-test" style="display:none">Send Test</button>
      </div>

      <div class="sidebar-footer">
        <div class="role-indicator" id="role-indicator">
          <span id="role-dot"></span>
          <span id="role-text"></span>
          <button class="role-btn" id="btn-role" style="display:none"></button>
        </div>
        <button id="btn-theme" class="theme-toggle" title="Toggle theme">&#9728;</button>
        <div class="status">
          <div class="status-dot connecting" id="status-dot"></div>
          <span id="status-text">...</span>
        </div>
        <div class="version">v${VERSION}</div>
      </div>
    </aside>
    <div class="main">
      <div class="tab-bar">
        <button class="tab-toggle" id="btn-sidebar" title="Toggle sidebar">&#9776;</button>
        <div class="tab-list" id="tab-list"></div>
        <button class="tab-new" id="btn-new-tab" title="New tab">+</button>
        <div class="view-switch">
          <button id="btn-live" class="active">Live</button>
          <button id="btn-inspect">Inspect</button>
          <button id="btn-workspace">Workspace</button>
        </div>
      </div>
      <div id="terminal"></div>
      <div id="inspect">
        <div id="inspect-header">
          <div id="inspect-meta"></div>
          <div id="inspect-search">
            <input type="text" id="inspect-search-input" placeholder="Search..." />
            <span class="match-count" id="inspect-match-count"></span>
          </div>
        </div>
        <pre id="inspect-content"></pre>
      </div>
      <div id="workspace">
        <div class="ws-search">
          <input type="text" id="ws-search-input" placeholder="Search topics, artifacts, runs..." />
        </div>
        <div id="ws-search-results" class="ws-search-results"></div>
        <div id="ws-handoff" class="ws-handoff"></div>
        <div class="ws-section" id="ws-notes-section">
          <div class="ws-section-title">
            <span>Notes</span>
            <button id="btn-handoff">Handoff</button>
          </div>
          <div class="ws-note-input">
            <input type="text" id="ws-note-input" placeholder="Add a note..." />
            <button id="btn-add-note">Add</button>
          </div>
          <div id="ws-notes"></div>
        </div>
        <div class="ws-section">
          <div class="ws-section-title">
            <span>Pending Approvals</span>
          </div>
          <div id="ws-approvals"></div>
        </div>
        <div class="ws-section">
          <div class="ws-section-title">
            <span>Topics</span>
            <button id="btn-new-topic">+ New</button>
          </div>
          <div id="ws-topics"></div>
        </div>
        <div class="ws-section">
          <div class="ws-section-title">
            <span>Active Runs</span>
          </div>
          <div id="ws-runs"></div>
        </div>
        <div class="ws-section">
          <div class="ws-section-title">
            <span>Recent Artifacts</span>
            <button id="btn-capture-snapshot">Capture Snapshot</button>
          </div>
          <div id="ws-artifacts"></div>
        </div>
        <div class="ws-section">
          <div class="ws-section-title">
            <span>Commands</span>
          </div>
          <div id="ws-commands"></div>
        </div>
      </div>
      <div class="compose-bar" id="compose-bar">
        <button data-seq="esc">Esc</button>
        <button data-seq="tab">Tab</button>
        <button data-mod="ctrl" id="btn-ctrl">Ctrl</button>
        <button data-seq="up">&#8593;</button>
        <button data-seq="down">&#8595;</button>
        <button data-seq="left">&#8592;</button>
        <button data-seq="right">&#8594;</button>
        <button data-ch="|">|</button>
        <button data-ch="~">~</button>
        <button data-ch="/">/ </button>
        <button data-seq="ctrl-c">C-c</button>
        <button data-seq="ctrl-d">C-d</button>
        <button data-seq="ctrl-z">C-z</button>
        <button data-seq="pgup">PgUp</button>
        <button data-seq="pgdn">PgDn</button>
        <button data-seq="home">Home</button>
        <button data-seq="end">End</button>
      </div>
    </div>

    <script type="module">
      import { init, Terminal, FitAddon } from '/dist/ghostty-web.js';
      await init();

      // -- Terminal color themes (ghostty-web ITheme) --
      const THEMES = {
        dark: {
          // ghostty-web default dark
          background: '#1e1e1e', foreground: '#d4d4d4', cursor: '#ffffff',
          cursorAccent: '#1e1e1e', selectionBackground: '#264f78', selectionForeground: '#ffffff',
          black: '#000000', red: '#cd3131', green: '#0dbc79', yellow: '#e5e510',
          blue: '#2472c8', magenta: '#bc3fbc', cyan: '#11a8cd', white: '#e5e5e5',
          brightBlack: '#666666', brightRed: '#f14c4c', brightGreen: '#23d18b',
          brightYellow: '#f5f543', brightBlue: '#3b8eea', brightMagenta: '#d670d6',
          brightCyan: '#29b8db', brightWhite: '#ffffff',
        },
        light: {
          // Ghostty-style light
          background: '#ffffff', foreground: '#1d1f21', cursor: '#1d1f21',
          cursorAccent: '#ffffff', selectionBackground: '#b4d5fe', selectionForeground: '#1d1f21',
          black: '#1d1f21', red: '#c82829', green: '#718c00', yellow: '#eab700',
          blue: '#4271ae', magenta: '#8959a8', cyan: '#3e999f', white: '#d6d6d6',
          brightBlack: '#969896', brightRed: '#cc6666', brightGreen: '#b5bd68',
          brightYellow: '#f0c674', brightBlue: '#81a2be', brightMagenta: '#b294bb',
          brightCyan: '#8abeb7', brightWhite: '#ffffff',
        },
      };

      const initTheme = localStorage.getItem('remux-theme') ||
        (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');

      let term, fitAddon, fitObserver = null, fitSettleTimer = null;
      function createTerminal(themeMode) {
        const container = document.getElementById('terminal');
        if (fitObserver) { fitObserver.disconnect(); fitObserver = null; }
        if (fitSettleTimer) { clearTimeout(fitSettleTimer); fitSettleTimer = null; }
        if (term) { term.dispose(); container.innerHTML = ''; }
        term = window._remuxTerm = new Terminal({ cols: 80, rows: 24,
          fontFamily: 'Menlo, Monaco, "Courier New", monospace',
          fontSize: 14, cursorBlink: true,
          theme: THEMES[themeMode] || THEMES.dark,
          scrollback: 10000 });
        fitAddon = new FitAddon();
        term.loadAddon(fitAddon);
        term.open(container);
        fitObserver = new ResizeObserver(() => safeFit());
        fitObserver.observe(container);
        safeFit();
        fitSettleTimer = setTimeout(() => {
          fitSettleTimer = null;
          safeFit();
        }, 250);
        if (document.fonts && document.fonts.ready) {
          document.fonts.ready.then(() => safeFit()).catch(() => {});
        }
        return term;
      }

      // -- IME composition guard --
      // Defer fit()/resize during active IME composition to avoid layout thrash.
      // Note: ghostty-web binds composition listeners on the container, and
      // browser-native composition events bubble from textarea to container,
      // so no forwarding patch is needed. Just guard fit() during composition.
      let _isComposing = false;
      let _pendingFit = false;
      let fitDebounceTimer = null;
      const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
      function safeFit() {
        if (_isComposing) { _pendingFit = true; return; }
        if (fitAddon) fitAddon.fit();
      }
      function syncTouchViewportHeight() {
        if (!window.visualViewport || !isTouchDevice || _isComposing) return;
        const vh = window.visualViewport.height;
        if (vh > 0) document.body.style.height = vh + 'px';
        clearTimeout(fitDebounceTimer);
        fitDebounceTimer = setTimeout(safeFit, 100);
      }
      function stabilizeFit() {
        safeFit();
        if (fitSettleTimer) clearTimeout(fitSettleTimer);
        fitSettleTimer = setTimeout(() => {
          fitSettleTimer = null;
          safeFit();
        }, 250);
      }
      window.addEventListener('resize', safeFit);
      const _termContainer = document.getElementById('terminal');
      _termContainer.addEventListener('compositionstart', () => { _isComposing = true; });
      _termContainer.addEventListener('compositionend', () => {
        _isComposing = false;
        if (_pendingFit) { _pendingFit = false; stabilizeFit(); }
      });
      createTerminal(initTheme);

      let sessions = [], currentSession = null, currentTabId = null, ws = null, ctrlActive = false;
      let myClientId = null, myRole = null, clientsList = [];

      // -- Predictive echo via DOM overlay (see #80 Phase 2) --
      // Shows predicted characters as transparent HTML spans over the canvas.
      // Does NOT inject any ANSI escape sequences into the terminal \u2014 the overlay
      // is purely visual and the terminal data path is never modified.
      // Adapted from VS Code TypeAheadAddon concept, using DOM overlay instead of
      // xterm.js decorations (which ghostty-web lacks).
      const _peOverlay = document.createElement('div');
      _peOverlay.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;pointer-events:none;z-index:1;overflow:hidden;';
      _termContainer.appendChild(_peOverlay);
      const _pePreds = [];
      function _peCellSize() {
        // Use ghostty-web renderer's exact font metrics when available
        if (term.renderer) return { w: term.renderer.charWidth, h: term.renderer.charHeight };
        const cvs = _termContainer.querySelector('canvas');
        if (!cvs) return { w: 8, h: 16 };
        return { w: cvs.offsetWidth / term.cols, h: cvs.offsetHeight / term.rows };
      }
      function peOnInput(data) {
        if (_isComposing) return;
        if (term.buffer && term.buffer.active && term.buffer.active.type === 'alternate') return;
        if (myRole && myRole !== 'active') return;
        for (let i = 0; i < data.length; i++) {
          const c = data.charCodeAt(i);
          if (c >= 0x20 && c <= 0x7e && _pePreds.length < 32) {
            const buf = term.buffer && term.buffer.active;
            const cx = (buf ? buf.cursorX : 0) + _pePreds.length;
            const cy = buf ? buf.cursorY : 0;
            const cell = _peCellSize();
            const span = document.createElement('span');
            span.textContent = data[i];
            span.style.cssText = 'position:absolute;display:inline-block;color:var(--text,#d4d4d4);opacity:0.6;'
              + 'font-family:Menlo,Monaco,Courier New,monospace;'
              + 'left:' + (cx * cell.w) + 'px;top:' + (cy * cell.h) + 'px;'
              + 'width:' + cell.w + 'px;height:' + cell.h + 'px;'
              + 'font-size:14px;line-height:' + cell.h + 'px;text-align:center;';
            _peOverlay.appendChild(span);
            _pePreds.push({ ch: data[i], span, ts: Date.now() });
          } else if (c < 0x20 || c === 0x7f) {
            peClearAll();
          }
          // Non-ASCII: skip prediction, don't clear
        }
      }
      function peOnServerData(data) {
        // Match predictions against server echo, remove confirmed overlay spans.
        // NEVER modify or consume data \u2014 always pass full data to term.write().
        if (_pePreds.length === 0) return;
        for (let i = 0; i < data.length && _pePreds.length > 0; i++) {
          if (data.charCodeAt(i) === 0x1b) { peClearAll(); return; }
          if (data[i] === _pePreds[0].ch) {
            const p = _pePreds.shift();
            p.span.remove();
          } else { peClearAll(); return; }
        }
      }
      function peClearAll() {
        for (const p of _pePreds) p.span.remove();
        _pePreds.length = 0;
      }
      const $ = id => document.getElementById(id);
      const esc = t => (t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      const setStatus = (s, t) => { $('status-dot').className = 'status-dot ' + s; $('status-text').textContent = t; };

      // -- Theme switching --
      function setTheme(mode) {
        document.documentElement.setAttribute('data-theme', mode);
        localStorage.setItem('remux-theme', mode);
        $('btn-theme').innerHTML = mode === 'dark' ? '&#9728;' : '&#9790;';
        // Recreate terminal with new theme (ghostty-web doesn't support runtime theme change)
        createTerminal(mode);
        peClearAll();
        // Rebind terminal I/O
        term.onData(data => {
          if (!ws || ws.readyState !== WebSocket.OPEN) return;
          if (ctrlActive) {
            ctrlActive = false; $('btn-ctrl').classList.remove('active');
            const ch = data.toLowerCase().charCodeAt(0);
            if (ch >= 0x61 && ch <= 0x7a) { sendTermData(String.fromCharCode(ch - 0x60)); return; }
          }
          peOnInput(data);
          sendTermData(data);
        });
        term.onResize(({ cols, rows }) => sendCtrl({ type: 'resize', cols, rows }));
        // Re-attach to current tab to get snapshot
        if (currentTabId != null) {
          sendCtrl({ type: 'attach_tab', tabId: currentTabId, cols: term.cols, rows: term.rows });
        }
      }
      // Apply initial theme CSS (terminal already created with correct theme)
      document.documentElement.setAttribute('data-theme', initTheme);
      $('btn-theme').innerHTML = initTheme === 'dark' ? '&#9728;' : '&#9790;';
      $('btn-theme').addEventListener('click', () => {
        const current = document.documentElement.getAttribute('data-theme') || 'dark';
        setTheme(current === 'dark' ? 'light' : 'dark');
      });

      // -- Sidebar --
      const sidebar = $('sidebar'), overlay = $('sidebar-overlay');
      function toggleSidebar() {
        if (window.innerWidth <= 768) {
          sidebar.classList.remove('collapsed');
          sidebar.classList.toggle('open');
          overlay.classList.toggle('visible', sidebar.classList.contains('open'));
        } else { sidebar.classList.toggle('collapsed'); }
        setTimeout(stabilizeFit, 250);
      }
      function closeSidebarMobile() {
        if (window.innerWidth <= 768) { sidebar.classList.remove('open'); overlay.classList.remove('visible'); }
      }
      $('btn-sidebar').addEventListener('pointerdown', e => { e.preventDefault(); toggleSidebar(); });
      overlay.addEventListener('pointerdown', closeSidebarMobile);

      // -- Render sessions --
      function renderSessions() {
        const list = $('session-list'); list.innerHTML = '';
        sessions.forEach(s => {
          const el = document.createElement('button');
          el.className = 'session-item' + (s.name === currentSession ? ' active' : '');
          const live = s.tabs.filter(t => !t.ended).length;
          el.innerHTML = '<span class="dot"></span><span class="name">' + esc(s.name)
            + '</span><span class="count">' + live + '</span>'
            + '<button class="del" data-del="' + esc(s.name) + '">\xD7</button>';
          el.addEventListener('pointerdown', e => {
            if (e.target.dataset.del) {
              e.stopPropagation(); e.preventDefault();
              if (!confirm('Delete session "' + e.target.dataset.del + '"? All tabs will be closed.')) return;
              sendCtrl({ type: 'delete_session', name: e.target.dataset.del });
              // if deleting current, switch to another or create fresh
              if (e.target.dataset.del === currentSession) {
                const other = sessions.find(x => x.name !== currentSession);
                if (other) {
                  selectSession(other.name);
                } else {
                  // Last session deleted \u2014 re-bootstrap via attach_first
                  currentSession = null;
                  sendCtrl({ type: 'attach_first', cols: term.cols, rows: term.rows });
                }
              }
              return;
            }
            e.preventDefault();
            selectSession(s.name);
            closeSidebarMobile();
          });
          list.appendChild(el);
        });
      }

      // -- Render tabs (Chrome-style) --
      function renderTabs() {
        const list = $('tab-list'); list.innerHTML = '';
        const sess = sessions.find(s => s.name === currentSession);
        if (!sess) return;
        sess.tabs.forEach(t => {
          const el = document.createElement('button');
          el.className = 'tab' + (t.id === currentTabId ? ' active' : '');
          const clientCount = t.clients || 0;
          const countBadge = clientCount > 1 ? '<span class="client-count">' + clientCount + '</span>' : '';
          el.innerHTML = '<span class="title">' + esc(t.title) + '</span>' + countBadge
            + '<button class="close" data-close="' + t.id + '">\xD7</button>';
          el.addEventListener('pointerdown', e => {
            const closeId = e.target.dataset.close ?? e.target.closest('[data-close]')?.dataset.close;
            if (closeId != null) {
              e.stopPropagation(); e.preventDefault();
              closeTab(Number(closeId));
              return;
            }
            e.preventDefault();
            if (t.id !== currentTabId) attachTab(t.id);
          });
          list.appendChild(el);
        });
      }

      // -- Render role indicator --
      function renderRole() {
        const indicator = $('role-indicator');
        const dot = $('role-dot');
        const text = $('role-text');
        const btn = $('btn-role');
        if (!indicator || !myRole) return;
        indicator.className = 'role-indicator ' + myRole;
        if (myRole === 'active') {
          dot.textContent = '\u25CF';
          text.textContent = 'Active';
          btn.textContent = 'Release';
          btn.style.display = 'inline-block';
          // Auto-focus terminal when becoming active so keystrokes reach xterm
          if (currentView === 'live') setTimeout(() => term.focus(), 50);
        } else {
          dot.textContent = '\u25CB';
          text.textContent = 'Observer';
          btn.textContent = 'Take control';
          btn.style.display = 'inline-block';
        }
      }
      $('btn-role').addEventListener('click', () => {
        if (myRole === 'active') sendCtrl({ type: 'release_control' });
        else sendCtrl({ type: 'request_control' });
      });

      function selectSession(name) {
        currentSession = name;
        const sess = sessions.find(s => s.name === name);
        if (sess && sess.tabs.length > 0) attachTab(sess.tabs[0].id);
        renderSessions(); renderTabs();
      }

      function attachTab(tabId) {
        currentTabId = tabId;
        term.reset(); // full reset to avoid duplicate content
        sendCtrl({ type: 'attach_tab', tabId, cols: term.cols, rows: term.rows });
        stabilizeFit();
        renderTabs(); renderSessions();
      }

      function closeTab(tabId) {
        const sess = sessions.find(s => s.name === currentSession);
        if (!sess) return;
        // if closing active tab, switch to neighbor first
        if (tabId === currentTabId) {
          const idx = sess.tabs.findIndex(t => t.id === tabId);
          const next = sess.tabs[idx + 1] || sess.tabs[idx - 1];
          if (next) attachTab(next.id);
        }
        sendCtrl({ type: 'close_tab', tabId });
      }

      $('btn-new-tab').addEventListener('pointerdown', e => {
        e.preventDefault();
        sendCtrl({ type: 'new_tab', session: currentSession, cols: term.cols, rows: term.rows });
      });
      $('btn-new-session').addEventListener('pointerdown', e => {
        e.preventDefault();
        const name = prompt('Session name:');
        if (name && name.trim()) sendCtrl({ type: 'new_session', name: name.trim(), cols: term.cols, rows: term.rows });
      });

      // -- E2EE client (Web Crypto API) --
      // Adapted from Signal Protocol X25519+AES-GCM pattern
      const e2ee = {
        established: false,
        sendCounter: 0n,
        recvCounter: -1n,
        localKeyPair: null,  // { publicKey: CryptoKey, privateKey: CryptoKey, rawPublic: Uint8Array }
        sharedKey: null,     // CryptoKey (AES-GCM)
        available: !!(crypto && crypto.subtle),

        async init() {
          if (!this.available) return;
          try {
            const kp = await crypto.subtle.generateKey('X25519', false, ['deriveBits']);
            const rawPub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
            this.localKeyPair = { publicKey: kp.publicKey, privateKey: kp.privateKey, rawPublic: rawPub };
          } catch (e) {
            console.warn('[e2ee] X25519 not available:', e);
            this.available = false;
          }
        },

        getPublicKeyB64() {
          if (!this.localKeyPair) return null;
          return btoa(String.fromCharCode(...this.localKeyPair.rawPublic));
        },

        async completeHandshake(peerPubKeyB64) {
          if (!this.localKeyPair) return;
          try {
            const peerRaw = Uint8Array.from(atob(peerPubKeyB64), c => c.charCodeAt(0));
            const peerKey = await crypto.subtle.importKey('raw', peerRaw, 'X25519', false, []);
            // ECDH: derive raw shared bits
            const rawBits = await crypto.subtle.deriveBits(
              { name: 'X25519', public: peerKey },
              this.localKeyPair.privateKey,
              256
            );
            // HKDF-SHA256 to derive AES-256-GCM key
            const hkdfKey = await crypto.subtle.importKey('raw', rawBits, 'HKDF', false, ['deriveBits']);
            const salt = new TextEncoder().encode('remux-e2ee-v1');
            const info = new TextEncoder().encode('aes-256-gcm');
            const derived = await crypto.subtle.deriveBits(
              { name: 'HKDF', hash: 'SHA-256', salt, info },
              hkdfKey,
              256
            );
            this.sharedKey = await crypto.subtle.importKey('raw', derived, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
            this.established = true;
            this.sendCounter = 0n;
            this.recvCounter = -1n;
            console.log('[e2ee] handshake complete');
          } catch (e) {
            console.error('[e2ee] handshake failed:', e);
            this.available = false;
          }
        },

        async encryptMessage(plaintext) {
          if (!this.sharedKey) throw new Error('E2EE not established');
          const plaintextBuf = new TextEncoder().encode(plaintext);
          // IV: 4 random bytes + 8 byte counter (big-endian)
          const iv = new Uint8Array(12);
          crypto.getRandomValues(iv.subarray(0, 4));
          const counterView = new DataView(iv.buffer, iv.byteOffset + 4, 8);
          counterView.setBigUint64(0, this.sendCounter, false);
          this.sendCounter++;
          const encrypted = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv, tagLength: 128 },
            this.sharedKey,
            plaintextBuf
          );
          // AES-GCM returns ciphertext + tag concatenated
          const result = new Uint8Array(12 + encrypted.byteLength);
          result.set(iv, 0);
          result.set(new Uint8Array(encrypted), 12);
          return btoa(String.fromCharCode(...result));
        },

        async decryptMessage(encryptedB64) {
          if (!this.sharedKey) throw new Error('E2EE not established');
          const packed = Uint8Array.from(atob(encryptedB64), c => c.charCodeAt(0));
          if (packed.length < 28) throw new Error('E2EE message too short'); // 12 iv + 16 tag minimum
          const iv = packed.subarray(0, 12);
          const ciphertextWithTag = packed.subarray(12);
          // Anti-replay: check counter is monotonically increasing
          const counterView = new DataView(iv.buffer, iv.byteOffset + 4, 8);
          const counter = counterView.getBigUint64(0, false);
          if (counter <= this.recvCounter) throw new Error('E2EE replay detected');
          const decrypted = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv, tagLength: 128 },
            this.sharedKey,
            ciphertextWithTag
          );
          this.recvCounter = counter;
          return new TextDecoder().decode(decrypted);
        }
      };

      // -- WebSocket with exponential backoff + heartbeat --
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const urlToken = new URLSearchParams(location.search).get('token');

      // Exponential backoff: 1s -> 2s -> 4s -> 8s -> 16s -> 30s max
      let backoffMs = 1000;
      const BACKOFF_MAX = 30000;
      let reconnectTimer = null;

      // Heartbeat: if no message received for 45s, consider connection dead
      const HEARTBEAT_TIMEOUT = 45000;
      let lastMessageAt = Date.now();
      let heartbeatChecker = null;

      // Track last received message timestamp for session recovery
      let lastReceivedTimestamp = 0;
      let isResuming = false;

      function startHeartbeat() {
        lastMessageAt = Date.now();
        if (heartbeatChecker) clearInterval(heartbeatChecker);
        heartbeatChecker = setInterval(() => {
          if (Date.now() - lastMessageAt > HEARTBEAT_TIMEOUT) {
            console.log('[remux] heartbeat timeout, reconnecting');
            if (ws) ws.close();
          }
        }, 5000);
      }

      function stopHeartbeat() {
        if (heartbeatChecker) { clearInterval(heartbeatChecker); heartbeatChecker = null; }
      }

      function scheduleReconnect() {
        if (reconnectTimer) return;
        const delay = backoffMs;
        let remaining = Math.ceil(delay / 1000);
        setStatus('disconnected', 'Reconnecting in ' + remaining + 's...');
        const countdown = setInterval(() => {
          remaining--;
          if (remaining > 0) setStatus('disconnected', 'Reconnecting in ' + remaining + 's...');
        }, 1000);
        reconnectTimer = setTimeout(() => {
          clearInterval(countdown);
          reconnectTimer = null;
          backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX);
          connect();
        }, delay);
      }

      function connect() {
        setStatus('connecting', 'Connecting...');
        e2ee.established = false;
        e2ee.sharedKey = null;
        ws = new WebSocket(proto + '//' + location.host + '/ws');
        ws.onopen = async () => {
          backoffMs = 1000; // reset backoff on successful connection
          startHeartbeat();
          if (urlToken) {
            // Use persistent device ID from localStorage so each browser context
            // is a distinct device even with identical User-Agent
            if (!localStorage.getItem('remux-device-id')) {
              localStorage.setItem('remux-device-id', Math.random().toString(36).slice(2, 10) + Date.now().toString(36));
            }
            ws.send(JSON.stringify({ type: 'auth', token: urlToken, deviceId: localStorage.getItem('remux-device-id') }));
          }
          // Initiate E2EE handshake if Web Crypto API is available
          if (e2ee.available) {
            await e2ee.init();
            const pubKey = e2ee.getPublicKeyB64();
            if (pubKey) {
              ws.send(JSON.stringify({ v: 1, type: 'e2ee_init', payload: { publicKey: pubKey } }));
            }
          }
          // Session recovery: if we have a previous timestamp, request buffered messages
          const deviceId = localStorage.getItem('remux-device-id');
          if (lastReceivedTimestamp > 0 && deviceId) {
            isResuming = true;
            setStatus('connecting', 'Resuming session...');
            sendCtrl({ type: 'resume', deviceId: deviceId, lastTimestamp: lastReceivedTimestamp });
          }
          // Let server pick the session if we have none (bootstrap flow)
          sendCtrl({ type: 'attach_first', session: currentSession || undefined, cols: term.cols, rows: term.rows });
          // Request device list (works with or without auth)
          sendCtrl({ type: 'list_devices' });
          // Request VAPID key for push notifications
          sendCtrl({ type: 'get_vapid_key' });
        };
        ws.onmessage = e => {
          lastMessageAt = Date.now();
          if (typeof e.data === 'string' && e.data[0] === '{') {
            try {
              const parsed = JSON.parse(e.data);
              // Handle both envelope (v:1) and legacy messages
              // Unwrap envelope: spread payload first, then override type with the
              // envelope's type to prevent payload.type (e.g. artifact type "snapshot")
              // from colliding with the message type (e.g. "snapshot_captured")
              const msg = parsed.v === 1 ? { ...(parsed.payload || {}), type: parsed.type } : parsed;
              // Server heartbeat \u2014 just keep connection alive (lastMessageAt already updated)
              if (msg.type === 'ping') return;
              // E2EE handshake: server responds with its public key
              if (msg.type === 'e2ee_init') {
                if (msg.publicKey && e2ee.available && e2ee.localKeyPair) {
                  e2ee.completeHandshake(msg.publicKey);
                }
                return;
              }
              if (msg.type === 'e2ee_ready') {
                console.log('[e2ee] server confirmed E2EE established');
                return;
              }
              // E2EE encrypted message (terminal output from server)
              if (msg.type === 'e2ee_msg') {
                if (e2ee.established && msg.data) {
                  e2ee.decryptMessage(msg.data).then(decrypted => {
                    term.write(decrypted);
                  }).catch(err => console.error('[e2ee] decrypt failed:', err));
                }
                return;
              }
              // Session recovery complete
              if (msg.type === 'resume_complete') {
                isResuming = false;
                if (msg.replayed > 0) {
                  console.log('[remux] session recovered: ' + msg.replayed + ' buffered messages replayed');
                }
                return;
              }
              // Track timestamp for session recovery on reconnect
              lastReceivedTimestamp = Date.now();
              if (msg.type === 'auth_ok') {
                if (msg.deviceId) myDeviceId = msg.deviceId;
                // Request device list and workspace data after auth
                sendCtrl({ type: 'list_devices' });
                sendCtrl({ type: 'list_notes' });
                return;
              }
              if (msg.type === 'bootstrap') {
                sessions = msg.sessions || [];
                clientsList = msg.clients || [];
                renderSessions(); renderTabs(); renderRole(); stabilizeFit();
                return;
              }
              if (msg.type === 'auth_error') { setStatus('disconnected', 'Auth failed'); ws.close(); return; }
              // Generic server error \u2014 show to user (e.g. pair code trust errors)
              if (msg.type === 'error') {
                console.warn('[remux] server error:', msg.reason || 'unknown');
                alert('Error: ' + (msg.reason || 'unknown error'));
                return;
              }
              if (msg.type === 'device_list') {
                devicesList = msg.devices || [];
                renderDevices(); return;
              }
              if (msg.type === 'pair_code') {
                const display = $('pair-code-display');
                if (display) {
                  display.style.display = 'block';
                  $('pair-code-value').textContent = msg.code;
                  const remaining = Math.max(0, Math.ceil((msg.expiresAt - Date.now()) / 1000));
                  $('pair-expires').textContent = 'Expires in ' + Math.ceil(remaining / 60) + ' min';
                  setTimeout(() => { display.style.display = 'none'; }, remaining * 1000);
                }
                return;
              }
              if (msg.type === 'pair_result') {
                if (msg.success) {
                  $('pair-code-input').value = '';
                  sendCtrl({ type: 'list_devices' });
                } else {
                  alert('Pairing failed: ' + (msg.reason || 'invalid code'));
                }
                return;
              }
              if (msg.type === 'vapid_key') {
                pushVapidKey = msg.publicKey;
                showPushSection();
                // Check current push status
                sendCtrl({ type: 'get_push_status' });
                return;
              }
              if (msg.type === 'push_subscribed') {
                pushSubscribed = msg.success;
                updatePushUI();
                return;
              }
              if (msg.type === 'push_unsubscribed') {
                pushSubscribed = false;
                updatePushUI();
                return;
              }
              if (msg.type === 'push_status') {
                pushSubscribed = msg.subscribed;
                updatePushUI();
                return;
              }
              if (msg.type === 'push_test_result') {
                // Brief visual feedback
                const testBtn = $('btn-push-test');
                if (testBtn) {
                  testBtn.textContent = msg.sent ? 'Sent!' : 'Failed';
                  setTimeout(() => { testBtn.textContent = 'Send Test'; }, 2000);
                }
                return;
              }
              if (msg.type === 'state') {
                sessions = msg.sessions || [];
                clientsList = msg.clients || [];
                // Re-derive own role from authoritative server state
                if (myClientId) {
                  const me = clientsList.find(c => c.clientId === myClientId);
                  if (me) myRole = me.role;
                }
                renderSessions(); renderTabs(); renderRole(); stabilizeFit(); return;
              }
              if (msg.type === 'attached') {
                currentTabId = msg.tabId; currentSession = msg.session;
                if (msg.clientId) myClientId = msg.clientId;
                if (msg.role) myRole = msg.role;
                setStatus('connected', msg.session); renderSessions(); renderTabs(); renderRole(); stabilizeFit(); return;
              }
              if (msg.type === 'role_changed') {
                if (msg.clientId === myClientId) myRole = msg.role;
                renderRole(); return;
              }
              if (msg.type === 'inspect_result') {
                window._inspectText = msg.text || '(empty)';
                const m = msg.meta || {};
                $('inspect-meta').innerHTML =
                  '<span>' + esc(m.session) + ' / ' + esc(m.tabTitle || 'Tab ' + m.tabId) + '</span>' +
                  '<span>' + (m.cols || '?') + 'x' + (m.rows || '?') + '</span>' +
                  '<span>' + new Date(m.timestamp || Date.now()).toLocaleTimeString() + '</span>' +
                  '<button class="inspect-btn" id="btn-copy-inspect">Copy</button>';
                $('btn-copy-inspect').addEventListener('click', () => {
                  navigator.clipboard.writeText(window._inspectText).then(() => {
                    $('btn-copy-inspect').textContent = 'Copied!';
                    setTimeout(() => { const el = $('btn-copy-inspect'); if (el) el.textContent = 'Copy'; }, 1500);
                  });
                });
                // Apply search highlight if active
                applyInspectSearch();
                return;
              }
              // Workspace message handlers
              if (msg.type === 'topic_list') { wsTopics = msg.topics || []; renderWorkspaceTopics(); return; }
              if (msg.type === 'topic_created') {
                // Optimistic render: add topic directly
                if (msg.id && msg.title) wsTopics.unshift({ id: msg.id, sessionName: msg.sessionName, title: msg.title, createdAt: msg.createdAt, updatedAt: msg.updatedAt });
                renderWorkspaceTopics();
                return;
              }
              if (msg.type === 'topic_deleted') { refreshWorkspace(); return; }
              if (msg.type === 'run_list') { wsRuns = msg.runs || []; renderWorkspaceRuns(); return; }
              if (msg.type === 'run_created' || msg.type === 'run_updated') { if (currentView === 'workspace') refreshWorkspace(); return; }
              if (msg.type === 'artifact_list') { wsArtifacts = msg.artifacts || []; renderWorkspaceArtifacts(); return; }
              if (msg.type === 'snapshot_captured') {
                // Optimistic render: add artifact directly (with server-rendered HTML)
                if (msg.id) wsArtifacts.unshift({ id: msg.id, type: 'snapshot', title: msg.title || 'Snapshot', content: msg.content, contentType: msg.contentType || 'plain', renderedHtml: msg.renderedHtml, createdAt: msg.createdAt || Date.now() });
                renderWorkspaceArtifacts();
                return;
              }
              if (msg.type === 'approval_list') { wsApprovals = msg.approvals || []; renderWorkspaceApprovals(); return; }
              if (msg.type === 'approval_created') { if (currentView === 'workspace') refreshWorkspace(); return; }
              if (msg.type === 'approval_resolved') { if (currentView === 'workspace') refreshWorkspace(); return; }
              // Search results
              if (msg.type === 'search_results') { renderSearchResults(msg.results || []); return; }
              // Handoff bundle
              if (msg.type === 'handoff_bundle') { renderHandoffBundle(msg); return; }
              // Notes
              if (msg.type === 'note_list') { wsNotes = msg.notes || []; renderNotes(); return; }
              if (msg.type === 'note_created') {
                // Optimistic render: add note directly without waiting for list refresh
                if (msg.id && msg.content) wsNotes.unshift({ id: msg.id, content: msg.content, pinned: msg.pinned || false, createdAt: msg.createdAt, updatedAt: msg.updatedAt });
                renderNotes();
                return;
              }
              if (msg.type === 'note_updated' || msg.type === 'note_deleted' || msg.type === 'note_pinned') { sendCtrl({ type: 'list_notes' }); return; }
              // Commands
              if (msg.type === 'command_list') { wsCommands = msg.commands || []; renderCommands(); return; }
              // Unrecognized enveloped control message \u2014 discard, never write to terminal
              if (parsed.v === 1) {
                console.warn('[remux] unhandled message type:', msg.type);
                return;
              }
              // Non-enveloped JSON (e.g. PTY output that looks like JSON) \u2014 fall through to term.write
            } catch {}
          }
          peOnServerData(e.data);
          term.write(e.data);
        };
        ws.onclose = () => { stopHeartbeat(); peClearAll(); scheduleReconnect(); };
        ws.onerror = () => setStatus('disconnected', 'Error');
      }
      connect();
      function sendCtrl(msg) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); }
      // Send terminal data, encrypting if E2EE is established
      function sendTermData(data) {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        if (e2ee.established) {
          e2ee.encryptMessage(data).then(encrypted => {
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ v: 1, type: 'e2ee_msg', payload: { data: encrypted } }));
            }
          }).catch(err => {
            console.error('[e2ee] encrypt failed, sending plaintext:', err);
            ws.send(data);
          });
        } else {
          ws.send(data);
        }
      }

      // -- Terminal I/O --
      term.onData(data => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        if (ctrlActive) {
          ctrlActive = false; $('btn-ctrl').classList.remove('active');
          const ch = data.toLowerCase().charCodeAt(0);
          if (ch >= 0x61 && ch <= 0x7a) { sendTermData(String.fromCharCode(ch - 0x60)); return; }
        }
        peOnInput(data);
        sendTermData(data);
      });
      term.onResize(({ cols, rows }) => sendCtrl({ type: 'resize', cols, rows }));

      // -- Compose bar --
      const SEQ = {
        esc: '\\x1b', tab: '\\t',
        up: '\\x1b[A', down: '\\x1b[B', left: '\\x1b[D', right: '\\x1b[C',
        'ctrl-c': '\\x03', 'ctrl-d': '\\x04', 'ctrl-z': '\\x1a',
        pgup: '\\x1b[5~', pgdn: '\\x1b[6~', home: '\\x1b[H', end: '\\x1b[F',
      };
      $('compose-bar').addEventListener('pointerdown', e => {
        const btn = e.target.closest('button'); if (!btn) return;
        e.preventDefault();
        if (btn.dataset.mod === 'ctrl') { ctrlActive = !ctrlActive; btn.classList.toggle('active', ctrlActive); return; }
        const d = SEQ[btn.dataset.seq] || btn.dataset.ch;
        if (d) sendTermData(d);
        term.focus();
      });

      // -- Inspect view --
      let currentView = 'live', inspectTimer = null, wsRefreshTimer = null;
      function setView(mode) {
        currentView = mode;
        $('btn-live').classList.toggle('active', mode === 'live');
        $('btn-inspect').classList.toggle('active', mode === 'inspect');
        $('btn-workspace').classList.toggle('active', mode === 'workspace');
        $('terminal').classList.toggle('hidden', mode !== 'live');
        $('inspect').classList.toggle('visible', mode === 'inspect');
        $('workspace').classList.toggle('visible', mode === 'workspace');
        // Inspect auto-refresh
        if (inspectTimer) { clearInterval(inspectTimer); inspectTimer = null; }
        if (mode === 'inspect') {
          sendCtrl({ type: 'inspect' });
          inspectTimer = setInterval(() => sendCtrl({ type: 'inspect' }), 3000);
        }
        // Workspace auto-refresh
        if (wsRefreshTimer) { clearInterval(wsRefreshTimer); wsRefreshTimer = null; }
        if (mode === 'workspace') {
          refreshWorkspace();
          wsRefreshTimer = setInterval(refreshWorkspace, 5000);
        }
        if (mode === 'live') { term.focus(); stabilizeFit(); }
      }
      $('btn-live').addEventListener('pointerdown', e => { e.preventDefault(); closeSidebarMobile(); setView('live'); });
      $('btn-inspect').addEventListener('pointerdown', e => { e.preventDefault(); closeSidebarMobile(); setView('inspect'); });
      $('btn-workspace').addEventListener('pointerdown', e => { e.preventDefault(); closeSidebarMobile(); setView('workspace'); });

      // -- Inspect search --
      function applyInspectSearch() {
        const query = ($('inspect-search-input') || {}).value || '';
        const text = window._inspectText || '';
        if (!query) {
          $('inspect-content').textContent = text;
          $('inspect-match-count').textContent = '';
          return;
        }
        // Simple case-insensitive text search with <mark> highlighting
        // Work on raw text to avoid HTML entity issues, then escape each fragment
        const esc = t => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const q = query.toLowerCase();
        const lower = text.toLowerCase();
        let result = '', count = 0, pos = 0;
        while (pos < text.length) {
          const idx = lower.indexOf(q, pos);
          if (idx === -1) { result += esc(text.slice(pos)); break; }
          result += esc(text.slice(pos, idx)) + '<mark>' + esc(text.slice(idx, idx + q.length)) + '</mark>';
          count++; pos = idx + q.length;
        }
        $('inspect-content').innerHTML = result;
        $('inspect-match-count').textContent = count > 0 ? count + ' match' + (count !== 1 ? 'es' : '') : 'No matches';
      }
      $('inspect-search-input').addEventListener('input', applyInspectSearch);

      // -- Devices section --
      let devicesList = [], myDeviceId = null, devicesCollapsed = false;

      function renderDevices() {
        const list = $('devices-list');
        const actions = $('devices-actions');
        if (!list) return;
        list.innerHTML = '';
        devicesList.forEach(d => {
          const el = document.createElement('div');
          el.className = 'device-item';
          const isSelf = d.id === myDeviceId;
          el.innerHTML = '<span class="device-dot ' + esc(d.trust) + '"></span>'
            + '<span class="device-name">' + esc(d.name) + (isSelf ? ' <span class="device-self">(you)</span>' : '') + '</span>'
            + '<span class="device-actions">'
            + (d.trust !== 'trusted' ? '<button data-trust="' + d.id + '" title="Trust">&#10003;</button>' : '')
            + (d.trust !== 'blocked' ? '<button data-block="' + d.id + '" title="Block">&#10007;</button>' : '')
            + '<button data-rename-dev="' + d.id + '" title="Rename">&#9998;</button>'
            + (!isSelf ? '<button data-revoke="' + d.id + '" title="Revoke">&#128465;</button>' : '')
            + '</span>';
          el.addEventListener('click', e => {
            const btn = e.target.closest('button');
            if (!btn) return;
            if (btn.dataset.trust) sendCtrl({ type: 'trust_device', deviceId: btn.dataset.trust });
            if (btn.dataset.block) sendCtrl({ type: 'block_device', deviceId: btn.dataset.block });
            if (btn.dataset.renameDev) {
              const newName = prompt('Device name:', d.name);
              if (newName && newName.trim()) sendCtrl({ type: 'rename_device', deviceId: btn.dataset.renameDev, name: newName.trim() });
            }
            if (btn.dataset.revoke) {
              if (confirm('Revoke device "' + d.name + '"?')) sendCtrl({ type: 'revoke_device', deviceId: btn.dataset.revoke });
            }
          });
          list.appendChild(el);
        });

        // Show actions only for trusted devices; untrusted see pair input instead
        const isTrusted = devicesList.find(d => d.id === myDeviceId && d.trust === 'trusted');
        if (actions) {
          actions.style.display = 'block';
          const btnPair = $('btn-pair');
          if (btnPair) {
            btnPair.disabled = !isTrusted;
            btnPair.title = isTrusted ? '' : 'Only trusted devices can generate pair codes';
          }
          // Show pair input for untrusted devices
          const pairInput = $('pair-input-area');
          if (pairInput) pairInput.style.display = isTrusted ? 'none' : 'flex';
        }
      }

      $('devices-header').addEventListener('click', () => {
        devicesCollapsed = !devicesCollapsed;
        $('devices-list').classList.toggle('collapsed', devicesCollapsed);
        $('devices-toggle').classList.toggle('collapsed', devicesCollapsed);
        if ($('devices-actions')) $('devices-actions').style.display = devicesCollapsed ? 'none' : '';
      });

      $('btn-pair').addEventListener('click', () => {
        sendCtrl({ type: 'generate_pair_code' });
      });

      $('btn-submit-pair').addEventListener('click', () => {
        const code = $('pair-code-input').value.trim();
        if (!/^d{6}$/.test(code)) { alert('Please enter a 6-digit pair code'); return; }
        sendCtrl({ type: 'pair', code });
      });

      $('pair-code-input').addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); $('btn-submit-pair').click(); }
      });

      // -- Push notifications --
      let pushSubscribed = false;
      let pushVapidKey = null;

      function showPushSection() {
        // Show only if browser supports push + service workers
        if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
        $('push-section').style.display = 'block';
      }

      function updatePushUI() {
        const btn = $('btn-push-toggle');
        const label = $('push-label');
        const testBtn = $('btn-push-test');
        if (pushSubscribed) {
          btn.classList.add('subscribed');
          label.textContent = 'Notifications On';
          testBtn.style.display = 'block';
        } else {
          btn.classList.remove('subscribed');
          label.textContent = 'Enable Notifications';
          testBtn.style.display = 'none';
        }
      }

      function urlBase64ToUint8Array(base64String) {
        const padding = '='.repeat((4 - base64String.length % 4) % 4);
        const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
        const rawData = atob(base64);
        const outputArray = new Uint8Array(rawData.length);
        for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
        return outputArray;
      }

      async function subscribePush() {
        if (!pushVapidKey) return;
        try {
          const reg = await navigator.serviceWorker.register('/sw.js');
          await navigator.serviceWorker.ready;
          const sub = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(pushVapidKey),
          });
          const subJson = sub.toJSON();
          sendCtrl({
            type: 'subscribe_push',
            subscription: {
              endpoint: subJson.endpoint,
              keys: { p256dh: subJson.keys.p256dh, auth: subJson.keys.auth },
            },
          });
        } catch (err) {
          console.error('[push] subscribe failed:', err);
          if (Notification.permission === 'denied') {
            $('push-label').textContent = 'Permission Denied';
          } else {
            $('push-label').textContent = 'Not Available';
          }
        }
      }

      async function unsubscribePush() {
        try {
          const reg = await navigator.serviceWorker.getRegistration();
          if (reg) {
            const sub = await reg.pushManager.getSubscription();
            if (sub) await sub.unsubscribe();
          }
          sendCtrl({ type: 'unsubscribe_push' });
        } catch (err) {
          console.error('[push] unsubscribe failed:', err);
        }
      }

      $('btn-push-toggle').addEventListener('click', async () => {
        if (pushSubscribed) {
          await unsubscribePush();
          pushSubscribed = false;
        } else {
          await subscribePush();
        }
        updatePushUI();
      });

      $('btn-push-test').addEventListener('click', () => {
        sendCtrl({ type: 'test_push' });
      });

      // -- Workspace view --
      let wsTopics = [], wsRuns = [], wsArtifacts = [], wsApprovals = [];
      let wsNotes = [], wsCommands = [];

      function refreshWorkspace() {
        if (!currentSession) return; // Wait until bootstrap resolves a session
        sendCtrl({ type: 'list_topics', sessionName: currentSession });
        sendCtrl({ type: 'list_runs' });
        sendCtrl({ type: 'list_artifacts', sessionName: currentSession });
        sendCtrl({ type: 'list_approvals' });
        sendCtrl({ type: 'list_notes' }); // Notes are global workspace memory, not session-scoped
        sendCtrl({ type: 'list_commands' });
      }

      function timeAgo(ts) {
        const s = Math.floor((Date.now() - ts) / 1000);
        if (s < 60) return s + 's ago';
        if (s < 3600) return Math.floor(s / 60) + 'm ago';
        if (s < 86400) return Math.floor(s / 3600) + 'h ago';
        return Math.floor(s / 86400) + 'd ago';
      }

      function renderWorkspaceApprovals() {
        const el = $('ws-approvals');
        if (!el) return;
        const pending = wsApprovals.filter(a => a.status === 'pending');
        if (pending.length === 0) { el.innerHTML = '<div class="ws-empty">No pending approvals</div>'; return; }
        el.innerHTML = pending.map(a =>
          '<div class="ws-card">' +
            '<div class="ws-card-header">' +
              '<span class="ws-badge pending">pending</span>' +
              '<span class="ws-card-title">' + esc(a.title) + '</span>' +
              '<span class="ws-card-meta">' + timeAgo(a.createdAt) + '</span>' +
            '</div>' +
            (a.description ? '<div class="ws-card-desc">' + esc(a.description) + '</div>' : '') +
            '<div class="ws-card-actions">' +
              '<button class="approve" data-approve-id="' + a.id + '">Approve</button>' +
              '<button class="reject" data-reject-id="' + a.id + '">Reject</button>' +
            '</div>' +
          '</div>'
        ).join('');
        el.querySelectorAll('[data-approve-id]').forEach(btn => {
          btn.addEventListener('click', () => sendCtrl({ type: 'resolve_approval', approvalId: btn.dataset.approveId, status: 'approved' }));
        });
        el.querySelectorAll('[data-reject-id]').forEach(btn => {
          btn.addEventListener('click', () => sendCtrl({ type: 'resolve_approval', approvalId: btn.dataset.rejectId, status: 'rejected' }));
        });
      }

      function renderWorkspaceTopics() {
        const el = $('ws-topics');
        if (!el) return;
        if (wsTopics.length === 0) { el.innerHTML = '<div class="ws-empty">No topics yet</div>'; return; }
        el.innerHTML = wsTopics.map(t =>
          '<div class="ws-card">' +
            '<div class="ws-card-header">' +
              '<span class="ws-card-title">' + esc(t.title) + '</span>' +
              '<span class="ws-card-meta">' + timeAgo(t.createdAt) + '</span>' +
              '<button class="del-topic" data-del-topic="' + t.id + '" title="Delete">&times;</button>' +
            '</div>' +
            '<div class="ws-card-meta">' + esc(t.sessionName) + '</div>' +
          '</div>'
        ).join('');
        el.querySelectorAll('[data-del-topic]').forEach(btn => {
          btn.addEventListener('click', () => {
            sendCtrl({ type: 'delete_topic', topicId: btn.dataset.delTopic });
            setTimeout(refreshWorkspace, 200);
          });
        });
      }

      function renderWorkspaceRuns() {
        const el = $('ws-runs');
        if (!el) return;
        const active = wsRuns.filter(r => r.status === 'running');
        const recent = wsRuns.filter(r => r.status !== 'running').slice(-5).reverse();
        const all = [...active, ...recent];
        if (all.length === 0) { el.innerHTML = '<div class="ws-empty">No runs</div>'; return; }
        el.innerHTML = all.map(r =>
          '<div class="ws-card">' +
            '<div class="ws-card-header">' +
              '<span class="ws-badge ' + r.status + '">' + r.status + '</span>' +
              '<span class="ws-card-title">' + esc(r.command || '(no command)') + '</span>' +
              '<span class="ws-card-meta">' + timeAgo(r.startedAt) + '</span>' +
            '</div>' +
            (r.exitCode !== null ? '<div class="ws-card-meta">Exit: ' + r.exitCode + '</div>' : '') +
          '</div>'
        ).join('');
      }

      // Track which artifact IDs are expanded (persists across re-renders)
      const _expandedArtifacts = new Set();

      function renderWorkspaceArtifacts() {
        const el = $('ws-artifacts');
        if (!el) return;
        // Artifacts are already filtered by session_name on the server side
        const recent = wsArtifacts.slice(-10).reverse();
        if (recent.length === 0) { el.innerHTML = '<div class="ws-empty">No artifacts</div>'; return; }
        el.innerHTML = recent.map((a) => {
          var hasContent = a.content && a.content.trim();
          var ct = a.contentType || 'plain';
          var badge = (ct !== 'plain') ? ' <span class="ws-badge ' + esc(ct) + '">' + esc(ct) + '</span>' : '';
          var rendered = a.renderedHtml || (hasContent ? '<pre style="margin:0;font-size:11px;color:var(--text-muted);white-space:pre-wrap;word-break:break-word">' + esc(a.content) + '</pre>' : '');
          var isExpanded = _expandedArtifacts.has(a.id);
          return '<div class="ws-card">' +
            '<div class="ws-card-header">' +
              '<span class="ws-badge ' + esc(a.type) + '">' + esc(a.type) + '</span>' +
              badge +
              '<span class="ws-card-title">' + esc(a.title) + '</span>' +
              '<span class="ws-card-meta">' + timeAgo(a.createdAt) + '</span>' +
              (hasContent ? '<button class="ws-card-toggle" data-toggle-art="' + esc(a.id) + '">' + (isExpanded ? 'Hide' : 'Show') + '</button>' : '') +
            '</div>' +
            (hasContent ? '<div class="ws-card-content" data-art-content="' + esc(a.id) + '" style="display:' + (isExpanded ? 'block' : 'none') + '">' + rendered + '</div>' : '') +
          '</div>';
        }).join('');
        // Wire up toggle buttons
        el.querySelectorAll('[data-toggle-art]').forEach(function(btn) {
          btn.addEventListener('click', function() {
            var artId = btn.getAttribute('data-toggle-art');
            var contentEl = el.querySelector('[data-art-content="' + artId + '"]');
            if (!contentEl) return;
            var visible = contentEl.style.display !== 'none';
            contentEl.style.display = visible ? 'none' : 'block';
            btn.textContent = visible ? 'Show' : 'Hide';
            if (visible) _expandedArtifacts.delete(artId); else _expandedArtifacts.add(artId);
          });
        });
      }

      $('btn-new-topic').addEventListener('click', () => {
        const title = prompt('Topic title:');
        if (title && title.trim()) {
          sendCtrl({ type: 'create_topic', sessionName: currentSession, title: title.trim() });
          // Optimistic render in topic_created handler, no delayed refresh needed
        }
      });

      $('btn-capture-snapshot').addEventListener('click', () => {
        sendCtrl({ type: 'capture_snapshot' });
        // Optimistic render in snapshot_captured handler, no delayed refresh needed
      });

      // -- Search --
      let searchDebounce = null;
      $('ws-search-input').addEventListener('input', () => {
        clearTimeout(searchDebounce);
        const q = $('ws-search-input').value.trim();
        if (!q) { $('ws-search-results').innerHTML = ''; return; }
        searchDebounce = setTimeout(() => sendCtrl({ type: 'search', query: q }), 200);
      });

      function renderSearchResults(results) {
        const el = $('ws-search-results');
        if (!el) return;
        if (results.length === 0) {
          const q = ($('ws-search-input') || {}).value || '';
          el.innerHTML = q ? '<div class="ws-empty">No results</div>' : '';
          return;
        }
        const esc = t => (t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        el.innerHTML = results.map(r =>
          '<div class="ws-search-result">' +
            '<span class="sr-type">' + esc(r.entityType) + '</span> ' +
            '<span class="sr-title">' + esc(r.title) + '</span>' +
          '</div>'
        ).join('');
      }

      // -- Handoff --
      $('btn-handoff').addEventListener('click', () => {
        const el = $('ws-handoff');
        if (el.classList.contains('visible')) { el.classList.remove('visible'); return; }
        sendCtrl({ type: 'get_handoff' });
      });

      function renderHandoffBundle(bundle) {
        const el = $('ws-handoff');
        if (!el) return;
        el.classList.add('visible');
        const esc = t => (t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        let html = '<div class="ws-handoff-section"><div class="ws-handoff-label">Sessions</div>';
        html += '<ul class="ws-handoff-list">';
        (bundle.sessions || []).forEach(s => {
          html += '<li>' + esc(s.name) + ' (' + s.activeTabs + ' active tabs)</li>';
        });
        html += '</ul></div>';
        if ((bundle.activeTopics || []).length > 0) {
          html += '<div class="ws-handoff-section"><div class="ws-handoff-label">Active Topics (24h)</div>';
          html += '<ul class="ws-handoff-list">';
          bundle.activeTopics.forEach(t => { html += '<li>' + esc(t.title) + '</li>'; });
          html += '</ul></div>';
        }
        if ((bundle.pendingApprovals || []).length > 0) {
          html += '<div class="ws-handoff-section"><div class="ws-handoff-label">Pending Approvals</div>';
          html += '<ul class="ws-handoff-list">';
          bundle.pendingApprovals.forEach(a => { html += '<li>' + esc(a.title) + '</li>'; });
          html += '</ul></div>';
        }
        html += '<div class="ws-handoff-section"><div class="ws-handoff-label">Recent Runs (' + (bundle.recentRuns || []).length + ')</div></div>';
        html += '<div class="ws-handoff-section"><div class="ws-handoff-label">Key Artifacts (' + (bundle.keyArtifacts || []).length + ')</div></div>';
        el.innerHTML = html;
      }

      // -- Notes --
      function renderNotes() {
        const el = $('ws-notes');
        if (!el) return;
        if (wsNotes.length === 0) { el.innerHTML = '<div class="ws-empty">No notes yet</div>'; return; }
        const esc = t => (t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        el.innerHTML = wsNotes.map(n =>
          '<div class="ws-note' + (n.pinned ? ' pinned' : '') + '">' +
            '<div class="ws-note-content">' + esc(n.content) + '</div>' +
            '<div class="ws-note-actions">' +
              '<button data-pin-note="' + n.id + '">' + (n.pinned ? 'Unpin' : 'Pin') + '</button>' +
              '<button data-del-note="' + n.id + '">Delete</button>' +
            '</div>' +
          '</div>'
        ).join('');
        el.querySelectorAll('[data-pin-note]').forEach(btn => {
          btn.addEventListener('click', () => sendCtrl({ type: 'pin_note', noteId: btn.dataset.pinNote }));
        });
        el.querySelectorAll('[data-del-note]').forEach(btn => {
          btn.addEventListener('click', () => sendCtrl({ type: 'delete_note', noteId: btn.dataset.delNote }));
        });
      }

      $('btn-add-note').addEventListener('click', () => {
        const input = $('ws-note-input');
        const content = input.value.trim();
        if (!content) return;
        sendCtrl({ type: 'create_note', content });
        input.value = '';
        // Feedback: show saving indicator, revert if no response in 3s
        const el = $('ws-notes');
        const prevHtml = el.innerHTML;
        el.innerHTML = '<div class="ws-empty">Saving...</div>';
        setTimeout(() => {
          if (el.innerHTML.includes('Saving...')) {
            el.innerHTML = '<div class="ws-empty" style="color:var(--text-dim)">Note may not have saved \u2014 check server logs</div>';
          }
        }, 3000);
      });
      $('ws-note-input').addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); $('btn-add-note').click(); }
      });

      // -- Commands --
      function formatDuration(startedAt, endedAt) {
        if (!endedAt) return 'running';
        const ms = endedAt - startedAt;
        if (ms < 1000) return ms + 'ms';
        if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
        return Math.floor(ms / 60000) + 'm ' + Math.floor((ms % 60000) / 1000) + 's';
      }

      function renderCommands() {
        const el = $('ws-commands');
        if (!el) return;
        if (wsCommands.length === 0) { el.innerHTML = '<div class="ws-empty">No commands detected (requires shell integration)</div>'; return; }
        const esc = t => (t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        el.innerHTML = wsCommands.slice(0, 20).map(c => {
          const exitClass = c.exitCode === null ? '' : (c.exitCode === 0 ? 'ok' : 'err');
          const exitSymbol = c.exitCode === null ? '' : (c.exitCode === 0 ? '&#10003;' : '&#10007; ' + c.exitCode);
          return '<div class="ws-cmd">' +
            '<span class="ws-cmd-text">' + esc(c.command || '(unknown)') + '</span>' +
            (exitSymbol ? '<span class="ws-cmd-exit ' + exitClass + '">' + exitSymbol + '</span>' : '') +
            '<span class="ws-cmd-meta">' + formatDuration(c.startedAt, c.endedAt) + '</span>' +
            (c.cwd ? '<span class="ws-cmd-meta">' + esc(c.cwd) + '</span>' : '') +
          '</div>';
        }).join('');
      }

      // -- Tab rename (double-click) --
      $('tab-list').addEventListener('dblclick', e => {
        const tabEl = e.target.closest('.tab');
        if (!tabEl) return;
        const titleSpan = tabEl.querySelector('.title');
        if (!titleSpan) return;
        // Find tab id from close button
        const closeBtn = tabEl.querySelector('.close');
        if (!closeBtn) return;
        const tabId = Number(closeBtn.dataset.close);
        const oldTitle = titleSpan.textContent;

        const input = document.createElement('input');
        input.className = 'rename-input';
        input.value = oldTitle;
        input.setAttribute('maxlength', '32');
        titleSpan.replaceWith(input);
        input.focus();
        input.select();

        function commit() {
          const newTitle = input.value.trim() || oldTitle;
          // Send rename to server
          if (newTitle !== oldTitle) sendCtrl({ type: 'rename_tab', tabId, title: newTitle });
          // Restore span immediately
          const span = document.createElement('span');
          span.className = 'title';
          span.textContent = newTitle;
          input.replaceWith(span);
        }
        function cancel() {
          const span = document.createElement('span');
          span.className = 'title';
          span.textContent = oldTitle;
          input.replaceWith(span);
        }
        input.addEventListener('keydown', ev => {
          if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
          if (ev.key === 'Escape') { ev.preventDefault(); cancel(); }
        });
        input.addEventListener('blur', commit);
      });

      // -- Mobile virtual keyboard handling --
      // Only apply visualViewport height adjustments on touch devices.
      // Ignore viewport sync during IME composition so candidate UI can't
      // temporarily collapse the terminal area.
      if (window.visualViewport && isTouchDevice) {
        window.visualViewport.addEventListener('resize', syncTouchViewportHeight);
        window.visualViewport.addEventListener('scroll', () => window.scrollTo(0, 0));
      }
      // iOS Safari: touching terminal area focuses hidden textarea for input
      document.getElementById('terminal').addEventListener('touchend', () => { if (currentView === 'live') term.focus(); });

      // -- IME diagnostic (active when ?debug=1) --
      if (new URLSearchParams(location.search).has('debug')) {
        const _d = window._imeDiag = { events: [], t0: Date.now() };
        function _ilog(type, detail) {
          const e = { t: Date.now() - _d.t0, type, ...detail };
          _d.events.push(e);
          if (_d.events.length > 300) _d.events.shift();
          try { localStorage.setItem('_imeDiag', JSON.stringify(_d.events.slice(-50))); } catch {}
        }
        const _ta = document.querySelector('textarea');
        if (_ta) {
          ['compositionstart','compositionupdate','compositionend'].forEach(n =>
            _ta.addEventListener(n, e => _ilog(n, { data: e.data }), true));
          _ta.addEventListener('input', e => _ilog('input', {
            data: e.data?.substring(0,20), inputType: e.inputType, isComposing: e.isComposing
          }), true);
          _ta.addEventListener('keydown', e => {
            if (e.isComposing || e.keyCode === 229)
              _ilog('keydown-ime', { key: e.key, code: e.code, kc: e.keyCode });
          }, true);
        }
        new ResizeObserver(entries => entries.forEach(e => {
          const n = e.target.id || e.target.tagName;
          _ilog('resize', { el: n, h: Math.round(e.contentRect.height) });
        })).observe(document.body);
        if (window.visualViewport) window.visualViewport.addEventListener('resize', () =>
          _ilog('vv-resize', { vh: Math.round(window.visualViewport.height), bh: document.body.offsetHeight }));
        new MutationObserver(() => _ilog('body-style', {
          h: document.body.style.height, oh: document.body.offsetHeight
        })).observe(document.body, { attributes: true, attributeFilter: ['style'] });
        window.addEventListener('error', e => _ilog('js-error', { msg: e.message, line: e.lineno }));
        // Track textarea style/size changes (IME may resize it)
        if (_ta) {
          new ResizeObserver(() => {
            _ilog('ta-resize', { w: _ta.offsetWidth, h: _ta.offsetHeight, vis: getComputedStyle(_ta).visibility, op: getComputedStyle(_ta).opacity });
          }).observe(_ta);
        }
        // Track canvas visibility
        const _cvs = document.querySelector('#terminal canvas');
        if (_cvs) {
          new ResizeObserver(() => {
            _ilog('canvas-resize', { w: _cvs.width, h: _cvs.height, display: getComputedStyle(_cvs).display });
          }).observe(_cvs);
        }
        // Floating debug overlay \u2014 stays visible even when page goes "blank"
        const _dbg = document.createElement('div');
        _dbg.id = 'ime-debug';
        _dbg.style.cssText = 'position:fixed;bottom:0;right:0;z-index:999999;background:rgba(0,0,0,0.85);color:#0f0;font:10px monospace;padding:4px 8px;max-width:60vw;max-height:40vh;overflow:auto;pointer-events:none;white-space:pre-wrap;';
        document.documentElement.appendChild(_dbg);

        // Continuous polling \u2014 captures state even when no events fire
        let _prevState = '';
        setInterval(() => {
          const _ta2 = document.querySelector('textarea');
          const _cvs2 = document.querySelector('#terminal canvas');
          const _term2 = document.getElementById('terminal');
          const _main2 = document.querySelector('.main');
          const _sidebar2 = document.querySelector('.sidebar');
          const state = JSON.stringify({
            body: { h: document.body.offsetHeight, w: document.body.offsetWidth, styleH: document.body.style.height, vis: document.body.style.visibility, disp: document.body.style.display },
            main: _main2 ? { h: _main2.offsetHeight, vis: getComputedStyle(_main2).visibility, op: getComputedStyle(_main2).opacity, disp: getComputedStyle(_main2).display } : null,
            term: _term2 ? { h: _term2.offsetHeight, w: _term2.offsetWidth, vis: getComputedStyle(_term2).visibility, disp: getComputedStyle(_term2).display, op: getComputedStyle(_term2).opacity } : null,
            cvs: _cvs2 ? { w: _cvs2.width, h: _cvs2.height, styleW: _cvs2.style.width, styleH: _cvs2.style.height, vis: getComputedStyle(_cvs2).visibility, disp: getComputedStyle(_cvs2).display } : null,
            ta: _ta2 ? { w: _ta2.offsetWidth, h: _ta2.offsetHeight, styleW: _ta2.style.width, styleH: _ta2.style.height, pos: getComputedStyle(_ta2).position, vis: getComputedStyle(_ta2).visibility, op: getComputedStyle(_ta2).opacity, zIdx: getComputedStyle(_ta2).zIndex, bg: getComputedStyle(_ta2).background?.substring(0,40) } : null,
            sidebar: _sidebar2 ? { h: _sidebar2.offsetHeight, vis: getComputedStyle(_sidebar2).visibility } : null,
            vv: window.visualViewport ? { h: Math.round(window.visualViewport.height), w: Math.round(window.visualViewport.width) } : null
          });
          if (state !== _prevState) {
            _prevState = state;
            _ilog('poll', JSON.parse(state));
          }
          // Always update overlay with latest events
          const last = _d.events.slice(-12);
          _dbg.textContent = last.map(e => {
            const {t, type, ...r} = e;
            return t + 'ms ' + type + ': ' + JSON.stringify(r).substring(0, 120);
          }).join('\\n');
        }, 200);
        console.log('[remux] IME diagnostic v2 active \u2014 polling every 200ms');
      }
    </script>
  </body>
</html>`;
    SW_SCRIPT = `self.addEventListener('push', function(event) {
  if (!event.data) return;
  try {
    var data = event.data.json();
    event.waitUntil(
      self.registration.showNotification(data.title || 'Remux', {
        body: data.body || '',
        icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">></text></svg>',
        badge: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">></text></svg>',
        tag: 'remux-' + (data.tag || 'default'),
        renotify: true,
      })
    );
  } catch (e) {
    // Fallback for non-JSON payloads
    event.waitUntil(
      self.registration.showNotification('Remux', { body: event.data.text() })
    );
  }
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      for (var i = 0; i < clientList.length; i++) {
        if (clientList[i].url.includes(self.location.origin) && 'focus' in clientList[i]) {
          return clientList[i].focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow('/');
      }
    })
  );
});
`;
    MIME = {
      ".html": "text/html",
      ".js": "application/javascript",
      ".wasm": "application/wasm",
      ".css": "text/css",
      ".json": "application/json"
    };
    httpServer = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname === "/auth" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => body += chunk);
        req.on("end", () => {
          const params = new URLSearchParams(body);
          const submitted = params.get("password");
          if (PASSWORD && submitted === PASSWORD) {
            const sessionToken = generateToken();
            addPasswordToken(sessionToken);
            res.writeHead(302, { Location: `/?token=${sessionToken}` });
            res.end();
          } else {
            res.writeHead(302, { Location: "/?error=1" });
            res.end();
          }
        });
        return;
      }
      if (url.pathname === "/" || url.pathname === "/index.html") {
        const urlToken = url.searchParams.get("token");
        const isAuthed = !TOKEN && !PASSWORD || // no auth configured (impossible after auto-gen, but safe)
        urlToken != null && validateToken(urlToken, TOKEN);
        if (!isAuthed) {
          if (PASSWORD) {
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(PASSWORD_PAGE);
            return;
          }
          res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
          res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Remux</title><link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>\u2B1B</text></svg>"><style>body{font-family:-apple-system,system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#1e1e1e;color:#ccc}div{text-align:center;max-width:400px;padding:2rem}h1{font-size:1.5rem;margin:0 0 1rem}p{color:#888;line-height:1.6}code{background:#333;padding:2px 6px;border-radius:3px;font-size:0.9em}</style></head><body><div><h1>Remux</h1><p>Access requires a valid token.</p><p>Add <code>?token=YOUR_TOKEN</code> to the URL.</p></div></body></html>`);
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(HTML_TEMPLATE);
        return;
      }
      if (url.pathname.startsWith("/dist/")) {
        const resolved = path6.resolve(distPath, url.pathname.slice(6));
        const rel = path6.relative(distPath, resolved);
        if (rel.startsWith("..") || path6.isAbsolute(rel)) {
          res.writeHead(403);
          res.end("Forbidden");
          return;
        }
        return serveFile(resolved, res);
      }
      if (url.pathname === "/ghostty-vt.wasm") {
        return serveFile(wasmPath, res);
      }
      if (url.pathname === "/sw.js") {
        res.writeHead(200, {
          "Content-Type": "application/javascript",
          "Service-Worker-Allowed": "/"
        });
        res.end(SW_SCRIPT);
        return;
      }
      res.writeHead(404);
      res.end("Not Found");
    });
    wss = setupWebSocket(httpServer, TOKEN, PASSWORD);
    adapterRegistry.onEvent((event) => {
      const envelope = JSON.stringify({
        v: 1,
        type: "adapter_event",
        domain: "semantic",
        emittedAt: event.timestamp,
        source: "server",
        payload: event
      });
      for (const client of wss.clients) {
        if (client.readyState === 1) {
          if (client._remuxAuthed) {
            client.send(envelope);
          }
        }
      }
    });
    httpServer.listen(PORT2, () => {
      let url = `http://localhost:${PORT2}`;
      if (TOKEN) url += `?token=${TOKEN}`;
      console.log(`
  Remux running at ${url}
`);
      if (PASSWORD) {
        console.log(`  Password authentication enabled`);
        console.log(`  Login page: http://localhost:${PORT2}
`);
      } else if (TOKEN) {
        console.log(`  Token: ${TOKEN}
`);
      }
      qrcode.generate(url, { small: true }, (code) => {
        console.log(code);
      });
      launchTunnel();
    });
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  }
});
init_server();
export {
  adapterRegistry
};

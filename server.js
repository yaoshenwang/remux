#!/usr/bin/env node
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
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
var __commonJS = (cb, mod) => function __require2() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
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
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
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
  `);
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
function createDevice(fingerprint, trust = "untrusted", name) {
  const db = getDb();
  const id = generateDeviceId();
  const now = Date.now();
  const deviceName = name || `Device-${id.slice(0, 4).toUpperCase()}`;
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
  const result = db.prepare("DELETE FROM topics WHERE id = ?").run(id);
  return result.changes > 0;
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
function listRuns(topicId) {
  const db = getDb();
  let rows;
  if (topicId) {
    rows = db.prepare("SELECT * FROM runs WHERE topic_id = ? ORDER BY started_at").all(topicId);
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
    `INSERT INTO artifacts (id, run_id, topic_id, type, title, content, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    params.runId ?? null,
    params.topicId ?? null,
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
  const safeQuery = query.replace(/"/g, '""');
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
function createNote(content) {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = Date.now();
  db.prepare(
    "INSERT INTO memory_notes (id, content, pinned, created_at, updated_at) VALUES (?, ?, 0, ?, ?)"
  ).run(id, content, now, now);
  return { id, content, pinned: false, createdAt: now, updatedAt: now };
}
function listNotes() {
  const db = getDb();
  const rows = db.prepare(
    "SELECT * FROM memory_notes ORDER BY pinned DESC, updated_at DESC"
  ).all();
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
  const result = db.prepare("DELETE FROM memory_notes WHERE id = ?").run(id);
  return result.changes > 0;
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
  if (TOKEN2 && token === TOKEN2) return true;
  if (passwordTokens.has(token)) return true;
  return false;
}
function registerDevice(req) {
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
var passwordTokens, PASSWORD_PAGE;
var init_auth = __esm({
  "src/auth.ts"() {
    "use strict";
    init_store();
    passwordTokens = /* @__PURE__ */ new Set();
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
      const bytes = typeof data === "string" ? Buffer.from(data) : data;
      const ptr = wasmExports.ghostty_wasm_alloc_u8_array(bytes.length);
      new Uint8Array(wasmMemory.buffer).set(bytes, ptr);
      wasmExports.ghostty_terminal_write(handle, ptr, bytes.length);
      wasmExports.ghostty_wasm_free_u8_array(ptr, bytes.length);
    },
    resize(cols2, rows2) {
      wasmExports.ghostty_terminal_resize(handle, cols2, rows2);
    },
    isAltScreen() {
      return !!wasmExports.ghostty_terminal_is_alternate_screen(handle);
    },
    snapshot() {
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
      wasmExports.ghostty_terminal_free(handle);
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

// src/session.ts
import fs3 from "fs";
import { homedir as homedir2 } from "os";
import pty from "node-pty";
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
  const ptyProcess = pty.spawn(getShell(), [], {
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
  const vtTerminal = createVtTerminal(cols, rows);
  const tab = {
    id,
    pty: ptyProcess,
    scrollback: new RingBuffer(),
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
    }
  };
  ptyProcess.onData((data) => {
    tab.scrollback.write(data);
    if (tab.vt) tab.vt.consume(data);
    for (const ws of tab.clients) {
      if (ws.readyState === ws.OPEN) ws.send(data);
    }
    processShellIntegration(data, tab, session.name);
    try {
      const { adapterRegistry: adapterRegistry2 } = (init_server(), __toCommonJS(server_exports));
      adapterRegistry2?.dispatchTerminalData(session.name, data);
    } catch {
    }
    const now = Date.now();
    if (now - lastOutputTimestamp > IDLE_THRESHOLD_MS && !isIdle) {
      isIdle = true;
    }
    if (isIdle) {
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
      if (ws.readyState === ws.OPEN) ws.send(msg);
    }
    broadcastState();
    broadcastPush(
      "Shell Exited",
      `"${session.name}" tab "${tab.title}" exited (code: ${exitCode})`
    ).catch(() => {
    });
  });
  session.tabs.push(tab);
  console.log(
    `[tab] created id=${id} in session "${session.name}" (pid=${ptyProcess.pid})`
  );
  return tab;
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
    if (!tab.ended) tab.pty.kill();
  }
  sessionMap.delete(name);
  console.log(`[session] deleted "${name}"`);
}
function getState() {
  return [...sessionMap.values()].map((s) => ({
    name: s.name,
    tabs: s.tabs.map((t) => ({
      id: t.id,
      title: t.title,
      ended: t.ended,
      clients: t.clients.size
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
      if (snapshot) ws.send(snapshot);
    } else {
      const history = tab.scrollback.read();
      if (history.length > 0) ws.send(history.toString("utf8"));
    }
  }
  tab.clients.add(ws);
  ws._remuxTabId = tab.id;
  ws._remuxCols = cols;
  ws._remuxRows = rows;
  recalcTabSize(tab);
  if (!tab.ended && tab.vt) {
    const { text } = tab.vt.textSnapshot();
    if (text && text.trim().length > 0) {
      setTimeout(() => {
        tab.pty.write("\f");
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
    tab.cols = minCols;
    tab.rows = minRows;
    tab.pty.resize(minCols, minRows);
    if (tab.vt) tab.vt.resize(minCols, minRows);
  }
}
function setBroadcastHooks(sendFn, clientListFn) {
  _sendEnvelopeFn = sendFn;
  _getClientListFn = clientListFn;
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
var IDLE_THRESHOLD_MS, lastOutputTimestamp, isIdle, RingBuffer, tabIdCounter, sessionMap, controlClients, _sendEnvelopeFn, _getClientListFn, PERSIST_INTERVAL_MS;
var init_session = __esm({
  "src/session.ts"() {
    "use strict";
    init_store();
    init_push();
    init_vt_tracker();
    IDLE_THRESHOLD_MS = 5 * 60 * 1e3;
    lastOutputTimestamp = Date.now();
    isIdle = false;
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
          return this.buf.subarray(this.writePos - this.length, this.writePos);
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
    PERSIST_INTERVAL_MS = 8e3;
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

// node_modules/.pnpm/ms@2.1.3/node_modules/ms/index.js
var require_ms = __commonJS({
  "node_modules/.pnpm/ms@2.1.3/node_modules/ms/index.js"(exports, module) {
    var s = 1e3;
    var m = s * 60;
    var h = m * 60;
    var d = h * 24;
    var w = d * 7;
    var y = d * 365.25;
    module.exports = function(val, options) {
      options = options || {};
      var type = typeof val;
      if (type === "string" && val.length > 0) {
        return parse(val);
      } else if (type === "number" && isFinite(val)) {
        return options.long ? fmtLong(val) : fmtShort(val);
      }
      throw new Error(
        "val is not a non-empty string or a valid number. val=" + JSON.stringify(val)
      );
    };
    function parse(str) {
      str = String(str);
      if (str.length > 100) {
        return;
      }
      var match = /^(-?(?:\d+)?\.?\d+) *(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w|years?|yrs?|y)?$/i.exec(
        str
      );
      if (!match) {
        return;
      }
      var n = parseFloat(match[1]);
      var type = (match[2] || "ms").toLowerCase();
      switch (type) {
        case "years":
        case "year":
        case "yrs":
        case "yr":
        case "y":
          return n * y;
        case "weeks":
        case "week":
        case "w":
          return n * w;
        case "days":
        case "day":
        case "d":
          return n * d;
        case "hours":
        case "hour":
        case "hrs":
        case "hr":
        case "h":
          return n * h;
        case "minutes":
        case "minute":
        case "mins":
        case "min":
        case "m":
          return n * m;
        case "seconds":
        case "second":
        case "secs":
        case "sec":
        case "s":
          return n * s;
        case "milliseconds":
        case "millisecond":
        case "msecs":
        case "msec":
        case "ms":
          return n;
        default:
          return void 0;
      }
    }
    function fmtShort(ms) {
      var msAbs = Math.abs(ms);
      if (msAbs >= d) {
        return Math.round(ms / d) + "d";
      }
      if (msAbs >= h) {
        return Math.round(ms / h) + "h";
      }
      if (msAbs >= m) {
        return Math.round(ms / m) + "m";
      }
      if (msAbs >= s) {
        return Math.round(ms / s) + "s";
      }
      return ms + "ms";
    }
    function fmtLong(ms) {
      var msAbs = Math.abs(ms);
      if (msAbs >= d) {
        return plural(ms, msAbs, d, "day");
      }
      if (msAbs >= h) {
        return plural(ms, msAbs, h, "hour");
      }
      if (msAbs >= m) {
        return plural(ms, msAbs, m, "minute");
      }
      if (msAbs >= s) {
        return plural(ms, msAbs, s, "second");
      }
      return ms + " ms";
    }
    function plural(ms, msAbs, n, name) {
      var isPlural = msAbs >= n * 1.5;
      return Math.round(ms / n) + " " + name + (isPlural ? "s" : "");
    }
  }
});

// node_modules/.pnpm/debug@4.4.3/node_modules/debug/src/common.js
var require_common = __commonJS({
  "node_modules/.pnpm/debug@4.4.3/node_modules/debug/src/common.js"(exports, module) {
    function setup(env) {
      createDebug.debug = createDebug;
      createDebug.default = createDebug;
      createDebug.coerce = coerce;
      createDebug.disable = disable;
      createDebug.enable = enable;
      createDebug.enabled = enabled;
      createDebug.humanize = require_ms();
      createDebug.destroy = destroy;
      Object.keys(env).forEach((key) => {
        createDebug[key] = env[key];
      });
      createDebug.names = [];
      createDebug.skips = [];
      createDebug.formatters = {};
      function selectColor(namespace) {
        let hash = 0;
        for (let i = 0; i < namespace.length; i++) {
          hash = (hash << 5) - hash + namespace.charCodeAt(i);
          hash |= 0;
        }
        return createDebug.colors[Math.abs(hash) % createDebug.colors.length];
      }
      createDebug.selectColor = selectColor;
      function createDebug(namespace) {
        let prevTime;
        let enableOverride = null;
        let namespacesCache;
        let enabledCache;
        function debug2(...args) {
          if (!debug2.enabled) {
            return;
          }
          const self = debug2;
          const curr = Number(/* @__PURE__ */ new Date());
          const ms = curr - (prevTime || curr);
          self.diff = ms;
          self.prev = prevTime;
          self.curr = curr;
          prevTime = curr;
          args[0] = createDebug.coerce(args[0]);
          if (typeof args[0] !== "string") {
            args.unshift("%O");
          }
          let index = 0;
          args[0] = args[0].replace(/%([a-zA-Z%])/g, (match, format) => {
            if (match === "%%") {
              return "%";
            }
            index++;
            const formatter = createDebug.formatters[format];
            if (typeof formatter === "function") {
              const val = args[index];
              match = formatter.call(self, val);
              args.splice(index, 1);
              index--;
            }
            return match;
          });
          createDebug.formatArgs.call(self, args);
          const logFn = self.log || createDebug.log;
          logFn.apply(self, args);
        }
        debug2.namespace = namespace;
        debug2.useColors = createDebug.useColors();
        debug2.color = createDebug.selectColor(namespace);
        debug2.extend = extend;
        debug2.destroy = createDebug.destroy;
        Object.defineProperty(debug2, "enabled", {
          enumerable: true,
          configurable: false,
          get: () => {
            if (enableOverride !== null) {
              return enableOverride;
            }
            if (namespacesCache !== createDebug.namespaces) {
              namespacesCache = createDebug.namespaces;
              enabledCache = createDebug.enabled(namespace);
            }
            return enabledCache;
          },
          set: (v) => {
            enableOverride = v;
          }
        });
        if (typeof createDebug.init === "function") {
          createDebug.init(debug2);
        }
        return debug2;
      }
      function extend(namespace, delimiter) {
        const newDebug = createDebug(this.namespace + (typeof delimiter === "undefined" ? ":" : delimiter) + namespace);
        newDebug.log = this.log;
        return newDebug;
      }
      function enable(namespaces) {
        createDebug.save(namespaces);
        createDebug.namespaces = namespaces;
        createDebug.names = [];
        createDebug.skips = [];
        const split = (typeof namespaces === "string" ? namespaces : "").trim().replace(/\s+/g, ",").split(",").filter(Boolean);
        for (const ns of split) {
          if (ns[0] === "-") {
            createDebug.skips.push(ns.slice(1));
          } else {
            createDebug.names.push(ns);
          }
        }
      }
      function matchesTemplate(search, template) {
        let searchIndex = 0;
        let templateIndex = 0;
        let starIndex = -1;
        let matchIndex = 0;
        while (searchIndex < search.length) {
          if (templateIndex < template.length && (template[templateIndex] === search[searchIndex] || template[templateIndex] === "*")) {
            if (template[templateIndex] === "*") {
              starIndex = templateIndex;
              matchIndex = searchIndex;
              templateIndex++;
            } else {
              searchIndex++;
              templateIndex++;
            }
          } else if (starIndex !== -1) {
            templateIndex = starIndex + 1;
            matchIndex++;
            searchIndex = matchIndex;
          } else {
            return false;
          }
        }
        while (templateIndex < template.length && template[templateIndex] === "*") {
          templateIndex++;
        }
        return templateIndex === template.length;
      }
      function disable() {
        const namespaces = [
          ...createDebug.names,
          ...createDebug.skips.map((namespace) => "-" + namespace)
        ].join(",");
        createDebug.enable("");
        return namespaces;
      }
      function enabled(name) {
        for (const skip of createDebug.skips) {
          if (matchesTemplate(name, skip)) {
            return false;
          }
        }
        for (const ns of createDebug.names) {
          if (matchesTemplate(name, ns)) {
            return true;
          }
        }
        return false;
      }
      function coerce(val) {
        if (val instanceof Error) {
          return val.stack || val.message;
        }
        return val;
      }
      function destroy() {
        console.warn("Instance method `debug.destroy()` is deprecated and no longer does anything. It will be removed in the next major version of `debug`.");
      }
      createDebug.enable(createDebug.load());
      return createDebug;
    }
    module.exports = setup;
  }
});

// node_modules/.pnpm/debug@4.4.3/node_modules/debug/src/browser.js
var require_browser = __commonJS({
  "node_modules/.pnpm/debug@4.4.3/node_modules/debug/src/browser.js"(exports, module) {
    exports.formatArgs = formatArgs;
    exports.save = save;
    exports.load = load;
    exports.useColors = useColors;
    exports.storage = localstorage();
    exports.destroy = /* @__PURE__ */ (() => {
      let warned = false;
      return () => {
        if (!warned) {
          warned = true;
          console.warn("Instance method `debug.destroy()` is deprecated and no longer does anything. It will be removed in the next major version of `debug`.");
        }
      };
    })();
    exports.colors = [
      "#0000CC",
      "#0000FF",
      "#0033CC",
      "#0033FF",
      "#0066CC",
      "#0066FF",
      "#0099CC",
      "#0099FF",
      "#00CC00",
      "#00CC33",
      "#00CC66",
      "#00CC99",
      "#00CCCC",
      "#00CCFF",
      "#3300CC",
      "#3300FF",
      "#3333CC",
      "#3333FF",
      "#3366CC",
      "#3366FF",
      "#3399CC",
      "#3399FF",
      "#33CC00",
      "#33CC33",
      "#33CC66",
      "#33CC99",
      "#33CCCC",
      "#33CCFF",
      "#6600CC",
      "#6600FF",
      "#6633CC",
      "#6633FF",
      "#66CC00",
      "#66CC33",
      "#9900CC",
      "#9900FF",
      "#9933CC",
      "#9933FF",
      "#99CC00",
      "#99CC33",
      "#CC0000",
      "#CC0033",
      "#CC0066",
      "#CC0099",
      "#CC00CC",
      "#CC00FF",
      "#CC3300",
      "#CC3333",
      "#CC3366",
      "#CC3399",
      "#CC33CC",
      "#CC33FF",
      "#CC6600",
      "#CC6633",
      "#CC9900",
      "#CC9933",
      "#CCCC00",
      "#CCCC33",
      "#FF0000",
      "#FF0033",
      "#FF0066",
      "#FF0099",
      "#FF00CC",
      "#FF00FF",
      "#FF3300",
      "#FF3333",
      "#FF3366",
      "#FF3399",
      "#FF33CC",
      "#FF33FF",
      "#FF6600",
      "#FF6633",
      "#FF9900",
      "#FF9933",
      "#FFCC00",
      "#FFCC33"
    ];
    function useColors() {
      if (typeof window !== "undefined" && window.process && (window.process.type === "renderer" || window.process.__nwjs)) {
        return true;
      }
      if (typeof navigator !== "undefined" && navigator.userAgent && navigator.userAgent.toLowerCase().match(/(edge|trident)\/(\d+)/)) {
        return false;
      }
      let m;
      return typeof document !== "undefined" && document.documentElement && document.documentElement.style && document.documentElement.style.WebkitAppearance || // Is firebug? http://stackoverflow.com/a/398120/376773
      typeof window !== "undefined" && window.console && (window.console.firebug || window.console.exception && window.console.table) || // Is firefox >= v31?
      // https://developer.mozilla.org/en-US/docs/Tools/Web_Console#Styling_messages
      typeof navigator !== "undefined" && navigator.userAgent && (m = navigator.userAgent.toLowerCase().match(/firefox\/(\d+)/)) && parseInt(m[1], 10) >= 31 || // Double check webkit in userAgent just in case we are in a worker
      typeof navigator !== "undefined" && navigator.userAgent && navigator.userAgent.toLowerCase().match(/applewebkit\/(\d+)/);
    }
    function formatArgs(args) {
      args[0] = (this.useColors ? "%c" : "") + this.namespace + (this.useColors ? " %c" : " ") + args[0] + (this.useColors ? "%c " : " ") + "+" + module.exports.humanize(this.diff);
      if (!this.useColors) {
        return;
      }
      const c = "color: " + this.color;
      args.splice(1, 0, c, "color: inherit");
      let index = 0;
      let lastC = 0;
      args[0].replace(/%[a-zA-Z%]/g, (match) => {
        if (match === "%%") {
          return;
        }
        index++;
        if (match === "%c") {
          lastC = index;
        }
      });
      args.splice(lastC, 0, c);
    }
    exports.log = console.debug || console.log || (() => {
    });
    function save(namespaces) {
      try {
        if (namespaces) {
          exports.storage.setItem("debug", namespaces);
        } else {
          exports.storage.removeItem("debug");
        }
      } catch (error) {
      }
    }
    function load() {
      let r;
      try {
        r = exports.storage.getItem("debug") || exports.storage.getItem("DEBUG");
      } catch (error) {
      }
      if (!r && typeof process !== "undefined" && "env" in process) {
        r = process.env.DEBUG;
      }
      return r;
    }
    function localstorage() {
      try {
        return localStorage;
      } catch (error) {
      }
    }
    module.exports = require_common()(exports);
    var { formatters } = module.exports;
    formatters.j = function(v) {
      try {
        return JSON.stringify(v);
      } catch (error) {
        return "[UnexpectedJSONParseError]: " + error.message;
      }
    };
  }
});

// node_modules/.pnpm/debug@4.4.3/node_modules/debug/src/node.js
var require_node = __commonJS({
  "node_modules/.pnpm/debug@4.4.3/node_modules/debug/src/node.js"(exports, module) {
    var tty = __require("tty");
    var util = __require("util");
    exports.init = init;
    exports.log = log;
    exports.formatArgs = formatArgs;
    exports.save = save;
    exports.load = load;
    exports.useColors = useColors;
    exports.destroy = util.deprecate(
      () => {
      },
      "Instance method `debug.destroy()` is deprecated and no longer does anything. It will be removed in the next major version of `debug`."
    );
    exports.colors = [6, 2, 3, 4, 5, 1];
    try {
      const supportsColor = __require("supports-color");
      if (supportsColor && (supportsColor.stderr || supportsColor).level >= 2) {
        exports.colors = [
          20,
          21,
          26,
          27,
          32,
          33,
          38,
          39,
          40,
          41,
          42,
          43,
          44,
          45,
          56,
          57,
          62,
          63,
          68,
          69,
          74,
          75,
          76,
          77,
          78,
          79,
          80,
          81,
          92,
          93,
          98,
          99,
          112,
          113,
          128,
          129,
          134,
          135,
          148,
          149,
          160,
          161,
          162,
          163,
          164,
          165,
          166,
          167,
          168,
          169,
          170,
          171,
          172,
          173,
          178,
          179,
          184,
          185,
          196,
          197,
          198,
          199,
          200,
          201,
          202,
          203,
          204,
          205,
          206,
          207,
          208,
          209,
          214,
          215,
          220,
          221
        ];
      }
    } catch (error) {
    }
    exports.inspectOpts = Object.keys(process.env).filter((key) => {
      return /^debug_/i.test(key);
    }).reduce((obj, key) => {
      const prop = key.substring(6).toLowerCase().replace(/_([a-z])/g, (_, k) => {
        return k.toUpperCase();
      });
      let val = process.env[key];
      if (/^(yes|on|true|enabled)$/i.test(val)) {
        val = true;
      } else if (/^(no|off|false|disabled)$/i.test(val)) {
        val = false;
      } else if (val === "null") {
        val = null;
      } else {
        val = Number(val);
      }
      obj[prop] = val;
      return obj;
    }, {});
    function useColors() {
      return "colors" in exports.inspectOpts ? Boolean(exports.inspectOpts.colors) : tty.isatty(process.stderr.fd);
    }
    function formatArgs(args) {
      const { namespace: name, useColors: useColors2 } = this;
      if (useColors2) {
        const c = this.color;
        const colorCode = "\x1B[3" + (c < 8 ? c : "8;5;" + c);
        const prefix = `  ${colorCode};1m${name} \x1B[0m`;
        args[0] = prefix + args[0].split("\n").join("\n" + prefix);
        args.push(colorCode + "m+" + module.exports.humanize(this.diff) + "\x1B[0m");
      } else {
        args[0] = getDate() + name + " " + args[0];
      }
    }
    function getDate() {
      if (exports.inspectOpts.hideDate) {
        return "";
      }
      return (/* @__PURE__ */ new Date()).toISOString() + " ";
    }
    function log(...args) {
      return process.stderr.write(util.formatWithOptions(exports.inspectOpts, ...args) + "\n");
    }
    function save(namespaces) {
      if (namespaces) {
        process.env.DEBUG = namespaces;
      } else {
        delete process.env.DEBUG;
      }
    }
    function load() {
      return process.env.DEBUG;
    }
    function init(debug2) {
      debug2.inspectOpts = {};
      const keys = Object.keys(exports.inspectOpts);
      for (let i = 0; i < keys.length; i++) {
        debug2.inspectOpts[keys[i]] = exports.inspectOpts[keys[i]];
      }
    }
    module.exports = require_common()(exports);
    var { formatters } = module.exports;
    formatters.o = function(v) {
      this.inspectOpts.colors = this.useColors;
      return util.inspect(v, this.inspectOpts).split("\n").map((str) => str.trim()).join(" ");
    };
    formatters.O = function(v) {
      this.inspectOpts.colors = this.useColors;
      return util.inspect(v, this.inspectOpts);
    };
  }
});

// node_modules/.pnpm/debug@4.4.3/node_modules/debug/src/index.js
var require_src = __commonJS({
  "node_modules/.pnpm/debug@4.4.3/node_modules/debug/src/index.js"(exports, module) {
    if (typeof process === "undefined" || process.type === "renderer" || process.browser === true || process.__nwjs) {
      module.exports = require_browser();
    } else {
      module.exports = require_node();
    }
  }
});

// node_modules/.pnpm/@kwsites+file-exists@1.1.1/node_modules/@kwsites/file-exists/dist/src/index.js
var require_src2 = __commonJS({
  "node_modules/.pnpm/@kwsites+file-exists@1.1.1/node_modules/@kwsites/file-exists/dist/src/index.js"(exports) {
    "use strict";
    var __importDefault = exports && exports.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports, "__esModule", { value: true });
    var fs_1 = __require("fs");
    var debug_1 = __importDefault(require_src());
    var log = debug_1.default("@kwsites/file-exists");
    function check(path4, isFile, isDirectory) {
      log(`checking %s`, path4);
      try {
        const stat = fs_1.statSync(path4);
        if (stat.isFile() && isFile) {
          log(`[OK] path represents a file`);
          return true;
        }
        if (stat.isDirectory() && isDirectory) {
          log(`[OK] path represents a directory`);
          return true;
        }
        log(`[FAIL] path represents something other than a file or directory`);
        return false;
      } catch (e) {
        if (e.code === "ENOENT") {
          log(`[FAIL] path is not accessible: %o`, e);
          return false;
        }
        log(`[FATAL] %o`, e);
        throw e;
      }
    }
    function exists2(path4, type = exports.READABLE) {
      return check(path4, (type & exports.FILE) > 0, (type & exports.FOLDER) > 0);
    }
    exports.exists = exists2;
    exports.FILE = 1;
    exports.FOLDER = 2;
    exports.READABLE = exports.FILE + exports.FOLDER;
  }
});

// node_modules/.pnpm/@kwsites+file-exists@1.1.1/node_modules/@kwsites/file-exists/dist/index.js
var require_dist = __commonJS({
  "node_modules/.pnpm/@kwsites+file-exists@1.1.1/node_modules/@kwsites/file-exists/dist/index.js"(exports) {
    "use strict";
    function __export3(m) {
      for (var p in m) if (!exports.hasOwnProperty(p)) exports[p] = m[p];
    }
    Object.defineProperty(exports, "__esModule", { value: true });
    __export3(require_src2());
  }
});

// node_modules/.pnpm/@kwsites+promise-deferred@1.1.1/node_modules/@kwsites/promise-deferred/dist/index.js
var require_dist2 = __commonJS({
  "node_modules/.pnpm/@kwsites+promise-deferred@1.1.1/node_modules/@kwsites/promise-deferred/dist/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.createDeferred = exports.deferred = void 0;
    function deferred2() {
      let done;
      let fail;
      let status = "pending";
      const promise = new Promise((_done, _fail) => {
        done = _done;
        fail = _fail;
      });
      return {
        promise,
        done(result) {
          if (status === "pending") {
            status = "resolved";
            done(result);
          }
        },
        fail(error) {
          if (status === "pending") {
            status = "rejected";
            fail(error);
          }
        },
        get fulfilled() {
          return status !== "pending";
        },
        get status() {
          return status;
        }
      };
    }
    exports.deferred = deferred2;
    exports.createDeferred = deferred2;
    exports.default = deferred2;
  }
});

// node_modules/.pnpm/simple-git@3.33.0/node_modules/simple-git/dist/esm/index.js
import { Buffer as Buffer2 } from "node:buffer";
import { spawn } from "child_process";
import { normalize } from "node:path";
import { EventEmitter } from "node:events";
function pathspec(...paths) {
  const key = new String(paths);
  cache.set(key, paths);
  return key;
}
function isPathSpec(path4) {
  return path4 instanceof String && cache.has(path4);
}
function toPaths(pathSpec) {
  return cache.get(pathSpec) || [];
}
function asFunction(source) {
  if (typeof source !== "function") {
    return NOOP;
  }
  return source;
}
function isUserFunction(source) {
  return typeof source === "function" && source !== NOOP;
}
function splitOn(input, char) {
  const index = input.indexOf(char);
  if (index <= 0) {
    return [input, ""];
  }
  return [input.substr(0, index), input.substr(index + 1)];
}
function first(input, offset = 0) {
  return isArrayLike(input) && input.length > offset ? input[offset] : void 0;
}
function last(input, offset = 0) {
  if (isArrayLike(input) && input.length > offset) {
    return input[input.length - 1 - offset];
  }
}
function isArrayLike(input) {
  return filterHasLength(input);
}
function toLinesWithContent(input = "", trimmed2 = true, separator = "\n") {
  return input.split(separator).reduce((output, line) => {
    const lineContent = trimmed2 ? line.trim() : line;
    if (lineContent) {
      output.push(lineContent);
    }
    return output;
  }, []);
}
function forEachLineWithContent(input, callback) {
  return toLinesWithContent(input, true).map((line) => callback(line));
}
function folderExists(path4) {
  return (0, import_file_exists.exists)(path4, import_file_exists.FOLDER);
}
function append(target, item) {
  if (Array.isArray(target)) {
    if (!target.includes(item)) {
      target.push(item);
    }
  } else {
    target.add(item);
  }
  return item;
}
function including(target, item) {
  if (Array.isArray(target) && !target.includes(item)) {
    target.push(item);
  }
  return target;
}
function remove(target, item) {
  if (Array.isArray(target)) {
    const index = target.indexOf(item);
    if (index >= 0) {
      target.splice(index, 1);
    }
  } else {
    target.delete(item);
  }
  return item;
}
function asArray(source) {
  return Array.isArray(source) ? source : [source];
}
function asCamelCase(str) {
  return str.replace(/[\s-]+(.)/g, (_all, chr) => {
    return chr.toUpperCase();
  });
}
function asStringArray(source) {
  return asArray(source).map((item) => {
    return item instanceof String ? item : String(item);
  });
}
function asNumber(source, onNaN = 0) {
  if (source == null) {
    return onNaN;
  }
  const num = parseInt(source, 10);
  return Number.isNaN(num) ? onNaN : num;
}
function prefixedArray(input, prefix) {
  const output = [];
  for (let i = 0, max = input.length; i < max; i++) {
    output.push(prefix, input[i]);
  }
  return output;
}
function bufferToString(input) {
  return (Array.isArray(input) ? Buffer2.concat(input) : input).toString("utf-8");
}
function pick(source, properties) {
  const out = {};
  properties.forEach((key) => {
    if (source[key] !== void 0) {
      out[key] = source[key];
    }
  });
  return out;
}
function delay(duration = 0) {
  return new Promise((done) => setTimeout(done, duration));
}
function orVoid(input) {
  if (input === false) {
    return void 0;
  }
  return input;
}
function filterType(input, filter, def) {
  if (filter(input)) {
    return input;
  }
  return arguments.length > 2 ? def : void 0;
}
function filterPrimitives(input, omit) {
  const type = isPathSpec(input) ? "string" : typeof input;
  return /number|string|boolean/.test(type) && (!omit || !omit.includes(type));
}
function filterPlainObject(input) {
  return !!input && objectToString(input) === "[object Object]";
}
function filterFunction(input) {
  return typeof input === "function";
}
function useMatchesDefault() {
  throw new Error(`LineParser:useMatches not implemented`);
}
function createInstanceConfig(...options) {
  const baseDir = process.cwd();
  const config = Object.assign(
    { baseDir, ...defaultOptions },
    ...options.filter((o) => typeof o === "object" && o)
  );
  config.baseDir = config.baseDir || baseDir;
  config.trimmed = config.trimmed === true;
  return config;
}
function appendTaskOptions(options, commands = []) {
  if (!filterPlainObject(options)) {
    return commands;
  }
  return Object.keys(options).reduce((commands2, key) => {
    const value = options[key];
    if (isPathSpec(value)) {
      commands2.push(value);
    } else if (filterPrimitives(value, ["boolean"])) {
      commands2.push(key + "=" + value);
    } else if (Array.isArray(value)) {
      for (const v of value) {
        if (!filterPrimitives(v, ["string", "number"])) {
          commands2.push(key + "=" + v);
        }
      }
    } else {
      commands2.push(key);
    }
    return commands2;
  }, commands);
}
function getTrailingOptions(args, initialPrimitive = 0, objectOnly = false) {
  const command = [];
  for (let i = 0, max = initialPrimitive < 0 ? args.length : initialPrimitive; i < max; i++) {
    if ("string|number".includes(typeof args[i])) {
      command.push(String(args[i]));
    }
  }
  appendTaskOptions(trailingOptionsArgument(args), command);
  if (!objectOnly) {
    command.push(...trailingArrayArgument(args));
  }
  return command;
}
function trailingArrayArgument(args) {
  const hasTrailingCallback = typeof last(args) === "function";
  return asStringArray(filterType(last(args, hasTrailingCallback ? 1 : 0), filterArray, []));
}
function trailingOptionsArgument(args) {
  const hasTrailingCallback = filterFunction(last(args));
  return filterType(last(args, hasTrailingCallback ? 1 : 0), filterPlainObject);
}
function trailingFunctionArgument(args, includeNoop = true) {
  const callback = asFunction(last(args));
  return includeNoop || isUserFunction(callback) ? callback : void 0;
}
function callTaskParser(parser4, streams) {
  return parser4(streams.stdOut, streams.stdErr);
}
function parseStringResponse(result, parsers12, texts, trim = true) {
  asArray(texts).forEach((text) => {
    for (let lines = toLinesWithContent(text, trim), i = 0, max = lines.length; i < max; i++) {
      const line = (offset = 0) => {
        if (i + offset >= max) {
          return;
        }
        return lines[i + offset];
      };
      parsers12.some(({ parse }) => parse(line, result));
    }
  });
  return result;
}
function checkIsRepoTask(action) {
  switch (action) {
    case "bare":
      return checkIsBareRepoTask();
    case "root":
      return checkIsRepoRootTask();
  }
  const commands = ["rev-parse", "--is-inside-work-tree"];
  return {
    commands,
    format: "utf-8",
    onError,
    parser
  };
}
function checkIsRepoRootTask() {
  const commands = ["rev-parse", "--git-dir"];
  return {
    commands,
    format: "utf-8",
    onError,
    parser(path4) {
      return /^\.(git)?$/.test(path4.trim());
    }
  };
}
function checkIsBareRepoTask() {
  const commands = ["rev-parse", "--is-bare-repository"];
  return {
    commands,
    format: "utf-8",
    onError,
    parser
  };
}
function isNotRepoMessage(error) {
  return /(Not a git repository|Kein Git-Repository)/i.test(String(error));
}
function cleanSummaryParser(dryRun, text) {
  const summary = new CleanResponse(dryRun);
  const regexp = dryRun ? dryRunRemovalRegexp : removalRegexp;
  toLinesWithContent(text).forEach((line) => {
    const removed = line.replace(regexp, "");
    summary.paths.push(removed);
    (isFolderRegexp.test(removed) ? summary.folders : summary.files).push(removed);
  });
  return summary;
}
function adhocExecTask(parser4) {
  return {
    commands: EMPTY_COMMANDS,
    format: "empty",
    parser: parser4
  };
}
function configurationErrorTask(error) {
  return {
    commands: EMPTY_COMMANDS,
    format: "empty",
    parser() {
      throw typeof error === "string" ? new TaskConfigurationError(error) : error;
    }
  };
}
function straightThroughStringTask(commands, trimmed2 = false) {
  return {
    commands,
    format: "utf-8",
    parser(text) {
      return trimmed2 ? String(text).trim() : text;
    }
  };
}
function straightThroughBufferTask(commands) {
  return {
    commands,
    format: "buffer",
    parser(buffer) {
      return buffer;
    }
  };
}
function isBufferTask(task) {
  return task.format === "buffer";
}
function isEmptyTask(task) {
  return task.format === "empty" || !task.commands.length;
}
function cleanWithOptionsTask(mode, customArgs) {
  const { cleanMode, options, valid } = getCleanOptions(mode);
  if (!cleanMode) {
    return configurationErrorTask(CONFIG_ERROR_MODE_REQUIRED);
  }
  if (!valid.options) {
    return configurationErrorTask(CONFIG_ERROR_UNKNOWN_OPTION + JSON.stringify(mode));
  }
  options.push(...customArgs);
  if (options.some(isInteractiveMode)) {
    return configurationErrorTask(CONFIG_ERROR_INTERACTIVE_MODE);
  }
  return cleanTask(cleanMode, options);
}
function cleanTask(mode, customArgs) {
  const commands = ["clean", `-${mode}`, ...customArgs];
  return {
    commands,
    format: "utf-8",
    parser(text) {
      return cleanSummaryParser(mode === "n", text);
    }
  };
}
function isCleanOptionsArray(input) {
  return Array.isArray(input) && input.every((test) => CleanOptionValues.has(test));
}
function getCleanOptions(input) {
  let cleanMode;
  let options = [];
  let valid = { cleanMode: false, options: true };
  input.replace(/[^a-z]i/g, "").split("").forEach((char) => {
    if (isCleanMode(char)) {
      cleanMode = char;
      valid.cleanMode = true;
    } else {
      valid.options = valid.options && isKnownOption(options[options.length] = `-${char}`);
    }
  });
  return {
    cleanMode,
    options,
    valid
  };
}
function isCleanMode(cleanMode) {
  return cleanMode === "f" || cleanMode === "n";
}
function isKnownOption(option) {
  return /^-[a-z]$/i.test(option) && CleanOptionValues.has(option.charAt(1));
}
function isInteractiveMode(option) {
  if (/^-[^\-]/.test(option)) {
    return option.indexOf("i") > 0;
  }
  return option === "--interactive";
}
function configListParser(text) {
  const config = new ConfigList();
  for (const item of configParser(text)) {
    config.addValue(item.file, String(item.key), item.value);
  }
  return config;
}
function configGetParser(text, key) {
  let value = null;
  const values = [];
  const scopes = /* @__PURE__ */ new Map();
  for (const item of configParser(text, key)) {
    if (item.key !== key) {
      continue;
    }
    values.push(value = item.value);
    if (!scopes.has(item.file)) {
      scopes.set(item.file, []);
    }
    scopes.get(item.file).push(value);
  }
  return {
    key,
    paths: Array.from(scopes.keys()),
    scopes,
    value,
    values
  };
}
function configFilePath(filePath) {
  return filePath.replace(/^(file):/, "");
}
function* configParser(text, requestedKey = null) {
  const lines = text.split("\0");
  for (let i = 0, max = lines.length - 1; i < max; ) {
    const file = configFilePath(lines[i++]);
    let value = lines[i++];
    let key = requestedKey;
    if (value.includes("\n")) {
      const line = splitOn(value, "\n");
      key = line[0];
      value = line[1];
    }
    yield { file, key, value };
  }
}
function asConfigScope(scope, fallback) {
  if (typeof scope === "string" && Object.hasOwn(GitConfigScope, scope)) {
    return scope;
  }
  return fallback;
}
function addConfigTask(key, value, append2, scope) {
  const commands = ["config", `--${scope}`];
  if (append2) {
    commands.push("--add");
  }
  commands.push(key, value);
  return {
    commands,
    format: "utf-8",
    parser(text) {
      return text;
    }
  };
}
function getConfigTask(key, scope) {
  const commands = ["config", "--null", "--show-origin", "--get-all", key];
  if (scope) {
    commands.splice(1, 0, `--${scope}`);
  }
  return {
    commands,
    format: "utf-8",
    parser(text) {
      return configGetParser(text, key);
    }
  };
}
function listConfigTask(scope) {
  const commands = ["config", "--list", "--show-origin", "--null"];
  if (scope) {
    commands.push(`--${scope}`);
  }
  return {
    commands,
    format: "utf-8",
    parser(text) {
      return configListParser(text);
    }
  };
}
function config_default() {
  return {
    addConfig(key, value, ...rest) {
      return this._runTask(
        addConfigTask(
          key,
          value,
          rest[0] === true,
          asConfigScope(
            rest[1],
            "local"
            /* local */
          )
        ),
        trailingFunctionArgument(arguments)
      );
    },
    getConfig(key, scope) {
      return this._runTask(
        getConfigTask(key, asConfigScope(scope, void 0)),
        trailingFunctionArgument(arguments)
      );
    },
    listConfig(...rest) {
      return this._runTask(
        listConfigTask(asConfigScope(rest[0], void 0)),
        trailingFunctionArgument(arguments)
      );
    }
  };
}
function isDiffNameStatus(input) {
  return diffNameStatus.has(input);
}
function grepQueryBuilder(...params) {
  return new GrepQuery().param(...params);
}
function parseGrep(grep) {
  const paths = /* @__PURE__ */ new Set();
  const results = {};
  forEachLineWithContent(grep, (input) => {
    const [path4, line, preview] = input.split(NULL);
    paths.add(path4);
    (results[path4] = results[path4] || []).push({
      line: asNumber(line),
      path: path4,
      preview
    });
  });
  return {
    paths,
    results
  };
}
function grep_default() {
  return {
    grep(searchTerm) {
      const then = trailingFunctionArgument(arguments);
      const options = getTrailingOptions(arguments);
      for (const option of disallowedOptions) {
        if (options.includes(option)) {
          return this._runTask(
            configurationErrorTask(`git.grep: use of "${option}" is not supported.`),
            then
          );
        }
      }
      if (typeof searchTerm === "string") {
        searchTerm = grepQueryBuilder().param(searchTerm);
      }
      const commands = ["grep", "--null", "-n", "--full-name", ...options, ...searchTerm];
      return this._runTask(
        {
          commands,
          format: "utf-8",
          parser(stdOut) {
            return parseGrep(stdOut);
          }
        },
        then
      );
    }
  };
}
function resetTask(mode, customArgs) {
  const commands = ["reset"];
  if (isValidResetMode(mode)) {
    commands.push(`--${mode}`);
  }
  commands.push(...customArgs);
  return straightThroughStringTask(commands);
}
function getResetMode(mode) {
  if (isValidResetMode(mode)) {
    return mode;
  }
  switch (typeof mode) {
    case "string":
    case "undefined":
      return "soft";
  }
  return;
}
function isValidResetMode(mode) {
  return typeof mode === "string" && validResetModes.includes(mode);
}
function createLog() {
  return (0, import_debug.default)("simple-git");
}
function prefixedLogger(to, prefix, forward) {
  if (!prefix || !String(prefix).replace(/\s*/, "")) {
    return !forward ? to : (message, ...args) => {
      to(message, ...args);
      forward(message, ...args);
    };
  }
  return (message, ...args) => {
    to(`%s ${message}`, prefix, ...args);
    if (forward) {
      forward(message, ...args);
    }
  };
}
function childLoggerName(name, childDebugger, { namespace: parentNamespace }) {
  if (typeof name === "string") {
    return name;
  }
  const childNamespace = childDebugger && childDebugger.namespace || "";
  if (childNamespace.startsWith(parentNamespace)) {
    return childNamespace.substr(parentNamespace.length + 1);
  }
  return childNamespace || parentNamespace;
}
function createLogger(label, verbose, initialStep, infoDebugger = createLog()) {
  const labelPrefix = label && `[${label}]` || "";
  const spawned = [];
  const debugDebugger = typeof verbose === "string" ? infoDebugger.extend(verbose) : verbose;
  const key = childLoggerName(filterType(verbose, filterString), debugDebugger, infoDebugger);
  return step(initialStep);
  function sibling(name, initial) {
    return append(
      spawned,
      createLogger(label, key.replace(/^[^:]+/, name), initial, infoDebugger)
    );
  }
  function step(phase) {
    const stepPrefix = phase && `[${phase}]` || "";
    const debug2 = debugDebugger && prefixedLogger(debugDebugger, stepPrefix) || NOOP;
    const info = prefixedLogger(infoDebugger, `${labelPrefix} ${stepPrefix}`, debug2);
    return Object.assign(debugDebugger ? debug2 : info, {
      label,
      sibling,
      info,
      step
    });
  }
}
function pluginContext(task, commands) {
  return {
    method: first(task.commands) || "",
    commands
  };
}
function onErrorReceived(target, logger) {
  return (err) => {
    logger(`[ERROR] child process exception %o`, err);
    target.push(Buffer.from(String(err.stack), "ascii"));
  };
}
function onDataReceived(target, name, logger, output) {
  return (buffer) => {
    logger(`%s received %L bytes`, name, buffer);
    output(`%B`, buffer);
    target.push(buffer);
  };
}
function taskCallback(task, response, callback = NOOP) {
  const onSuccess = (data) => {
    callback(null, data);
  };
  const onError2 = (err) => {
    if (err?.task === task) {
      callback(
        err instanceof GitResponseError ? addDeprecationNoticeToError(err) : err,
        void 0
      );
    }
  };
  response.then(onSuccess, onError2);
}
function addDeprecationNoticeToError(err) {
  let log = (name) => {
    console.warn(
      `simple-git deprecation notice: accessing GitResponseError.${name} should be GitResponseError.git.${name}, this will no longer be available in version 3`
    );
    log = NOOP;
  };
  return Object.create(err, Object.getOwnPropertyNames(err.git).reduce(descriptorReducer, {}));
  function descriptorReducer(all, name) {
    if (name in err) {
      return all;
    }
    all[name] = {
      enumerable: false,
      configurable: false,
      get() {
        log(name);
        return err.git[name];
      }
    };
    return all;
  }
}
function changeWorkingDirectoryTask(directory, root) {
  return adhocExecTask((instance) => {
    if (!folderExists(directory)) {
      throw new Error(`Git.cwd: cannot change to non-directory "${directory}"`);
    }
    return (root || instance).cwd = directory;
  });
}
function checkoutTask(args) {
  const commands = ["checkout", ...args];
  if (commands[1] === "-b" && commands.includes("-B")) {
    commands[1] = remove(commands, "-B");
  }
  return straightThroughStringTask(commands);
}
function checkout_default() {
  return {
    checkout() {
      return this._runTask(
        checkoutTask(getTrailingOptions(arguments, 1)),
        trailingFunctionArgument(arguments)
      );
    },
    checkoutBranch(branchName, startPoint) {
      return this._runTask(
        checkoutTask(["-b", branchName, startPoint, ...getTrailingOptions(arguments)]),
        trailingFunctionArgument(arguments)
      );
    },
    checkoutLocalBranch(branchName) {
      return this._runTask(
        checkoutTask(["-b", branchName, ...getTrailingOptions(arguments)]),
        trailingFunctionArgument(arguments)
      );
    }
  };
}
function countObjectsResponse() {
  return {
    count: 0,
    garbage: 0,
    inPack: 0,
    packs: 0,
    prunePackable: 0,
    size: 0,
    sizeGarbage: 0,
    sizePack: 0
  };
}
function count_objects_default() {
  return {
    countObjects() {
      return this._runTask({
        commands: ["count-objects", "--verbose"],
        format: "utf-8",
        parser(stdOut) {
          return parseStringResponse(countObjectsResponse(), [parser2], stdOut);
        }
      });
    }
  };
}
function parseCommitResult(stdOut) {
  const result = {
    author: null,
    branch: "",
    commit: "",
    root: false,
    summary: {
      changes: 0,
      insertions: 0,
      deletions: 0
    }
  };
  return parseStringResponse(result, parsers, stdOut);
}
function commitTask(message, files, customArgs) {
  const commands = [
    "-c",
    "core.abbrev=40",
    "commit",
    ...prefixedArray(message, "-m"),
    ...files,
    ...customArgs
  ];
  return {
    commands,
    format: "utf-8",
    parser: parseCommitResult
  };
}
function commit_default() {
  return {
    commit(message, ...rest) {
      const next = trailingFunctionArgument(arguments);
      const task = rejectDeprecatedSignatures(message) || commitTask(
        asArray(message),
        asArray(filterType(rest[0], filterStringOrStringArray, [])),
        [
          ...asStringArray(filterType(rest[1], filterArray, [])),
          ...getTrailingOptions(arguments, 0, true)
        ]
      );
      return this._runTask(task, next);
    }
  };
  function rejectDeprecatedSignatures(message) {
    return !filterStringOrStringArray(message) && configurationErrorTask(
      `git.commit: requires the commit message to be supplied as a string/string[]`
    );
  }
}
function first_commit_default() {
  return {
    firstCommit() {
      return this._runTask(
        straightThroughStringTask(["rev-list", "--max-parents=0", "HEAD"], true),
        trailingFunctionArgument(arguments)
      );
    }
  };
}
function hashObjectTask(filePath, write) {
  const commands = ["hash-object", filePath];
  if (write) {
    commands.push("-w");
  }
  return straightThroughStringTask(commands, true);
}
function parseInit(bare, path4, text) {
  const response = String(text).trim();
  let result;
  if (result = initResponseRegex.exec(response)) {
    return new InitSummary(bare, path4, false, result[1]);
  }
  if (result = reInitResponseRegex.exec(response)) {
    return new InitSummary(bare, path4, true, result[1]);
  }
  let gitDir = "";
  const tokens = response.split(" ");
  while (tokens.length) {
    const token = tokens.shift();
    if (token === "in") {
      gitDir = tokens.join(" ");
      break;
    }
  }
  return new InitSummary(bare, path4, /^re/i.test(response), gitDir);
}
function hasBareCommand(command) {
  return command.includes(bareCommand);
}
function initTask(bare = false, path4, customArgs) {
  const commands = ["init", ...customArgs];
  if (bare && !hasBareCommand(commands)) {
    commands.splice(1, 0, bareCommand);
  }
  return {
    commands,
    format: "utf-8",
    parser(text) {
      return parseInit(commands.includes("--bare"), path4, text);
    }
  };
}
function logFormatFromCommand(customArgs) {
  for (let i = 0; i < customArgs.length; i++) {
    const format = logFormatRegex.exec(customArgs[i]);
    if (format) {
      return `--${format[1]}`;
    }
  }
  return "";
}
function isLogFormat(customArg) {
  return logFormatRegex.test(customArg);
}
function getDiffParser(format = "") {
  const parser4 = diffSummaryParsers[format];
  return (stdOut) => parseStringResponse(new DiffSummary(), parser4, stdOut, false);
}
function lineBuilder(tokens, fields) {
  return fields.reduce(
    (line, field, index) => {
      line[field] = tokens[index] || "";
      return line;
    },
    /* @__PURE__ */ Object.create({ diff: null })
  );
}
function createListLogSummaryParser(splitter = SPLITTER, fields = defaultFieldNames, logFormat = "") {
  const parseDiffResult = getDiffParser(logFormat);
  return function(stdOut) {
    const all = toLinesWithContent(
      stdOut.trim(),
      false,
      START_BOUNDARY
    ).map(function(item) {
      const lineDetail = item.split(COMMIT_BOUNDARY);
      const listLogLine = lineBuilder(lineDetail[0].split(splitter), fields);
      if (lineDetail.length > 1 && !!lineDetail[1].trim()) {
        listLogLine.diff = parseDiffResult(lineDetail[1]);
      }
      return listLogLine;
    });
    return {
      all,
      latest: all.length && all[0] || null,
      total: all.length
    };
  };
}
function diffSummaryTask(customArgs) {
  let logFormat = logFormatFromCommand(customArgs);
  const commands = ["diff"];
  if (logFormat === "") {
    logFormat = "--stat";
    commands.push("--stat=4096");
  }
  commands.push(...customArgs);
  return validateLogFormatConfig(commands) || {
    commands,
    format: "utf-8",
    parser: getDiffParser(logFormat)
  };
}
function validateLogFormatConfig(customArgs) {
  const flags = customArgs.filter(isLogFormat);
  if (flags.length > 1) {
    return configurationErrorTask(
      `Summary flags are mutually exclusive - pick one of ${flags.join(",")}`
    );
  }
  if (flags.length && customArgs.includes("-z")) {
    return configurationErrorTask(
      `Summary flag ${flags} parsing is not compatible with null termination option '-z'`
    );
  }
}
function prettyFormat(format, splitter) {
  const fields = [];
  const formatStr = [];
  Object.keys(format).forEach((field) => {
    fields.push(field);
    formatStr.push(String(format[field]));
  });
  return [fields, formatStr.join(splitter)];
}
function userOptions(input) {
  return Object.keys(input).reduce((out, key) => {
    if (!(key in excludeOptions)) {
      out[key] = input[key];
    }
    return out;
  }, {});
}
function parseLogOptions(opt = {}, customArgs = []) {
  const splitter = filterType(opt.splitter, filterString, SPLITTER);
  const format = filterPlainObject(opt.format) ? opt.format : {
    hash: "%H",
    date: opt.strictDate === false ? "%ai" : "%aI",
    message: "%s",
    refs: "%D",
    body: opt.multiLine ? "%B" : "%b",
    author_name: opt.mailMap !== false ? "%aN" : "%an",
    author_email: opt.mailMap !== false ? "%aE" : "%ae"
  };
  const [fields, formatStr] = prettyFormat(format, splitter);
  const suffix = [];
  const command = [
    `--pretty=format:${START_BOUNDARY}${formatStr}${COMMIT_BOUNDARY}`,
    ...customArgs
  ];
  const maxCount = opt.n || opt["max-count"] || opt.maxCount;
  if (maxCount) {
    command.push(`--max-count=${maxCount}`);
  }
  if (opt.from || opt.to) {
    const rangeOperator = opt.symmetric !== false ? "..." : "..";
    suffix.push(`${opt.from || ""}${rangeOperator}${opt.to || ""}`);
  }
  if (filterString(opt.file)) {
    command.push("--follow", pathspec(opt.file));
  }
  appendTaskOptions(userOptions(opt), command);
  return {
    fields,
    splitter,
    commands: [...command, ...suffix]
  };
}
function logTask(splitter, fields, customArgs) {
  const parser4 = createListLogSummaryParser(splitter, fields, logFormatFromCommand(customArgs));
  return {
    commands: ["log", ...customArgs],
    format: "utf-8",
    parser: parser4
  };
}
function log_default() {
  return {
    log(...rest) {
      const next = trailingFunctionArgument(arguments);
      const options = parseLogOptions(
        trailingOptionsArgument(arguments),
        asStringArray(filterType(arguments[0], filterArray, []))
      );
      const task = rejectDeprecatedSignatures(...rest) || validateLogFormatConfig(options.commands) || createLogTask(options);
      return this._runTask(task, next);
    }
  };
  function createLogTask(options) {
    return logTask(options.splitter, options.fields, options.commands);
  }
  function rejectDeprecatedSignatures(from, to) {
    return filterString(from) && filterString(to) && configurationErrorTask(
      `git.log(string, string) should be replaced with git.log({ from: string, to: string })`
    );
  }
}
function objectEnumerationResult(remoteMessages) {
  return remoteMessages.objects = remoteMessages.objects || {
    compressing: 0,
    counting: 0,
    enumerating: 0,
    packReused: 0,
    reused: { count: 0, delta: 0 },
    total: { count: 0, delta: 0 }
  };
}
function asObjectCount(source) {
  const count = /^\s*(\d+)/.exec(source);
  const delta = /delta (\d+)/i.exec(source);
  return {
    count: asNumber(count && count[1] || "0"),
    delta: asNumber(delta && delta[1] || "0")
  };
}
function parseRemoteMessages(_stdOut, stdErr) {
  return parseStringResponse({ remoteMessages: new RemoteMessageSummary() }, parsers2, stdErr);
}
function parsePullErrorResult(stdOut, stdErr) {
  const pullError = parseStringResponse(new PullFailedSummary(), errorParsers, [stdOut, stdErr]);
  return pullError.message && pullError;
}
function mergeTask(customArgs) {
  if (!customArgs.length) {
    return configurationErrorTask("Git.merge requires at least one option");
  }
  return {
    commands: ["merge", ...customArgs],
    format: "utf-8",
    parser(stdOut, stdErr) {
      const merge = parseMergeResult(stdOut, stdErr);
      if (merge.failed) {
        throw new GitResponseError(merge);
      }
      return merge;
    }
  };
}
function pushResultPushedItem(local, remote, status) {
  const deleted = status.includes("deleted");
  const tag = status.includes("tag") || /^refs\/tags/.test(local);
  const alreadyUpdated = !status.includes("new");
  return {
    deleted,
    tag,
    branch: !tag,
    new: !alreadyUpdated,
    alreadyUpdated,
    local,
    remote
  };
}
function pushTagsTask(ref = {}, customArgs) {
  append(customArgs, "--tags");
  return pushTask(ref, customArgs);
}
function pushTask(ref = {}, customArgs) {
  const commands = ["push", ...customArgs];
  if (ref.branch) {
    commands.splice(1, 0, ref.branch);
  }
  if (ref.remote) {
    commands.splice(1, 0, ref.remote);
  }
  remove(commands, "-v");
  append(commands, "--verbose");
  append(commands, "--porcelain");
  return {
    commands,
    format: "utf-8",
    parser: parsePushResult
  };
}
function show_default() {
  return {
    showBuffer() {
      const commands = ["show", ...getTrailingOptions(arguments, 1)];
      if (!commands.includes("--binary")) {
        commands.splice(1, 0, "--binary");
      }
      return this._runTask(
        straightThroughBufferTask(commands),
        trailingFunctionArgument(arguments)
      );
    },
    show() {
      const commands = ["show", ...getTrailingOptions(arguments, 1)];
      return this._runTask(
        straightThroughStringTask(commands),
        trailingFunctionArgument(arguments)
      );
    }
  };
}
function renamedFile(line) {
  const [to, from] = line.split(NULL);
  return {
    from: from || to,
    to
  };
}
function parser3(indexX, indexY, handler) {
  return [`${indexX}${indexY}`, handler];
}
function conflicts(indexX, ...indexY) {
  return indexY.map((y) => parser3(indexX, y, (result, file) => result.conflicted.push(file)));
}
function splitLine(result, lineStr) {
  const trimmed2 = lineStr.trim();
  switch (" ") {
    case trimmed2.charAt(2):
      return data(trimmed2.charAt(0), trimmed2.charAt(1), trimmed2.slice(3));
    case trimmed2.charAt(1):
      return data(" ", trimmed2.charAt(0), trimmed2.slice(2));
    default:
      return;
  }
  function data(index, workingDir, path4) {
    const raw = `${index}${workingDir}`;
    const handler = parsers6.get(raw);
    if (handler) {
      handler(result, path4);
    }
    if (raw !== "##" && raw !== "!!") {
      result.files.push(new FileStatusSummary(path4, index, workingDir));
    }
  }
}
function statusTask(customArgs) {
  const commands = [
    "status",
    "--porcelain",
    "-b",
    "-u",
    "--null",
    ...customArgs.filter((arg) => !ignoredOptions.includes(arg))
  ];
  return {
    format: "utf-8",
    commands,
    parser(text) {
      return parseStatusSummary(text);
    }
  };
}
function versionResponse(major = 0, minor = 0, patch = 0, agent = "", installed = true) {
  return Object.defineProperty(
    {
      major,
      minor,
      patch,
      agent,
      installed
    },
    "toString",
    {
      value() {
        return `${this.major}.${this.minor}.${this.patch}`;
      },
      configurable: false,
      enumerable: false
    }
  );
}
function notInstalledResponse() {
  return versionResponse(0, 0, 0, "", false);
}
function version_default() {
  return {
    version() {
      return this._runTask({
        commands: ["--version"],
        format: "utf-8",
        parser: versionParser,
        onError(result, error, done, fail) {
          if (result.exitCode === -2) {
            return done(Buffer.from(NOT_INSTALLED));
          }
          fail(error);
        }
      });
    }
  };
}
function versionParser(stdOut) {
  if (stdOut === NOT_INSTALLED) {
    return notInstalledResponse();
  }
  return parseStringResponse(versionResponse(0, 0, 0, stdOut), parsers7, stdOut);
}
function createCloneTask(api, task, repoPath, ...args) {
  if (!filterString(repoPath)) {
    return configurationErrorTask(`git.${api}() requires a string 'repoPath'`);
  }
  return task(repoPath, filterType(args[0], filterString), getTrailingOptions(arguments));
}
function clone_default() {
  return {
    clone(repo, ...rest) {
      return this._runTask(
        createCloneTask("clone", cloneTask, filterType(repo, filterString), ...rest),
        trailingFunctionArgument(arguments)
      );
    },
    mirror(repo, ...rest) {
      return this._runTask(
        createCloneTask("mirror", cloneMirrorTask, filterType(repo, filterString), ...rest),
        trailingFunctionArgument(arguments)
      );
    }
  };
}
function applyPatchTask(patches, customArgs) {
  return straightThroughStringTask(["apply", ...customArgs, ...patches]);
}
function branchDeletionSuccess(branch, hash) {
  return {
    branch,
    hash,
    success: true
  };
}
function branchDeletionFailure(branch) {
  return {
    branch,
    hash: null,
    success: false
  };
}
function hasBranchDeletionError(data, processExitCode) {
  return processExitCode === 1 && deleteErrorRegex.test(data);
}
function branchStatus(input) {
  return input ? input.charAt(0) : "";
}
function parseBranchSummary(stdOut, currentOnly = false) {
  return parseStringResponse(
    new BranchSummaryResult(),
    currentOnly ? [currentBranchParser] : parsers9,
    stdOut
  );
}
function containsDeleteBranchCommand(commands) {
  const deleteCommands = ["-d", "-D", "--delete"];
  return commands.some((command) => deleteCommands.includes(command));
}
function branchTask(customArgs) {
  const isDelete = containsDeleteBranchCommand(customArgs);
  const isCurrentOnly = customArgs.includes("--show-current");
  const commands = ["branch", ...customArgs];
  if (commands.length === 1) {
    commands.push("-a");
  }
  if (!commands.includes("-v")) {
    commands.splice(1, 0, "-v");
  }
  return {
    format: "utf-8",
    commands,
    parser(stdOut, stdErr) {
      if (isDelete) {
        return parseBranchDeletions(stdOut, stdErr).all[0];
      }
      return parseBranchSummary(stdOut, isCurrentOnly);
    }
  };
}
function branchLocalTask() {
  return {
    format: "utf-8",
    commands: ["branch", "-v"],
    parser(stdOut) {
      return parseBranchSummary(stdOut);
    }
  };
}
function deleteBranchesTask(branches, forceDelete = false) {
  return {
    format: "utf-8",
    commands: ["branch", "-v", forceDelete ? "-D" : "-d", ...branches],
    parser(stdOut, stdErr) {
      return parseBranchDeletions(stdOut, stdErr);
    },
    onError({ exitCode, stdOut }, error, done, fail) {
      if (!hasBranchDeletionError(String(error), exitCode)) {
        return fail(error);
      }
      done(stdOut);
    }
  };
}
function deleteBranchTask(branch, forceDelete = false) {
  const task = {
    format: "utf-8",
    commands: ["branch", "-v", forceDelete ? "-D" : "-d", branch],
    parser(stdOut, stdErr) {
      return parseBranchDeletions(stdOut, stdErr).branches[branch];
    },
    onError({ exitCode, stdErr, stdOut }, error, _, fail) {
      if (!hasBranchDeletionError(String(error), exitCode)) {
        return fail(error);
      }
      throw new GitResponseError(
        task.parser(bufferToString(stdOut), bufferToString(stdErr)),
        String(error)
      );
    }
  };
  return task;
}
function toPath(input) {
  const path4 = input.trim().replace(/^["']|["']$/g, "");
  return path4 && normalize(path4);
}
function checkIgnoreTask(paths) {
  return {
    commands: ["check-ignore", ...paths],
    format: "utf-8",
    parser: parseCheckIgnore
  };
}
function parseFetchResult(stdOut, stdErr) {
  const result = {
    raw: stdOut,
    remote: null,
    branches: [],
    tags: [],
    updated: [],
    deleted: []
  };
  return parseStringResponse(result, parsers10, [stdOut, stdErr]);
}
function disallowedCommand(command) {
  return /^--upload-pack(=|$)/.test(command);
}
function fetchTask(remote, branch, customArgs) {
  const commands = ["fetch", ...customArgs];
  if (remote && branch) {
    commands.push(remote, branch);
  }
  const banned = commands.find(disallowedCommand);
  if (banned) {
    return configurationErrorTask(`git.fetch: potential exploit argument blocked.`);
  }
  return {
    commands,
    format: "utf-8",
    parser: parseFetchResult
  };
}
function parseMoveResult(stdOut) {
  return parseStringResponse({ moves: [] }, parsers11, stdOut);
}
function moveTask(from, to) {
  return {
    commands: ["mv", "-v", ...asArray(from), to],
    format: "utf-8",
    parser: parseMoveResult
  };
}
function pullTask(remote, branch, customArgs) {
  const commands = ["pull", ...customArgs];
  if (remote && branch) {
    commands.splice(1, 0, remote, branch);
  }
  return {
    commands,
    format: "utf-8",
    parser(stdOut, stdErr) {
      return parsePullResult(stdOut, stdErr);
    },
    onError(result, _error, _done, fail) {
      const pullError = parsePullErrorResult(
        bufferToString(result.stdOut),
        bufferToString(result.stdErr)
      );
      if (pullError) {
        return fail(new GitResponseError(pullError));
      }
      fail(_error);
    }
  };
}
function parseGetRemotes(text) {
  const remotes = {};
  forEach(text, ([name]) => remotes[name] = { name });
  return Object.values(remotes);
}
function parseGetRemotesVerbose(text) {
  const remotes = {};
  forEach(text, ([name, url, purpose]) => {
    if (!Object.hasOwn(remotes, name)) {
      remotes[name] = {
        name,
        refs: { fetch: "", push: "" }
      };
    }
    if (purpose && url) {
      remotes[name].refs[purpose.replace(/[^a-z]/g, "")] = url;
    }
  });
  return Object.values(remotes);
}
function forEach(text, handler) {
  forEachLineWithContent(text, (line) => handler(line.split(/\s+/)));
}
function addRemoteTask(remoteName, remoteRepo, customArgs) {
  return straightThroughStringTask(["remote", "add", ...customArgs, remoteName, remoteRepo]);
}
function getRemotesTask(verbose) {
  const commands = ["remote"];
  if (verbose) {
    commands.push("-v");
  }
  return {
    commands,
    format: "utf-8",
    parser: verbose ? parseGetRemotesVerbose : parseGetRemotes
  };
}
function listRemotesTask(customArgs) {
  const commands = [...customArgs];
  if (commands[0] !== "ls-remote") {
    commands.unshift("ls-remote");
  }
  return straightThroughStringTask(commands);
}
function remoteTask(customArgs) {
  const commands = [...customArgs];
  if (commands[0] !== "remote") {
    commands.unshift("remote");
  }
  return straightThroughStringTask(commands);
}
function removeRemoteTask(remoteName) {
  return straightThroughStringTask(["remote", "remove", remoteName]);
}
function stashListTask(opt = {}, customArgs) {
  const options = parseLogOptions(opt);
  const commands = ["stash", "list", ...options.commands, ...customArgs];
  const parser4 = createListLogSummaryParser(
    options.splitter,
    options.fields,
    logFormatFromCommand(commands)
  );
  return validateLogFormatConfig(commands) || {
    commands,
    format: "utf-8",
    parser: parser4
  };
}
function addSubModuleTask(repo, path4) {
  return subModuleTask(["add", repo, path4]);
}
function initSubModuleTask(customArgs) {
  return subModuleTask(["init", ...customArgs]);
}
function subModuleTask(customArgs) {
  const commands = [...customArgs];
  if (commands[0] !== "submodule") {
    commands.unshift("submodule");
  }
  return straightThroughStringTask(commands);
}
function updateSubModuleTask(customArgs) {
  return subModuleTask(["update", ...customArgs]);
}
function singleSorted(a, b) {
  const aIsNum = Number.isNaN(a);
  const bIsNum = Number.isNaN(b);
  if (aIsNum !== bIsNum) {
    return aIsNum ? 1 : -1;
  }
  return aIsNum ? sorted(a, b) : 0;
}
function sorted(a, b) {
  return a === b ? 0 : a > b ? 1 : -1;
}
function trimmed(input) {
  return input.trim();
}
function toNumber(input) {
  if (typeof input === "string") {
    return parseInt(input.replace(/^\D+/g, ""), 10) || 0;
  }
  return 0;
}
function tagListTask(customArgs = []) {
  const hasCustomSort = customArgs.some((option) => /^--sort=/.test(option));
  return {
    format: "utf-8",
    commands: ["tag", "-l", ...customArgs],
    parser(text) {
      return parseTagList(text, hasCustomSort);
    }
  };
}
function addTagTask(name) {
  return {
    format: "utf-8",
    commands: ["tag", name],
    parser() {
      return { name };
    }
  };
}
function addAnnotatedTagTask(name, tagMessage) {
  return {
    format: "utf-8",
    commands: ["tag", "-a", "-m", tagMessage, name],
    parser() {
      return { name };
    }
  };
}
function abortPlugin(signal) {
  if (!signal) {
    return;
  }
  const onSpawnAfter = {
    type: "spawn.after",
    action(_data, context) {
      function kill() {
        context.kill(new GitPluginError(void 0, "abort", "Abort signal received"));
      }
      signal.addEventListener("abort", kill);
      context.spawned.on("close", () => signal.removeEventListener("abort", kill));
    }
  };
  const onSpawnBefore = {
    type: "spawn.before",
    action(_data, context) {
      if (signal.aborted) {
        context.kill(new GitPluginError(void 0, "abort", "Abort already signaled"));
      }
    }
  };
  return [onSpawnBefore, onSpawnAfter];
}
function isConfigSwitch(arg) {
  return typeof arg === "string" && arg.trim().toLowerCase() === "-c";
}
function isCloneUploadPackSwitch(char, arg) {
  if (typeof arg !== "string" || !arg.includes(char)) {
    return false;
  }
  const cleaned = arg.trim().replace(/\0/g, "");
  return /^(--no)?-{1,2}[\dlsqvnobucj]+(\s|$)/.test(cleaned);
}
function preventConfigBuilder(config, setting, message = String(config)) {
  const regex = typeof config === "string" ? new RegExp(`\\s*${config}`, "i") : config;
  return function preventCommand(options, arg, next) {
    if (options[setting] !== true && isConfigSwitch(arg) && regex.test(next)) {
      throw new GitPluginError(
        void 0,
        "unsafe",
        `Configuring ${message} is not permitted without enabling ${setting}`
      );
    }
  };
}
function preventUploadPack(arg, method) {
  if (/^\s*--(upload|receive)-pack/.test(arg)) {
    throw new GitPluginError(
      void 0,
      "unsafe",
      `Use of --upload-pack or --receive-pack is not permitted without enabling allowUnsafePack`
    );
  }
  if (method === "clone" && isCloneUploadPackSwitch("u", arg)) {
    throw new GitPluginError(
      void 0,
      "unsafe",
      `Use of clone with option -u is not permitted without enabling allowUnsafePack`
    );
  }
  if (method === "push" && /^\s*--exec\b/.test(arg)) {
    throw new GitPluginError(
      void 0,
      "unsafe",
      `Use of push with option --exec is not permitted without enabling allowUnsafePack`
    );
  }
}
function blockUnsafeOperationsPlugin({
  allowUnsafePack = false,
  ...options
} = {}) {
  return {
    type: "spawn.args",
    action(args, context) {
      args.forEach((current, index) => {
        const next = index < args.length ? args[index + 1] : "";
        allowUnsafePack || preventUploadPack(current, context.method);
        preventUnsafeConfig.forEach((helper) => helper(options, current, next));
      });
      return args;
    }
  };
}
function commandConfigPrefixingPlugin(configuration) {
  const prefix = prefixedArray(configuration, "-c");
  return {
    type: "spawn.args",
    action(data) {
      return [...prefix, ...data];
    }
  };
}
function completionDetectionPlugin({
  onClose = true,
  onExit = 50
} = {}) {
  function createEvents() {
    let exitCode = -1;
    const events = {
      close: (0, import_promise_deferred2.deferred)(),
      closeTimeout: (0, import_promise_deferred2.deferred)(),
      exit: (0, import_promise_deferred2.deferred)(),
      exitTimeout: (0, import_promise_deferred2.deferred)()
    };
    const result = Promise.race([
      onClose === false ? never : events.closeTimeout.promise,
      onExit === false ? never : events.exitTimeout.promise
    ]);
    configureTimeout(onClose, events.close, events.closeTimeout);
    configureTimeout(onExit, events.exit, events.exitTimeout);
    return {
      close(code) {
        exitCode = code;
        events.close.done();
      },
      exit(code) {
        exitCode = code;
        events.exit.done();
      },
      get exitCode() {
        return exitCode;
      },
      result
    };
  }
  function configureTimeout(flag, event, timeout) {
    if (flag === false) {
      return;
    }
    (flag === true ? event.promise : event.promise.then(() => delay(flag))).then(timeout.done);
  }
  return {
    type: "spawn.after",
    async action(_data, { spawned, close }) {
      const events = createEvents();
      let deferClose = true;
      let quickClose = () => void (deferClose = false);
      spawned.stdout?.on("data", quickClose);
      spawned.stderr?.on("data", quickClose);
      spawned.on("error", quickClose);
      spawned.on("close", (code) => events.close(code));
      spawned.on("exit", (code) => events.exit(code));
      try {
        await events.result;
        if (deferClose) {
          await delay(50);
        }
        close(events.exitCode);
      } catch (err) {
        close(events.exitCode, err);
      }
    }
  };
}
function isBadArgument(arg) {
  return !arg || !/^([a-z]:)?([a-z0-9/.\\_~-]+)$/i.test(arg);
}
function toBinaryConfig(input, allowUnsafe) {
  if (input.length < 1 || input.length > 2) {
    throw new GitPluginError(void 0, "binary", WRONG_NUMBER_ERR);
  }
  const isBad = input.some(isBadArgument);
  if (isBad) {
    if (allowUnsafe) {
      console.warn(WRONG_CHARS_ERR);
    } else {
      throw new GitPluginError(void 0, "binary", WRONG_CHARS_ERR);
    }
  }
  const [binary, prefix] = input;
  return {
    binary,
    prefix
  };
}
function customBinaryPlugin(plugins, input = ["git"], allowUnsafe = false) {
  let config = toBinaryConfig(asArray(input), allowUnsafe);
  plugins.on("binary", (input2) => {
    config = toBinaryConfig(asArray(input2), allowUnsafe);
  });
  plugins.append("spawn.binary", () => {
    return config.binary;
  });
  plugins.append("spawn.args", (data) => {
    return config.prefix ? [config.prefix, ...data] : data;
  });
}
function isTaskError(result) {
  return !!(result.exitCode && result.stdErr.length);
}
function getErrorMessage(result) {
  return Buffer.concat([...result.stdOut, ...result.stdErr]);
}
function errorDetectionHandler(overwrite = false, isError = isTaskError, errorMessage = getErrorMessage) {
  return (error, result) => {
    if (!overwrite && error || !isError(result)) {
      return error;
    }
    return errorMessage(result);
  };
}
function errorDetectionPlugin(config) {
  return {
    type: "task.error",
    action(data, context) {
      const error = config(data.error, {
        stdErr: context.stdErr,
        stdOut: context.stdOut,
        exitCode: context.exitCode
      });
      if (Buffer.isBuffer(error)) {
        return { error: new GitError(void 0, error.toString("utf-8")) };
      }
      return {
        error
      };
    }
  };
}
function progressMonitorPlugin(progress) {
  const progressCommand = "--progress";
  const progressMethods = ["checkout", "clone", "fetch", "pull", "push"];
  const onProgress = {
    type: "spawn.after",
    action(_data, context) {
      if (!context.commands.includes(progressCommand)) {
        return;
      }
      context.spawned.stderr?.on("data", (chunk) => {
        const message = /^([\s\S]+?):\s*(\d+)% \((\d+)\/(\d+)\)/.exec(chunk.toString("utf8"));
        if (!message) {
          return;
        }
        progress({
          method: context.method,
          stage: progressEventStage(message[1]),
          progress: asNumber(message[2]),
          processed: asNumber(message[3]),
          total: asNumber(message[4])
        });
      });
    }
  };
  const onArgs = {
    type: "spawn.args",
    action(args, context) {
      if (!progressMethods.includes(context.method)) {
        return args;
      }
      return including(args, progressCommand);
    }
  };
  return [onArgs, onProgress];
}
function progressEventStage(input) {
  return String(input.toLowerCase().split(" ", 1)) || "unknown";
}
function spawnOptionsPlugin(spawnOptions) {
  const options = pick(spawnOptions, ["uid", "gid"]);
  return {
    type: "spawn.options",
    action(data) {
      return { ...options, ...data };
    }
  };
}
function timeoutPlugin({
  block,
  stdErr = true,
  stdOut = true
}) {
  if (block > 0) {
    return {
      type: "spawn.after",
      action(_data, context) {
        let timeout;
        function wait() {
          timeout && clearTimeout(timeout);
          timeout = setTimeout(kill, block);
        }
        function stop() {
          context.spawned.stdout?.off("data", wait);
          context.spawned.stderr?.off("data", wait);
          context.spawned.off("exit", stop);
          context.spawned.off("close", stop);
          timeout && clearTimeout(timeout);
        }
        function kill() {
          stop();
          context.kill(new GitPluginError(void 0, "timeout", `block timeout reached`));
        }
        stdOut && context.spawned.stdout?.on("data", wait);
        stdErr && context.spawned.stderr?.on("data", wait);
        context.spawned.on("exit", stop);
        context.spawned.on("close", stop);
        wait();
      }
    };
  }
}
function suffixPathsPlugin() {
  return {
    type: "spawn.args",
    action(data) {
      const prefix = [];
      let suffix;
      function append2(args) {
        (suffix = suffix || []).push(...args);
      }
      for (let i = 0; i < data.length; i++) {
        const param = data[i];
        if (isPathSpec(param)) {
          append2(toPaths(param));
          continue;
        }
        if (param === "--") {
          append2(
            data.slice(i + 1).flatMap((item) => isPathSpec(item) && toPaths(item) || item)
          );
          break;
        }
        prefix.push(param);
      }
      return !suffix ? prefix : [...prefix, "--", ...suffix.map(String)];
    }
  };
}
function gitInstanceFactory(baseDir, options) {
  const plugins = new PluginStore();
  const config = createInstanceConfig(
    baseDir && (typeof baseDir === "string" ? { baseDir } : baseDir) || {},
    options
  );
  if (!folderExists(config.baseDir)) {
    throw new GitConstructError(
      config,
      `Cannot use simple-git on a directory that does not exist`
    );
  }
  if (Array.isArray(config.config)) {
    plugins.add(commandConfigPrefixingPlugin(config.config));
  }
  plugins.add(blockUnsafeOperationsPlugin(config.unsafe));
  plugins.add(completionDetectionPlugin(config.completion));
  config.abort && plugins.add(abortPlugin(config.abort));
  config.progress && plugins.add(progressMonitorPlugin(config.progress));
  config.timeout && plugins.add(timeoutPlugin(config.timeout));
  config.spawnOptions && plugins.add(spawnOptionsPlugin(config.spawnOptions));
  plugins.add(suffixPathsPlugin());
  plugins.add(errorDetectionPlugin(errorDetectionHandler(true)));
  config.errors && plugins.add(errorDetectionPlugin(config.errors));
  customBinaryPlugin(plugins, config.binary, config.unsafe?.allowUnsafeCustomBinary);
  return new Git(config, plugins);
}
var import_file_exists, import_debug, import_promise_deferred, import_promise_deferred2, __defProp2, __getOwnPropDesc2, __getOwnPropNames2, __hasOwnProp2, __esm2, __commonJS2, __export2, __copyProps2, __toCommonJS2, cache, init_pathspec, GitError, init_git_error, GitResponseError, init_git_response_error, TaskConfigurationError, init_task_configuration_error, NULL, NOOP, objectToString, init_util, filterArray, filterNumber, filterString, filterStringOrStringArray, filterHasLength, init_argument_filters, ExitCodes, init_exit_codes, GitOutputStreams, init_git_output_streams, LineParser, RemoteLineParser, init_line_parser, defaultOptions, init_simple_git_options, init_task_options, init_task_parser, utils_exports, init_utils, check_is_repo_exports, CheckRepoActions, onError, parser, init_check_is_repo, CleanResponse, removalRegexp, dryRunRemovalRegexp, isFolderRegexp, init_CleanSummary, task_exports, EMPTY_COMMANDS, init_task, clean_exports, CONFIG_ERROR_INTERACTIVE_MODE, CONFIG_ERROR_MODE_REQUIRED, CONFIG_ERROR_UNKNOWN_OPTION, CleanOptions, CleanOptionValues, init_clean, ConfigList, init_ConfigList, GitConfigScope, init_config, DiffNameStatus, diffNameStatus, init_diff_name_status, disallowedOptions, Query, _a, GrepQuery, init_grep, reset_exports, ResetMode, validResetModes, init_reset, init_git_logger, TasksPendingQueue, init_tasks_pending_queue, GitExecutorChain, init_git_executor_chain, git_executor_exports, GitExecutor, init_git_executor, init_task_callback, init_change_working_directory, init_checkout, parser2, init_count_objects, parsers, init_parse_commit, init_commit, init_first_commit, init_hash_object, InitSummary, initResponseRegex, reInitResponseRegex, init_InitSummary, bareCommand, init_init, logFormatRegex, init_log_format, DiffSummary, init_DiffSummary, statParser, numStatParser, nameOnlyParser, nameStatusParser, diffSummaryParsers, init_parse_diff_summary, START_BOUNDARY, COMMIT_BOUNDARY, SPLITTER, defaultFieldNames, init_parse_list_log_summary, diff_exports, init_diff, excludeOptions, init_log, MergeSummaryConflict, MergeSummaryDetail, init_MergeSummary, PullSummary, PullFailedSummary, init_PullSummary, remoteMessagesObjectParsers, init_parse_remote_objects, parsers2, RemoteMessageSummary, init_parse_remote_messages, FILE_UPDATE_REGEX, SUMMARY_REGEX, ACTION_REGEX, parsers3, errorParsers, parsePullDetail, parsePullResult, init_parse_pull, parsers4, parseMergeResult, parseMergeDetail, init_parse_merge, init_merge, parsers5, parsePushResult, parsePushDetail, init_parse_push, push_exports, init_push2, init_show, fromPathRegex, FileStatusSummary, init_FileStatusSummary, StatusSummary, parsers6, parseStatusSummary, init_StatusSummary, ignoredOptions, init_status, NOT_INSTALLED, parsers7, init_version, cloneTask, cloneMirrorTask, init_clone, simple_git_api_exports, SimpleGitApi, init_simple_git_api, scheduler_exports, createScheduledTask, Scheduler, init_scheduler, apply_patch_exports, init_apply_patch, BranchDeletionBatch, init_BranchDeleteSummary, deleteSuccessRegex, deleteErrorRegex, parsers8, parseBranchDeletions, init_parse_branch_delete, BranchSummaryResult, init_BranchSummary, parsers9, currentBranchParser, init_parse_branch, branch_exports, init_branch, parseCheckIgnore, init_CheckIgnore, check_ignore_exports, init_check_ignore, parsers10, init_parse_fetch, fetch_exports, init_fetch, parsers11, init_parse_move, move_exports, init_move, pull_exports, init_pull, init_GetRemoteSummary, remote_exports, init_remote, stash_list_exports, init_stash_list, sub_module_exports, init_sub_module, TagList, parseTagList, init_TagList, tag_exports, init_tag, require_git, GitConstructError, GitPluginError, preventUnsafeConfig, never, WRONG_NUMBER_ERR, WRONG_CHARS_ERR, PluginStore, Git, esm_default;
var init_esm = __esm({
  "node_modules/.pnpm/simple-git@3.33.0/node_modules/simple-git/dist/esm/index.js"() {
    import_file_exists = __toESM(require_dist(), 1);
    import_debug = __toESM(require_src(), 1);
    import_promise_deferred = __toESM(require_dist2(), 1);
    import_promise_deferred2 = __toESM(require_dist2(), 1);
    __defProp2 = Object.defineProperty;
    __getOwnPropDesc2 = Object.getOwnPropertyDescriptor;
    __getOwnPropNames2 = Object.getOwnPropertyNames;
    __hasOwnProp2 = Object.prototype.hasOwnProperty;
    __esm2 = (fn, res) => function __init() {
      return fn && (res = (0, fn[__getOwnPropNames2(fn)[0]])(fn = 0)), res;
    };
    __commonJS2 = (cb, mod) => function __require2() {
      return mod || (0, cb[__getOwnPropNames2(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
    };
    __export2 = (target, all) => {
      for (var name in all)
        __defProp2(target, name, { get: all[name], enumerable: true });
    };
    __copyProps2 = (to, from, except, desc) => {
      if (from && typeof from === "object" || typeof from === "function") {
        for (let key of __getOwnPropNames2(from))
          if (!__hasOwnProp2.call(to, key) && key !== except)
            __defProp2(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc2(from, key)) || desc.enumerable });
      }
      return to;
    };
    __toCommonJS2 = (mod) => __copyProps2(__defProp2({}, "__esModule", { value: true }), mod);
    init_pathspec = __esm2({
      "src/lib/args/pathspec.ts"() {
        "use strict";
        cache = /* @__PURE__ */ new WeakMap();
      }
    });
    init_git_error = __esm2({
      "src/lib/errors/git-error.ts"() {
        "use strict";
        GitError = class extends Error {
          constructor(task, message) {
            super(message);
            this.task = task;
            Object.setPrototypeOf(this, new.target.prototype);
          }
        };
      }
    });
    init_git_response_error = __esm2({
      "src/lib/errors/git-response-error.ts"() {
        "use strict";
        init_git_error();
        GitResponseError = class extends GitError {
          constructor(git2, message) {
            super(void 0, message || String(git2));
            this.git = git2;
          }
        };
      }
    });
    init_task_configuration_error = __esm2({
      "src/lib/errors/task-configuration-error.ts"() {
        "use strict";
        init_git_error();
        TaskConfigurationError = class extends GitError {
          constructor(message) {
            super(void 0, message);
          }
        };
      }
    });
    init_util = __esm2({
      "src/lib/utils/util.ts"() {
        "use strict";
        init_argument_filters();
        NULL = "\0";
        NOOP = () => {
        };
        objectToString = Object.prototype.toString.call.bind(Object.prototype.toString);
      }
    });
    init_argument_filters = __esm2({
      "src/lib/utils/argument-filters.ts"() {
        "use strict";
        init_pathspec();
        init_util();
        filterArray = (input) => {
          return Array.isArray(input);
        };
        filterNumber = (input) => {
          return typeof input === "number";
        };
        filterString = (input) => {
          return typeof input === "string" || isPathSpec(input);
        };
        filterStringOrStringArray = (input) => {
          return filterString(input) || Array.isArray(input) && input.every(filterString);
        };
        filterHasLength = (input) => {
          if (input == null || "number|boolean|function".includes(typeof input)) {
            return false;
          }
          return typeof input.length === "number";
        };
      }
    });
    init_exit_codes = __esm2({
      "src/lib/utils/exit-codes.ts"() {
        "use strict";
        ExitCodes = /* @__PURE__ */ ((ExitCodes2) => {
          ExitCodes2[ExitCodes2["SUCCESS"] = 0] = "SUCCESS";
          ExitCodes2[ExitCodes2["ERROR"] = 1] = "ERROR";
          ExitCodes2[ExitCodes2["NOT_FOUND"] = -2] = "NOT_FOUND";
          ExitCodes2[ExitCodes2["UNCLEAN"] = 128] = "UNCLEAN";
          return ExitCodes2;
        })(ExitCodes || {});
      }
    });
    init_git_output_streams = __esm2({
      "src/lib/utils/git-output-streams.ts"() {
        "use strict";
        GitOutputStreams = class _GitOutputStreams {
          constructor(stdOut, stdErr) {
            this.stdOut = stdOut;
            this.stdErr = stdErr;
          }
          asStrings() {
            return new _GitOutputStreams(this.stdOut.toString("utf8"), this.stdErr.toString("utf8"));
          }
        };
      }
    });
    init_line_parser = __esm2({
      "src/lib/utils/line-parser.ts"() {
        "use strict";
        LineParser = class {
          constructor(regExp, useMatches) {
            this.matches = [];
            this.useMatches = useMatchesDefault;
            this.parse = (line, target) => {
              this.resetMatches();
              if (!this._regExp.every((reg, index) => this.addMatch(reg, index, line(index)))) {
                return false;
              }
              return this.useMatches(target, this.prepareMatches()) !== false;
            };
            this._regExp = Array.isArray(regExp) ? regExp : [regExp];
            if (useMatches) {
              this.useMatches = useMatches;
            }
          }
          resetMatches() {
            this.matches.length = 0;
          }
          prepareMatches() {
            return this.matches;
          }
          addMatch(reg, index, line) {
            const matched = line && reg.exec(line);
            if (matched) {
              this.pushMatch(index, matched);
            }
            return !!matched;
          }
          pushMatch(_index, matched) {
            this.matches.push(...matched.slice(1));
          }
        };
        RemoteLineParser = class extends LineParser {
          addMatch(reg, index, line) {
            return /^remote:\s/.test(String(line)) && super.addMatch(reg, index, line);
          }
          pushMatch(index, matched) {
            if (index > 0 || matched.length > 1) {
              super.pushMatch(index, matched);
            }
          }
        };
      }
    });
    init_simple_git_options = __esm2({
      "src/lib/utils/simple-git-options.ts"() {
        "use strict";
        defaultOptions = {
          binary: "git",
          maxConcurrentProcesses: 5,
          config: [],
          trimmed: false
        };
      }
    });
    init_task_options = __esm2({
      "src/lib/utils/task-options.ts"() {
        "use strict";
        init_argument_filters();
        init_util();
        init_pathspec();
      }
    });
    init_task_parser = __esm2({
      "src/lib/utils/task-parser.ts"() {
        "use strict";
        init_util();
      }
    });
    utils_exports = {};
    __export2(utils_exports, {
      ExitCodes: () => ExitCodes,
      GitOutputStreams: () => GitOutputStreams,
      LineParser: () => LineParser,
      NOOP: () => NOOP,
      NULL: () => NULL,
      RemoteLineParser: () => RemoteLineParser,
      append: () => append,
      appendTaskOptions: () => appendTaskOptions,
      asArray: () => asArray,
      asCamelCase: () => asCamelCase,
      asFunction: () => asFunction,
      asNumber: () => asNumber,
      asStringArray: () => asStringArray,
      bufferToString: () => bufferToString,
      callTaskParser: () => callTaskParser,
      createInstanceConfig: () => createInstanceConfig,
      delay: () => delay,
      filterArray: () => filterArray,
      filterFunction: () => filterFunction,
      filterHasLength: () => filterHasLength,
      filterNumber: () => filterNumber,
      filterPlainObject: () => filterPlainObject,
      filterPrimitives: () => filterPrimitives,
      filterString: () => filterString,
      filterStringOrStringArray: () => filterStringOrStringArray,
      filterType: () => filterType,
      first: () => first,
      folderExists: () => folderExists,
      forEachLineWithContent: () => forEachLineWithContent,
      getTrailingOptions: () => getTrailingOptions,
      including: () => including,
      isUserFunction: () => isUserFunction,
      last: () => last,
      objectToString: () => objectToString,
      orVoid: () => orVoid,
      parseStringResponse: () => parseStringResponse,
      pick: () => pick,
      prefixedArray: () => prefixedArray,
      remove: () => remove,
      splitOn: () => splitOn,
      toLinesWithContent: () => toLinesWithContent,
      trailingFunctionArgument: () => trailingFunctionArgument,
      trailingOptionsArgument: () => trailingOptionsArgument
    });
    init_utils = __esm2({
      "src/lib/utils/index.ts"() {
        "use strict";
        init_argument_filters();
        init_exit_codes();
        init_git_output_streams();
        init_line_parser();
        init_simple_git_options();
        init_task_options();
        init_task_parser();
        init_util();
      }
    });
    check_is_repo_exports = {};
    __export2(check_is_repo_exports, {
      CheckRepoActions: () => CheckRepoActions,
      checkIsBareRepoTask: () => checkIsBareRepoTask,
      checkIsRepoRootTask: () => checkIsRepoRootTask,
      checkIsRepoTask: () => checkIsRepoTask
    });
    init_check_is_repo = __esm2({
      "src/lib/tasks/check-is-repo.ts"() {
        "use strict";
        init_utils();
        CheckRepoActions = /* @__PURE__ */ ((CheckRepoActions2) => {
          CheckRepoActions2["BARE"] = "bare";
          CheckRepoActions2["IN_TREE"] = "tree";
          CheckRepoActions2["IS_REPO_ROOT"] = "root";
          return CheckRepoActions2;
        })(CheckRepoActions || {});
        onError = ({ exitCode }, error, done, fail) => {
          if (exitCode === 128 && isNotRepoMessage(error)) {
            return done(Buffer.from("false"));
          }
          fail(error);
        };
        parser = (text) => {
          return text.trim() === "true";
        };
      }
    });
    init_CleanSummary = __esm2({
      "src/lib/responses/CleanSummary.ts"() {
        "use strict";
        init_utils();
        CleanResponse = class {
          constructor(dryRun) {
            this.dryRun = dryRun;
            this.paths = [];
            this.files = [];
            this.folders = [];
          }
        };
        removalRegexp = /^[a-z]+\s*/i;
        dryRunRemovalRegexp = /^[a-z]+\s+[a-z]+\s*/i;
        isFolderRegexp = /\/$/;
      }
    });
    task_exports = {};
    __export2(task_exports, {
      EMPTY_COMMANDS: () => EMPTY_COMMANDS,
      adhocExecTask: () => adhocExecTask,
      configurationErrorTask: () => configurationErrorTask,
      isBufferTask: () => isBufferTask,
      isEmptyTask: () => isEmptyTask,
      straightThroughBufferTask: () => straightThroughBufferTask,
      straightThroughStringTask: () => straightThroughStringTask
    });
    init_task = __esm2({
      "src/lib/tasks/task.ts"() {
        "use strict";
        init_task_configuration_error();
        EMPTY_COMMANDS = [];
      }
    });
    clean_exports = {};
    __export2(clean_exports, {
      CONFIG_ERROR_INTERACTIVE_MODE: () => CONFIG_ERROR_INTERACTIVE_MODE,
      CONFIG_ERROR_MODE_REQUIRED: () => CONFIG_ERROR_MODE_REQUIRED,
      CONFIG_ERROR_UNKNOWN_OPTION: () => CONFIG_ERROR_UNKNOWN_OPTION,
      CleanOptions: () => CleanOptions,
      cleanTask: () => cleanTask,
      cleanWithOptionsTask: () => cleanWithOptionsTask,
      isCleanOptionsArray: () => isCleanOptionsArray
    });
    init_clean = __esm2({
      "src/lib/tasks/clean.ts"() {
        "use strict";
        init_CleanSummary();
        init_utils();
        init_task();
        CONFIG_ERROR_INTERACTIVE_MODE = "Git clean interactive mode is not supported";
        CONFIG_ERROR_MODE_REQUIRED = 'Git clean mode parameter ("n" or "f") is required';
        CONFIG_ERROR_UNKNOWN_OPTION = "Git clean unknown option found in: ";
        CleanOptions = /* @__PURE__ */ ((CleanOptions2) => {
          CleanOptions2["DRY_RUN"] = "n";
          CleanOptions2["FORCE"] = "f";
          CleanOptions2["IGNORED_INCLUDED"] = "x";
          CleanOptions2["IGNORED_ONLY"] = "X";
          CleanOptions2["EXCLUDING"] = "e";
          CleanOptions2["QUIET"] = "q";
          CleanOptions2["RECURSIVE"] = "d";
          return CleanOptions2;
        })(CleanOptions || {});
        CleanOptionValues = /* @__PURE__ */ new Set([
          "i",
          ...asStringArray(Object.values(CleanOptions))
        ]);
      }
    });
    init_ConfigList = __esm2({
      "src/lib/responses/ConfigList.ts"() {
        "use strict";
        init_utils();
        ConfigList = class {
          constructor() {
            this.files = [];
            this.values = /* @__PURE__ */ Object.create(null);
          }
          get all() {
            if (!this._all) {
              this._all = this.files.reduce((all, file) => {
                return Object.assign(all, this.values[file]);
              }, {});
            }
            return this._all;
          }
          addFile(file) {
            if (!(file in this.values)) {
              const latest = last(this.files);
              this.values[file] = latest ? Object.create(this.values[latest]) : {};
              this.files.push(file);
            }
            return this.values[file];
          }
          addValue(file, key, value) {
            const values = this.addFile(file);
            if (!Object.hasOwn(values, key)) {
              values[key] = value;
            } else if (Array.isArray(values[key])) {
              values[key].push(value);
            } else {
              values[key] = [values[key], value];
            }
            this._all = void 0;
          }
        };
      }
    });
    init_config = __esm2({
      "src/lib/tasks/config.ts"() {
        "use strict";
        init_ConfigList();
        init_utils();
        GitConfigScope = /* @__PURE__ */ ((GitConfigScope2) => {
          GitConfigScope2["system"] = "system";
          GitConfigScope2["global"] = "global";
          GitConfigScope2["local"] = "local";
          GitConfigScope2["worktree"] = "worktree";
          return GitConfigScope2;
        })(GitConfigScope || {});
      }
    });
    init_diff_name_status = __esm2({
      "src/lib/tasks/diff-name-status.ts"() {
        "use strict";
        DiffNameStatus = /* @__PURE__ */ ((DiffNameStatus2) => {
          DiffNameStatus2["ADDED"] = "A";
          DiffNameStatus2["COPIED"] = "C";
          DiffNameStatus2["DELETED"] = "D";
          DiffNameStatus2["MODIFIED"] = "M";
          DiffNameStatus2["RENAMED"] = "R";
          DiffNameStatus2["CHANGED"] = "T";
          DiffNameStatus2["UNMERGED"] = "U";
          DiffNameStatus2["UNKNOWN"] = "X";
          DiffNameStatus2["BROKEN"] = "B";
          return DiffNameStatus2;
        })(DiffNameStatus || {});
        diffNameStatus = new Set(Object.values(DiffNameStatus));
      }
    });
    init_grep = __esm2({
      "src/lib/tasks/grep.ts"() {
        "use strict";
        init_utils();
        init_task();
        disallowedOptions = ["-h"];
        Query = /* @__PURE__ */ Symbol("grepQuery");
        GrepQuery = class {
          constructor() {
            this[_a] = [];
          }
          *[(_a = Query, Symbol.iterator)]() {
            for (const query of this[Query]) {
              yield query;
            }
          }
          and(...and) {
            and.length && this[Query].push("--and", "(", ...prefixedArray(and, "-e"), ")");
            return this;
          }
          param(...param) {
            this[Query].push(...prefixedArray(param, "-e"));
            return this;
          }
        };
      }
    });
    reset_exports = {};
    __export2(reset_exports, {
      ResetMode: () => ResetMode,
      getResetMode: () => getResetMode,
      resetTask: () => resetTask
    });
    init_reset = __esm2({
      "src/lib/tasks/reset.ts"() {
        "use strict";
        init_utils();
        init_task();
        ResetMode = /* @__PURE__ */ ((ResetMode2) => {
          ResetMode2["MIXED"] = "mixed";
          ResetMode2["SOFT"] = "soft";
          ResetMode2["HARD"] = "hard";
          ResetMode2["MERGE"] = "merge";
          ResetMode2["KEEP"] = "keep";
          return ResetMode2;
        })(ResetMode || {});
        validResetModes = asStringArray(Object.values(ResetMode));
      }
    });
    init_git_logger = __esm2({
      "src/lib/git-logger.ts"() {
        "use strict";
        init_utils();
        import_debug.default.formatters.L = (value) => String(filterHasLength(value) ? value.length : "-");
        import_debug.default.formatters.B = (value) => {
          if (Buffer.isBuffer(value)) {
            return value.toString("utf8");
          }
          return objectToString(value);
        };
      }
    });
    init_tasks_pending_queue = __esm2({
      "src/lib/runners/tasks-pending-queue.ts"() {
        "use strict";
        init_git_error();
        init_git_logger();
        TasksPendingQueue = class _TasksPendingQueue {
          constructor(logLabel = "GitExecutor") {
            this.logLabel = logLabel;
            this._queue = /* @__PURE__ */ new Map();
          }
          withProgress(task) {
            return this._queue.get(task);
          }
          createProgress(task) {
            const name = _TasksPendingQueue.getName(task.commands[0]);
            const logger = createLogger(this.logLabel, name);
            return {
              task,
              logger,
              name
            };
          }
          push(task) {
            const progress = this.createProgress(task);
            progress.logger("Adding task to the queue, commands = %o", task.commands);
            this._queue.set(task, progress);
            return progress;
          }
          fatal(err) {
            for (const [task, { logger }] of Array.from(this._queue.entries())) {
              if (task === err.task) {
                logger.info(`Failed %o`, err);
                logger(
                  `Fatal exception, any as-yet un-started tasks run through this executor will not be attempted`
                );
              } else {
                logger.info(
                  `A fatal exception occurred in a previous task, the queue has been purged: %o`,
                  err.message
                );
              }
              this.complete(task);
            }
            if (this._queue.size !== 0) {
              throw new Error(`Queue size should be zero after fatal: ${this._queue.size}`);
            }
          }
          complete(task) {
            const progress = this.withProgress(task);
            if (progress) {
              this._queue.delete(task);
            }
          }
          attempt(task) {
            const progress = this.withProgress(task);
            if (!progress) {
              throw new GitError(void 0, "TasksPendingQueue: attempt called for an unknown task");
            }
            progress.logger("Starting task");
            return progress;
          }
          static getName(name = "empty") {
            return `task:${name}:${++_TasksPendingQueue.counter}`;
          }
          static {
            this.counter = 0;
          }
        };
      }
    });
    init_git_executor_chain = __esm2({
      "src/lib/runners/git-executor-chain.ts"() {
        "use strict";
        init_git_error();
        init_task();
        init_utils();
        init_tasks_pending_queue();
        GitExecutorChain = class {
          constructor(_executor, _scheduler, _plugins) {
            this._executor = _executor;
            this._scheduler = _scheduler;
            this._plugins = _plugins;
            this._chain = Promise.resolve();
            this._queue = new TasksPendingQueue();
          }
          get cwd() {
            return this._cwd || this._executor.cwd;
          }
          set cwd(cwd) {
            this._cwd = cwd;
          }
          get env() {
            return this._executor.env;
          }
          get outputHandler() {
            return this._executor.outputHandler;
          }
          chain() {
            return this;
          }
          push(task) {
            this._queue.push(task);
            return this._chain = this._chain.then(() => this.attemptTask(task));
          }
          async attemptTask(task) {
            const onScheduleComplete = await this._scheduler.next();
            const onQueueComplete = () => this._queue.complete(task);
            try {
              const { logger } = this._queue.attempt(task);
              return await (isEmptyTask(task) ? this.attemptEmptyTask(task, logger) : this.attemptRemoteTask(task, logger));
            } catch (e) {
              throw this.onFatalException(task, e);
            } finally {
              onQueueComplete();
              onScheduleComplete();
            }
          }
          onFatalException(task, e) {
            const gitError = e instanceof GitError ? Object.assign(e, { task }) : new GitError(task, e && String(e));
            this._chain = Promise.resolve();
            this._queue.fatal(gitError);
            return gitError;
          }
          async attemptRemoteTask(task, logger) {
            const binary = this._plugins.exec("spawn.binary", "", pluginContext(task, task.commands));
            const args = this._plugins.exec(
              "spawn.args",
              [...task.commands],
              pluginContext(task, task.commands)
            );
            const raw = await this.gitResponse(
              task,
              binary,
              args,
              this.outputHandler,
              logger.step("SPAWN")
            );
            const outputStreams = await this.handleTaskData(task, args, raw, logger.step("HANDLE"));
            logger(`passing response to task's parser as a %s`, task.format);
            if (isBufferTask(task)) {
              return callTaskParser(task.parser, outputStreams);
            }
            return callTaskParser(task.parser, outputStreams.asStrings());
          }
          async attemptEmptyTask(task, logger) {
            logger(`empty task bypassing child process to call to task's parser`);
            return task.parser(this);
          }
          handleTaskData(task, args, result, logger) {
            const { exitCode, rejection, stdOut, stdErr } = result;
            return new Promise((done, fail) => {
              logger(`Preparing to handle process response exitCode=%d stdOut=`, exitCode);
              const { error } = this._plugins.exec(
                "task.error",
                { error: rejection },
                {
                  ...pluginContext(task, args),
                  ...result
                }
              );
              if (error && task.onError) {
                logger.info(`exitCode=%s handling with custom error handler`);
                return task.onError(
                  result,
                  error,
                  (newStdOut) => {
                    logger.info(`custom error handler treated as success`);
                    logger(`custom error returned a %s`, objectToString(newStdOut));
                    done(
                      new GitOutputStreams(
                        Array.isArray(newStdOut) ? Buffer.concat(newStdOut) : newStdOut,
                        Buffer.concat(stdErr)
                      )
                    );
                  },
                  fail
                );
              }
              if (error) {
                logger.info(
                  `handling as error: exitCode=%s stdErr=%s rejection=%o`,
                  exitCode,
                  stdErr.length,
                  rejection
                );
                return fail(error);
              }
              logger.info(`retrieving task output complete`);
              done(new GitOutputStreams(Buffer.concat(stdOut), Buffer.concat(stdErr)));
            });
          }
          async gitResponse(task, command, args, outputHandler, logger) {
            const outputLogger = logger.sibling("output");
            const spawnOptions = this._plugins.exec(
              "spawn.options",
              {
                cwd: this.cwd,
                env: this.env,
                windowsHide: true
              },
              pluginContext(task, task.commands)
            );
            return new Promise((done) => {
              const stdOut = [];
              const stdErr = [];
              logger.info(`%s %o`, command, args);
              logger("%O", spawnOptions);
              let rejection = this._beforeSpawn(task, args);
              if (rejection) {
                return done({
                  stdOut,
                  stdErr,
                  exitCode: 9901,
                  rejection
                });
              }
              this._plugins.exec("spawn.before", void 0, {
                ...pluginContext(task, args),
                kill(reason) {
                  rejection = reason || rejection;
                }
              });
              const spawned = spawn(command, args, spawnOptions);
              spawned.stdout.on(
                "data",
                onDataReceived(stdOut, "stdOut", logger, outputLogger.step("stdOut"))
              );
              spawned.stderr.on(
                "data",
                onDataReceived(stdErr, "stdErr", logger, outputLogger.step("stdErr"))
              );
              spawned.on("error", onErrorReceived(stdErr, logger));
              if (outputHandler) {
                logger(`Passing child process stdOut/stdErr to custom outputHandler`);
                outputHandler(command, spawned.stdout, spawned.stderr, [...args]);
              }
              this._plugins.exec("spawn.after", void 0, {
                ...pluginContext(task, args),
                spawned,
                close(exitCode, reason) {
                  done({
                    stdOut,
                    stdErr,
                    exitCode,
                    rejection: rejection || reason
                  });
                },
                kill(reason) {
                  if (spawned.killed) {
                    return;
                  }
                  rejection = reason;
                  spawned.kill("SIGINT");
                }
              });
            });
          }
          _beforeSpawn(task, args) {
            let rejection;
            this._plugins.exec("spawn.before", void 0, {
              ...pluginContext(task, args),
              kill(reason) {
                rejection = reason || rejection;
              }
            });
            return rejection;
          }
        };
      }
    });
    git_executor_exports = {};
    __export2(git_executor_exports, {
      GitExecutor: () => GitExecutor
    });
    init_git_executor = __esm2({
      "src/lib/runners/git-executor.ts"() {
        "use strict";
        init_git_executor_chain();
        GitExecutor = class {
          constructor(cwd, _scheduler, _plugins) {
            this.cwd = cwd;
            this._scheduler = _scheduler;
            this._plugins = _plugins;
            this._chain = new GitExecutorChain(this, this._scheduler, this._plugins);
          }
          chain() {
            return new GitExecutorChain(this, this._scheduler, this._plugins);
          }
          push(task) {
            return this._chain.push(task);
          }
        };
      }
    });
    init_task_callback = __esm2({
      "src/lib/task-callback.ts"() {
        "use strict";
        init_git_response_error();
        init_utils();
      }
    });
    init_change_working_directory = __esm2({
      "src/lib/tasks/change-working-directory.ts"() {
        "use strict";
        init_utils();
        init_task();
      }
    });
    init_checkout = __esm2({
      "src/lib/tasks/checkout.ts"() {
        "use strict";
        init_utils();
        init_task();
      }
    });
    init_count_objects = __esm2({
      "src/lib/tasks/count-objects.ts"() {
        "use strict";
        init_utils();
        parser2 = new LineParser(
          /([a-z-]+): (\d+)$/,
          (result, [key, value]) => {
            const property = asCamelCase(key);
            if (Object.hasOwn(result, property)) {
              result[property] = asNumber(value);
            }
          }
        );
      }
    });
    init_parse_commit = __esm2({
      "src/lib/parsers/parse-commit.ts"() {
        "use strict";
        init_utils();
        parsers = [
          new LineParser(/^\[([^\s]+)( \([^)]+\))? ([^\]]+)/, (result, [branch, root, commit]) => {
            result.branch = branch;
            result.commit = commit;
            result.root = !!root;
          }),
          new LineParser(/\s*Author:\s(.+)/i, (result, [author]) => {
            const parts = author.split("<");
            const email = parts.pop();
            if (!email || !email.includes("@")) {
              return;
            }
            result.author = {
              email: email.substr(0, email.length - 1),
              name: parts.join("<").trim()
            };
          }),
          new LineParser(
            /(\d+)[^,]*(?:,\s*(\d+)[^,]*)(?:,\s*(\d+))/g,
            (result, [changes, insertions, deletions]) => {
              result.summary.changes = parseInt(changes, 10) || 0;
              result.summary.insertions = parseInt(insertions, 10) || 0;
              result.summary.deletions = parseInt(deletions, 10) || 0;
            }
          ),
          new LineParser(
            /^(\d+)[^,]*(?:,\s*(\d+)[^(]+\(([+-]))?/,
            (result, [changes, lines, direction]) => {
              result.summary.changes = parseInt(changes, 10) || 0;
              const count = parseInt(lines, 10) || 0;
              if (direction === "-") {
                result.summary.deletions = count;
              } else if (direction === "+") {
                result.summary.insertions = count;
              }
            }
          )
        ];
      }
    });
    init_commit = __esm2({
      "src/lib/tasks/commit.ts"() {
        "use strict";
        init_parse_commit();
        init_utils();
        init_task();
      }
    });
    init_first_commit = __esm2({
      "src/lib/tasks/first-commit.ts"() {
        "use strict";
        init_utils();
        init_task();
      }
    });
    init_hash_object = __esm2({
      "src/lib/tasks/hash-object.ts"() {
        "use strict";
        init_task();
      }
    });
    init_InitSummary = __esm2({
      "src/lib/responses/InitSummary.ts"() {
        "use strict";
        InitSummary = class {
          constructor(bare, path4, existing, gitDir) {
            this.bare = bare;
            this.path = path4;
            this.existing = existing;
            this.gitDir = gitDir;
          }
        };
        initResponseRegex = /^Init.+ repository in (.+)$/;
        reInitResponseRegex = /^Rein.+ in (.+)$/;
      }
    });
    init_init = __esm2({
      "src/lib/tasks/init.ts"() {
        "use strict";
        init_InitSummary();
        bareCommand = "--bare";
      }
    });
    init_log_format = __esm2({
      "src/lib/args/log-format.ts"() {
        "use strict";
        logFormatRegex = /^--(stat|numstat|name-only|name-status)(=|$)/;
      }
    });
    init_DiffSummary = __esm2({
      "src/lib/responses/DiffSummary.ts"() {
        "use strict";
        DiffSummary = class {
          constructor() {
            this.changed = 0;
            this.deletions = 0;
            this.insertions = 0;
            this.files = [];
          }
        };
      }
    });
    init_parse_diff_summary = __esm2({
      "src/lib/parsers/parse-diff-summary.ts"() {
        "use strict";
        init_log_format();
        init_DiffSummary();
        init_diff_name_status();
        init_utils();
        statParser = [
          new LineParser(
            /^(.+)\s+\|\s+(\d+)(\s+[+\-]+)?$/,
            (result, [file, changes, alterations = ""]) => {
              result.files.push({
                file: file.trim(),
                changes: asNumber(changes),
                insertions: alterations.replace(/[^+]/g, "").length,
                deletions: alterations.replace(/[^-]/g, "").length,
                binary: false
              });
            }
          ),
          new LineParser(
            /^(.+) \|\s+Bin ([0-9.]+) -> ([0-9.]+) ([a-z]+)/,
            (result, [file, before, after]) => {
              result.files.push({
                file: file.trim(),
                before: asNumber(before),
                after: asNumber(after),
                binary: true
              });
            }
          ),
          new LineParser(
            /(\d+) files? changed\s*((?:, \d+ [^,]+){0,2})/,
            (result, [changed, summary]) => {
              const inserted = /(\d+) i/.exec(summary);
              const deleted = /(\d+) d/.exec(summary);
              result.changed = asNumber(changed);
              result.insertions = asNumber(inserted?.[1]);
              result.deletions = asNumber(deleted?.[1]);
            }
          )
        ];
        numStatParser = [
          new LineParser(
            /(\d+)\t(\d+)\t(.+)$/,
            (result, [changesInsert, changesDelete, file]) => {
              const insertions = asNumber(changesInsert);
              const deletions = asNumber(changesDelete);
              result.changed++;
              result.insertions += insertions;
              result.deletions += deletions;
              result.files.push({
                file,
                changes: insertions + deletions,
                insertions,
                deletions,
                binary: false
              });
            }
          ),
          new LineParser(/-\t-\t(.+)$/, (result, [file]) => {
            result.changed++;
            result.files.push({
              file,
              after: 0,
              before: 0,
              binary: true
            });
          })
        ];
        nameOnlyParser = [
          new LineParser(/(.+)$/, (result, [file]) => {
            result.changed++;
            result.files.push({
              file,
              changes: 0,
              insertions: 0,
              deletions: 0,
              binary: false
            });
          })
        ];
        nameStatusParser = [
          new LineParser(
            /([ACDMRTUXB])([0-9]{0,3})\t(.[^\t]*)(\t(.[^\t]*))?$/,
            (result, [status, similarity, from, _to, to]) => {
              result.changed++;
              result.files.push({
                file: to ?? from,
                changes: 0,
                insertions: 0,
                deletions: 0,
                binary: false,
                status: orVoid(isDiffNameStatus(status) && status),
                from: orVoid(!!to && from !== to && from),
                similarity: asNumber(similarity)
              });
            }
          )
        ];
        diffSummaryParsers = {
          [
            ""
            /* NONE */
          ]: statParser,
          [
            "--stat"
            /* STAT */
          ]: statParser,
          [
            "--numstat"
            /* NUM_STAT */
          ]: numStatParser,
          [
            "--name-status"
            /* NAME_STATUS */
          ]: nameStatusParser,
          [
            "--name-only"
            /* NAME_ONLY */
          ]: nameOnlyParser
        };
      }
    });
    init_parse_list_log_summary = __esm2({
      "src/lib/parsers/parse-list-log-summary.ts"() {
        "use strict";
        init_utils();
        init_parse_diff_summary();
        init_log_format();
        START_BOUNDARY = "\xF2\xF2\xF2\xF2\xF2\xF2 ";
        COMMIT_BOUNDARY = " \xF2\xF2";
        SPLITTER = " \xF2 ";
        defaultFieldNames = ["hash", "date", "message", "refs", "author_name", "author_email"];
      }
    });
    diff_exports = {};
    __export2(diff_exports, {
      diffSummaryTask: () => diffSummaryTask,
      validateLogFormatConfig: () => validateLogFormatConfig
    });
    init_diff = __esm2({
      "src/lib/tasks/diff.ts"() {
        "use strict";
        init_log_format();
        init_parse_diff_summary();
        init_task();
      }
    });
    init_log = __esm2({
      "src/lib/tasks/log.ts"() {
        "use strict";
        init_log_format();
        init_pathspec();
        init_parse_list_log_summary();
        init_utils();
        init_task();
        init_diff();
        excludeOptions = /* @__PURE__ */ ((excludeOptions2) => {
          excludeOptions2[excludeOptions2["--pretty"] = 0] = "--pretty";
          excludeOptions2[excludeOptions2["max-count"] = 1] = "max-count";
          excludeOptions2[excludeOptions2["maxCount"] = 2] = "maxCount";
          excludeOptions2[excludeOptions2["n"] = 3] = "n";
          excludeOptions2[excludeOptions2["file"] = 4] = "file";
          excludeOptions2[excludeOptions2["format"] = 5] = "format";
          excludeOptions2[excludeOptions2["from"] = 6] = "from";
          excludeOptions2[excludeOptions2["to"] = 7] = "to";
          excludeOptions2[excludeOptions2["splitter"] = 8] = "splitter";
          excludeOptions2[excludeOptions2["symmetric"] = 9] = "symmetric";
          excludeOptions2[excludeOptions2["mailMap"] = 10] = "mailMap";
          excludeOptions2[excludeOptions2["multiLine"] = 11] = "multiLine";
          excludeOptions2[excludeOptions2["strictDate"] = 12] = "strictDate";
          return excludeOptions2;
        })(excludeOptions || {});
      }
    });
    init_MergeSummary = __esm2({
      "src/lib/responses/MergeSummary.ts"() {
        "use strict";
        MergeSummaryConflict = class {
          constructor(reason, file = null, meta) {
            this.reason = reason;
            this.file = file;
            this.meta = meta;
          }
          toString() {
            return `${this.file}:${this.reason}`;
          }
        };
        MergeSummaryDetail = class {
          constructor() {
            this.conflicts = [];
            this.merges = [];
            this.result = "success";
          }
          get failed() {
            return this.conflicts.length > 0;
          }
          get reason() {
            return this.result;
          }
          toString() {
            if (this.conflicts.length) {
              return `CONFLICTS: ${this.conflicts.join(", ")}`;
            }
            return "OK";
          }
        };
      }
    });
    init_PullSummary = __esm2({
      "src/lib/responses/PullSummary.ts"() {
        "use strict";
        PullSummary = class {
          constructor() {
            this.remoteMessages = {
              all: []
            };
            this.created = [];
            this.deleted = [];
            this.files = [];
            this.deletions = {};
            this.insertions = {};
            this.summary = {
              changes: 0,
              deletions: 0,
              insertions: 0
            };
          }
        };
        PullFailedSummary = class {
          constructor() {
            this.remote = "";
            this.hash = {
              local: "",
              remote: ""
            };
            this.branch = {
              local: "",
              remote: ""
            };
            this.message = "";
          }
          toString() {
            return this.message;
          }
        };
      }
    });
    init_parse_remote_objects = __esm2({
      "src/lib/parsers/parse-remote-objects.ts"() {
        "use strict";
        init_utils();
        remoteMessagesObjectParsers = [
          new RemoteLineParser(
            /^remote:\s*(enumerating|counting|compressing) objects: (\d+),/i,
            (result, [action, count]) => {
              const key = action.toLowerCase();
              const enumeration = objectEnumerationResult(result.remoteMessages);
              Object.assign(enumeration, { [key]: asNumber(count) });
            }
          ),
          new RemoteLineParser(
            /^remote:\s*(enumerating|counting|compressing) objects: \d+% \(\d+\/(\d+)\),/i,
            (result, [action, count]) => {
              const key = action.toLowerCase();
              const enumeration = objectEnumerationResult(result.remoteMessages);
              Object.assign(enumeration, { [key]: asNumber(count) });
            }
          ),
          new RemoteLineParser(
            /total ([^,]+), reused ([^,]+), pack-reused (\d+)/i,
            (result, [total, reused, packReused]) => {
              const objects = objectEnumerationResult(result.remoteMessages);
              objects.total = asObjectCount(total);
              objects.reused = asObjectCount(reused);
              objects.packReused = asNumber(packReused);
            }
          )
        ];
      }
    });
    init_parse_remote_messages = __esm2({
      "src/lib/parsers/parse-remote-messages.ts"() {
        "use strict";
        init_utils();
        init_parse_remote_objects();
        parsers2 = [
          new RemoteLineParser(/^remote:\s*(.+)$/, (result, [text]) => {
            result.remoteMessages.all.push(text.trim());
            return false;
          }),
          ...remoteMessagesObjectParsers,
          new RemoteLineParser(
            [/create a (?:pull|merge) request/i, /\s(https?:\/\/\S+)$/],
            (result, [pullRequestUrl]) => {
              result.remoteMessages.pullRequestUrl = pullRequestUrl;
            }
          ),
          new RemoteLineParser(
            [/found (\d+) vulnerabilities.+\(([^)]+)\)/i, /\s(https?:\/\/\S+)$/],
            (result, [count, summary, url]) => {
              result.remoteMessages.vulnerabilities = {
                count: asNumber(count),
                summary,
                url
              };
            }
          )
        ];
        RemoteMessageSummary = class {
          constructor() {
            this.all = [];
          }
        };
      }
    });
    init_parse_pull = __esm2({
      "src/lib/parsers/parse-pull.ts"() {
        "use strict";
        init_PullSummary();
        init_utils();
        init_parse_remote_messages();
        FILE_UPDATE_REGEX = /^\s*(.+?)\s+\|\s+\d+\s*(\+*)(-*)/;
        SUMMARY_REGEX = /(\d+)\D+((\d+)\D+\(\+\))?(\D+(\d+)\D+\(-\))?/;
        ACTION_REGEX = /^(create|delete) mode \d+ (.+)/;
        parsers3 = [
          new LineParser(FILE_UPDATE_REGEX, (result, [file, insertions, deletions]) => {
            result.files.push(file);
            if (insertions) {
              result.insertions[file] = insertions.length;
            }
            if (deletions) {
              result.deletions[file] = deletions.length;
            }
          }),
          new LineParser(SUMMARY_REGEX, (result, [changes, , insertions, , deletions]) => {
            if (insertions !== void 0 || deletions !== void 0) {
              result.summary.changes = +changes || 0;
              result.summary.insertions = +insertions || 0;
              result.summary.deletions = +deletions || 0;
              return true;
            }
            return false;
          }),
          new LineParser(ACTION_REGEX, (result, [action, file]) => {
            append(result.files, file);
            append(action === "create" ? result.created : result.deleted, file);
          })
        ];
        errorParsers = [
          new LineParser(/^from\s(.+)$/i, (result, [remote]) => void (result.remote = remote)),
          new LineParser(/^fatal:\s(.+)$/, (result, [message]) => void (result.message = message)),
          new LineParser(
            /([a-z0-9]+)\.\.([a-z0-9]+)\s+(\S+)\s+->\s+(\S+)$/,
            (result, [hashLocal, hashRemote, branchLocal, branchRemote]) => {
              result.branch.local = branchLocal;
              result.hash.local = hashLocal;
              result.branch.remote = branchRemote;
              result.hash.remote = hashRemote;
            }
          )
        ];
        parsePullDetail = (stdOut, stdErr) => {
          return parseStringResponse(new PullSummary(), parsers3, [stdOut, stdErr]);
        };
        parsePullResult = (stdOut, stdErr) => {
          return Object.assign(
            new PullSummary(),
            parsePullDetail(stdOut, stdErr),
            parseRemoteMessages(stdOut, stdErr)
          );
        };
      }
    });
    init_parse_merge = __esm2({
      "src/lib/parsers/parse-merge.ts"() {
        "use strict";
        init_MergeSummary();
        init_utils();
        init_parse_pull();
        parsers4 = [
          new LineParser(/^Auto-merging\s+(.+)$/, (summary, [autoMerge]) => {
            summary.merges.push(autoMerge);
          }),
          new LineParser(/^CONFLICT\s+\((.+)\): Merge conflict in (.+)$/, (summary, [reason, file]) => {
            summary.conflicts.push(new MergeSummaryConflict(reason, file));
          }),
          new LineParser(
            /^CONFLICT\s+\((.+\/delete)\): (.+) deleted in (.+) and/,
            (summary, [reason, file, deleteRef]) => {
              summary.conflicts.push(new MergeSummaryConflict(reason, file, { deleteRef }));
            }
          ),
          new LineParser(/^CONFLICT\s+\((.+)\):/, (summary, [reason]) => {
            summary.conflicts.push(new MergeSummaryConflict(reason, null));
          }),
          new LineParser(/^Automatic merge failed;\s+(.+)$/, (summary, [result]) => {
            summary.result = result;
          })
        ];
        parseMergeResult = (stdOut, stdErr) => {
          return Object.assign(parseMergeDetail(stdOut, stdErr), parsePullResult(stdOut, stdErr));
        };
        parseMergeDetail = (stdOut) => {
          return parseStringResponse(new MergeSummaryDetail(), parsers4, stdOut);
        };
      }
    });
    init_merge = __esm2({
      "src/lib/tasks/merge.ts"() {
        "use strict";
        init_git_response_error();
        init_parse_merge();
        init_task();
      }
    });
    init_parse_push = __esm2({
      "src/lib/parsers/parse-push.ts"() {
        "use strict";
        init_utils();
        init_parse_remote_messages();
        parsers5 = [
          new LineParser(/^Pushing to (.+)$/, (result, [repo]) => {
            result.repo = repo;
          }),
          new LineParser(/^updating local tracking ref '(.+)'/, (result, [local]) => {
            result.ref = {
              ...result.ref || {},
              local
            };
          }),
          new LineParser(/^[=*-]\s+([^:]+):(\S+)\s+\[(.+)]$/, (result, [local, remote, type]) => {
            result.pushed.push(pushResultPushedItem(local, remote, type));
          }),
          new LineParser(
            /^Branch '([^']+)' set up to track remote branch '([^']+)' from '([^']+)'/,
            (result, [local, remote, remoteName]) => {
              result.branch = {
                ...result.branch || {},
                local,
                remote,
                remoteName
              };
            }
          ),
          new LineParser(
            /^([^:]+):(\S+)\s+([a-z0-9]+)\.\.([a-z0-9]+)$/,
            (result, [local, remote, from, to]) => {
              result.update = {
                head: {
                  local,
                  remote
                },
                hash: {
                  from,
                  to
                }
              };
            }
          )
        ];
        parsePushResult = (stdOut, stdErr) => {
          const pushDetail = parsePushDetail(stdOut, stdErr);
          const responseDetail = parseRemoteMessages(stdOut, stdErr);
          return {
            ...pushDetail,
            ...responseDetail
          };
        };
        parsePushDetail = (stdOut, stdErr) => {
          return parseStringResponse({ pushed: [] }, parsers5, [stdOut, stdErr]);
        };
      }
    });
    push_exports = {};
    __export2(push_exports, {
      pushTagsTask: () => pushTagsTask,
      pushTask: () => pushTask
    });
    init_push2 = __esm2({
      "src/lib/tasks/push.ts"() {
        "use strict";
        init_parse_push();
        init_utils();
      }
    });
    init_show = __esm2({
      "src/lib/tasks/show.ts"() {
        "use strict";
        init_utils();
        init_task();
      }
    });
    init_FileStatusSummary = __esm2({
      "src/lib/responses/FileStatusSummary.ts"() {
        "use strict";
        fromPathRegex = /^(.+)\0(.+)$/;
        FileStatusSummary = class {
          constructor(path4, index, working_dir) {
            this.path = path4;
            this.index = index;
            this.working_dir = working_dir;
            if (index === "R" || working_dir === "R") {
              const detail = fromPathRegex.exec(path4) || [null, path4, path4];
              this.from = detail[2] || "";
              this.path = detail[1] || "";
            }
          }
        };
      }
    });
    init_StatusSummary = __esm2({
      "src/lib/responses/StatusSummary.ts"() {
        "use strict";
        init_utils();
        init_FileStatusSummary();
        StatusSummary = class {
          constructor() {
            this.not_added = [];
            this.conflicted = [];
            this.created = [];
            this.deleted = [];
            this.ignored = void 0;
            this.modified = [];
            this.renamed = [];
            this.files = [];
            this.staged = [];
            this.ahead = 0;
            this.behind = 0;
            this.current = null;
            this.tracking = null;
            this.detached = false;
            this.isClean = () => {
              return !this.files.length;
            };
          }
        };
        parsers6 = new Map([
          parser3(
            " ",
            "A",
            (result, file) => result.created.push(file)
          ),
          parser3(
            " ",
            "D",
            (result, file) => result.deleted.push(file)
          ),
          parser3(
            " ",
            "M",
            (result, file) => result.modified.push(file)
          ),
          parser3("A", " ", (result, file) => {
            result.created.push(file);
            result.staged.push(file);
          }),
          parser3("A", "M", (result, file) => {
            result.created.push(file);
            result.staged.push(file);
            result.modified.push(file);
          }),
          parser3("D", " ", (result, file) => {
            result.deleted.push(file);
            result.staged.push(file);
          }),
          parser3("M", " ", (result, file) => {
            result.modified.push(file);
            result.staged.push(file);
          }),
          parser3("M", "M", (result, file) => {
            result.modified.push(file);
            result.staged.push(file);
          }),
          parser3("R", " ", (result, file) => {
            result.renamed.push(renamedFile(file));
          }),
          parser3("R", "M", (result, file) => {
            const renamed = renamedFile(file);
            result.renamed.push(renamed);
            result.modified.push(renamed.to);
          }),
          parser3("!", "!", (_result, _file) => {
            (_result.ignored = _result.ignored || []).push(_file);
          }),
          parser3(
            "?",
            "?",
            (result, file) => result.not_added.push(file)
          ),
          ...conflicts(
            "A",
            "A",
            "U"
            /* UNMERGED */
          ),
          ...conflicts(
            "D",
            "D",
            "U"
            /* UNMERGED */
          ),
          ...conflicts(
            "U",
            "A",
            "D",
            "U"
            /* UNMERGED */
          ),
          [
            "##",
            (result, line) => {
              const aheadReg = /ahead (\d+)/;
              const behindReg = /behind (\d+)/;
              const currentReg = /^(.+?(?=(?:\.{3}|\s|$)))/;
              const trackingReg = /\.{3}(\S*)/;
              const onEmptyBranchReg = /\son\s(\S+?)(?=\.{3}|$)/;
              let regexResult = aheadReg.exec(line);
              result.ahead = regexResult && +regexResult[1] || 0;
              regexResult = behindReg.exec(line);
              result.behind = regexResult && +regexResult[1] || 0;
              regexResult = currentReg.exec(line);
              result.current = filterType(regexResult?.[1], filterString, null);
              regexResult = trackingReg.exec(line);
              result.tracking = filterType(regexResult?.[1], filterString, null);
              regexResult = onEmptyBranchReg.exec(line);
              if (regexResult) {
                result.current = filterType(regexResult?.[1], filterString, result.current);
              }
              result.detached = /\(no branch\)/.test(line);
            }
          ]
        ]);
        parseStatusSummary = function(text) {
          const lines = text.split(NULL);
          const status = new StatusSummary();
          for (let i = 0, l = lines.length; i < l; ) {
            let line = lines[i++].trim();
            if (!line) {
              continue;
            }
            if (line.charAt(0) === "R") {
              line += NULL + (lines[i++] || "");
            }
            splitLine(status, line);
          }
          return status;
        };
      }
    });
    init_status = __esm2({
      "src/lib/tasks/status.ts"() {
        "use strict";
        init_StatusSummary();
        ignoredOptions = ["--null", "-z"];
      }
    });
    init_version = __esm2({
      "src/lib/tasks/version.ts"() {
        "use strict";
        init_utils();
        NOT_INSTALLED = "installed=false";
        parsers7 = [
          new LineParser(
            /version (\d+)\.(\d+)\.(\d+)(?:\s*\((.+)\))?/,
            (result, [major, minor, patch, agent = ""]) => {
              Object.assign(
                result,
                versionResponse(asNumber(major), asNumber(minor), asNumber(patch), agent)
              );
            }
          ),
          new LineParser(
            /version (\d+)\.(\d+)\.(\D+)(.+)?$/,
            (result, [major, minor, patch, agent = ""]) => {
              Object.assign(result, versionResponse(asNumber(major), asNumber(minor), patch, agent));
            }
          )
        ];
      }
    });
    init_clone = __esm2({
      "src/lib/tasks/clone.ts"() {
        "use strict";
        init_task();
        init_utils();
        init_pathspec();
        cloneTask = (repo, directory, customArgs) => {
          const commands = ["clone", ...customArgs];
          filterString(repo) && commands.push(pathspec(repo));
          filterString(directory) && commands.push(pathspec(directory));
          return straightThroughStringTask(commands);
        };
        cloneMirrorTask = (repo, directory, customArgs) => {
          append(customArgs, "--mirror");
          return cloneTask(repo, directory, customArgs);
        };
      }
    });
    simple_git_api_exports = {};
    __export2(simple_git_api_exports, {
      SimpleGitApi: () => SimpleGitApi
    });
    init_simple_git_api = __esm2({
      "src/lib/simple-git-api.ts"() {
        "use strict";
        init_task_callback();
        init_change_working_directory();
        init_checkout();
        init_count_objects();
        init_commit();
        init_config();
        init_first_commit();
        init_grep();
        init_hash_object();
        init_init();
        init_log();
        init_merge();
        init_push2();
        init_show();
        init_status();
        init_task();
        init_version();
        init_utils();
        init_clone();
        SimpleGitApi = class {
          constructor(_executor) {
            this._executor = _executor;
          }
          _runTask(task, then) {
            const chain = this._executor.chain();
            const promise = chain.push(task);
            if (then) {
              taskCallback(task, promise, then);
            }
            return Object.create(this, {
              then: { value: promise.then.bind(promise) },
              catch: { value: promise.catch.bind(promise) },
              _executor: { value: chain }
            });
          }
          add(files) {
            return this._runTask(
              straightThroughStringTask(["add", ...asArray(files)]),
              trailingFunctionArgument(arguments)
            );
          }
          cwd(directory) {
            const next = trailingFunctionArgument(arguments);
            if (typeof directory === "string") {
              return this._runTask(changeWorkingDirectoryTask(directory, this._executor), next);
            }
            if (typeof directory?.path === "string") {
              return this._runTask(
                changeWorkingDirectoryTask(
                  directory.path,
                  directory.root && this._executor || void 0
                ),
                next
              );
            }
            return this._runTask(
              configurationErrorTask("Git.cwd: workingDirectory must be supplied as a string"),
              next
            );
          }
          hashObject(path4, write) {
            return this._runTask(
              hashObjectTask(path4, write === true),
              trailingFunctionArgument(arguments)
            );
          }
          init(bare) {
            return this._runTask(
              initTask(bare === true, this._executor.cwd, getTrailingOptions(arguments)),
              trailingFunctionArgument(arguments)
            );
          }
          merge() {
            return this._runTask(
              mergeTask(getTrailingOptions(arguments)),
              trailingFunctionArgument(arguments)
            );
          }
          mergeFromTo(remote, branch) {
            if (!(filterString(remote) && filterString(branch))) {
              return this._runTask(
                configurationErrorTask(
                  `Git.mergeFromTo requires that the 'remote' and 'branch' arguments are supplied as strings`
                )
              );
            }
            return this._runTask(
              mergeTask([remote, branch, ...getTrailingOptions(arguments)]),
              trailingFunctionArgument(arguments, false)
            );
          }
          outputHandler(handler) {
            this._executor.outputHandler = handler;
            return this;
          }
          push() {
            const task = pushTask(
              {
                remote: filterType(arguments[0], filterString),
                branch: filterType(arguments[1], filterString)
              },
              getTrailingOptions(arguments)
            );
            return this._runTask(task, trailingFunctionArgument(arguments));
          }
          stash() {
            return this._runTask(
              straightThroughStringTask(["stash", ...getTrailingOptions(arguments)]),
              trailingFunctionArgument(arguments)
            );
          }
          status() {
            return this._runTask(
              statusTask(getTrailingOptions(arguments)),
              trailingFunctionArgument(arguments)
            );
          }
        };
        Object.assign(
          SimpleGitApi.prototype,
          checkout_default(),
          clone_default(),
          commit_default(),
          config_default(),
          count_objects_default(),
          first_commit_default(),
          grep_default(),
          log_default(),
          show_default(),
          version_default()
        );
      }
    });
    scheduler_exports = {};
    __export2(scheduler_exports, {
      Scheduler: () => Scheduler
    });
    init_scheduler = __esm2({
      "src/lib/runners/scheduler.ts"() {
        "use strict";
        init_utils();
        init_git_logger();
        createScheduledTask = /* @__PURE__ */ (() => {
          let id = 0;
          return () => {
            id++;
            const { promise, done } = (0, import_promise_deferred.createDeferred)();
            return {
              promise,
              done,
              id
            };
          };
        })();
        Scheduler = class {
          constructor(concurrency = 2) {
            this.concurrency = concurrency;
            this.logger = createLogger("", "scheduler");
            this.pending = [];
            this.running = [];
            this.logger(`Constructed, concurrency=%s`, concurrency);
          }
          schedule() {
            if (!this.pending.length || this.running.length >= this.concurrency) {
              this.logger(
                `Schedule attempt ignored, pending=%s running=%s concurrency=%s`,
                this.pending.length,
                this.running.length,
                this.concurrency
              );
              return;
            }
            const task = append(this.running, this.pending.shift());
            this.logger(`Attempting id=%s`, task.id);
            task.done(() => {
              this.logger(`Completing id=`, task.id);
              remove(this.running, task);
              this.schedule();
            });
          }
          next() {
            const { promise, id } = append(this.pending, createScheduledTask());
            this.logger(`Scheduling id=%s`, id);
            this.schedule();
            return promise;
          }
        };
      }
    });
    apply_patch_exports = {};
    __export2(apply_patch_exports, {
      applyPatchTask: () => applyPatchTask
    });
    init_apply_patch = __esm2({
      "src/lib/tasks/apply-patch.ts"() {
        "use strict";
        init_task();
      }
    });
    init_BranchDeleteSummary = __esm2({
      "src/lib/responses/BranchDeleteSummary.ts"() {
        "use strict";
        BranchDeletionBatch = class {
          constructor() {
            this.all = [];
            this.branches = {};
            this.errors = [];
          }
          get success() {
            return !this.errors.length;
          }
        };
      }
    });
    init_parse_branch_delete = __esm2({
      "src/lib/parsers/parse-branch-delete.ts"() {
        "use strict";
        init_BranchDeleteSummary();
        init_utils();
        deleteSuccessRegex = /(\S+)\s+\(\S+\s([^)]+)\)/;
        deleteErrorRegex = /^error[^']+'([^']+)'/m;
        parsers8 = [
          new LineParser(deleteSuccessRegex, (result, [branch, hash]) => {
            const deletion = branchDeletionSuccess(branch, hash);
            result.all.push(deletion);
            result.branches[branch] = deletion;
          }),
          new LineParser(deleteErrorRegex, (result, [branch]) => {
            const deletion = branchDeletionFailure(branch);
            result.errors.push(deletion);
            result.all.push(deletion);
            result.branches[branch] = deletion;
          })
        ];
        parseBranchDeletions = (stdOut, stdErr) => {
          return parseStringResponse(new BranchDeletionBatch(), parsers8, [stdOut, stdErr]);
        };
      }
    });
    init_BranchSummary = __esm2({
      "src/lib/responses/BranchSummary.ts"() {
        "use strict";
        BranchSummaryResult = class {
          constructor() {
            this.all = [];
            this.branches = {};
            this.current = "";
            this.detached = false;
          }
          push(status, detached, name, commit, label) {
            if (status === "*") {
              this.detached = detached;
              this.current = name;
            }
            this.all.push(name);
            this.branches[name] = {
              current: status === "*",
              linkedWorkTree: status === "+",
              name,
              commit,
              label
            };
          }
        };
      }
    });
    init_parse_branch = __esm2({
      "src/lib/parsers/parse-branch.ts"() {
        "use strict";
        init_BranchSummary();
        init_utils();
        parsers9 = [
          new LineParser(
            /^([*+]\s)?\((?:HEAD )?detached (?:from|at) (\S+)\)\s+([a-z0-9]+)\s(.*)$/,
            (result, [current, name, commit, label]) => {
              result.push(branchStatus(current), true, name, commit, label);
            }
          ),
          new LineParser(
            /^([*+]\s)?(\S+)\s+([a-z0-9]+)\s?(.*)$/s,
            (result, [current, name, commit, label]) => {
              result.push(branchStatus(current), false, name, commit, label);
            }
          )
        ];
        currentBranchParser = new LineParser(/^(\S+)$/s, (result, [name]) => {
          result.push("*", false, name, "", "");
        });
      }
    });
    branch_exports = {};
    __export2(branch_exports, {
      branchLocalTask: () => branchLocalTask,
      branchTask: () => branchTask,
      containsDeleteBranchCommand: () => containsDeleteBranchCommand,
      deleteBranchTask: () => deleteBranchTask,
      deleteBranchesTask: () => deleteBranchesTask
    });
    init_branch = __esm2({
      "src/lib/tasks/branch.ts"() {
        "use strict";
        init_git_response_error();
        init_parse_branch_delete();
        init_parse_branch();
        init_utils();
      }
    });
    init_CheckIgnore = __esm2({
      "src/lib/responses/CheckIgnore.ts"() {
        "use strict";
        parseCheckIgnore = (text) => {
          return text.split(/\n/g).map(toPath).filter(Boolean);
        };
      }
    });
    check_ignore_exports = {};
    __export2(check_ignore_exports, {
      checkIgnoreTask: () => checkIgnoreTask
    });
    init_check_ignore = __esm2({
      "src/lib/tasks/check-ignore.ts"() {
        "use strict";
        init_CheckIgnore();
      }
    });
    init_parse_fetch = __esm2({
      "src/lib/parsers/parse-fetch.ts"() {
        "use strict";
        init_utils();
        parsers10 = [
          new LineParser(/From (.+)$/, (result, [remote]) => {
            result.remote = remote;
          }),
          new LineParser(/\* \[new branch]\s+(\S+)\s*-> (.+)$/, (result, [name, tracking]) => {
            result.branches.push({
              name,
              tracking
            });
          }),
          new LineParser(/\* \[new tag]\s+(\S+)\s*-> (.+)$/, (result, [name, tracking]) => {
            result.tags.push({
              name,
              tracking
            });
          }),
          new LineParser(/- \[deleted]\s+\S+\s*-> (.+)$/, (result, [tracking]) => {
            result.deleted.push({
              tracking
            });
          }),
          new LineParser(
            /\s*([^.]+)\.\.(\S+)\s+(\S+)\s*-> (.+)$/,
            (result, [from, to, name, tracking]) => {
              result.updated.push({
                name,
                tracking,
                to,
                from
              });
            }
          )
        ];
      }
    });
    fetch_exports = {};
    __export2(fetch_exports, {
      fetchTask: () => fetchTask
    });
    init_fetch = __esm2({
      "src/lib/tasks/fetch.ts"() {
        "use strict";
        init_parse_fetch();
        init_task();
      }
    });
    init_parse_move = __esm2({
      "src/lib/parsers/parse-move.ts"() {
        "use strict";
        init_utils();
        parsers11 = [
          new LineParser(/^Renaming (.+) to (.+)$/, (result, [from, to]) => {
            result.moves.push({ from, to });
          })
        ];
      }
    });
    move_exports = {};
    __export2(move_exports, {
      moveTask: () => moveTask
    });
    init_move = __esm2({
      "src/lib/tasks/move.ts"() {
        "use strict";
        init_parse_move();
        init_utils();
      }
    });
    pull_exports = {};
    __export2(pull_exports, {
      pullTask: () => pullTask
    });
    init_pull = __esm2({
      "src/lib/tasks/pull.ts"() {
        "use strict";
        init_git_response_error();
        init_parse_pull();
        init_utils();
      }
    });
    init_GetRemoteSummary = __esm2({
      "src/lib/responses/GetRemoteSummary.ts"() {
        "use strict";
        init_utils();
      }
    });
    remote_exports = {};
    __export2(remote_exports, {
      addRemoteTask: () => addRemoteTask,
      getRemotesTask: () => getRemotesTask,
      listRemotesTask: () => listRemotesTask,
      remoteTask: () => remoteTask,
      removeRemoteTask: () => removeRemoteTask
    });
    init_remote = __esm2({
      "src/lib/tasks/remote.ts"() {
        "use strict";
        init_GetRemoteSummary();
        init_task();
      }
    });
    stash_list_exports = {};
    __export2(stash_list_exports, {
      stashListTask: () => stashListTask
    });
    init_stash_list = __esm2({
      "src/lib/tasks/stash-list.ts"() {
        "use strict";
        init_log_format();
        init_parse_list_log_summary();
        init_diff();
        init_log();
      }
    });
    sub_module_exports = {};
    __export2(sub_module_exports, {
      addSubModuleTask: () => addSubModuleTask,
      initSubModuleTask: () => initSubModuleTask,
      subModuleTask: () => subModuleTask,
      updateSubModuleTask: () => updateSubModuleTask
    });
    init_sub_module = __esm2({
      "src/lib/tasks/sub-module.ts"() {
        "use strict";
        init_task();
      }
    });
    init_TagList = __esm2({
      "src/lib/responses/TagList.ts"() {
        "use strict";
        TagList = class {
          constructor(all, latest) {
            this.all = all;
            this.latest = latest;
          }
        };
        parseTagList = function(data, customSort = false) {
          const tags = data.split("\n").map(trimmed).filter(Boolean);
          if (!customSort) {
            tags.sort(function(tagA, tagB) {
              const partsA = tagA.split(".");
              const partsB = tagB.split(".");
              if (partsA.length === 1 || partsB.length === 1) {
                return singleSorted(toNumber(partsA[0]), toNumber(partsB[0]));
              }
              for (let i = 0, l = Math.max(partsA.length, partsB.length); i < l; i++) {
                const diff = sorted(toNumber(partsA[i]), toNumber(partsB[i]));
                if (diff) {
                  return diff;
                }
              }
              return 0;
            });
          }
          const latest = customSort ? tags[0] : [...tags].reverse().find((tag) => tag.indexOf(".") >= 0);
          return new TagList(tags, latest);
        };
      }
    });
    tag_exports = {};
    __export2(tag_exports, {
      addAnnotatedTagTask: () => addAnnotatedTagTask,
      addTagTask: () => addTagTask,
      tagListTask: () => tagListTask
    });
    init_tag = __esm2({
      "src/lib/tasks/tag.ts"() {
        "use strict";
        init_TagList();
      }
    });
    require_git = __commonJS2({
      "src/git.js"(exports, module) {
        "use strict";
        var { GitExecutor: GitExecutor2 } = (init_git_executor(), __toCommonJS2(git_executor_exports));
        var { SimpleGitApi: SimpleGitApi2 } = (init_simple_git_api(), __toCommonJS2(simple_git_api_exports));
        var { Scheduler: Scheduler2 } = (init_scheduler(), __toCommonJS2(scheduler_exports));
        var { adhocExecTask: adhocExecTask2, configurationErrorTask: configurationErrorTask2 } = (init_task(), __toCommonJS2(task_exports));
        var {
          asArray: asArray2,
          filterArray: filterArray2,
          filterPrimitives: filterPrimitives2,
          filterString: filterString2,
          filterStringOrStringArray: filterStringOrStringArray2,
          filterType: filterType2,
          getTrailingOptions: getTrailingOptions2,
          trailingFunctionArgument: trailingFunctionArgument2,
          trailingOptionsArgument: trailingOptionsArgument2
        } = (init_utils(), __toCommonJS2(utils_exports));
        var { applyPatchTask: applyPatchTask2 } = (init_apply_patch(), __toCommonJS2(apply_patch_exports));
        var {
          branchTask: branchTask2,
          branchLocalTask: branchLocalTask2,
          deleteBranchesTask: deleteBranchesTask2,
          deleteBranchTask: deleteBranchTask2
        } = (init_branch(), __toCommonJS2(branch_exports));
        var { checkIgnoreTask: checkIgnoreTask2 } = (init_check_ignore(), __toCommonJS2(check_ignore_exports));
        var { checkIsRepoTask: checkIsRepoTask2 } = (init_check_is_repo(), __toCommonJS2(check_is_repo_exports));
        var { cleanWithOptionsTask: cleanWithOptionsTask2, isCleanOptionsArray: isCleanOptionsArray2 } = (init_clean(), __toCommonJS2(clean_exports));
        var { diffSummaryTask: diffSummaryTask2 } = (init_diff(), __toCommonJS2(diff_exports));
        var { fetchTask: fetchTask2 } = (init_fetch(), __toCommonJS2(fetch_exports));
        var { moveTask: moveTask2 } = (init_move(), __toCommonJS2(move_exports));
        var { pullTask: pullTask2 } = (init_pull(), __toCommonJS2(pull_exports));
        var { pushTagsTask: pushTagsTask2 } = (init_push2(), __toCommonJS2(push_exports));
        var {
          addRemoteTask: addRemoteTask2,
          getRemotesTask: getRemotesTask2,
          listRemotesTask: listRemotesTask2,
          remoteTask: remoteTask2,
          removeRemoteTask: removeRemoteTask2
        } = (init_remote(), __toCommonJS2(remote_exports));
        var { getResetMode: getResetMode2, resetTask: resetTask2 } = (init_reset(), __toCommonJS2(reset_exports));
        var { stashListTask: stashListTask2 } = (init_stash_list(), __toCommonJS2(stash_list_exports));
        var {
          addSubModuleTask: addSubModuleTask2,
          initSubModuleTask: initSubModuleTask2,
          subModuleTask: subModuleTask2,
          updateSubModuleTask: updateSubModuleTask2
        } = (init_sub_module(), __toCommonJS2(sub_module_exports));
        var { addAnnotatedTagTask: addAnnotatedTagTask2, addTagTask: addTagTask2, tagListTask: tagListTask2 } = (init_tag(), __toCommonJS2(tag_exports));
        var { straightThroughBufferTask: straightThroughBufferTask2, straightThroughStringTask: straightThroughStringTask2 } = (init_task(), __toCommonJS2(task_exports));
        function Git2(options, plugins) {
          this._plugins = plugins;
          this._executor = new GitExecutor2(
            options.baseDir,
            new Scheduler2(options.maxConcurrentProcesses),
            plugins
          );
          this._trimmed = options.trimmed;
        }
        (Git2.prototype = Object.create(SimpleGitApi2.prototype)).constructor = Git2;
        Git2.prototype.customBinary = function(command) {
          this._plugins.reconfigure("binary", command);
          return this;
        };
        Git2.prototype.env = function(name, value) {
          if (arguments.length === 1 && typeof name === "object") {
            this._executor.env = name;
          } else {
            (this._executor.env = this._executor.env || {})[name] = value;
          }
          return this;
        };
        Git2.prototype.stashList = function(options) {
          return this._runTask(
            stashListTask2(
              trailingOptionsArgument2(arguments) || {},
              filterArray2(options) && options || []
            ),
            trailingFunctionArgument2(arguments)
          );
        };
        Git2.prototype.mv = function(from, to) {
          return this._runTask(moveTask2(from, to), trailingFunctionArgument2(arguments));
        };
        Git2.prototype.checkoutLatestTag = function(then) {
          var git2 = this;
          return this.pull(function() {
            git2.tags(function(err, tags) {
              git2.checkout(tags.latest, then);
            });
          });
        };
        Git2.prototype.pull = function(remote, branch, options, then) {
          return this._runTask(
            pullTask2(
              filterType2(remote, filterString2),
              filterType2(branch, filterString2),
              getTrailingOptions2(arguments)
            ),
            trailingFunctionArgument2(arguments)
          );
        };
        Git2.prototype.fetch = function(remote, branch) {
          return this._runTask(
            fetchTask2(
              filterType2(remote, filterString2),
              filterType2(branch, filterString2),
              getTrailingOptions2(arguments)
            ),
            trailingFunctionArgument2(arguments)
          );
        };
        Git2.prototype.silent = function(silence) {
          return this._runTask(
            adhocExecTask2(
              () => console.warn(
                "simple-git deprecation notice: git.silent: logging should be configured using the `debug` library / `DEBUG` environment variable, this method will be removed."
              )
            )
          );
        };
        Git2.prototype.tags = function(options, then) {
          return this._runTask(
            tagListTask2(getTrailingOptions2(arguments)),
            trailingFunctionArgument2(arguments)
          );
        };
        Git2.prototype.rebase = function() {
          return this._runTask(
            straightThroughStringTask2(["rebase", ...getTrailingOptions2(arguments)]),
            trailingFunctionArgument2(arguments)
          );
        };
        Git2.prototype.reset = function(mode) {
          return this._runTask(
            resetTask2(getResetMode2(mode), getTrailingOptions2(arguments)),
            trailingFunctionArgument2(arguments)
          );
        };
        Git2.prototype.revert = function(commit) {
          const next = trailingFunctionArgument2(arguments);
          if (typeof commit !== "string") {
            return this._runTask(configurationErrorTask2("Commit must be a string"), next);
          }
          return this._runTask(
            straightThroughStringTask2(["revert", ...getTrailingOptions2(arguments, 0, true), commit]),
            next
          );
        };
        Git2.prototype.addTag = function(name) {
          const task = typeof name === "string" ? addTagTask2(name) : configurationErrorTask2("Git.addTag requires a tag name");
          return this._runTask(task, trailingFunctionArgument2(arguments));
        };
        Git2.prototype.addAnnotatedTag = function(tagName, tagMessage) {
          return this._runTask(
            addAnnotatedTagTask2(tagName, tagMessage),
            trailingFunctionArgument2(arguments)
          );
        };
        Git2.prototype.deleteLocalBranch = function(branchName, forceDelete, then) {
          return this._runTask(
            deleteBranchTask2(branchName, typeof forceDelete === "boolean" ? forceDelete : false),
            trailingFunctionArgument2(arguments)
          );
        };
        Git2.prototype.deleteLocalBranches = function(branchNames, forceDelete, then) {
          return this._runTask(
            deleteBranchesTask2(branchNames, typeof forceDelete === "boolean" ? forceDelete : false),
            trailingFunctionArgument2(arguments)
          );
        };
        Git2.prototype.branch = function(options, then) {
          return this._runTask(
            branchTask2(getTrailingOptions2(arguments)),
            trailingFunctionArgument2(arguments)
          );
        };
        Git2.prototype.branchLocal = function(then) {
          return this._runTask(branchLocalTask2(), trailingFunctionArgument2(arguments));
        };
        Git2.prototype.raw = function(commands) {
          const createRestCommands = !Array.isArray(commands);
          const command = [].slice.call(createRestCommands ? arguments : commands, 0);
          for (let i = 0; i < command.length && createRestCommands; i++) {
            if (!filterPrimitives2(command[i])) {
              command.splice(i, command.length - i);
              break;
            }
          }
          command.push(...getTrailingOptions2(arguments, 0, true));
          var next = trailingFunctionArgument2(arguments);
          if (!command.length) {
            return this._runTask(
              configurationErrorTask2("Raw: must supply one or more command to execute"),
              next
            );
          }
          return this._runTask(straightThroughStringTask2(command, this._trimmed), next);
        };
        Git2.prototype.submoduleAdd = function(repo, path4, then) {
          return this._runTask(addSubModuleTask2(repo, path4), trailingFunctionArgument2(arguments));
        };
        Git2.prototype.submoduleUpdate = function(args, then) {
          return this._runTask(
            updateSubModuleTask2(getTrailingOptions2(arguments, true)),
            trailingFunctionArgument2(arguments)
          );
        };
        Git2.prototype.submoduleInit = function(args, then) {
          return this._runTask(
            initSubModuleTask2(getTrailingOptions2(arguments, true)),
            trailingFunctionArgument2(arguments)
          );
        };
        Git2.prototype.subModule = function(options, then) {
          return this._runTask(
            subModuleTask2(getTrailingOptions2(arguments)),
            trailingFunctionArgument2(arguments)
          );
        };
        Git2.prototype.listRemote = function() {
          return this._runTask(
            listRemotesTask2(getTrailingOptions2(arguments)),
            trailingFunctionArgument2(arguments)
          );
        };
        Git2.prototype.addRemote = function(remoteName, remoteRepo, then) {
          return this._runTask(
            addRemoteTask2(remoteName, remoteRepo, getTrailingOptions2(arguments)),
            trailingFunctionArgument2(arguments)
          );
        };
        Git2.prototype.removeRemote = function(remoteName, then) {
          return this._runTask(removeRemoteTask2(remoteName), trailingFunctionArgument2(arguments));
        };
        Git2.prototype.getRemotes = function(verbose, then) {
          return this._runTask(getRemotesTask2(verbose === true), trailingFunctionArgument2(arguments));
        };
        Git2.prototype.remote = function(options, then) {
          return this._runTask(
            remoteTask2(getTrailingOptions2(arguments)),
            trailingFunctionArgument2(arguments)
          );
        };
        Git2.prototype.tag = function(options, then) {
          const command = getTrailingOptions2(arguments);
          if (command[0] !== "tag") {
            command.unshift("tag");
          }
          return this._runTask(straightThroughStringTask2(command), trailingFunctionArgument2(arguments));
        };
        Git2.prototype.updateServerInfo = function(then) {
          return this._runTask(
            straightThroughStringTask2(["update-server-info"]),
            trailingFunctionArgument2(arguments)
          );
        };
        Git2.prototype.pushTags = function(remote, then) {
          const task = pushTagsTask2(
            { remote: filterType2(remote, filterString2) },
            getTrailingOptions2(arguments)
          );
          return this._runTask(task, trailingFunctionArgument2(arguments));
        };
        Git2.prototype.rm = function(files) {
          return this._runTask(
            straightThroughStringTask2(["rm", "-f", ...asArray2(files)]),
            trailingFunctionArgument2(arguments)
          );
        };
        Git2.prototype.rmKeepLocal = function(files) {
          return this._runTask(
            straightThroughStringTask2(["rm", "--cached", ...asArray2(files)]),
            trailingFunctionArgument2(arguments)
          );
        };
        Git2.prototype.catFile = function(options, then) {
          return this._catFile("utf-8", arguments);
        };
        Git2.prototype.binaryCatFile = function() {
          return this._catFile("buffer", arguments);
        };
        Git2.prototype._catFile = function(format, args) {
          var handler = trailingFunctionArgument2(args);
          var command = ["cat-file"];
          var options = args[0];
          if (typeof options === "string") {
            return this._runTask(
              configurationErrorTask2("Git.catFile: options must be supplied as an array of strings"),
              handler
            );
          }
          if (Array.isArray(options)) {
            command.push.apply(command, options);
          }
          const task = format === "buffer" ? straightThroughBufferTask2(command) : straightThroughStringTask2(command);
          return this._runTask(task, handler);
        };
        Git2.prototype.diff = function(options, then) {
          const task = filterString2(options) ? configurationErrorTask2(
            "git.diff: supplying options as a single string is no longer supported, switch to an array of strings"
          ) : straightThroughStringTask2(["diff", ...getTrailingOptions2(arguments)]);
          return this._runTask(task, trailingFunctionArgument2(arguments));
        };
        Git2.prototype.diffSummary = function() {
          return this._runTask(
            diffSummaryTask2(getTrailingOptions2(arguments, 1)),
            trailingFunctionArgument2(arguments)
          );
        };
        Git2.prototype.applyPatch = function(patches) {
          const task = !filterStringOrStringArray2(patches) ? configurationErrorTask2(
            `git.applyPatch requires one or more string patches as the first argument`
          ) : applyPatchTask2(asArray2(patches), getTrailingOptions2([].slice.call(arguments, 1)));
          return this._runTask(task, trailingFunctionArgument2(arguments));
        };
        Git2.prototype.revparse = function() {
          const commands = ["rev-parse", ...getTrailingOptions2(arguments, true)];
          return this._runTask(
            straightThroughStringTask2(commands, true),
            trailingFunctionArgument2(arguments)
          );
        };
        Git2.prototype.clean = function(mode, options, then) {
          const usingCleanOptionsArray = isCleanOptionsArray2(mode);
          const cleanMode = usingCleanOptionsArray && mode.join("") || filterType2(mode, filterString2) || "";
          const customArgs = getTrailingOptions2([].slice.call(arguments, usingCleanOptionsArray ? 1 : 0));
          return this._runTask(
            cleanWithOptionsTask2(cleanMode, customArgs),
            trailingFunctionArgument2(arguments)
          );
        };
        Git2.prototype.exec = function(then) {
          const task = {
            commands: [],
            format: "utf-8",
            parser() {
              if (typeof then === "function") {
                then();
              }
            }
          };
          return this._runTask(task);
        };
        Git2.prototype.clearQueue = function() {
          return this._runTask(
            adhocExecTask2(
              () => console.warn(
                "simple-git deprecation notice: clearQueue() is deprecated and will be removed, switch to using the abortPlugin instead."
              )
            )
          );
        };
        Git2.prototype.checkIgnore = function(pathnames, then) {
          return this._runTask(
            checkIgnoreTask2(asArray2(filterType2(pathnames, filterStringOrStringArray2, []))),
            trailingFunctionArgument2(arguments)
          );
        };
        Git2.prototype.checkIsRepo = function(checkType, then) {
          return this._runTask(
            checkIsRepoTask2(filterType2(checkType, filterString2)),
            trailingFunctionArgument2(arguments)
          );
        };
        module.exports = Git2;
      }
    });
    init_pathspec();
    init_git_error();
    GitConstructError = class extends GitError {
      constructor(config, message) {
        super(void 0, message);
        this.config = config;
      }
    };
    init_git_error();
    init_git_error();
    GitPluginError = class extends GitError {
      constructor(task, plugin, message) {
        super(task, message);
        this.task = task;
        this.plugin = plugin;
        Object.setPrototypeOf(this, new.target.prototype);
      }
    };
    init_git_response_error();
    init_task_configuration_error();
    init_check_is_repo();
    init_clean();
    init_config();
    init_diff_name_status();
    init_grep();
    init_reset();
    preventUnsafeConfig = [
      preventConfigBuilder(
        /^\s*protocol(.[a-z]+)?.allow/i,
        "allowUnsafeProtocolOverride",
        "protocol.allow"
      ),
      preventConfigBuilder("core.sshCommand", "allowUnsafeSshCommand"),
      preventConfigBuilder("core.gitProxy", "allowUnsafeGitProxy"),
      preventConfigBuilder("core.hooksPath", "allowUnsafeHooksPath"),
      preventConfigBuilder("diff.external", "allowUnsafeDiffExternal")
    ];
    init_utils();
    init_utils();
    never = (0, import_promise_deferred2.deferred)().promise;
    init_utils();
    WRONG_NUMBER_ERR = `Invalid value supplied for custom binary, requires a single string or an array containing either one or two strings`;
    WRONG_CHARS_ERR = `Invalid value supplied for custom binary, restricted characters must be removed or supply the unsafe.allowUnsafeCustomBinary option`;
    init_git_error();
    init_utils();
    PluginStore = class {
      constructor() {
        this.plugins = /* @__PURE__ */ new Set();
        this.events = new EventEmitter();
      }
      on(type, listener) {
        this.events.on(type, listener);
      }
      reconfigure(type, data) {
        this.events.emit(type, data);
      }
      append(type, action) {
        const plugin = append(this.plugins, { type, action });
        return () => this.plugins.delete(plugin);
      }
      add(plugin) {
        const plugins = [];
        asArray(plugin).forEach((plugin2) => plugin2 && this.plugins.add(append(plugins, plugin2)));
        return () => {
          plugins.forEach((plugin2) => this.plugins.delete(plugin2));
        };
      }
      exec(type, data, context) {
        let output = data;
        const contextual = Object.freeze(Object.create(context));
        for (const plugin of this.plugins) {
          if (plugin.type === type) {
            output = plugin.action(output, contextual);
          }
        }
        return output;
      }
    };
    init_utils();
    init_utils();
    init_pathspec();
    init_utils();
    Git = require_git();
    init_git_response_error();
    esm_default = gitInstanceFactory;
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
function initGitService(cwd) {
  git = esm_default(cwd || process.cwd());
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
  const diffText = await g.diff([diffBase]);
  const diffStat = await g.diffSummary([diffBase]);
  return {
    diff: diffText.substring(0, 1024 * 1024),
    // 1MB limit
    files: diffStat.files.map((f) => ({
      file: f.file,
      insertions: f.insertions,
      deletions: f.deletions
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
async function createWorktree(branch, path4) {
  const g = getGit();
  await g.raw(["worktree", "add", "-b", branch, path4, "dev"]);
}
async function compareBranches(base, head) {
  const g = getGit();
  const diffStat = await g.diffSummary([`${base}...${head}`]);
  const aheadLog = await g.log({ from: base, to: head });
  const behindLog = await g.log({ from: head, to: base });
  return {
    ahead: aheadLog.total,
    behind: behindLog.total,
    files: diffStat.files.map((f) => ({
      file: f.file,
      insertions: f.insertions,
      deletions: f.deletions
    }))
  };
}
function watchGitChanges(onChange) {
  const fs6 = __require("fs");
  const path4 = __require("path");
  const gitDir = path4.join(process.cwd(), ".git");
  try {
    const watcher = fs6.watch(
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
var git;
var init_git_service = __esm({
  "src/git-service.ts"() {
    "use strict";
    init_esm();
    git = null;
  }
});

// src/ws-handler.ts
import crypto3 from "crypto";
import { WebSocketServer } from "ws";
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
function generateClientId() {
  return crypto3.randomBytes(4).toString("hex");
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
function setupWebSocket(httpServer2, TOKEN2, PASSWORD2) {
  setBroadcastHooks(sendEnvelope, getClientList);
  const wss2 = new WebSocketServer({ noServer: true });
  httpServer2.on("upgrade", (req, socket, head) => {
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
              sendEnvelope(ws, "auth_ok", {
                deviceId: deviceInfo?.id ?? null,
                trust: deviceInfo?.trust ?? null
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
          if (p.type === "attach_first") {
            const name = p.session || "main";
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
            const session = createSession(p.session || "main");
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
              if (!found2.tab.ended) found2.tab.pty.kill();
              found2.session.tabs = found2.session.tabs.filter(
                (t) => t.id !== p.tabId
              );
              if (found2.session.tabs.length === 0) {
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
                p.sessionName || "main",
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
              sessionName: p.sessionName || "main",
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
            const runs = listRuns(p.topicId || void 0);
            sendEnvelope(ws, "run_list", { runs });
            return;
          }
          if (p.type === "capture_snapshot") {
            const tabId = ws._remuxTabId;
            if (tabId != null) {
              const result = captureSnapshot(
                clientState.currentSession || "main",
                tabId,
                p.topicId || void 0
              );
              if (result) {
                sendEnvelope(ws, "snapshot_captured", result.artifact);
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
              runId: p.runId || void 0
            });
            sendEnvelope(ws, "artifact_list", { artifacts });
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
              const note = createNote(p.content.trim());
              sendEnvelope(ws, "note_created", note);
            }
            return;
          }
          if (p.type === "list_notes") {
            const notes = listNotes();
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
      if (found && !found.tab.ended) {
        found.tab.pty.write(msg);
      }
    });
    ws.on("close", () => {
      const tabId = ws._remuxTabId;
      const wasActive = clientState.role === "active";
      if (ws._remuxDeviceId) {
        const sockets = deviceSockets.get(ws._remuxDeviceId);
        if (sockets) {
          sockets.delete(ws);
          if (sockets.size === 0) deviceSockets.delete(ws._remuxDeviceId);
        }
      }
      detachFromTab(ws);
      controlClients.delete(ws);
      clientStates.delete(ws);
      if (tabId != null) {
        reassignRolesAfterDetach(tabId, wasActive);
        broadcastState();
      }
    });
    ws.on("error", () => {
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
var ACTIVE_IDLE_TIMEOUT_MS, clientStates, deviceSockets;
var init_ws_handler = __esm({
  "src/ws-handler.ts"() {
    "use strict";
    init_session();
    init_auth();
    init_store();
    init_push();
    init_store();
    init_workspace();
    ACTIVE_IDLE_TIMEOUT_MS = 12e4;
    clientStates = /* @__PURE__ */ new Map();
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
          listener(event);
        }
      }
      /** Forward terminal data to all passive adapters */
      dispatchTerminalData(sessionName, data) {
        for (const adapter of this.adapters.values()) {
          if (adapter.mode === "passive" && adapter.onTerminalData) {
            try {
              adapter.onTerminalData(sessionName, data);
            } catch {
            }
          }
        }
      }
      /** Forward event file data to all passive adapters */
      dispatchEventFile(path4, event) {
        for (const adapter of this.adapters.values()) {
          if (adapter.mode === "passive" && adapter.onEventFile) {
            try {
              adapter.onEventFile(path4, event);
            } catch {
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
import * as path2 from "path";
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
      lastFileSize = 0;
      eventsDir;
      onEmit;
      constructor(onEmit) {
        this.onEmit = onEmit;
        this.eventsDir = path2.join(os.homedir(), ".claude", "projects");
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
                this.processEventFile(path2.join(this.eventsDir, filename));
              }
            }
          );
        } catch {
        }
      }
      processEventFile(filePath) {
        try {
          const stat = fs4.statSync(filePath);
          if (stat.size <= this.lastFileSize) return;
          const fd = fs4.openSync(filePath, "r");
          const buffer = Buffer.alloc(stat.size - this.lastFileSize);
          fs4.readSync(fd, buffer, 0, buffer.length, this.lastFileSize);
          fs4.closeSync(fd);
          this.lastFileSize = stat.size;
          const lines = buffer.toString().split("\n").filter((l) => l.trim());
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

// src/adapters/index.ts
var init_adapters = __esm({
  "src/adapters/index.ts"() {
    "use strict";
    init_registry();
    init_generic_shell();
    init_claude_code();
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
        reject(new Error("cloudflared tunnel URL not detected within 30s"));
      }
    }, TIMEOUT_MS);
    function handleData(data) {
      output += data.toString();
      const match = output.match(TUNNEL_URL_RE);
      if (match && !resolved) {
        resolved = true;
        clearTimeout(timer);
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

// src/server.ts
var server_exports = {};
__export(server_exports, {
  adapterRegistry: () => adapterRegistry
});
import fs5 from "fs";
import http from "http";
import path3 from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import qrcode from "qrcode-terminal";
function findGhosttyWeb() {
  const ghosttyWebMain = require2.resolve("ghostty-web");
  const ghosttyWebRoot = ghosttyWebMain.replace(/[/\\]dist[/\\].*$/, "");
  const distPath2 = path3.join(ghosttyWebRoot, "dist");
  const wasmPath2 = path3.join(ghosttyWebRoot, "ghostty-vt.wasm");
  if (fs5.existsSync(path3.join(distPath2, "ghostty-web.js")) && fs5.existsSync(wasmPath2)) {
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
        const tab = createTab(session);
        tab.title = t.title || tab.title;
        if (t.scrollback) {
          tab.scrollback.write(t.scrollback);
        }
      }
      if (session.tabs.length === 0) createTab(session);
    }
  }
  if (sessionMap.size === 0) {
    const s = createSession("main");
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
}
function serveFile(filePath, res) {
  const ext = path3.extname(filePath);
  fs5.readFile(filePath, (err, data) => {
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
  persistSessions();
  closeDb();
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
      if (!tab.ended) tab.pty.kill();
    }
  }
  process.exit(0);
}
var __filename, __dirname, require2, PKG, VERSION, PORT2, TOKEN, PASSWORD, tunnelMode, tunnelProcess, distPath, wasmPath, startupDone, adapterRegistry, HTML_TEMPLATE, SW_SCRIPT, MIME, httpServer, wss;
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
    __filename = fileURLToPath(import.meta.url);
    __dirname = path3.dirname(__filename);
    require2 = createRequire(import.meta.url);
    PKG = JSON.parse(
      fs5.readFileSync(path3.join(__dirname, "package.json"), "utf8")
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
        display: flex; align-items: center; gap: 8px; }
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
      #terminal { flex: 1; background: var(--bg); overflow: hidden; }
      #terminal canvas { display: block; }
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
      .pair-input-area input { flex: 1; padding: 5px 8px; font-size: 13px; font-family: 'Menlo','Monaco',monospace;
        background: var(--bg); border: 1px solid var(--compose-border); border-radius: 4px;
        color: var(--text); outline: none; text-align: center; letter-spacing: 2px; }
      .pair-input-area input:focus { border-color: var(--accent); }
      .pair-input-area .pair-btn { width: auto; }

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
          margin-left: -220px; box-shadow: 4px 0 20px rgba(0,0,0,.5); }
        .sidebar.open { margin-left: 0; }
        .sidebar-overlay { display: none; position: fixed; inset: 0;
          background: rgba(0,0,0,.4); z-index: 99; }
        .sidebar-overlay.visible { display: block; }
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

      let term, fitAddon;
      function createTerminal(themeMode) {
        const container = document.getElementById('terminal');
        if (term) { term.dispose(); container.innerHTML = ''; }
        term = window._remuxTerm = new Terminal({ cols: 80, rows: 24,
          fontFamily: 'Menlo, Monaco, "Courier New", monospace',
          fontSize: 14, cursorBlink: true,
          theme: THEMES[themeMode] || THEMES.dark,
          scrollback: 10000 });
        fitAddon = new FitAddon();
        term.loadAddon(fitAddon);
        term.open(container);
        fitAddon.fit();
        fitAddon.observeResize();
        return term;
      }
      createTerminal(initTheme);
      window.addEventListener('resize', () => { if (fitAddon) fitAddon.fit(); });

      let sessions = [], currentSession = 'main', currentTabId = null, ws = null, ctrlActive = false;
      let myClientId = null, myRole = null, clientsList = [];
      const $ = id => document.getElementById(id);
      const setStatus = (s, t) => { $('status-dot').className = 'status-dot ' + s; $('status-text').textContent = t; };

      // -- Theme switching --
      function setTheme(mode) {
        document.documentElement.setAttribute('data-theme', mode);
        localStorage.setItem('remux-theme', mode);
        $('btn-theme').innerHTML = mode === 'dark' ? '&#9728;' : '&#9790;';
        // Recreate terminal with new theme (ghostty-web doesn't support runtime theme change)
        createTerminal(mode);
        // Rebind terminal I/O
        term.onData(data => {
          if (!ws || ws.readyState !== WebSocket.OPEN) return;
          if (ctrlActive) {
            ctrlActive = false; $('btn-ctrl').classList.remove('active');
            const ch = data.toLowerCase().charCodeAt(0);
            if (ch >= 0x61 && ch <= 0x7a) { ws.send(String.fromCharCode(ch - 0x60)); return; }
          }
          ws.send(data);
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
          sidebar.classList.toggle('open');
          overlay.classList.toggle('visible', sidebar.classList.contains('open'));
        } else { sidebar.classList.toggle('collapsed'); }
        setTimeout(() => fitAddon.fit(), 250);
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
          el.innerHTML = '<span class="dot"></span><span class="name">' + s.name
            + '</span><span class="count">' + live + '</span>'
            + '<button class="del" data-del="' + s.name + '">\xD7</button>';
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
                  // Last session deleted \u2014 server will create a new one on next attach
                  sendCtrl({ type: 'new_session', name: 'main', cols: term.cols, rows: term.rows });
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
          el.innerHTML = '<span class="title">' + t.title + '</span>' + countBadge
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
        ws = new WebSocket(proto + '//' + location.host + '/ws');
        ws.onopen = () => {
          backoffMs = 1000; // reset backoff on successful connection
          startHeartbeat();
          if (urlToken) ws.send(JSON.stringify({ type: 'auth', token: urlToken }));
          sendCtrl({ type: 'attach_first', session: currentSession || 'main', cols: term.cols, rows: term.rows });
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
              if (msg.type === 'auth_ok') {
                if (msg.deviceId) myDeviceId = msg.deviceId;
                // Request device list and workspace data after auth
                sendCtrl({ type: 'list_devices' });
                sendCtrl({ type: 'list_notes' });
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
                renderSessions(); renderTabs(); renderRole(); return;
              }
              if (msg.type === 'attached') {
                currentTabId = msg.tabId; currentSession = msg.session;
                if (msg.clientId) myClientId = msg.clientId;
                if (msg.role) myRole = msg.role;
                setStatus('connected', msg.session); renderSessions(); renderTabs(); renderRole(); return;
              }
              if (msg.type === 'role_changed') {
                if (msg.clientId === myClientId) myRole = msg.role;
                renderRole(); return;
              }
              if (msg.type === 'inspect_result') {
                window._inspectText = msg.text || '(empty)';
                const m = msg.meta || {};
                $('inspect-meta').innerHTML =
                  '<span>' + (m.session || '') + ' / ' + (m.tabTitle || 'Tab ' + m.tabId) + '</span>' +
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
                // Optimistic render: add artifact directly
                if (msg.id) wsArtifacts.unshift({ id: msg.id, type: 'snapshot', title: msg.title || 'Snapshot', content: msg.content, createdAt: msg.createdAt || Date.now() });
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
          term.write(e.data);
        };
        ws.onclose = () => { stopHeartbeat(); scheduleReconnect(); };
        ws.onerror = () => setStatus('disconnected', 'Error');
      }
      connect();
      function sendCtrl(msg) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); }

      // -- Terminal I/O --
      term.onData(data => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        if (ctrlActive) {
          ctrlActive = false; $('btn-ctrl').classList.remove('active');
          const ch = data.toLowerCase().charCodeAt(0);
          if (ch >= 0x61 && ch <= 0x7a) { ws.send(String.fromCharCode(ch - 0x60)); return; }
        }
        ws.send(data);
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
        if (d && ws && ws.readyState === WebSocket.OPEN) ws.send(d);
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
        if (mode === 'live') { term.focus(); fitAddon.fit(); }
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
          el.innerHTML = '<span class="device-dot ' + d.trust + '"></span>'
            + '<span class="device-name">' + d.name + (isSelf ? ' <span class="device-self">(you)</span>' : '') + '</span>'
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

        // Show actions only for trusted devices
        const isTrusted = devicesList.find(d => d.id === myDeviceId && d.trust === 'trusted');
        if (actions) {
          actions.style.display = isTrusted ? 'block' : 'none';
          // Show pair input for untrusted devices
          const pairInput = $('pair-input-area');
          if (pairInput && !isTrusted) {
            pairInput.style.display = 'flex';
            actions.style.display = 'block';
          }
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
        if (code.length === 6) sendCtrl({ type: 'pair', code });
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
            userNotificationAllowed: true,
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
        sendCtrl({ type: 'list_topics', sessionName: currentSession });
        sendCtrl({ type: 'list_runs' });
        sendCtrl({ type: 'list_artifacts' });
        sendCtrl({ type: 'list_approvals' });
        sendCtrl({ type: 'list_notes' });
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
              '<span class="ws-card-title">' + (a.title || '') + '</span>' +
              '<span class="ws-card-meta">' + timeAgo(a.createdAt) + '</span>' +
            '</div>' +
            (a.description ? '<div class="ws-card-desc">' + a.description + '</div>' : '') +
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
              '<span class="ws-card-title">' + (t.title || '') + '</span>' +
              '<span class="ws-card-meta">' + timeAgo(t.createdAt) + '</span>' +
              '<button class="del-topic" data-del-topic="' + t.id + '" title="Delete">&times;</button>' +
            '</div>' +
            '<div class="ws-card-meta">' + t.sessionName + '</div>' +
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
              '<span class="ws-card-title">' + (r.command || '(no command)') + '</span>' +
              '<span class="ws-card-meta">' + timeAgo(r.startedAt) + '</span>' +
            '</div>' +
            (r.exitCode !== null ? '<div class="ws-card-meta">Exit: ' + r.exitCode + '</div>' : '') +
          '</div>'
        ).join('');
      }

      function renderWorkspaceArtifacts() {
        const el = $('ws-artifacts');
        if (!el) return;
        // Filter artifacts to current session (title contains "session / Tab")
        const sessionArtifacts = wsArtifacts.filter(a =>
          !a.title || a.title.includes(currentSession + ' /') || a.title.includes(currentSession + '/')
        );
        const recent = sessionArtifacts.slice(-10).reverse();
        if (recent.length === 0) { el.innerHTML = '<div class="ws-empty">No artifacts</div>'; return; }
        el.innerHTML = recent.map(a =>
          '<div class="ws-card">' +
            '<div class="ws-card-header">' +
              '<span class="ws-badge ' + a.type + '">' + a.type + '</span>' +
              '<span class="ws-card-title">' + (a.title || '') + '</span>' +
              '<span class="ws-card-meta">' + timeAgo(a.createdAt) + '</span>' +
            '</div>' +
          '</div>'
        ).join('');
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

      // -- Mobile --
      let fitDebounceTimer = null;
      if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', () => {
          document.body.style.height = window.visualViewport.height + 'px';
          // Debounce fit() to avoid excessive recalculations during keyboard animation
          clearTimeout(fitDebounceTimer);
          fitDebounceTimer = setTimeout(() => { if (fitAddon) fitAddon.fit(); }, 100);
        });
        window.visualViewport.addEventListener('scroll', () => window.scrollTo(0, 0));
      }
      // iOS Safari: touching terminal area focuses hidden textarea for input
      document.getElementById('terminal').addEventListener('touchend', () => { if (currentView === 'live') term.focus(); });
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
            passwordTokens.add(sessionToken);
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
        TOKEN != null && urlToken === TOKEN || passwordTokens.has(urlToken);
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
        return serveFile(path3.join(distPath, url.pathname.slice(6)), res);
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

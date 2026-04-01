#!/usr/bin/env node

// src/server.ts
import fs4 from "fs";
import http from "http";
import path2 from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import qrcode from "qrcode-terminal";

// src/auth.ts
import crypto2 from "crypto";

// src/store.ts
import Database from "better-sqlite3";
import path from "path";
import { homedir } from "os";
import fs from "fs";
import crypto from "crypto";
var REMUX_DIR = path.join(homedir(), ".remux");
var PORT = process.env.PORT || 8767;
var PERSIST_ID = process.env.REMUX_INSTANCE_ID || `port-${PORT}`;
function getDbPath() {
  return path.join(REMUX_DIR, `remux-${PERSIST_ID}.db`);
}
var _db = null;
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

// src/auth.ts
var passwordTokens = /* @__PURE__ */ new Set();
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
var PASSWORD_PAGE = `<!doctype html>
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

// src/vt-tracker.ts
import fs2 from "fs";
var wasmExports = null;
var wasmMemory = null;
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

// src/push.ts
import webpush from "web-push";
var VAPID_PUBLIC_KEY = "vapid_public_key";
var VAPID_PRIVATE_KEY = "vapid_private_key";
var VAPID_SUBJECT = "mailto:remux@localhost";
var vapidPublicKey = null;
var vapidReady = false;
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

// src/session.ts
import fs3 from "fs";
import { homedir as homedir2 } from "os";
import pty from "node-pty";
var IDLE_THRESHOLD_MS = 5 * 60 * 1e3;
var lastOutputTimestamp = Date.now();
var isIdle = false;
var RingBuffer = class {
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
var tabIdCounter = 0;
var sessionMap = /* @__PURE__ */ new Map();
var controlClients = /* @__PURE__ */ new Set();
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
    title: `Tab ${session.tabs.length + 1}`
  };
  ptyProcess.onData((data) => {
    tab.scrollback.write(data);
    if (tab.vt) tab.vt.consume(data);
    for (const ws of tab.clients) {
      if (ws.readyState === ws.OPEN) ws.send(data);
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
  if (!tab.ended) {
    setTimeout(() => {
      tab.pty.write("\f");
    }, 50);
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
var _sendEnvelopeFn = null;
var _getClientListFn = null;
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
var PERSIST_INTERVAL_MS = 8e3;
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

// src/ws-handler.ts
import crypto3 from "crypto";
import { WebSocketServer } from "ws";

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

// src/ws-handler.ts
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
var clientStates = /* @__PURE__ */ new Map();
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
  } else {
    state.role = "observer";
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
var deviceSockets = /* @__PURE__ */ new Map();
function setupWebSocket(httpServer2, TOKEN2, PASSWORD2) {
  setBroadcastHooks(sendEnvelope, getClientList);
  const wss = new WebSocketServer({ noServer: true });
  httpServer2.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === "/ws") {
      wss.handleUpgrade(
        req,
        socket,
        head,
        (ws) => wss.emit("connection", ws, req)
      );
    } else {
      socket.destroy();
    }
  });
  const HEARTBEAT_INTERVAL = 3e4;
  setInterval(() => {
    for (const ws of controlClients) {
      if (ws.readyState === ws.OPEN) ws.ping();
    }
  }, HEARTBEAT_INTERVAL);
  wss.on("connection", (rawWs, req) => {
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
              if (found2.session.tabs.length === 0 && found2.session.name !== "main") {
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
              const text = rawText.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
              sendEnvelope(ws, "inspect_result", {
                text,
                meta: { timestamp: Date.now() }
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
          return;
        } catch {
        }
      }
      if (clientState.role !== "active") return;
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
  return wss;
}

// src/tunnel.ts
import { spawn, execFile } from "child_process";
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
var TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
function startTunnel(port, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
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

// src/server.ts
var __filename = fileURLToPath(import.meta.url);
var __dirname = path2.dirname(__filename);
var require2 = createRequire(import.meta.url);
var PKG = JSON.parse(
  fs4.readFileSync(path2.join(__dirname, "package.json"), "utf8")
);
var VERSION = PKG.version;
var PORT2 = process.env.PORT || 8767;
var { TOKEN, PASSWORD } = resolveAuth(process.argv);
var { tunnelMode } = parseTunnelArgs(process.argv);
var tunnelProcess = null;
function findGhosttyWeb() {
  const ghosttyWebMain = require2.resolve("ghostty-web");
  const ghosttyWebRoot = ghosttyWebMain.replace(/[/\\]dist[/\\].*$/, "");
  const distPath2 = path2.join(ghosttyWebRoot, "dist");
  const wasmPath2 = path2.join(ghosttyWebRoot, "ghostty-vt.wasm");
  if (fs4.existsSync(path2.join(distPath2, "ghostty-web.js")) && fs4.existsSync(wasmPath2)) {
    return { distPath: distPath2, wasmPath: wasmPath2 };
  }
  console.error("Error: ghostty-web package not found.");
  process.exit(1);
}
var { distPath, wasmPath } = findGhosttyWeb();
var startupDone = false;
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
  startupDone = true;
}
startup().catch((e) => {
  console.error("[startup] fatal:", e);
  if (sessionMap.size === 0) {
    const s = createSession("main");
    createTab(s);
  }
  startupDone = true;
});
var HTML_TEMPLATE = `<!doctype html>
<html lang="en" data-theme="dark">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
    <title>Remux</title>
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
        min-height: 36px; padding: 0 0 0 0; }
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
      #inspect-content { font-family: 'Menlo','Monaco','Courier New',monospace; font-size: 13px;
        line-height: 1.5; color: var(--text-bright); white-space: pre; tab-size: 8;
        user-select: text; -webkit-user-select: text; }
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
              if (sessions.length <= 1) return; // don't delete last session
              sendCtrl({ type: 'delete_session', name: e.target.dataset.del });
              // if deleting current, switch to first other
              if (e.target.dataset.del === currentSession) {
                const other = sessions.find(x => x.name !== currentSession);
                if (other) selectSession(other.name);
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
              const msg = parsed.v === 1 ? { type: parsed.type, ...parsed.payload } : parsed;
              if (msg.type === 'auth_ok') {
                if (msg.deviceId) myDeviceId = msg.deviceId;
                // Request device list after auth
                sendCtrl({ type: 'list_devices' });
                return;
              }
              if (msg.type === 'auth_error') { setStatus('disconnected', 'Auth failed'); ws.close(); return; }
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
              if (msg.type === 'topic_created') { refreshWorkspace(); return; }
              if (msg.type === 'topic_deleted') { refreshWorkspace(); return; }
              if (msg.type === 'run_list') { wsRuns = msg.runs || []; renderWorkspaceRuns(); return; }
              if (msg.type === 'run_created' || msg.type === 'run_updated') { if (currentView === 'workspace') refreshWorkspace(); return; }
              if (msg.type === 'artifact_list') { wsArtifacts = msg.artifacts || []; renderWorkspaceArtifacts(); return; }
              if (msg.type === 'snapshot_captured') { if (currentView === 'workspace') refreshWorkspace(); return; }
              if (msg.type === 'approval_list') { wsApprovals = msg.approvals || []; renderWorkspaceApprovals(); return; }
              if (msg.type === 'approval_created') { if (currentView === 'workspace') refreshWorkspace(); return; }
              if (msg.type === 'approval_resolved') { if (currentView === 'workspace') refreshWorkspace(); return; }
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
      $('btn-live').addEventListener('pointerdown', e => { e.preventDefault(); setView('live'); });
      $('btn-inspect').addEventListener('pointerdown', e => { e.preventDefault(); setView('inspect'); });
      $('btn-workspace').addEventListener('pointerdown', e => { e.preventDefault(); setView('workspace'); });

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
            alert('Notification permission denied. Please enable in browser settings.');
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

      function refreshWorkspace() {
        sendCtrl({ type: 'list_topics', sessionName: currentSession });
        sendCtrl({ type: 'list_runs' });
        sendCtrl({ type: 'list_artifacts' });
        sendCtrl({ type: 'list_approvals' });
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
        const recent = wsArtifacts.slice(-10).reverse();
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
          setTimeout(refreshWorkspace, 200);
        }
      });

      $('btn-capture-snapshot').addEventListener('click', () => {
        sendCtrl({ type: 'capture_snapshot' });
        setTimeout(refreshWorkspace, 500);
      });

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
var SW_SCRIPT = `self.addEventListener('push', function(event) {
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
var MIME = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".wasm": "application/wasm",
  ".css": "text/css",
  ".json": "application/json"
};
var httpServer = http.createServer((req, res) => {
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
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden: invalid or missing token");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(HTML_TEMPLATE);
    return;
  }
  if (url.pathname.startsWith("/dist/")) {
    return serveFile(path2.join(distPath, url.pathname.slice(6)), res);
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
function serveFile(filePath, res) {
  const ext = path2.extname(filePath);
  fs4.readFile(filePath, (err, data) => {
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
setupWebSocket(httpServer, TOKEN, PASSWORD);
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
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

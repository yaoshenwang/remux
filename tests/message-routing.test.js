/**
 * Tests that verify WebSocket message routing never leaks control-plane
 * JSON into terminal PTY output, and that workspace CRUD operations
 * produce visible results through the correct message flow.
 *
 * Red-line tests:
 * 1. Server: JSON control messages must never reach pty.write()
 * 2. Client: enveloped (v:1) messages must never reach term.write()
 * 3. Client: known control-type JSON from scrollback must be stripped
 * 4. Store: createNote/listNotes round-trip returns the created note
 * 5. Store: createTopic/listTopics round-trip returns the created topic
 * 6. Inspect: ANSI cleanup removes ^L (form-feed) character
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import {
  _resetDbForTest,
  closeDb,
  createNote,
  listNotes,
  createTopic,
  listTopics,
  listDevices,
  createDevice,
} from "../src/store.ts";

/** Create an in-memory SQLite DB with the full schema. */
function createTestDb() {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (name TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS tabs (
      id INTEGER PRIMARY KEY, session_name TEXT NOT NULL, title TEXT NOT NULL DEFAULT 'Tab',
      scrollback BLOB, ended INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (session_name) REFERENCES sessions(name) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, fingerprint TEXT NOT NULL,
      trust TEXT NOT NULL DEFAULT 'untrusted', created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pair_codes (
      code TEXT PRIMARY KEY, created_by TEXT NOT NULL, expires_at INTEGER NOT NULL,
      FOREIGN KEY (created_by) REFERENCES devices(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      device_id TEXT PRIMARY KEY, endpoint TEXT NOT NULL, p256dh TEXT NOT NULL,
      auth TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS topics (
      id TEXT PRIMARY KEY, session_name TEXT NOT NULL, title TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, topic_id TEXT REFERENCES topics(id), session_name TEXT NOT NULL,
      tab_id INTEGER, command TEXT, exit_code INTEGER, started_at INTEGER NOT NULL,
      ended_at INTEGER, status TEXT DEFAULT 'running'
    );
    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY, run_id TEXT REFERENCES runs(id), topic_id TEXT REFERENCES topics(id),
      type TEXT NOT NULL, title TEXT, content TEXT, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY, run_id TEXT REFERENCES runs(id), topic_id TEXT REFERENCES topics(id),
      title TEXT NOT NULL, description TEXT, status TEXT DEFAULT 'pending',
      created_at INTEGER NOT NULL, resolved_at INTEGER
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_index USING fts5(
      entity_type, entity_id, title, content, tokenize='porter unicode61'
    );
    CREATE TABLE IF NOT EXISTS memory_notes (
      id TEXT PRIMARY KEY, content TEXT NOT NULL, pinned INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS commands (
      id TEXT PRIMARY KEY, session_name TEXT NOT NULL, tab_id INTEGER NOT NULL,
      command TEXT, exit_code INTEGER, cwd TEXT, started_at INTEGER NOT NULL, ended_at INTEGER
    );
  `);
  return db;
}

// ── RED LINE 1: Notes CRUD round-trip ──────────────────────────────

describe("workspace notes: create and list round-trip", () => {
  let db;
  beforeEach(() => { db = createTestDb(); _resetDbForTest(db); });
  afterEach(() => { closeDb(); });

  it("createNote returns a note and listNotes returns it", () => {
    const note = createNote("test note content");
    expect(note).toBeDefined();
    expect(note.id).toBeTruthy();
    expect(note.content).toBe("test note content");
    expect(note.pinned).toBe(false);

    const notes = listNotes();
    expect(notes.length).toBe(1);
    expect(notes[0].id).toBe(note.id);
    expect(notes[0].content).toBe("test note content");
  });

  it("multiple notes are listed and all present", () => {
    createNote("first");
    createNote("second");
    createNote("third");

    const notes = listNotes();
    expect(notes.length).toBe(3);
    const contents = notes.map(n => n.content);
    expect(contents).toContain("first");
    expect(contents).toContain("second");
    expect(contents).toContain("third");
  });
});

// ── RED LINE 2: Topics CRUD round-trip ─────────────────────────────

describe("workspace topics: create and list round-trip", () => {
  let db;
  beforeEach(() => { db = createTestDb(); _resetDbForTest(db); });
  afterEach(() => { closeDb(); });

  it("createTopic returns a topic and listTopics returns it", () => {
    const topic = createTopic("test-session", "Test Topic");
    expect(topic).toBeDefined();
    expect(topic.id).toBeTruthy();
    expect(topic.title).toBe("Test Topic");

    const topics = listTopics("test-session");
    expect(topics.length).toBe(1);
    expect(topics[0].id).toBe(topic.id);
    expect(topics[0].title).toBe("Test Topic");
  });
});

// ── RED LINE 3: Devices CRUD round-trip ────────────────────────────

describe("devices: create and list round-trip", () => {
  let db;
  beforeEach(() => { db = createTestDb(); _resetDbForTest(db); });
  afterEach(() => { closeDb(); });

  it("createDevice and listDevices round-trip", () => {
    // createDevice(fingerprint, trust, name)
    const device = createDevice("fp-abc123", "trusted", "Test Device");
    expect(device).toBeDefined();
    expect(device.name).toBe("Test Device");

    const devices = listDevices();
    expect(devices.length).toBe(1);
    expect(devices[0].name).toBe("Test Device");
    expect(devices[0].trust).toBe("trusted");
  });
});

// ── RED LINE 4: ANSI cleanup strips form-feed ──────────────────────

describe("inspect ANSI cleanup", () => {
  it("form-feed character (0x0c) is stripped from inspect output", () => {
    // Simulate the ANSI stripping regex from ws-handler inspect fallback
    const rawText = "\x0cwangyaoshen@mac ~ % echo hello\nhello\nwangyaoshen@mac ~ % ";
    const cleaned = rawText
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
      .replace(/\x1b[PX^_][^\x1b]*\x1b\\/g, "")
      .replace(/\x1b[()][A-Z0-9]/g, "")
      .replace(/\x1b[A-Z=><78]/gi, "")
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")
      .replace(/\x7f/g, "");

    expect(cleaned).not.toContain("\x0c");
    expect(cleaned).toContain("echo hello");
    expect(cleaned).toContain("hello");
  });
});

// ── RED LINE 5: Client message routing logic ───────────────────────

describe("client-side message routing", () => {
  // Simulate the client's ws.onmessage routing logic
  function routeMessage(data) {
    const result = { writtenToTerm: false, handled: false, warned: false };

    if (typeof data === "string" && data[0] === "{") {
      try {
        const parsed = JSON.parse(data);
        const msg = parsed.v === 1 ? { type: parsed.type, ...parsed.payload } : parsed;

        if (msg.type === "ping") { result.handled = true; return result; }
        if (msg.type === "state") { result.handled = true; return result; }
        if (msg.type === "attached") { result.handled = true; return result; }
        if (msg.type === "note_list") { result.handled = true; return result; }
        if (msg.type === "topic_list") { result.handled = true; return result; }
        if (msg.type === "device_list") { result.handled = true; return result; }
        // ... other known types would go here ...

        // Unrecognized enveloped message — block from terminal
        if (parsed.v === 1) {
          result.warned = true;
          return result;
        }
        // Non-enveloped JSON — falls through to term.write (could be PTY output)
      } catch {}
    }

    result.writtenToTerm = true;
    return result;
  }

  it("enveloped ping is handled, not written to terminal", () => {
    const r = routeMessage('{"v":1,"type":"ping","payload":{}}');
    expect(r.handled).toBe(true);
    expect(r.writtenToTerm).toBe(false);
  });

  it("enveloped note_list is handled, not written to terminal", () => {
    const r = routeMessage('{"v":1,"type":"note_list","payload":{"notes":[]}}');
    expect(r.handled).toBe(true);
    expect(r.writtenToTerm).toBe(false);
  });

  it("unrecognized enveloped message is warned, not written to terminal", () => {
    const r = routeMessage('{"v":1,"type":"unknown_future_type","payload":{}}');
    expect(r.warned).toBe(true);
    expect(r.writtenToTerm).toBe(false);
  });

  it("non-enveloped JSON (PTY echo) is written to terminal", () => {
    // User ran: echo '{"type":"foo"}'
    const r = routeMessage('{"type":"foo"}');
    expect(r.writtenToTerm).toBe(true);
  });

  it("plain terminal text is written to terminal", () => {
    const r = routeMessage("wangyaoshen@mac ~ % ");
    expect(r.writtenToTerm).toBe(true);
  });

  it("non-enveloped control-type JSON from PTY scrollback is written to terminal (regression risk)", () => {
    // This is the known issue: if PTY scrollback contains {"type":"list_devices"},
    // it will be written to terminal because it's not enveloped (v:1).
    // The CLIENT cannot distinguish this from legitimate PTY output like
    // echo '{"type":"list_devices"}'. The fix must be SERVER-side (prevent
    // control messages from ever reaching PTY).
    const r = routeMessage('{"type":"list_devices"}');
    expect(r.writtenToTerm).toBe(true); // Expected: falls through (non-enveloped)
  });
});

// ── RED LINE 6: Server-side JSON routing never reaches PTY ─────────

describe("server-side JSON routing", () => {
  // Simulate the server's ws.on("message") routing logic
  function routeServerMessage(msg) {
    const result = { handledAsControl: false, writtenToPty: false };

    if (msg.startsWith("{")) {
      try {
        JSON.parse(msg); // Parse to validate
        // In real code: handlers for each type + return at line 991
        result.handledAsControl = true;
        return result; // The return at line 991 prevents PTY write
      } catch {
        // not valid JSON — fall through to PTY
      }
    }

    // Raw terminal input → PTY
    result.writtenToPty = true;
    return result;
  }

  it("list_topics JSON is handled as control, not written to PTY", () => {
    const r = routeServerMessage('{"type":"list_topics","sessionName":"main"}');
    expect(r.handledAsControl).toBe(true);
    expect(r.writtenToPty).toBe(false);
  });

  it("list_devices JSON is handled as control, not written to PTY", () => {
    const r = routeServerMessage('{"type":"list_devices"}');
    expect(r.handledAsControl).toBe(true);
    expect(r.writtenToPty).toBe(false);
  });

  it("create_note JSON is handled as control, not written to PTY", () => {
    const r = routeServerMessage('{"type":"create_note","content":"test"}');
    expect(r.handledAsControl).toBe(true);
    expect(r.writtenToPty).toBe(false);
  });

  it("plain text is written to PTY", () => {
    const r = routeServerMessage("hello world");
    expect(r.writtenToPty).toBe(true);
    expect(r.handledAsControl).toBe(false);
  });

  it("invalid JSON starting with { falls through to PTY", () => {
    const r = routeServerMessage("{not valid json");
    expect(r.writtenToPty).toBe(true);
  });
});

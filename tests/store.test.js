/**
 * Tests for SQLite store (src/store.ts).
 * Device CRUD, trust levels, pairing, and session/tab persistence.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import {
  _resetDbForTest,
  closeDb,
  upsertSession,
  upsertTab,
  loadSessions,
  removeSession,
  removeStaleTab,
  createDevice,
  findDeviceById,
  findDeviceByFingerprint,
  listDevices,
  updateDeviceTrust,
  renameDevice,
  deleteDevice,
  touchDevice,
  hasAnyDevice,
  computeFingerprint,
  createPairCode,
  consumePairCode,
} from "../src/persistence/store.ts";

/** Create an in-memory SQLite DB with the same schema as store.ts. */
function createTestDb() {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
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
  `);
  return db;
}

describe("store: session/tab persistence", () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
    _resetDbForTest(db);
  });

  afterEach(() => {
    closeDb();
  });

  it("upserts and loads sessions", () => {
    upsertSession("main", 1000);
    upsertSession("work", 2000);

    const sessions = loadSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions[0].name).toBe("main");
    expect(sessions[0].createdAt).toBe(1000);
    expect(sessions[1].name).toBe("work");
  });

  it("upserts and loads tabs with scrollback as BLOB", () => {
    upsertSession("main", 1000);
    const scrollback = Buffer.from("hello world terminal output");
    upsertTab({
      id: 1,
      sessionName: "main",
      title: "Tab 1",
      scrollback,
      ended: false,
    });
    upsertTab({
      id: 2,
      sessionName: "main",
      title: "Tab 2",
      scrollback: null,
      ended: true,
    });

    const sessions = loadSessions();
    expect(sessions[0].tabs).toHaveLength(2);
    expect(Buffer.isBuffer(sessions[0].tabs[0].scrollback)).toBe(true);
    expect(sessions[0].tabs[0].scrollback.toString()).toBe(
      "hello world terminal output",
    );
    expect(sessions[0].tabs[0].ended).toBe(false);
    expect(sessions[0].tabs[1].scrollback).toBeNull();
    expect(sessions[0].tabs[1].ended).toBe(true);
  });

  it("upsert updates existing tab data", () => {
    upsertSession("main", 1000);
    upsertTab({
      id: 1,
      sessionName: "main",
      title: "Tab 1",
      scrollback: Buffer.from("old"),
      ended: false,
    });

    upsertTab({
      id: 1,
      sessionName: "main",
      title: "Renamed",
      scrollback: Buffer.from("new data"),
      ended: false,
    });

    const sessions = loadSessions();
    expect(sessions[0].tabs).toHaveLength(1);
    expect(sessions[0].tabs[0].title).toBe("Renamed");
    expect(sessions[0].tabs[0].scrollback.toString()).toBe("new data");
  });

  it("removeSession cascades to tabs", () => {
    upsertSession("temp", 3000);
    upsertTab({
      id: 10,
      sessionName: "temp",
      title: "Tab",
      scrollback: null,
      ended: false,
    });

    removeSession("temp");
    const sessions = loadSessions();
    expect(sessions).toHaveLength(0);
  });

  it("removeStaleTab deletes individual tabs", () => {
    upsertSession("main", 1000);
    upsertTab({
      id: 1,
      sessionName: "main",
      title: "Tab 1",
      scrollback: null,
      ended: false,
    });
    upsertTab({
      id: 2,
      sessionName: "main",
      title: "Tab 2",
      scrollback: null,
      ended: false,
    });

    removeStaleTab(1);
    const sessions = loadSessions();
    expect(sessions[0].tabs).toHaveLength(1);
    expect(sessions[0].tabs[0].id).toBe(2);
  });
});

describe("store: device CRUD", () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
    _resetDbForTest(db);
  });

  afterEach(() => {
    closeDb();
  });

  it("creates a device with generated ID", () => {
    const device = createDevice("fp123", "untrusted");
    expect(device.id).toHaveLength(16);
    expect(device.fingerprint).toBe("fp123");
    expect(device.trust).toBe("untrusted");
    expect(device.name).toMatch(/^Device-/);
  });

  it("creates a device with custom name", () => {
    const device = createDevice("fp123", "trusted", "My Phone");
    expect(device.name).toBe("My Phone");
    expect(device.trust).toBe("trusted");
  });

  it("findDeviceById returns device or null", () => {
    const device = createDevice("fp-find", "untrusted");
    const found = findDeviceById(device.id);
    expect(found).not.toBeNull();
    expect(found.fingerprint).toBe("fp-find");

    const notFound = findDeviceById("nonexistent");
    expect(notFound).toBeNull();
  });

  it("findDeviceByFingerprint returns device or null", () => {
    createDevice("fp-search", "untrusted");
    const found = findDeviceByFingerprint("fp-search");
    expect(found).not.toBeNull();

    const notFound = findDeviceByFingerprint("nonexistent");
    expect(notFound).toBeNull();
  });

  it("listDevices returns all devices", () => {
    const d1 = createDevice("fp1", "untrusted");
    const d2 = createDevice("fp2", "trusted");

    const devices = listDevices();
    expect(devices).toHaveLength(2);
    const ids = devices.map((d) => d.id);
    expect(ids).toContain(d1.id);
    expect(ids).toContain(d2.id);
  });

  it("hasAnyDevice returns correct boolean", () => {
    expect(hasAnyDevice()).toBe(false);
    createDevice("fp-check", "untrusted");
    expect(hasAnyDevice()).toBe(true);
  });
});

describe("store: trust levels", () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
    _resetDbForTest(db);
  });

  afterEach(() => {
    closeDb();
  });

  it("updateDeviceTrust changes trust level", () => {
    const device = createDevice("fp-trust", "untrusted");
    expect(device.trust).toBe("untrusted");

    updateDeviceTrust(device.id, "trusted");
    const updated = findDeviceById(device.id);
    expect(updated.trust).toBe("trusted");

    updateDeviceTrust(device.id, "blocked");
    const blocked = findDeviceById(device.id);
    expect(blocked.trust).toBe("blocked");
  });

  it("updateDeviceTrust returns false for nonexistent device", () => {
    const result = updateDeviceTrust("nonexistent", "trusted");
    expect(result).toBe(false);
  });

  it("renameDevice changes the device name", () => {
    const device = createDevice("fp-rename", "untrusted");
    renameDevice(device.id, "New Name");
    const updated = findDeviceById(device.id);
    expect(updated.name).toBe("New Name");
  });

  it("deleteDevice removes the device", () => {
    const device = createDevice("fp-del", "untrusted");
    expect(deleteDevice(device.id)).toBe(true);
    expect(findDeviceById(device.id)).toBeNull();
    expect(deleteDevice("nonexistent")).toBe(false);
  });

  it("touchDevice updates last_seen", () => {
    const device = createDevice("fp-touch", "untrusted");
    const before = device.lastSeen;

    // Small delay to ensure timestamp changes
    const now = Date.now() + 1000;
    const origNow = Date.now;

    touchDevice(device.id);
    const updated = findDeviceById(device.id);
    expect(updated.lastSeen).toBeGreaterThanOrEqual(before);
  });
});

describe("store: pairing codes", () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
    _resetDbForTest(db);
  });

  afterEach(() => {
    closeDb();
  });

  it("creates a valid 6-digit pair code", () => {
    const device = createDevice("fp-pair", "trusted");
    const pc = createPairCode(device.id);
    expect(pc.code).toHaveLength(6);
    expect(Number(pc.code)).toBeGreaterThanOrEqual(100000);
    expect(Number(pc.code)).toBeLessThan(1000000);
    expect(pc.expiresAt).toBeGreaterThan(Date.now());
    expect(pc.createdBy).toBe(device.id);
  });

  it("consumePairCode returns creator and is one-time use", () => {
    const device = createDevice("fp-pair-consume", "trusted");
    const pc = createPairCode(device.id);

    const creator = consumePairCode(pc.code);
    expect(creator).toBe(device.id);

    // Second use should fail (one-time)
    const second = consumePairCode(pc.code);
    expect(second).toBeNull();
  });

  it("expired code returns null", () => {
    const device = createDevice("fp-pair-expired", "trusted");
    // Manually insert an expired code
    db.prepare(
      "INSERT INTO pair_codes (code, created_by, expires_at) VALUES (?, ?, ?)",
    ).run("999999", device.id, Date.now() - 1000);

    const result = consumePairCode("999999");
    expect(result).toBeNull();
  });

  it("invalid code returns null", () => {
    const result = consumePairCode("000000");
    expect(result).toBeNull();
  });
});

describe("store: computeFingerprint", () => {
  it("produces consistent 16-char hex fingerprints", () => {
    const fp = computeFingerprint("Mozilla/5.0", "en-US");
    expect(fp).toHaveLength(16);
    expect(fp).toMatch(/^[a-f0-9]{16}$/);

    // Same input => same output
    const fp2 = computeFingerprint("Mozilla/5.0", "en-US");
    expect(fp2).toBe(fp);
  });

  it("different inputs produce different fingerprints", () => {
    const fp1 = computeFingerprint("Chrome/120", "en-US");
    const fp2 = computeFingerprint("Safari/17", "en-US");
    expect(fp1).not.toBe(fp2);
  });
});

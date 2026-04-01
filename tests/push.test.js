/**
 * Tests for Web Push module (src/push.ts) and store push subscription CRUD.
 * VAPID key generation/persistence, subscription management, broadcast logic.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import {
  _resetDbForTest,
  closeDb,
  getSetting,
  setSetting,
  savePushSubscription,
  getPushSubscription,
  removePushSubscription,
  listPushSubscriptions,
  createDevice,
} from "../src/store.ts";

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
  return db;
}

describe("store: settings KV", () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
    _resetDbForTest(db);
  });

  afterEach(() => {
    closeDb();
  });

  it("getSetting returns null for missing key", () => {
    expect(getSetting("nonexistent")).toBeNull();
  });

  it("setSetting creates a new setting", () => {
    setSetting("test_key", "test_value");
    expect(getSetting("test_key")).toBe("test_value");
  });

  it("setSetting upserts existing setting", () => {
    setSetting("key", "old_value");
    setSetting("key", "new_value");
    expect(getSetting("key")).toBe("new_value");
  });

  it("handles empty string values", () => {
    setSetting("empty", "");
    expect(getSetting("empty")).toBe("");
  });
});

describe("store: push subscriptions", () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
    _resetDbForTest(db);
  });

  afterEach(() => {
    closeDb();
  });

  it("saves and retrieves a push subscription", () => {
    savePushSubscription("dev-1", "https://push.example.com/sub1", "p256dh_key", "auth_key");
    const sub = getPushSubscription("dev-1");
    expect(sub).not.toBeNull();
    expect(sub.deviceId).toBe("dev-1");
    expect(sub.endpoint).toBe("https://push.example.com/sub1");
    expect(sub.p256dh).toBe("p256dh_key");
    expect(sub.auth).toBe("auth_key");
    expect(sub.createdAt).toBeGreaterThan(0);
  });

  it("returns null for non-existent subscription", () => {
    expect(getPushSubscription("nonexistent")).toBeNull();
  });

  it("upserts subscription for same device", () => {
    savePushSubscription("dev-1", "https://old.example.com", "old_p256dh", "old_auth");
    savePushSubscription("dev-1", "https://new.example.com", "new_p256dh", "new_auth");

    const sub = getPushSubscription("dev-1");
    expect(sub.endpoint).toBe("https://new.example.com");
    expect(sub.p256dh).toBe("new_p256dh");
    expect(sub.auth).toBe("new_auth");

    // Should only be one record
    const all = listPushSubscriptions();
    expect(all).toHaveLength(1);
  });

  it("removes a push subscription", () => {
    savePushSubscription("dev-1", "https://push.example.com", "p256dh", "auth");
    expect(removePushSubscription("dev-1")).toBe(true);
    expect(getPushSubscription("dev-1")).toBeNull();
  });

  it("removePushSubscription returns false for non-existent", () => {
    expect(removePushSubscription("nonexistent")).toBe(false);
  });

  it("lists all push subscriptions", () => {
    savePushSubscription("dev-1", "https://push.example.com/1", "p1", "a1");
    savePushSubscription("dev-2", "https://push.example.com/2", "p2", "a2");
    savePushSubscription("dev-3", "https://push.example.com/3", "p3", "a3");

    const all = listPushSubscriptions();
    expect(all).toHaveLength(3);
    const deviceIds = all.map((s) => s.deviceId);
    expect(deviceIds).toContain("dev-1");
    expect(deviceIds).toContain("dev-2");
    expect(deviceIds).toContain("dev-3");
  });

  it("empty list when no subscriptions", () => {
    expect(listPushSubscriptions()).toHaveLength(0);
  });
});

describe("push: VAPID key generation and persistence", () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
    _resetDbForTest(db);
  });

  afterEach(() => {
    closeDb();
    vi.restoreAllMocks();
  });

  it("initPush generates and persists VAPID keys on first run", async () => {
    // Dynamic import to get fresh module state
    const { initPush, getVapidPublicKey, isPushReady } = await import("../src/push.ts");

    // Before init
    // Note: module state persists across tests, so we just verify initPush works
    initPush();

    expect(isPushReady()).toBe(true);
    const publicKey = getVapidPublicKey();
    expect(publicKey).not.toBeNull();
    expect(typeof publicKey).toBe("string");
    expect(publicKey.length).toBeGreaterThan(0);

    // Verify keys were persisted in settings
    const storedPub = getSetting("vapid_public_key");
    const storedPriv = getSetting("vapid_private_key");
    expect(storedPub).toBe(publicKey);
    expect(storedPriv).not.toBeNull();
    expect(storedPriv.length).toBeGreaterThan(0);
  });

  it("initPush loads existing VAPID keys on subsequent run", async () => {
    // Pre-populate settings with known keys
    const { initPush: initPush2, getVapidPublicKey: getKey2 } = await import("../src/push.ts");

    // First init generates keys
    initPush2();
    const firstKey = getKey2();

    // Store the key, re-init should load the same key
    const storedKey = getSetting("vapid_public_key");
    expect(storedKey).toBe(firstKey);

    // Re-init should use stored keys (not generate new ones)
    initPush2();
    expect(getKey2()).toBe(firstKey);
  });
});

describe("push: sendPushNotification", () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
    _resetDbForTest(db);
  });

  afterEach(() => {
    closeDb();
    vi.restoreAllMocks();
  });

  it("returns false when no subscription exists for device", async () => {
    const { initPush, sendPushNotification } = await import("../src/push.ts");
    initPush();

    const result = await sendPushNotification("no-such-device", "Title", "Body");
    expect(result).toBe(false);
  });
});

describe("push: broadcastPush", () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
    _resetDbForTest(db);
  });

  afterEach(() => {
    closeDb();
    vi.restoreAllMocks();
  });

  it("skips excluded device IDs", async () => {
    const { initPush, broadcastPush } = await import("../src/push.ts");
    initPush();

    // Add subscriptions for two devices
    savePushSubscription("dev-a", "https://push.example.com/a", "pa", "aa");
    savePushSubscription("dev-b", "https://push.example.com/b", "pb", "ab");

    // broadcastPush with both excluded should effectively be a no-op
    // (won't throw since it just filters them out)
    await broadcastPush("Test", "Body", ["dev-a", "dev-b"]);

    // Verify subscriptions still exist (not removed)
    expect(getPushSubscription("dev-a")).not.toBeNull();
    expect(getPushSubscription("dev-b")).not.toBeNull();
  });

  it("handles empty subscription list gracefully", async () => {
    const { initPush, broadcastPush } = await import("../src/push.ts");
    initPush();

    // Should not throw
    await broadcastPush("Test", "Body");
  });
});

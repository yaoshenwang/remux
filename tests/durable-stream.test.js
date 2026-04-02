/**
 * Tests for durable terminal stream — tab_stream_chunks, tab_snapshots, device_tab_cursors.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import {
  _resetDbForTest,
  closeDb,
  saveStreamChunk,
  getChunksSince,
  saveTabSnapshot,
  getLatestSnapshot,
  updateDeviceCursor,
  getDeviceCursor,
} from "../src/store.js";

describe("durable stream", () => {
  let db;

  beforeAll(() => {
    db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    _resetDbForTest(db);

    // Create the stream tables
    db.exec(`
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
  });

  afterAll(() => {
    closeDb();
  });

  describe("tab_stream_chunks", () => {
    it("saves and retrieves chunks", () => {
      saveStreamChunk(1, 1, 10, Buffer.from("chunk-1"));
      saveStreamChunk(1, 11, 20, Buffer.from("chunk-2"));
      saveStreamChunk(1, 21, 30, Buffer.from("chunk-3"));

      const chunks = getChunksSince(1, 0);
      expect(chunks).toHaveLength(3);
      expect(chunks[0].seqFrom).toBe(1);
      expect(chunks[0].data.toString()).toBe("chunk-1");
      expect(chunks[2].seqFrom).toBe(21);
    });

    it("filters chunks by seq (returns chunks whose seq_to > sinceSeq)", () => {
      // sinceSeq=15: chunk-2 (seq_to=20 > 15) and chunk-3 (seq_to=30 > 15) returned
      const chunks = getChunksSince(1, 15);
      expect(chunks).toHaveLength(2);
      expect(chunks[0].seqFrom).toBe(11);
      expect(chunks[1].seqFrom).toBe(21);
    });

    it("returns empty for future seq", () => {
      const chunks = getChunksSince(1, 100);
      expect(chunks).toHaveLength(0);
    });

    it("returns empty for non-existent tab", () => {
      const chunks = getChunksSince(999, 0);
      expect(chunks).toHaveLength(0);
    });
  });

  describe("tab_snapshots", () => {
    it("saves and retrieves snapshot", () => {
      saveTabSnapshot(1, 25, 80, 24, Buffer.from("snapshot-data"));

      const snapshot = getLatestSnapshot(1);
      expect(snapshot).not.toBeNull();
      expect(snapshot.seq).toBe(25);
      expect(snapshot.cols).toBe(80);
      expect(snapshot.rows).toBe(24);
      expect(snapshot.snapshot.toString()).toBe("snapshot-data");
    });

    it("returns latest snapshot when multiple exist", () => {
      saveTabSnapshot(1, 50, 100, 30, Buffer.from("newer-snapshot"));

      const snapshot = getLatestSnapshot(1);
      expect(snapshot.seq).toBe(50);
      expect(snapshot.snapshot.toString()).toBe("newer-snapshot");
    });

    it("returns null for non-existent tab", () => {
      const snapshot = getLatestSnapshot(999);
      expect(snapshot).toBeNull();
    });
  });

  describe("device_tab_cursors", () => {
    it("creates cursor on first update", () => {
      updateDeviceCursor("device-a", 1, 15);

      const cursor = getDeviceCursor("device-a", 1);
      expect(cursor).not.toBeNull();
      expect(cursor.lastAckedSeq).toBe(15);
    });

    it("updates existing cursor", () => {
      updateDeviceCursor("device-a", 1, 30);

      const cursor = getDeviceCursor("device-a", 1);
      expect(cursor.lastAckedSeq).toBe(30);
    });

    it("tracks per device and per tab", () => {
      updateDeviceCursor("device-a", 2, 5);
      updateDeviceCursor("device-b", 1, 10);

      const cursorA1 = getDeviceCursor("device-a", 1);
      const cursorA2 = getDeviceCursor("device-a", 2);
      const cursorB1 = getDeviceCursor("device-b", 1);

      expect(cursorA1.lastAckedSeq).toBe(30);
      expect(cursorA2.lastAckedSeq).toBe(5);
      expect(cursorB1.lastAckedSeq).toBe(10);
    });

    it("returns null for non-existent cursor", () => {
      const cursor = getDeviceCursor("device-x", 999);
      expect(cursor).toBeNull();
    });
  });
});

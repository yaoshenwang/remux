/**
 * Tests for workspace_head — multi-device shared state.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { _resetDbForTest, closeDb } from "../src/store.js";
import { initWorkspaceHeadTable, getHead, updateHead } from "../src/workspace-head.js";

describe("workspace_head", () => {
  let db;

  beforeAll(() => {
    db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    _resetDbForTest(db);

    // Create minimal schema needed
    db.exec(`
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
    `);
  });

  afterAll(() => {
    closeDb();
  });

  it("returns null when no head exists", () => {
    const head = getHead();
    expect(head).toBeNull();
  });

  it("creates head on first updateHead call", () => {
    const head = updateHead({
      sessionName: "main",
      tabId: 0,
      view: "live",
    }, "device-1");

    expect(head).toBeDefined();
    expect(head.sessionName).toBe("main");
    expect(head.tabId).toBe(0);
    expect(head.view).toBe("live");
    expect(head.revision).toBe(1);
    expect(head.updatedByDevice).toBe("device-1");
    expect(head.updatedAt).toBeGreaterThan(0);
  });

  it("getHead returns the created head", () => {
    const head = getHead();
    expect(head).not.toBeNull();
    expect(head.sessionName).toBe("main");
    expect(head.tabId).toBe(0);
    expect(head.revision).toBe(1);
  });

  it("increments revision on update", () => {
    const head1 = updateHead({ tabId: 1 }, "device-2");
    expect(head1.revision).toBe(2);
    expect(head1.tabId).toBe(1);
    expect(head1.updatedByDevice).toBe("device-2");
    // sessionName should be preserved from previous
    expect(head1.sessionName).toBe("main");

    const head2 = updateHead({ tabId: 2 }, "device-1");
    expect(head2.revision).toBe(3);
    expect(head2.tabId).toBe(2);
  });

  it("updates session and resets tab", () => {
    const head = updateHead({
      sessionName: "logs",
      tabId: 5,
      view: "workspace",
    }, "device-3");

    expect(head.sessionName).toBe("logs");
    expect(head.tabId).toBe(5);
    expect(head.view).toBe("workspace");
    expect(head.revision).toBe(4);
  });

  it("handles topicId updates", () => {
    const head1 = updateHead({ topicId: "topic-abc" }, "device-1");
    expect(head1.topicId).toBe("topic-abc");

    const head2 = updateHead({ topicId: null }, "device-1");
    expect(head2.topicId).toBeNull();
  });

  it("preserves fields not specified in partial update", () => {
    // Set everything
    updateHead({
      sessionName: "work",
      tabId: 10,
      topicId: "topic-xyz",
      view: "inspect",
    }, "device-1");

    // Update only view
    const head = updateHead({ view: "live" }, "device-2");
    expect(head.sessionName).toBe("work");
    expect(head.tabId).toBe(10);
    expect(head.topicId).toBe("topic-xyz");
    expect(head.view).toBe("live");
  });
});

/**
 * Tests for AI workspace primitives: topics, runs, artifacts, approvals.
 * Covers CRUD operations in store.ts and high-level workspace.ts functions.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import {
  _resetDbForTest,
  closeDb,
  createTopic,
  updateTopic,
  listTopics,
  deleteTopic,
  createRun,
  updateRun,
  listRuns,
  createArtifact,
  listArtifacts,
  createApproval,
  listApprovals,
  resolveApproval,
} from "../src/store.ts";

/** Create an in-memory SQLite DB with the full schema including workspace tables. */
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
  return db;
}

// ── Topics ──────────────────────────────────────────────────────

describe("workspace: topics CRUD", () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
    _resetDbForTest(db);
  });

  afterEach(() => {
    closeDb();
  });

  it("creates a topic with generated ID and timestamps", () => {
    const topic = createTopic("main", "My first topic");
    expect(topic.id).toBeTruthy();
    expect(topic.id.length).toBeGreaterThan(0);
    expect(topic.sessionName).toBe("main");
    expect(topic.title).toBe("My first topic");
    expect(topic.createdAt).toBeGreaterThan(0);
    expect(topic.updatedAt).toBe(topic.createdAt);
  });

  it("lists topics filtered by sessionName", () => {
    createTopic("main", "Topic A");
    createTopic("main", "Topic B");
    createTopic("work", "Topic C");

    const mainTopics = listTopics("main");
    expect(mainTopics).toHaveLength(2);
    expect(mainTopics[0].title).toBe("Topic A");
    expect(mainTopics[1].title).toBe("Topic B");

    const workTopics = listTopics("work");
    expect(workTopics).toHaveLength(1);
    expect(workTopics[0].title).toBe("Topic C");
  });

  it("lists all topics when no sessionName filter", () => {
    createTopic("main", "Topic A");
    createTopic("work", "Topic B");

    const all = listTopics();
    expect(all).toHaveLength(2);
  });

  it("updates a topic title and updatedAt", () => {
    const topic = createTopic("main", "Old title");
    const updated = updateTopic(topic.id, "New title");
    expect(updated).toBe(true);

    const topics = listTopics("main");
    expect(topics[0].title).toBe("New title");
    expect(topics[0].updatedAt).toBeGreaterThanOrEqual(topics[0].createdAt);
  });

  it("updateTopic returns false for nonexistent ID", () => {
    const result = updateTopic("nonexistent", "Title");
    expect(result).toBe(false);
  });

  it("deletes a topic", () => {
    const topic = createTopic("main", "To delete");
    expect(deleteTopic(topic.id)).toBe(true);
    expect(listTopics("main")).toHaveLength(0);
  });

  it("deleteTopic returns false for nonexistent ID", () => {
    expect(deleteTopic("nonexistent")).toBe(false);
  });
});

// ── Runs ────────────────────────────────────────────────────────

describe("workspace: runs CRUD", () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
    _resetDbForTest(db);
  });

  afterEach(() => {
    closeDb();
  });

  it("creates a run with default status 'running'", () => {
    const topic = createTopic("main", "Test topic");
    const run = createRun({
      topicId: topic.id,
      sessionName: "main",
      tabId: 0,
      command: "ls -la",
    });
    expect(run.id).toBeTruthy();
    expect(run.topicId).toBe(topic.id);
    expect(run.sessionName).toBe("main");
    expect(run.command).toBe("ls -la");
    expect(run.status).toBe("running");
    expect(run.startedAt).toBeGreaterThan(0);
    expect(run.endedAt).toBeNull();
    expect(run.exitCode).toBeNull();
  });

  it("creates a run without topicId", () => {
    const run = createRun({
      sessionName: "main",
      command: "echo hello",
    });
    expect(run.id).toBeTruthy();
    expect(run.topicId).toBeNull();
    expect(run.status).toBe("running");
  });

  it("updates run exit code and status", () => {
    const run = createRun({ sessionName: "main", command: "test" });
    const updated = updateRun(run.id, { exitCode: 0, status: "completed" });
    expect(updated).toBe(true);

    const runs = listRuns();
    expect(runs[0].exitCode).toBe(0);
    expect(runs[0].status).toBe("completed");
    expect(runs[0].endedAt).toBeGreaterThan(0);
  });

  it("lists runs filtered by topicId", () => {
    const topic = createTopic("main", "T");
    createRun({ topicId: topic.id, sessionName: "main", command: "a" });
    createRun({ topicId: topic.id, sessionName: "main", command: "b" });
    createRun({ sessionName: "main", command: "c" });

    const topicRuns = listRuns(topic.id);
    expect(topicRuns).toHaveLength(2);

    const allRuns = listRuns();
    expect(allRuns).toHaveLength(3);
  });

  it("updateRun returns false for nonexistent ID", () => {
    expect(updateRun("nonexistent", { status: "failed" })).toBe(false);
  });
});

// ── Artifacts ───────────────────────────────────────────────────

describe("workspace: artifacts CRUD", () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
    _resetDbForTest(db);
  });

  afterEach(() => {
    closeDb();
  });

  it("creates an artifact with type and content", () => {
    const topic = createTopic("main", "T");
    const artifact = createArtifact({
      topicId: topic.id,
      type: "snapshot",
      title: "Terminal snapshot",
      content: "$ ls\nfoo bar",
    });
    expect(artifact.id).toBeTruthy();
    expect(artifact.topicId).toBe(topic.id);
    expect(artifact.type).toBe("snapshot");
    expect(artifact.content).toBe("$ ls\nfoo bar");
    expect(artifact.createdAt).toBeGreaterThan(0);
  });

  it("creates an artifact linked to a run", () => {
    const run = createRun({ sessionName: "main", command: "ls" });
    const artifact = createArtifact({
      runId: run.id,
      type: "command-card",
      title: "ls output",
      content: "foo bar",
    });
    expect(artifact.runId).toBe(run.id);
  });

  it("lists artifacts filtered by topicId", () => {
    const topic = createTopic("main", "T");
    createArtifact({ topicId: topic.id, type: "note", title: "N1", content: "x" });
    createArtifact({ topicId: topic.id, type: "note", title: "N2", content: "y" });
    createArtifact({ type: "snapshot", title: "S", content: "z" });

    const topicArtifacts = listArtifacts({ topicId: topic.id });
    expect(topicArtifacts).toHaveLength(2);

    const allArtifacts = listArtifacts({});
    expect(allArtifacts).toHaveLength(3);
  });

  it("lists artifacts filtered by runId", () => {
    const run = createRun({ sessionName: "main", command: "test" });
    createArtifact({ runId: run.id, type: "command-card", title: "C", content: "x" });

    const runArtifacts = listArtifacts({ runId: run.id });
    expect(runArtifacts).toHaveLength(1);
  });
});

// ── Approvals ───────────────────────────────────────────────────

describe("workspace: approvals CRUD", () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
    _resetDbForTest(db);
  });

  afterEach(() => {
    closeDb();
  });

  it("creates an approval with pending status", () => {
    const approval = createApproval({
      title: "Deploy to production?",
      description: "Running deploy script",
    });
    expect(approval.id).toBeTruthy();
    expect(approval.title).toBe("Deploy to production?");
    expect(approval.status).toBe("pending");
    expect(approval.createdAt).toBeGreaterThan(0);
    expect(approval.resolvedAt).toBeNull();
  });

  it("creates an approval linked to topic and run", () => {
    const topic = createTopic("main", "T");
    const run = createRun({ topicId: topic.id, sessionName: "main", command: "deploy" });
    const approval = createApproval({
      runId: run.id,
      topicId: topic.id,
      title: "Approve deploy",
    });
    expect(approval.runId).toBe(run.id);
    expect(approval.topicId).toBe(topic.id);
  });

  it("lists approvals filtered by status", () => {
    createApproval({ title: "A1" });
    createApproval({ title: "A2" });

    const pending = listApprovals("pending");
    expect(pending).toHaveLength(2);

    const approved = listApprovals("approved");
    expect(approved).toHaveLength(0);
  });

  it("lists all approvals when no status filter", () => {
    createApproval({ title: "A1" });
    createApproval({ title: "A2" });

    const all = listApprovals();
    expect(all).toHaveLength(2);
  });

  it("resolves an approval as approved", () => {
    const approval = createApproval({ title: "Test" });
    const result = resolveApproval(approval.id, "approved");
    expect(result).toBe(true);

    const list = listApprovals("approved");
    expect(list).toHaveLength(1);
    expect(list[0].status).toBe("approved");
    expect(list[0].resolvedAt).toBeGreaterThan(0);
  });

  it("resolves an approval as rejected", () => {
    const approval = createApproval({ title: "Test" });
    resolveApproval(approval.id, "rejected");

    const list = listApprovals("rejected");
    expect(list).toHaveLength(1);
    expect(list[0].status).toBe("rejected");
  });

  it("resolveApproval returns false for nonexistent ID", () => {
    expect(resolveApproval("nonexistent", "approved")).toBe(false);
  });
});

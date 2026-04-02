/**
 * Tests for P5-B (Search / Memory / Handoff) and P5-C (Shell Integration).
 * Covers FTS5 indexing, memory notes CRUD, handoff bundle, and command parsing.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import {
  _resetDbForTest,
  closeDb,
  createTopic,
  createRun,
  createArtifact,
  indexEntity,
  searchEntities,
  removeFromIndex,
  createNote,
  listNotes,
  updateNote,
  deleteNote,
  togglePinNote,
  createCommand,
  completeCommand,
  listCommands,
  listApprovals,
  createApproval,
} from "../src/store.ts";
import { processShellIntegration } from "../src/session.ts";

/** Create an in-memory SQLite DB with full schema including new tables. */
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
      updated_at INTEGER NOT NULL,
      session_name TEXT
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

// ── FTS5 Search ───────────────────────────────────────────────────

describe("FTS5: indexing and search", () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
    _resetDbForTest(db);
  });

  afterEach(() => {
    closeDb();
  });

  it("indexes and searches entities", () => {
    indexEntity("topic", "t1", "Deploy Pipeline", "CI/CD deploy pipeline setup");
    indexEntity("artifact", "a1", "Build Log", "npm run build output log");

    const results = searchEntities("deploy");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].entityId).toBe("t1");
    expect(results[0].entityType).toBe("topic");
  });

  it("returns empty for empty query", () => {
    indexEntity("topic", "t1", "Test", "content");
    expect(searchEntities("")).toHaveLength(0);
    expect(searchEntities("  ")).toHaveLength(0);
  });

  it("respects limit parameter", () => {
    for (let i = 0; i < 10; i++) {
      indexEntity("topic", `t${i}`, `Topic ${i}`, `content about testing topic ${i}`);
    }
    const results = searchEntities("topic", 3);
    expect(results).toHaveLength(3);
  });

  it("removeFromIndex removes entity", () => {
    indexEntity("topic", "t1", "Searchable", "findme content");
    expect(searchEntities("findme").length).toBeGreaterThanOrEqual(1);

    removeFromIndex("t1");
    expect(searchEntities("findme")).toHaveLength(0);
  });

  it("handles special characters gracefully", () => {
    indexEntity("topic", "t1", "Test", "content");
    // Should not throw
    const results = searchEntities('test "quoted"');
    // May or may not find results, but should not crash
    expect(Array.isArray(results)).toBe(true);
  });

  it("createTopic auto-indexes into FTS", () => {
    const topic = createTopic("main", "Database Migration Plan");
    const results = searchEntities("migration");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].entityId).toBe(topic.id);
  });

  it("createRun auto-indexes command into FTS", () => {
    const run = createRun({ sessionName: "main", command: "npm test --coverage" });
    const results = searchEntities("coverage");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].entityId).toBe(run.id);
  });

  it("createArtifact auto-indexes into FTS", () => {
    const artifact = createArtifact({
      type: "note",
      title: "Architecture Decision",
      content: "Use SQLite for persistence layer",
    });
    const results = searchEntities("persistence");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].entityId).toBe(artifact.id);
  });
});

// ── Memory Notes ──────────────────────────────────────────────────

describe("Memory Notes CRUD", () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
    _resetDbForTest(db);
  });

  afterEach(() => {
    closeDb();
  });

  it("creates a note with generated ID and timestamps", () => {
    const note = createNote("Remember to check logs");
    expect(note.id).toBeTruthy();
    expect(note.content).toBe("Remember to check logs");
    expect(note.pinned).toBe(false);
    expect(note.createdAt).toBeGreaterThan(0);
    expect(note.updatedAt).toBe(note.createdAt);
  });

  it("lists notes (pinned first)", () => {
    const n1 = createNote("Note A");
    const n2 = createNote("Note B");
    togglePinNote(n1.id);

    const notes = listNotes();
    expect(notes).toHaveLength(2);
    // Pinned note should be first
    expect(notes[0].id).toBe(n1.id);
    expect(notes[0].pinned).toBe(true);
  });

  it("updates a note content", () => {
    const note = createNote("Old content");
    const ok = updateNote(note.id, "New content");
    expect(ok).toBe(true);

    const notes = listNotes();
    expect(notes[0].content).toBe("New content");
    expect(notes[0].updatedAt).toBeGreaterThanOrEqual(notes[0].createdAt);
  });

  it("updateNote returns false for nonexistent ID", () => {
    expect(updateNote("nonexistent", "x")).toBe(false);
  });

  it("deletes a note", () => {
    const note = createNote("To delete");
    expect(deleteNote(note.id)).toBe(true);
    expect(listNotes()).toHaveLength(0);
  });

  it("deleteNote returns false for nonexistent ID", () => {
    expect(deleteNote("nonexistent")).toBe(false);
  });

  it("togglePinNote toggles pin state", () => {
    const note = createNote("Pin me");
    expect(listNotes()[0].pinned).toBe(false);

    togglePinNote(note.id);
    expect(listNotes()[0].pinned).toBe(true);

    togglePinNote(note.id);
    expect(listNotes()[0].pinned).toBe(false);
  });
});

// ── Commands (Shell Integration Store) ────────────────────────────

describe("Commands CRUD", () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
    _resetDbForTest(db);
  });

  afterEach(() => {
    closeDb();
  });

  it("creates a command record", () => {
    const cmd = createCommand({
      sessionName: "main",
      tabId: 0,
      command: "ls -la",
      cwd: "/home/user",
    });
    expect(cmd.id).toBeTruthy();
    expect(cmd.sessionName).toBe("main");
    expect(cmd.tabId).toBe(0);
    expect(cmd.command).toBe("ls -la");
    expect(cmd.cwd).toBe("/home/user");
    expect(cmd.exitCode).toBeNull();
    expect(cmd.endedAt).toBeNull();
    expect(cmd.startedAt).toBeGreaterThan(0);
  });

  it("completes a command with exit code", () => {
    const cmd = createCommand({ sessionName: "main", tabId: 0, command: "test" });
    const ok = completeCommand(cmd.id, 0);
    expect(ok).toBe(true);

    const commands = listCommands(0);
    expect(commands[0].exitCode).toBe(0);
    expect(commands[0].endedAt).toBeGreaterThan(0);
  });

  it("lists commands for a tab (most recent first)", () => {
    createCommand({ sessionName: "main", tabId: 1, command: "first" });
    createCommand({ sessionName: "main", tabId: 1, command: "second" });
    createCommand({ sessionName: "main", tabId: 2, command: "other tab" });

    const cmds = listCommands(1);
    expect(cmds).toHaveLength(2);
    expect(cmds[0].command).toBe("second"); // most recent first
    expect(cmds[1].command).toBe("first");

    const otherCmds = listCommands(2);
    expect(otherCmds).toHaveLength(1);
  });

  it("respects limit parameter", () => {
    for (let i = 0; i < 10; i++) {
      createCommand({ sessionName: "main", tabId: 0, command: `cmd${i}` });
    }
    const cmds = listCommands(0, 3);
    expect(cmds).toHaveLength(3);
  });
});

// ── Shell Integration: OSC 133 Parsing ────────────────────────────

describe("Shell Integration: OSC 133 parsing", () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
    _resetDbForTest(db);
  });

  afterEach(() => {
    closeDb();
  });

  /** Create a minimal mock tab for testing shell integration. */
  function mockTab(id = 0) {
    return {
      id,
      pty: null,
      scrollback: { write: () => {}, read: () => Buffer.alloc(0) },
      vt: null,
      clients: new Set(),
      cols: 80,
      rows: 24,
      ended: false,
      title: "Test",
      shellIntegration: {
        phase: "idle",
        commandBuffer: "",
        cwd: null,
        activeCommandId: null,
      },
    };
  }

  it("tracks CWD from OSC 7", () => {
    const tab = mockTab();
    processShellIntegration(
      "\x1b]7;file://localhost/home/user/project\x07",
      tab,
      "main",
    );
    expect(tab.shellIntegration.cwd).toBe("/home/user/project");
  });

  it("parses OSC 133;A (prompt start)", () => {
    const tab = mockTab();
    processShellIntegration("\x1b]133;A\x07", tab, "main");
    expect(tab.shellIntegration.phase).toBe("prompt");
  });

  it("parses full command lifecycle (B -> C -> D)", () => {
    const tab = mockTab();

    // Prompt start
    processShellIntegration("\x1b]133;A\x07", tab, "main");
    expect(tab.shellIntegration.phase).toBe("prompt");

    // Command start + text + output start in one chunk
    processShellIntegration(
      "\x1b]133;B\x07ls -la\x1b]133;C\x07",
      tab,
      "main",
    );
    expect(tab.shellIntegration.phase).toBe("output");
    expect(tab.shellIntegration.commandBuffer).toBe("ls -la");
    expect(tab.shellIntegration.activeCommandId).toBeTruthy();

    // Command end
    const cmdId = tab.shellIntegration.activeCommandId;
    processShellIntegration("\x1b]133;D;0\x07", tab, "main");
    expect(tab.shellIntegration.phase).toBe("idle");
    expect(tab.shellIntegration.activeCommandId).toBeNull();

    // Verify command was persisted in DB
    const commands = listCommands(tab.id);
    expect(commands).toHaveLength(1);
    expect(commands[0].command).toBe("ls -la");
    expect(commands[0].exitCode).toBe(0);
  });

  it("tracks non-zero exit codes", () => {
    const tab = mockTab();

    processShellIntegration(
      "\x1b]133;B\x07bad-command\x1b]133;C\x07",
      tab,
      "main",
    );
    processShellIntegration("\x1b]133;D;127\x07", tab, "main");

    const commands = listCommands(tab.id);
    expect(commands).toHaveLength(1);
    expect(commands[0].exitCode).toBe(127);
  });

  it("handles OSC 7 with encoded path", () => {
    const tab = mockTab();
    processShellIntegration(
      "\x1b]7;file://host/home/user/my%20project\x07",
      tab,
      "main",
    );
    expect(tab.shellIntegration.cwd).toBe("/home/user/my project");
  });
});

// ── Handoff Bundle ────────────────────────────────────────────────

describe("Handoff bundle generation", () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
    _resetDbForTest(db);
  });

  afterEach(() => {
    closeDb();
  });

  it("generates a bundle with basic structure", async () => {
    // Need to import dynamically to avoid circular dependency issues
    const { generateHandoffBundle } = await import("../src/workspace.ts");

    const bundle = generateHandoffBundle();
    expect(bundle.timestamp).toBeGreaterThan(0);
    expect(Array.isArray(bundle.sessions)).toBe(true);
    expect(Array.isArray(bundle.recentRuns)).toBe(true);
    expect(Array.isArray(bundle.activeTopics)).toBe(true);
    expect(Array.isArray(bundle.pendingApprovals)).toBe(true);
    expect(Array.isArray(bundle.keyArtifacts)).toBe(true);
  });

  it("includes recent runs and active topics", async () => {
    const { generateHandoffBundle } = await import("../src/workspace.ts");

    createTopic("main", "Active Topic");
    createRun({ sessionName: "main", command: "npm test" });
    createApproval({ title: "Deploy?" });

    const bundle = generateHandoffBundle();
    expect(bundle.activeTopics).toHaveLength(1);
    expect(bundle.activeTopics[0].title).toBe("Active Topic");
    expect(bundle.recentRuns).toHaveLength(1);
    expect(bundle.pendingApprovals).toHaveLength(1);
  });
});

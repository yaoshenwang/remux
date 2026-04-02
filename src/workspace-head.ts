/**
 * Workspace head — shared state for multi-device sync.
 * Tracks which session/tab/view the workspace is focused on.
 * All connected devices see the same workspace head and can update it.
 *
 * Inspired by CRDTs and Figma's multiplayer cursor model.
 */

import { getDb } from "./store.js";

// ── Types ───────────────────────────────────────────────────────

export interface WorkspaceHead {
  id: string;
  sessionName: string;
  tabId: number;
  topicId: string | null;
  view: string; // "live" | "inspect" | "workspace"
  revision: number;
  updatedByDevice: string | null;
  updatedAt: number;
}

// ── Table initialization ────────────────────────────────────────

/**
 * Create the workspace_head table if it doesn't exist.
 * Called from store.ts getDb() during database initialization.
 */
export function initWorkspaceHeadTable(): void {
  const db = getDb();
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
}

// ── CRUD ────────────────────────────────────────────────────────

/**
 * Get the current workspace head (global singleton).
 * Returns null if no head has been set yet.
 */
export function getHead(): WorkspaceHead | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM workspace_head WHERE id = 'global'")
    .get() as any;
  if (!row) return null;
  return {
    id: row.id,
    sessionName: row.session_name,
    tabId: row.tab_id,
    topicId: row.topic_id,
    view: row.view,
    revision: row.revision,
    updatedByDevice: row.updated_by_device,
    updatedAt: row.updated_at,
  };
}

/**
 * Update the workspace head with partial fields.
 * Auto-increments revision and sets updatedAt.
 * Creates the head if it doesn't exist yet.
 */
export function updateHead(
  fields: Partial<Omit<WorkspaceHead, "id" | "revision" | "updatedAt">>,
  deviceId?: string,
): WorkspaceHead {
  const db = getDb();
  const now = Date.now();
  const current = getHead();

  if (!current) {
    // First-time creation
    const head: WorkspaceHead = {
      id: "global",
      sessionName: fields.sessionName || "default",
      tabId: fields.tabId ?? 0,
      topicId: fields.topicId ?? null,
      view: fields.view || "live",
      revision: 1,
      updatedByDevice: deviceId || fields.updatedByDevice || null,
      updatedAt: now,
    };
    db.prepare(
      `INSERT INTO workspace_head (id, session_name, tab_id, topic_id, view, revision, updated_by_device, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      head.id,
      head.sessionName,
      head.tabId,
      head.topicId,
      head.view,
      head.revision,
      head.updatedByDevice,
      head.updatedAt,
    );
    return head;
  }

  // Update existing head
  const updated: WorkspaceHead = {
    id: "global",
    sessionName: fields.sessionName ?? current.sessionName,
    tabId: fields.tabId ?? current.tabId,
    topicId: fields.topicId !== undefined ? fields.topicId : current.topicId,
    view: fields.view ?? current.view,
    revision: current.revision + 1,
    updatedByDevice: deviceId || fields.updatedByDevice || current.updatedByDevice,
    updatedAt: now,
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
     WHERE id = 'global'`,
  ).run(
    updated.sessionName,
    updated.tabId,
    updated.topicId,
    updated.view,
    updated.revision,
    updated.updatedByDevice,
    updated.updatedAt,
  );

  return updated;
}

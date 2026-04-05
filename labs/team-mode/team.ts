/**
 * E17: Team Mode Foundations — user identity, RBAC, workspace/project models.
 * Personal Mode (current): single implicit workspace, no user auth.
 * Team Mode: multi-user with roles and permissions.
 */

import { getDb } from "../../src/persistence/store.js";

// E17-001: User Identity
export interface UserIdentity {
  userId: string;
  displayName: string;
  email: string;
  avatarUrl?: string;
  role: "owner" | "admin" | "member" | "viewer";
}

// E17-003: RBAC
export type Permission = "read" | "write" | "admin" | "approve";

const ROLE_PERMISSIONS: Record<string, Permission[]> = {
  owner: ["read", "write", "admin", "approve"],
  admin: ["read", "write", "admin", "approve"],
  member: ["read", "write", "approve"],
  viewer: ["read"],
};

export function hasPermission(role: string, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}

// E17-004: Workspace model
export interface Workspace {
  id: string;
  name: string;
  ownerId: string;
  createdAt: string;
}

// E17-005: Project model
export interface Project {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  createdAt: string;
}

// E17-006: Audit Log
export interface AuditEntry {
  id: number;
  userId: string;
  action: string;
  target: string;
  timestamp: string;
  details: string;
}

export function initTeamTables(): void {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      avatar_url TEXT,
      role TEXT NOT NULL DEFAULT 'member',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      action TEXT NOT NULL,
      target TEXT NOT NULL,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      details TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS workspace_members (
      workspace_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      joined_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (workspace_id, user_id)
    );
  `);
}

export function logAudit(
  userId: string,
  action: string,
  target: string,
  details?: string,
): void {
  const db = getDb();
  db.prepare(
    "INSERT INTO audit_log (user_id, action, target, details) VALUES (?, ?, ?, ?)",
  ).run(userId, action, target, details || "");
}

export function getAuditLog(limit = 100): AuditEntry[] {
  const db = getDb();
  return db
    .prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?")
    .all(limit) as AuditEntry[];
}

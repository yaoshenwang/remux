/**
 * Manages an isolated zellij socket directory for Remux.
 *
 * When no explicit REMUX_ZELLIJ_SOCKET_DIR is provided, Remux auto-creates
 * a short, reusable, owner-only directory under the system temp dir.
 * This prevents Remux sessions from mixing with the user's global zellij sessions.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Prefix used for auto-created socket dirs. */
export const REMUX_SOCKET_DIR_PREFIX = "remux-zj";

/** Cached auto-created dir path (reusable across calls). */
let autoSocketDir: string | null = null;
/** Whether the current dir was auto-created (vs user-provided). */
let isAutoCreated = false;

/**
 * Resolve the zellij socket directory.
 *
 * - If `explicitDir` is given, use it as-is (user's choice).
 * - Otherwise, create/reuse a short isolated dir under /tmp.
 *
 * The auto-created path is kept short to stay within the Unix socket
 * 108-byte path limit (dir + /contract_version_1/session_name).
 */
export function resolveZellijSocketDir(explicitDir: string | undefined): string {
  if (explicitDir) {
    // User explicitly set the dir — use it, don't manage lifecycle
    autoSocketDir = explicitDir;
    isAutoCreated = false;
    return explicitDir;
  }

  // Reuse if already created
  if (autoSocketDir && fs.existsSync(autoSocketDir)) {
    return autoSocketDir;
  }

  // Build a short, stable path: /tmp/rmx-<uid>
  // Using uid makes it per-user and avoids conflicts.
  // We use /tmp directly (not os.tmpdir()) because macOS's tmpdir
  // is very long (/var/folders/...) and would exceed the 108-byte
  // Unix socket path limit.
  const uid = process.platform === "win32" ? process.pid : os.userInfo().uid;
  const dirName = `${REMUX_SOCKET_DIR_PREFIX}-${uid}`;
  const baseDir = process.platform === "win32" ? os.tmpdir() : "/tmp";
  const dirPath = path.join(baseDir, dirName);

  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  autoSocketDir = dirPath;
  isAutoCreated = true;
  return dirPath;
}

/**
 * Clean up the auto-created socket dir on shutdown.
 * Does NOT remove user-provided explicit dirs.
 */
export function cleanupSocketDir(): void {
  if (!autoSocketDir || !isAutoCreated) {
    return;
  }

  try {
    fs.rmSync(autoSocketDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }

  autoSocketDir = null;
  isAutoCreated = false;
}

/**
 * Reset internal state (for testing).
 */
export function _resetSocketDirState(): void {
  autoSocketDir = null;
  isAutoCreated = false;
}

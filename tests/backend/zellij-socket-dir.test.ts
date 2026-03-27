import { describe, it, expect, afterEach, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveZellijSocketDir,
  cleanupSocketDir,
  _resetSocketDirState,
  REMUX_SOCKET_DIR_PREFIX
} from "../../src/backend/zellij/socket-dir.js";

describe("resolveZellijSocketDir", () => {
  const createdDirs: string[] = [];

  beforeEach(() => {
    _resetSocketDirState();
  });

  afterEach(() => {
    cleanupSocketDir();
    _resetSocketDirState();
    for (const dir of createdDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    createdDirs.length = 0;
  });

  it("returns explicit dir from env when provided", () => {
    const explicit = path.join(os.tmpdir(), "test-remux-explicit-" + Date.now());
    const result = resolveZellijSocketDir(explicit);
    expect(result).toBe(explicit);
  });

  it("creates an isolated dir when no explicit dir given", () => {
    const result = resolveZellijSocketDir(undefined);
    createdDirs.push(result);
    expect(result).toContain(REMUX_SOCKET_DIR_PREFIX);
    expect(fs.existsSync(result)).toBe(true);
  });

  it("returns the same dir on repeated calls (reusable)", () => {
    const first = resolveZellijSocketDir(undefined);
    createdDirs.push(first);
    const second = resolveZellijSocketDir(undefined);
    expect(second).toBe(first);
  });

  it("path is short enough for Unix socket limit", () => {
    const result = resolveZellijSocketDir(undefined);
    createdDirs.push(result);
    // socket path = dir + /contract_version_1/ + session_name
    // session name max ~32 chars, contract_version_1 = 18 chars
    // so dir + 18 + 1 + 32 + 2 separators < 108
    const worstCase = path.join(result, "contract_version_1", "a".repeat(32));
    expect(Buffer.byteLength(worstCase, "utf8")).toBeLessThan(108);
  });

  it("dir has correct permissions (owner-only on Unix)", () => {
    if (process.platform === "win32") return;
    const result = resolveZellijSocketDir(undefined);
    createdDirs.push(result);
    const stats = fs.statSync(result);
    // 0o700 = rwx------
    expect(stats.mode & 0o777).toBe(0o700);
  });
});

describe("cleanupSocketDir", () => {
  beforeEach(() => {
    _resetSocketDirState();
  });

  afterEach(() => {
    _resetSocketDirState();
  });

  it("removes the auto-created socket dir", () => {
    const dir = resolveZellijSocketDir(undefined);
    expect(fs.existsSync(dir)).toBe(true);
    cleanupSocketDir();
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("does not throw if dir was already removed", () => {
    resolveZellijSocketDir(undefined);
    cleanupSocketDir();
    expect(() => cleanupSocketDir()).not.toThrow();
  });

  it("does not remove explicit user-provided dir", () => {
    const explicit = path.join(os.tmpdir(), "test-remux-explicit-" + Date.now());
    fs.mkdirSync(explicit, { recursive: true });
    resolveZellijSocketDir(explicit);
    cleanupSocketDir();
    // explicit dir should NOT be removed
    expect(fs.existsSync(explicit)).toBe(true);
    fs.rmSync(explicit, { recursive: true, force: true });
  });
});

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";

const runCli = (args: string[]): string =>
  execFileSync("node", ["--import", "tsx", "src/backend/cli-tmux-compat.ts", ...args], {
    stdio: "pipe",
    timeout: 5000,
  }).toString();

/**
 * Unit tests for tmux-compat CLI argument parsing and key mapping.
 *
 * The full integration tests (new-session, send-keys, capture-pane)
 * require background process management that conflicts with vitest's
 * process lifecycle.  Run them manually:
 *
 *   node dist/backend/cli-tmux-compat.js new-session -d -s test -c /tmp
 *   node dist/backend/cli-tmux-compat.js has-session -t test
 *   node dist/backend/cli-tmux-compat.js send-keys -t test -l "echo hi"
 *   node dist/backend/cli-tmux-compat.js send-keys -t test Enter
 *   node dist/backend/cli-tmux-compat.js capture-pane -p -t test
 *   node dist/backend/cli-tmux-compat.js kill-session -t test
 */

const zellijAvailable = (() => {
  try {
    execFileSync("which", ["zellij"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
})();

const zellijSessionListingAvailable = (() => {
  if (!zellijAvailable) {
    return false;
  }
  try {
    execFileSync("zellij", ["list-sessions", "--no-formatting"], {
      stdio: "pipe",
      timeout: 2000,
    });
    return true;
  } catch {
    return false;
  }
})();

const describeIf = zellijSessionListingAvailable ? describe : describe.skip;

describeIf("remux-tmux CLI adapter", () => {
  it("has-session returns non-zero for non-existent session", () => {
    try {
      runCli(["has-session", "-t", "nonexistent-xyz-999"]);
      expect.unreachable("should have thrown");
    } catch (err: unknown) {
      expect((err as { status: number }).status).toBe(1);
    }
  });

  it("list-sessions runs without error", () => {
    const output = runCli(["list-sessions"]);
    expect(typeof output).toBe("string");
  });

  it("stub commands succeed silently", () => {
    for (const cmd of ["set-option", "bind-key", "rename-session", "resize-window"]) {
      runCli([cmd, "-t", "any"]);
    }
  });

  it("unknown command exits with error", () => {
    try {
      runCli(["invalid-command"]);
      expect.unreachable("should have thrown");
    } catch (err: unknown) {
      expect((err as { status: number }).status).toBe(1);
    }
  });
});

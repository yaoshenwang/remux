import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";

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

const describeIf = zellijAvailable ? describe : describe.skip;

describeIf("remux-tmux CLI adapter", () => {
  it("has-session returns non-zero for non-existent session", () => {
    try {
      execFileSync("node", ["dist/backend/cli-tmux-compat.js", "has-session", "-t", "nonexistent-xyz-999"], {
        stdio: "pipe",
        timeout: 5000,
      });
      expect.unreachable("should have thrown");
    } catch (err: unknown) {
      expect((err as { status: number }).status).toBe(1);
    }
  });

  it("list-sessions runs without error", () => {
    const output = execFileSync("node", ["dist/backend/cli-tmux-compat.js", "list-sessions"], {
      stdio: "pipe",
      timeout: 5000,
    }).toString();
    // Should contain at least one active session (remux-main or remux-dev).
    expect(output.length).toBeGreaterThan(0);
  });

  it("stub commands succeed silently", () => {
    for (const cmd of ["set-option", "bind-key", "rename-session", "resize-window"]) {
      execFileSync("node", ["dist/backend/cli-tmux-compat.js", cmd, "-t", "any"], {
        stdio: "pipe",
        timeout: 5000,
      });
    }
  });

  it("unknown command exits with error", () => {
    try {
      execFileSync("node", ["dist/backend/cli-tmux-compat.js", "invalid-command"], {
        stdio: "pipe",
        timeout: 5000,
      });
      expect.unreachable("should have thrown");
    } catch (err: unknown) {
      expect((err as { status: number }).status).toBe(1);
    }
  });
});

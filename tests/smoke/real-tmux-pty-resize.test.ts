import { execFile } from "node:child_process";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { NodePtyFactory } from "../../src/backend/pty/node-pty-adapter.js";
import { TmuxCliExecutor } from "../../src/backend/tmux/cli-executor.js";

const execFileAsync = promisify(execFile);
const shouldRun = process.env.REAL_TMUX_SMOKE === "1";

const socketPath = (name: string): string => path.join("/tmp", `${name}.sock`);

const safeCleanup = async (sockPath: string): Promise<void> => {
  try {
    await execFileAsync("tmux", ["-S", sockPath, "kill-server"]);
  } catch {
    // no-op; cleanup should never fail the suite
  }
};

const canRunIsolatedTmux = (() => {
  if (!shouldRun) {
    return false;
  }

  const sockPath = socketPath(`remux-pty-preflight-${process.pid}`);
  const create = spawnSync("tmux", ["-S", sockPath, "new-session", "-d", "-s", "preflight"], {
    encoding: "utf8"
  });
  spawnSync("tmux", ["-S", sockPath, "kill-server"], { encoding: "utf8" });

  const output = `${create.stderr ?? ""}\n${create.stdout ?? ""}`.toLowerCase();
  if (output.includes("operation not permitted") || output.includes("permission denied")) {
    return false;
  }

  return create.status === 0;
})();

const listClientSizes = async (sockPath: string): Promise<string[]> => {
  const { stdout } = await execFileAsync("tmux", ["-S", sockPath, "list-clients", "-F", "#{client_width}x#{client_height}"]);
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
};

const waitForClientSize = async (
  sockPath: string,
  expected: string,
  timeoutMs = 5_000
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  let lastSizes: string[] = [];

  while (Date.now() < deadline) {
    lastSizes = await listClientSizes(sockPath).catch(() => []);
    if (lastSizes.includes(expected)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`timed out waiting for tmux client size ${expected}, last sizes: ${lastSizes.join(",")}`);
};

describe.skipIf(!canRunIsolatedTmux)("real tmux pty resize", () => {
  test("updates tmux client dimensions to match terminal resizes", async () => {
    const sockPath = socketPath(`remux-pty-resize-${process.pid}-${Date.now()}`);
    const sessionName = "pty-resize-main";
    const tmux = new TmuxCliExecutor({ socketPath: sockPath });
    const ptyFactory = new NodePtyFactory({ socketPath: sockPath });

    await safeCleanup(sockPath);
    await tmux.createSession(sessionName);

    const ptyProcess = ptyFactory.spawnAttach(sessionName);

    try {
      await waitForClientSize(sockPath, "80x24");
      ptyProcess.resize(140, 50);
      await waitForClientSize(sockPath, "140x50");
    } finally {
      ptyProcess.kill();
      await tmux.killSession(sessionName).catch(() => undefined);
      await safeCleanup(sockPath);
    }
  }, 20_000);

  test("refuses script fallback because it cannot preserve terminal width invariants", async () => {
    const sockPath = socketPath(`remux-pty-fallback-${process.pid}-${Date.now()}`);
    const sessionName = "pty-fallback-main";
    const previousForceScript = process.env.REMUX_FORCE_SCRIPT_PTY;
    process.env.REMUX_FORCE_SCRIPT_PTY = "1";

    const tmux = new TmuxCliExecutor({ socketPath: sockPath });

    await safeCleanup(sockPath);
    await tmux.createSession(sessionName);

    try {
      const ptyFactory = new NodePtyFactory({ socketPath: sockPath });
      expect(() => ptyFactory.spawnAttach(sessionName)).toThrow(/resize/i);
    } finally {
      if (previousForceScript === undefined) {
        delete process.env.REMUX_FORCE_SCRIPT_PTY;
      } else {
        process.env.REMUX_FORCE_SCRIPT_PTY = previousForceScript;
      }
      await tmux.killSession(sessionName).catch(() => undefined);
      await safeCleanup(sockPath);
    }
  }, 20_000);
});

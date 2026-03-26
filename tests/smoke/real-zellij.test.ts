import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { ZellijCliExecutor } from "../../src/backend/zellij/cli-executor.js";
import { ZellijPtyFactory } from "../../src/backend/zellij/pane-io.js";

const execFileAsync = promisify(execFile);
const shouldRun = process.env.REAL_ZELLIJ_SMOKE === "1";

const waitForPtyOutput = async (
  register: (handler: (data: string) => void) => void,
  predicate: (data: string) => boolean,
  timeoutMs = 10_000
): Promise<string> => {
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    const timer = setTimeout(() => {
      reject(new Error(`timed out waiting for PTY output: ${chunks.join("")}`));
    }, timeoutMs);

    register((data) => {
      chunks.push(data);
      const output = chunks.join("");
      if (predicate(output)) {
        clearTimeout(timer);
        resolve(output);
      }
    });
  });
};

const waitForCapture = async (
  action: () => Promise<{ text: string; paneWidth: number; isApproximate: boolean }>,
  predicate: (capture: { text: string; paneWidth: number; isApproximate: boolean }) => boolean,
  timeoutMs = 10_000
): Promise<{ text: string; paneWidth: number; isApproximate: boolean }> => {
  const deadline = Date.now() + timeoutMs;
  let lastCapture: { text: string; paneWidth: number; isApproximate: boolean } | null = null;
  while (Date.now() < deadline) {
    lastCapture = await action();
    if (predicate(lastCapture)) {
      return lastCapture;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for zellij capture: ${JSON.stringify(lastCapture)}`);
};

const waitForSessionReady = async (
  socketDir: string,
  sessionName: string,
  timeoutMs = 10_000
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { stdout } = await execFileAsync("zellij", ["list-sessions", "-n"], {
        env: {
          ...process.env,
          ZELLIJ_SOCKET_DIR: socketDir
        }
      });
      if (stdout.includes(sessionName)) {
        return;
      }
    } catch {
      // Keep polling until timeout.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for zellij session '${sessionName}'`);
};

const resolveBridgeBinary = (): string | null => {
  const packagedBinaryNames = process.platform === "win32"
    ? ["remux-zellij-bridge.exe", "zellij-bridge.exe"]
    : ["remux-zellij-bridge", "zellij-bridge"];
  const devBinaryNames = process.platform === "win32"
    ? ["zellij-bridge.exe", "remux-zellij-bridge.exe"]
    : ["zellij-bridge", "remux-zellij-bridge"];
  const candidates = [
    process.env.REMUX_ZELLIJ_BRIDGE_BIN,
    ...packagedBinaryNames.map((binaryName) => path.resolve(process.cwd(), "dist/backend/zellij", binaryName)),
    ...devBinaryNames.map((binaryName) => path.resolve(process.cwd(), "native/zellij-bridge/target/release", binaryName)),
    ...devBinaryNames.map((binaryName) => path.resolve(process.cwd(), "native/zellij-bridge/target/debug", binaryName))
  ].filter((candidate): candidate is string => Boolean(candidate));

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
};

const bridgeBinary = resolveBridgeBinary();

const canRunIsolatedZellij = (() => {
  if (!shouldRun || !bridgeBinary || !process.stdin.isTTY || !process.stdout.isTTY) {
    return false;
  }

  const version = spawnSync("zellij", ["--version"], {
    encoding: "utf8"
  });
  if (version.status !== 0) {
    return false;
  }

  return true;
})();

describe.skipIf(!canRunIsolatedZellij)("real zellij smoke", () => {
  test("captures precise scrollback through the native bridge", async () => {
    const socketDir = fs.mkdtempSync(path.join(os.tmpdir(), "remux-zellij-smoke-"));
    const sessionName = `smoke-${process.pid}-${Date.now()}`;
    const previousBridgeBinary = process.env.REMUX_ZELLIJ_BRIDGE_BIN;
    process.env.REMUX_ZELLIJ_BRIDGE_BIN = bridgeBinary ?? undefined;
    const remuxShellPath = path.resolve(process.cwd(), "src/backend/zellij/remux-shell.sh");
    const bootstrapClient = spawn(
      "script",
      ["-q", "/dev/null", "zellij", "attach", "-c", sessionName, "options", "--default-shell", remuxShellPath],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          ZELLIJ_SOCKET_DIR: socketDir,
          REMUX: "1",
          SHELL: remuxShellPath,
          REMUX_ORIGINAL_SHELL: process.env.SHELL?.trim() || "/bin/sh"
        },
        stdio: ["pipe", "ignore", "ignore"]
      }
    );

    const zellij = new ZellijCliExecutor({ socketDir });
    const ptyFactory = new ZellijPtyFactory({
      socketDir,
      scrollbackLines: 200
    });

    try {
      await waitForSessionReady(socketDir, sessionName);
      bootstrapClient.stdin?.write("\x1b");
      await new Promise((resolve) => setTimeout(resolve, 250));

      const tabs = await zellij.listTabs(sessionName);
      const panes = await zellij.listPanes(sessionName, tabs[0]?.index ?? 0);
      const paneId = panes[0]?.id;
      expect(paneId).toBeTruthy();

      const ptyProcess = ptyFactory.spawnAttach(`${sessionName}:${paneId}`);
      try {
        await waitForPtyOutput(
          (handler) => ptyProcess.onData(handler),
          (output) => output.length > 0
        );

        const renderComplete = waitForPtyOutput(
          (handler) => ptyProcess.onData(handler),
          (output) => output.includes("smoke-40")
        );
        ptyProcess.write("for i in $(seq 1 40); do echo smoke-$i; done\r");
        await renderComplete;

        const capture = await waitForCapture(
          () => zellij.capturePane(paneId!, { lines: 80 }),
          (result) => !result.isApproximate && result.text.includes("smoke-1") && result.text.includes("smoke-40")
        );

        expect(capture.isApproximate).toBe(false);
        expect(capture.text).toContain("smoke-1");
        expect(capture.text).toContain("smoke-40");
        expect(capture.paneWidth).toBeGreaterThan(0);
      } finally {
        ptyProcess.kill();
      }
    } finally {
      process.env.REMUX_ZELLIJ_BRIDGE_BIN = previousBridgeBinary;
      bootstrapClient.kill("SIGTERM");
      await zellij.killSession(sessionName).catch(() => {});
      fs.rmSync(socketDir, { recursive: true, force: true });
    }
  }, 30_000);
});

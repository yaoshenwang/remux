import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawnSync } from "node:child_process";
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

const waitForTabList = async (
  action: () => Promise<Array<{ index: number; active: boolean }>>,
  predicate: (tabs: Array<{ index: number; active: boolean }>) => boolean,
  timeoutMs = 10_000
): Promise<Array<{ index: number; active: boolean }>> => {
  const deadline = Date.now() + timeoutMs;
  let lastTabs: Array<{ index: number; active: boolean }> = [];
  while (Date.now() < deadline) {
    lastTabs = await action();
    if (predicate(lastTabs)) {
      return lastTabs;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for zellij tabs: ${JSON.stringify(lastTabs)}`);
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

const waitForPtyExit = async (
  register: (handler: (exitCode: number) => void) => void,
  timeoutMs = 10_000
): Promise<number> => {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("timed out waiting for PTY exit"));
    }, timeoutMs);

    register((exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });
};

const makeShortSocketDir = (prefix: string): string => {
  const baseDir = process.platform === "win32" ? os.tmpdir() : "/tmp";
  return fs.mkdtempSync(path.join(baseDir, prefix));
};

const runZellijSessionCommand = async (
  socketDir: string,
  sessionName: string,
  args: string[]
): Promise<void> => {
  await execFileAsync("zellij", ["--session", sessionName, ...args], {
    env: {
      ...process.env,
      ZELLIJ_SOCKET_DIR: socketDir
    }
  });
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
    ...devBinaryNames.map((binaryName) => path.resolve(process.cwd(), "native/zellij-bridge/target/release", binaryName)),
    ...devBinaryNames.map((binaryName) => path.resolve(process.cwd(), "native/zellij-bridge/target/debug", binaryName)),
    ...packagedBinaryNames.map((binaryName) => path.resolve(process.cwd(), "dist/backend/zellij", binaryName))
  ].filter((candidate): candidate is string => Boolean(candidate));

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
};

const bridgeBinary = resolveBridgeBinary();
const externalSessionName = process.env.REAL_ZELLIJ_SESSION_NAME;
const externalSocketDir = process.env.REAL_ZELLIJ_SOCKET_DIR;
const smokeLogger = process.env.REAL_ZELLIJ_SMOKE_DEBUG === "1"
  ? console
  : undefined;

const canRunIsolatedZellij = (() => {
  if (!shouldRun || !bridgeBinary) {
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

const getPrimaryPaneId = async (
  zellij: ZellijCliExecutor,
  sessionName: string
): Promise<string> => {
  const tabs = await zellij.listTabs(sessionName);
  const panes = await zellij.listPanes(sessionName, tabs[0]?.index ?? 0);
  const paneId = panes[0]?.id;
  if (!paneId) {
    throw new Error(`failed to resolve a pane id for zellij session '${sessionName}'`);
  }
  return paneId;
};

const withRealZellijSession = async (
  action: (context: {
    sessionName: string;
    socketDir: string;
    zellij: ZellijCliExecutor;
    ptyFactory: ZellijPtyFactory;
  }) => Promise<void>
): Promise<void> => {
  const previousBridgeBinary = process.env.REMUX_ZELLIJ_BRIDGE_BIN;
  process.env.REMUX_ZELLIJ_BRIDGE_BIN = bridgeBinary ?? undefined;
  if (externalSessionName || externalSocketDir) {
    if (!externalSessionName || !externalSocketDir) {
      throw new Error(
        "REAL_ZELLIJ_SESSION_NAME and REAL_ZELLIJ_SOCKET_DIR must be provided together"
      );
    }

    const zellij = new ZellijCliExecutor({
      socketDir: externalSocketDir,
      logger: smokeLogger
    });
    const ptyFactory = new ZellijPtyFactory({
      socketDir: externalSocketDir,
      logger: smokeLogger,
      scrollbackLines: 200
    });

    try {
      await waitForSessionReady(externalSocketDir, externalSessionName);
      await action({
        sessionName: externalSessionName,
        socketDir: externalSocketDir,
        zellij,
        ptyFactory
      });
    } finally {
      process.env.REMUX_ZELLIJ_BRIDGE_BIN = previousBridgeBinary;
    }
    return;
  }

  const socketDir = makeShortSocketDir("rmx-zj-smoke-");
  const sessionName = `smoke-${process.pid}-${Date.now()}`;
  const zellij = new ZellijCliExecutor({
    socketDir,
    logger: smokeLogger
  });
  const ptyFactory = new ZellijPtyFactory({
    socketDir,
    logger: smokeLogger,
    scrollbackLines: 200
  });

  try {
    await zellij.createSession(sessionName);
    await waitForSessionReady(socketDir, sessionName);
    await action({ sessionName, socketDir, zellij, ptyFactory });
  } finally {
    process.env.REMUX_ZELLIJ_BRIDGE_BIN = previousBridgeBinary;
    await zellij.killSession(sessionName).catch(() => {});
    fs.rmSync(socketDir, { recursive: true, force: true });
  }
};

describe.skipIf(!canRunIsolatedZellij)("real zellij smoke", () => {
  test("captures precise scrollback through the native bridge", async () => {
    await withRealZellijSession(async ({ sessionName, zellij, ptyFactory }) => {
      const paneId = await getPrimaryPaneId(zellij, sessionName);
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
    });
  }, 30_000);

  test("handles bridge input, backspace, resize, and wrapped long lines", async () => {
    await withRealZellijSession(async ({ sessionName, zellij, ptyFactory }) => {
      const paneId = await getPrimaryPaneId(zellij, sessionName);
      const ptyProcess = ptyFactory.spawnAttach(`${sessionName}:${paneId}`);
      const longLine = "12345678901234567890123456789012";

      try {
        await waitForPtyOutput(
          (handler) => ptyProcess.onData(handler),
          (output) => output.length > 0
        );

        ptyProcess.resize(20, 12);
        ptyProcess.write("echo BRIDGx");
        ptyProcess.write("\u007f");
        ptyProcess.write("E_OK\r");
        await waitForPtyOutput(
          (handler) => ptyProcess.onData(handler),
          (output) => output.includes("BRIDGE_OK")
        );

        ptyProcess.write(`printf '%s\\n' '${longLine}'\r`);
        const wrappedOutput = await waitForPtyOutput(
          (handler) => ptyProcess.onData(handler),
          (output) => (
            output.includes("12345678901234567890")
            && output.includes("123456789012")
          )
        );

        expect(wrappedOutput).toContain("12345678901234567890");
        expect(wrappedOutput).toContain("123456789012");

        const capture = await waitForCapture(
          () => zellij.capturePane(paneId, { lines: 40 }),
          (result) => (
            !result.isApproximate
            && result.text.includes("BRIDGE_OK")
            && result.text.includes(longLine)
          )
        );

        expect(capture.isApproximate).toBe(false);
        expect(capture.text).toContain("BRIDGE_OK");
        expect(capture.text).toContain(longLine);
      } finally {
        ptyProcess.kill();
      }
    });
  }, 30_000);

  test("keeps pane-targeted input stable across external focus changes", async () => {
    await withRealZellijSession(async ({ sessionName, socketDir, zellij, ptyFactory }) => {
      const sourcePaneId = await getPrimaryPaneId(zellij, sessionName);
      const sourceTabs = await zellij.listTabs(sessionName);
      const sourceTabIndex = sourceTabs[0]?.index ?? 0;
      await runZellijSessionCommand(socketDir, sessionName, ["action", "new-tab"]);

      const tabs = await waitForTabList(
        () => zellij.listTabs(sessionName),
        (currentTabs) => currentTabs.some((tab) => tab.index !== sourceTabIndex)
      );
      const targetTabIndex = tabs.find((tab) => tab.index !== sourceTabIndex)?.index;
      if (targetTabIndex === undefined) {
        throw new Error("failed to resolve secondary tab for focus-change smoke");
      }

      const ptyProcess = ptyFactory.spawnAttach(`${sessionName}:${sourcePaneId}`);
      try {
        await waitForPtyOutput(
          (handler) => ptyProcess.onData(handler),
          (output) => output.length > 0
        );

        await zellij.selectTab(sessionName, targetTabIndex);
        ptyProcess.write("echo FOCUS_STICKY\r");

        const capture = await waitForCapture(
          () => zellij.capturePane(sourcePaneId, { lines: 80 }),
          (result) => result.text.includes("FOCUS_STICKY")
        );

        expect(capture.text).toContain("FOCUS_STICKY");
      } finally {
        ptyProcess.kill();
      }
    });
  }, 30_000);

  test("closes an attached pane cleanly when the pane is removed externally", async () => {
    await withRealZellijSession(async ({ sessionName, socketDir, zellij, ptyFactory }) => {
      const paneId = await getPrimaryPaneId(zellij, sessionName);
      const sourceTabs = await zellij.listTabs(sessionName);
      const sourceTabIndex = sourceTabs[0]?.index ?? 0;
      await runZellijSessionCommand(socketDir, sessionName, ["action", "new-tab"]);
      await waitForTabList(
        () => zellij.listTabs(sessionName),
        (currentTabs) => currentTabs.some((tab) => tab.index !== sourceTabIndex)
      );

      const ptyProcess = ptyFactory.spawnAttach(`${sessionName}:${paneId}`);
      try {
        await waitForPtyOutput(
          (handler) => ptyProcess.onData(handler),
          (output) => output.length > 0
        );

        const exitPromise = waitForPtyExit((handler) => {
          ptyProcess.onExit(handler);
        });

        await runZellijSessionCommand(socketDir, sessionName, [
          "action",
          "close-pane",
          "--pane-id",
          paneId
        ]);

        await expect(exitPromise).resolves.toBe(0);
      } finally {
        ptyProcess.kill();
      }
    });
  }, 30_000);
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const spawnMock = vi.fn();

vi.mock("node-pty", () => ({
  spawn: spawnMock
}));

describe("ZellijCliExecutor", () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    vi.resetModules();
    spawnMock.mockReset();
  });

  const makeSocketDir = (): string => {
    const socketDir = fs.mkdtempSync(path.join(os.tmpdir(), "remux-zellij-test-"));
    tempDirs.push(socketDir);
    return socketDir;
  };

  test("filters session list to sockets that exist in the isolated socket dir", async () => {
    const socketDir = makeSocketDir();
    fs.mkdirSync(path.join(socketDir, "contract_version_1"), { recursive: true });
    fs.writeFileSync(path.join(socketDir, "contract_version_1", "isolated"), "");

    const { ZellijCliExecutor } = await import("../../src/backend/zellij/cli-executor.js");
    const executor = new ZellijCliExecutor({
      socketDir,
      logger: { log: vi.fn(), error: vi.fn() }
    });

    const executorWithInternals = executor as unknown as {
      listSessionSummaries: () => Promise<Array<{ name: string; attached: boolean }>>;
      listTabs: (name: string) => Promise<Array<{ index: number }>>;
    };
    executorWithInternals.listSessionSummaries = vi.fn().mockResolvedValue([
      { name: "global-only", attached: false },
      { name: "isolated", attached: false }
    ]);
    executorWithInternals.listTabs = vi.fn().mockResolvedValue([{ index: 0 }]);

    await expect(executor.listSessions()).resolves.toEqual([
      { name: "isolated", attached: false, tabCount: 1 }
    ]);
  });

  test("does not treat same-named global metadata as an existing isolated session", async () => {
    const socketDir = makeSocketDir();

    const { ZellijCliExecutor } = await import("../../src/backend/zellij/cli-executor.js");
    const executor = new ZellijCliExecutor({
      socketDir,
      logger: { log: vi.fn(), error: vi.fn() }
    });

    const executorWithInternals = executor as unknown as {
      listSessionSummaries: () => Promise<Array<{ name: string }>>;
      spawnSessionBootstrap: (name: string) => Promise<void>;
    };
    executorWithInternals.listSessionSummaries = vi.fn().mockResolvedValue([{ name: "shared-name" }]);
    executorWithInternals.spawnSessionBootstrap = vi.fn().mockResolvedValue(undefined);

    await expect(executor.createSession("shared-name")).resolves.toBeUndefined();

    expect(executorWithInternals.spawnSessionBootstrap).toHaveBeenCalledWith("shared-name");
  });

  test("falls back to PTY bootstrap when attach -b fails", async () => {
    const kill = vi.fn();
    const onExit = vi.fn();
    spawnMock.mockReturnValue({ kill, onExit });

    const { ZellijCliExecutor } = await import("../../src/backend/zellij/cli-executor.js");
    const executor = new ZellijCliExecutor({
      timeoutMs: 500,
      logger: { log: vi.fn(), error: vi.fn() }
    });

    const executorWithInternals = executor as unknown as {
      tryCreateSessionInBackground: (name: string) => Promise<boolean>;
      listSessionSummaries: () => Promise<Array<{ name: string }>>;
      listSessionSummariesImmediate: () => Promise<Array<{ name: string }>>;
    };

    executorWithInternals.tryCreateSessionInBackground = vi.fn().mockRejectedValue(
      new Error("attach -b failed")
    );
    const listSessionsMock = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ name: "fallback-session" }]);
    executorWithInternals.listSessionSummaries = listSessionsMock;
    executorWithInternals.listSessionSummariesImmediate = listSessionsMock;

    await expect(executor.createSession("fallback-session")).resolves.toBeUndefined();

    expect(executorWithInternals.tryCreateSessionInBackground).toHaveBeenCalledWith("fallback-session");
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledTimes(1);
  });

  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

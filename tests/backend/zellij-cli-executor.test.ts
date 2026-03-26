import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const spawnMock = vi.fn();

vi.mock("node-pty", () => ({
  spawn: spawnMock
}));

class FakeNativeBridge {
  private dataHandlers: Array<(event: unknown) => void> = [];
  private exitHandlers: Array<(code: number | null) => void> = [];
  public readonly kill = vi.fn();

  onEvent(handler: (event: unknown) => void): void {
    this.dataHandlers.push(handler);
  }

  onExit(handler: (code: number | null) => void): void {
    this.exitHandlers.push(handler);
  }

  emit(event: unknown): void {
    for (const handler of this.dataHandlers) {
      handler(event);
    }
  }

  emitExit(code: number | null): void {
    for (const handler of this.exitHandlers) {
      handler(code);
    }
  }
}

describe("ZellijCliExecutor", () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    vi.resetModules();
    spawnMock.mockReset();
  });

  const makeSocketDir = (): string => {
    const baseDir = process.platform === "win32" ? os.tmpdir() : "/tmp";
    const socketDir = fs.mkdtempSync(path.join(baseDir, "rmx-zj-test-"));
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
      { name: "isolated", attached: false, tabCount: 0 }
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

  test("fails fast when an isolated socket dir would exceed the unix socket path limit", async () => {
    const socketDir = `/tmp/${"x".repeat(96)}`;

    const { ZellijCliExecutor } = await import("../../src/backend/zellij/cli-executor.js");
    const executor = new ZellijCliExecutor({
      socketDir,
      logger: { log: vi.fn(), error: vi.fn() }
    });

    const executorWithInternals = executor as unknown as {
      listSessionSummaries: () => Promise<Array<{ name: string }>>;
    };
    executorWithInternals.listSessionSummaries = vi.fn().mockResolvedValue([]);

    await expect(executor.createSession("short")).rejects.toThrow(/socket path.*too long/i);
  });

  test("prefers native detached bootstrap before CLI background attach", async () => {
    const { ZellijCliExecutor } = await import("../../src/backend/zellij/cli-executor.js");
    const executor = new ZellijCliExecutor({
      timeoutMs: 500,
      logger: { log: vi.fn(), error: vi.fn() }
    });

    const executorWithInternals = executor as unknown as {
      listSessionSummaries: () => Promise<Array<{ name: string }>>;
      tryCreateSessionWithNativeBridge: (name: string) => Promise<boolean>;
      tryCreateSessionInBackground: (name: string) => Promise<boolean>;
    };

    executorWithInternals.listSessionSummaries = vi.fn().mockResolvedValue([]);
    executorWithInternals.tryCreateSessionWithNativeBridge = vi.fn().mockResolvedValue(true);
    executorWithInternals.tryCreateSessionInBackground = vi.fn().mockResolvedValue(false);

    await expect(executor.createSession("native-bootstrap")).resolves.toBeUndefined();

    expect(executorWithInternals.tryCreateSessionWithNativeBridge).toHaveBeenCalledWith("native-bootstrap");
    expect(executorWithInternals.tryCreateSessionInBackground).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  test("falls back to CLI background attach when native detached bootstrap is unavailable", async () => {
    const { ZellijCliExecutor } = await import("../../src/backend/zellij/cli-executor.js");
    const executor = new ZellijCliExecutor({
      timeoutMs: 500,
      logger: { log: vi.fn(), error: vi.fn() }
    });

    const executorWithInternals = executor as unknown as {
      listSessionSummaries: () => Promise<Array<{ name: string }>>;
      tryCreateSessionWithNativeBridge: (name: string) => Promise<boolean>;
      tryCreateSessionInBackground: (name: string) => Promise<boolean>;
    };

    executorWithInternals.listSessionSummaries = vi.fn().mockResolvedValue([]);
    executorWithInternals.tryCreateSessionWithNativeBridge = vi.fn().mockResolvedValue(false);
    executorWithInternals.tryCreateSessionInBackground = vi.fn().mockResolvedValue(true);

    await expect(executor.createSession("cli-background")).resolves.toBeUndefined();

    expect(executorWithInternals.tryCreateSessionWithNativeBridge).toHaveBeenCalledWith("cli-background");
    expect(executorWithInternals.tryCreateSessionInBackground).toHaveBeenCalledWith("cli-background");
    expect(spawnMock).not.toHaveBeenCalled();
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
      tryCreateSessionWithNativeBridge: (name: string) => Promise<boolean>;
      tryCreateSessionInBackground: (name: string) => Promise<boolean>;
      listSessionSummaries: () => Promise<Array<{ name: string }>>;
      listSessionSummariesImmediate: () => Promise<Array<{ name: string }>>;
    };

    executorWithInternals.tryCreateSessionWithNativeBridge = vi.fn().mockResolvedValue(false);
    executorWithInternals.tryCreateSessionInBackground = vi.fn().mockRejectedValue(
      new Error("attach -b failed")
    );
    const listSessionsMock = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ name: "fallback-session" }]);
    executorWithInternals.listSessionSummaries = listSessionsMock;
    executorWithInternals.listSessionSummariesImmediate = listSessionsMock;
    const shellCommand = await (executor as unknown as {
      getRemuxShellCommand: () => Promise<string[]>;
    }).getRemuxShellCommand();

    await expect(executor.createSession("fallback-session")).resolves.toBeUndefined();

    expect(executorWithInternals.tryCreateSessionWithNativeBridge).toHaveBeenCalledWith("fallback-session");
    expect(executorWithInternals.tryCreateSessionInBackground).toHaveBeenCalledWith("fallback-session");
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0]?.[1]?.[1]).toContain("'attach' '-c' 'fallback-session' 'options' '--default-shell'");
    expect(spawnMock.mock.calls[0]?.[1]?.[1]).toContain("'--show-startup-tips' 'false'");
    expect(spawnMock.mock.calls[0]?.[1]?.[1]).toContain("'--show-release-notes' 'false'");
    expect(spawnMock.mock.calls[0]?.[2]?.env).toEqual(expect.objectContaining({
      SHELL: shellCommand[0],
      REMUX_ORIGINAL_SHELL: process.env.SHELL?.trim() || "/bin/sh",
      REMUX: "1"
    }));
    expect(kill).toHaveBeenCalledTimes(1);
  });

  test("waits for PTY bootstrap sessions to become live before createSession resolves", async () => {
    const kill = vi.fn();
    const onExit = vi.fn();
    spawnMock.mockReturnValue({ kill, onExit });

    const { ZellijCliExecutor } = await import("../../src/backend/zellij/cli-executor.js");
    const executor = new ZellijCliExecutor({
      timeoutMs: 800,
      logger: { log: vi.fn(), error: vi.fn() }
    });

    const executorWithInternals = executor as unknown as {
      listSessionSummaries: () => Promise<Array<{ name: string; lifecycle?: string }>>;
      tryCreateSessionWithNativeBridge: (name: string) => Promise<boolean>;
      tryCreateSessionInBackground: (name: string) => Promise<boolean>;
      listSessionSummariesImmediate: () => Promise<Array<{ name: string; lifecycle?: string }>>;
    };

    executorWithInternals.listSessionSummaries = vi.fn().mockResolvedValue([]);
    executorWithInternals.tryCreateSessionWithNativeBridge = vi.fn().mockResolvedValue(false);
    executorWithInternals.tryCreateSessionInBackground = vi.fn().mockRejectedValue(
      new Error("attach -b failed")
    );
    executorWithInternals.listSessionSummariesImmediate = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ name: "live-later", lifecycle: "exited" }])
      .mockResolvedValueOnce([{ name: "live-later", lifecycle: "live" }]);

    await expect(executor.createSession("live-later")).resolves.toBeUndefined();

    expect(executorWithInternals.listSessionSummariesImmediate).toHaveBeenCalledTimes(3);
    expect(kill).toHaveBeenCalledTimes(1);
  });

  test("uses the remux shell wrapper for new tabs and panes", async () => {
    const socketDir = makeSocketDir();
    const { ZellijCliExecutor } = await import("../../src/backend/zellij/cli-executor.js");
    const executor = new ZellijCliExecutor({
      socketDir,
      logger: { log: vi.fn(), error: vi.fn() }
    });

    const executorWithInternals = executor as unknown as {
      paneSessionMap: Map<string, string>;
      runZellij: (args: string[], session?: string) => Promise<string>;
      getRemuxShellCommand: () => Promise<string[]>;
    };
    const runZellij = vi.fn().mockResolvedValue("");
    executorWithInternals.runZellij = runZellij;
    executorWithInternals.paneSessionMap.set("terminal_1", "main");

    const shellCommand = await executorWithInternals.getRemuxShellCommand();

    await executor.newTab("main");
    await executor.splitPane("terminal_1", "right");

    expect(shellCommand).toHaveLength(1);
    expect(fs.readFileSync(shellCommand[0], "utf8")).toContain("export REMUX=1");
    expect(runZellij).toHaveBeenNthCalledWith(
      1,
      ["action", "new-tab", "--", ...shellCommand],
      "main"
    );
    expect(runZellij).toHaveBeenNthCalledWith(
      2,
      ["action", "hide-floating-panes"],
      "main"
    );
    expect(runZellij).toHaveBeenNthCalledWith(
      3,
      ["action", "list-panes", "--json", "--all"],
      "main"
    );
    expect(runZellij).toHaveBeenNthCalledWith(
      4,
      ["action", "new-pane", "-d", "right", "--", ...shellCommand],
      "main"
    );
  });

  test("builds a snapshot with one tabs call and one panes call per live session", async () => {
    const { ZellijCliExecutor } = await import("../../src/backend/zellij/cli-executor.js");
    const executor = new ZellijCliExecutor({
      logger: { log: vi.fn(), error: vi.fn() }
    });

    const executorWithInternals = executor as unknown as {
      buildSnapshot: () => Promise<{
        sessions: Array<{ name: string; lifecycle?: string; tabCount: number; tabs: Array<{ paneCount: number }> }>;
      }>;
      listSessionSummaries: () => Promise<Array<{ name: string; attached: boolean; tabCount: number; lifecycle?: string }>>;
      sessionExistsInSocketDir: (name: string) => Promise<boolean>;
      runZellij: (args: string[], session?: string) => Promise<string>;
    };

    executorWithInternals.listSessionSummaries = vi.fn().mockResolvedValue([
      { name: "live", attached: true, tabCount: 0, lifecycle: "live" },
      { name: "saved", attached: false, tabCount: 0, lifecycle: "exited" }
    ]);
    executorWithInternals.sessionExistsInSocketDir = vi.fn().mockResolvedValue(true);
    executorWithInternals.runZellij = vi.fn()
      .mockResolvedValueOnce(JSON.stringify([
        {
          position: 0,
          name: "shell",
          active: true,
          is_fullscreen_active: false,
          is_sync_panes_active: false,
          are_floating_panes_visible: false,
          viewport_rows: 24,
          viewport_columns: 120,
          display_area_rows: 24,
          display_area_columns: 120,
          selectable_tiled_panes_count: 1,
          selectable_floating_panes_count: 0,
          tab_id: 7
        }
      ]))
      .mockResolvedValueOnce(JSON.stringify([
        {
          id: 3,
          is_plugin: false,
          is_focused: true,
          is_fullscreen: false,
          is_floating: false,
          is_suppressed: false,
          title: "shell",
          exited: false,
          exit_status: null,
          is_held: false,
          pane_x: 0,
          pane_y: 0,
          pane_rows: 24,
          pane_columns: 120,
          pane_content_rows: 22,
          pane_content_columns: 118,
          cursor_coordinates_in_pane: [0, 0],
          terminal_command: "/bin/zsh",
          plugin_url: null,
          is_selectable: true,
          tab_id: 7,
          tab_position: 0,
          tab_name: "shell",
          pane_cwd: "/tmp"
        }
      ]));

    const snapshot = await executorWithInternals.buildSnapshot();

    expect(executorWithInternals.runZellij).toHaveBeenCalledTimes(2);
    expect(snapshot.sessions).toHaveLength(2);
    expect(snapshot.sessions[0]).toMatchObject({
      name: "live",
      tabCount: 1,
      tabs: [{ paneCount: 1 }]
    });
    expect(snapshot.sessions[1]).toMatchObject({
      name: "saved",
      lifecycle: "exited",
      tabCount: 0,
      tabs: []
    });
  });

  test("reports zellij scrollback as approximate", async () => {
    const { ZellijCliExecutor } = await import("../../src/backend/zellij/cli-executor.js");
    const executor = new ZellijCliExecutor({
      logger: { log: vi.fn(), error: vi.fn() }
    });

    expect(executor.capabilities.supportsPreciseScrollback).toBe(false);

    const executorWithInternals = executor as unknown as {
      paneSessionMap: Map<string, string>;
      runZellij: (args: string[], session?: string, options?: { raw?: boolean }) => Promise<string>;
    };
    executorWithInternals.paneSessionMap.set("terminal_3", "main");
    executorWithInternals.runZellij = vi.fn()
      .mockResolvedValueOnce("line 1\nline 2\n")
      .mockResolvedValueOnce(JSON.stringify([
        { id: 3, is_plugin: false, pane_content_columns: 118 }
      ]));

    await expect(executor.capturePane("terminal_3", { lines: 10 })).resolves.toEqual({
      text: "line 1\nline 2\n",
      paneWidth: 118,
      isApproximate: true
    });
  });

  test("uses native bridge scrollback cache for precise capture when available", async () => {
    const { ZellijCliExecutor } = await import("../../src/backend/zellij/cli-executor.js");
    const { createZellijNativeBridgeStateStore } = await import("../../src/backend/zellij/native-bridge-state.js");
    const nativeBridgeStateStore = createZellijNativeBridgeStateStore();
    nativeBridgeStateStore.updatePaneRender("main", "terminal_3", {
      viewport: ["prompt", "latest"],
      scrollback: ["line 1", "line 2"]
    });

    const executor = new ZellijCliExecutor({
      logger: { log: vi.fn(), error: vi.fn() },
      nativeBridgeStateStore
    });

    const executorWithInternals = executor as unknown as {
      paneSessionMap: Map<string, string>;
      runZellij: (args: string[], session?: string, options?: { raw?: boolean }) => Promise<string>;
    };
    executorWithInternals.paneSessionMap.set("terminal_3", "main");
    executorWithInternals.runZellij = vi.fn().mockResolvedValueOnce(JSON.stringify([
      { id: 3, is_plugin: false, pane_content_columns: 118 }
    ]));

    await expect(executor.capturePane("terminal_3", { lines: 3 })).resolves.toEqual({
      text: "line 2\nprompt\nlatest",
      paneWidth: 118,
      isApproximate: false
    });

    expect(executorWithInternals.runZellij).toHaveBeenCalledTimes(1);
    expect(executorWithInternals.runZellij).toHaveBeenCalledWith(
      ["action", "list-panes", "--json", "--all"],
      "main"
    );
  });

  test("falls back to CLI capture when native bridge cache has no scrollback payload", async () => {
    const { ZellijCliExecutor } = await import("../../src/backend/zellij/cli-executor.js");
    const { createZellijNativeBridgeStateStore } = await import("../../src/backend/zellij/native-bridge-state.js");
    const nativeBridgeStateStore = createZellijNativeBridgeStateStore();
    nativeBridgeStateStore.updatePaneRender("main", "terminal_3", {
      viewport: ["visible only"],
      scrollback: null
    });

    const executor = new ZellijCliExecutor({
      logger: { log: vi.fn(), error: vi.fn() },
      nativeBridgeStateStore
    });

    const executorWithInternals = executor as unknown as {
      paneSessionMap: Map<string, string>;
      runZellij: (args: string[], session?: string, options?: { raw?: boolean }) => Promise<string>;
    };
    executorWithInternals.paneSessionMap.set("terminal_3", "main");
    executorWithInternals.runZellij = vi.fn()
      .mockResolvedValueOnce("line 1\nline 2\n")
      .mockResolvedValueOnce(JSON.stringify([
        { id: 3, is_plugin: false, pane_content_columns: 118 }
      ]));

    await expect(executor.capturePane("terminal_3", { lines: 10 })).resolves.toEqual({
      text: "line 1\nline 2\n",
      paneWidth: 118,
      isApproximate: true
    });

    expect(executorWithInternals.runZellij).toHaveBeenCalledTimes(2);
  });

  test("uses the uniquely tracked native bridge pane when the pane session cache is empty", async () => {
    const { ZellijCliExecutor } = await import("../../src/backend/zellij/cli-executor.js");
    const { createZellijNativeBridgeStateStore } = await import("../../src/backend/zellij/native-bridge-state.js");
    const nativeBridgeStateStore = createZellijNativeBridgeStateStore();
    nativeBridgeStateStore.updatePaneRender("main", "terminal_3", {
      viewport: ["prompt", "latest"],
      scrollback: ["line 1", "line 2"]
    });

    const executor = new ZellijCliExecutor({
      logger: { log: vi.fn(), error: vi.fn() },
      nativeBridgeStateStore
    });

    const executorWithInternals = executor as unknown as {
      runZellij: (args: string[], session?: string, options?: { raw?: boolean }) => Promise<string>;
    };
    executorWithInternals.runZellij = vi.fn().mockResolvedValueOnce(JSON.stringify([
      { id: 3, is_plugin: false, pane_content_columns: 118 }
    ]));

    await expect(executor.capturePane("terminal_3", { lines: 4 })).resolves.toEqual({
      text: "line 1\nline 2\nprompt\nlatest",
      paneWidth: 118,
      isApproximate: false
    });

    expect(executorWithInternals.runZellij).toHaveBeenCalledWith(
      ["action", "list-panes", "--json", "--all"],
      "main"
    );
  });

  test("captures precise scrollback through an on-demand native bridge snapshot when cache is unavailable", async () => {
    const fakeBridge = new FakeNativeBridge();
    const { ZellijCliExecutor } = await import("../../src/backend/zellij/cli-executor.js");
    const executor = new ZellijCliExecutor({
      logger: { log: vi.fn(), error: vi.fn() },
      nativeBridgeFactory: async () => fakeBridge
    });

    const executorWithInternals = executor as unknown as {
      paneSessionMap: Map<string, string>;
      runZellij: (args: string[], session?: string, options?: { raw?: boolean }) => Promise<string>;
    };
    executorWithInternals.paneSessionMap.set("terminal_3", "main");
    executorWithInternals.runZellij = vi.fn().mockResolvedValueOnce(JSON.stringify([
      { id: 3, is_plugin: false, pane_content_columns: 118 }
    ]));

    const capturePromise = executor.capturePane("terminal_3", { lines: 3 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    fakeBridge.emit({
      type: "pane_render",
      paneId: "terminal_3",
      viewport: ["prompt", "latest"],
      scrollback: ["line 1", "line 2"],
      isInitial: true
    });

    await expect(capturePromise).resolves.toEqual({
      text: "line 2\nprompt\nlatest",
      paneWidth: 118,
      isApproximate: false
    });
    expect(fakeBridge.kill).toHaveBeenCalledTimes(1);
  });

  test("passes the remux shell wrapper to background session creation", async () => {
    const socketDir = makeSocketDir();
    const { ZellijCliExecutor } = await import("../../src/backend/zellij/cli-executor.js");
    const executor = new ZellijCliExecutor({
      socketDir,
      logger: { log: vi.fn(), error: vi.fn() }
    });

    const executorWithInternals = executor as unknown as {
      runZellij: (args: string[], session?: string) => Promise<string>;
      listSessionSummariesImmediate: () => Promise<Array<{ name: string }>>;
      getRemuxShellCommand: () => Promise<string[]>;
      tryCreateSessionInBackground: (name: string) => Promise<boolean>;
    };
    const runZellij = vi.fn().mockResolvedValue("");
    executorWithInternals.runZellij = runZellij;
    executorWithInternals.listSessionSummariesImmediate = vi.fn().mockResolvedValue([
      { name: "background-session" }
    ]);

    const shellCommand = await executorWithInternals.getRemuxShellCommand();
    await expect(
      executorWithInternals.tryCreateSessionInBackground("background-session")
    ).resolves.toBe(true);

    expect(runZellij).toHaveBeenCalledWith(
      [
        "attach", "-b", "background-session",
        "options",
        "--default-shell", shellCommand[0],
        "--show-startup-tips", "false",
        "--show-release-notes", "false"
      ],
      undefined,
      {
        env: expect.objectContaining({
          SHELL: shellCommand[0],
          REMUX_ORIGINAL_SHELL: process.env.SHELL?.trim() || "/bin/sh"
        })
      }
    );
  });

  test("waits for background-created sessions to become live", async () => {
    const { ZellijCliExecutor } = await import("../../src/backend/zellij/cli-executor.js");
    const executor = new ZellijCliExecutor({
      timeoutMs: 800,
      logger: { log: vi.fn(), error: vi.fn() }
    });

    const executorWithInternals = executor as unknown as {
      runZellij: (args: string[], session?: string) => Promise<string>;
      listSessionSummariesImmediate: () => Promise<Array<{ name: string; lifecycle?: string }>>;
      tryCreateSessionInBackground: (name: string) => Promise<boolean>;
    };

    executorWithInternals.runZellij = vi.fn().mockResolvedValue("");
    executorWithInternals.listSessionSummariesImmediate = vi.fn()
      .mockResolvedValueOnce([{ name: "background-session", lifecycle: "exited" }])
      .mockResolvedValueOnce([{ name: "background-session", lifecycle: "live" }]);

    await expect(
      executorWithInternals.tryCreateSessionInBackground("background-session")
    ).resolves.toBe(true);

    expect(executorWithInternals.listSessionSummariesImmediate).toHaveBeenCalledTimes(2);
  });

  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

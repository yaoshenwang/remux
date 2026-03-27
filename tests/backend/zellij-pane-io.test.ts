import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const nodePtySpawnMock = vi.fn();
const execFileMock = vi.fn();
const execFileWithPromisify = Object.assign(execFileMock, {
  [promisify.custom]: (...args: unknown[]) => new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFileMock(...args, (error: Error | null, stdout: string, stderr: string) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  })
});

vi.mock("node-pty", () => ({
  spawn: nodePtySpawnMock
}));

vi.mock("node:child_process", () => ({
  execFile: execFileWithPromisify
}));

class FakeNativeBridge {
  private dataHandlers: Array<(event: unknown) => void> = [];
  private exitHandlers: Array<(code: number | null) => void> = [];
  public readonly kill = vi.fn();
  public readonly sendCommand = vi.fn(() => true);

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

describe("ZellijPaneIO", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    nodePtySpawnMock.mockReset();
    execFileMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  const flushAsyncWork = async (): Promise<void> => {
    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();
    await Promise.resolve();
  };

  test("renders a full viewport frame with explicit cursor positioning", async () => {
    const { buildViewportFrame } = await import("../../src/backend/zellij/pane-io.js");

    expect(buildViewportFrame(
      ["\u001b[mhello", "\u001b[mworld\u001b[m"],
      { col: 3, row: 2 }
    )).toBe(
      "\x1b[?25l\x1b[3J\x1b[H\x1b[2J"
      + "\x1b[1;1H\x1b[2K\u001b[mhello"
      + "\x1b[2;1H\x1b[2K\u001b[mworld\u001b[m"
      + "\x1b[m\x1b[2;3H\x1b[?25h"
    );
  });

  test("creates a hidden client only when CLI resize fallback is needed", async () => {
    const firstClient = {
      resize: vi.fn(),
      write: vi.fn(),
      kill: vi.fn(),
      onExit: vi.fn()
    };
    const secondClient = {
      resize: vi.fn(),
      write: vi.fn(),
      kill: vi.fn(),
      onExit: vi.fn()
    };
    nodePtySpawnMock
      .mockReturnValueOnce(firstClient)
      .mockReturnValueOnce(secondClient);

    execFileMock.mockImplementation((_file, args, _options, callback) => {
      if (args.includes("dump-screen")) {
        callback?.(null, "", "");
        return;
      }
      if (args.includes("list-panes")) {
        callback?.(null, JSON.stringify([
          { id: 1, is_plugin: false, cursor_coordinates_in_pane: [1, 1] },
          { id: 2, is_plugin: false, cursor_coordinates_in_pane: [1, 1] }
        ]), "");
        return;
      }
      callback?.(null, "", "");
    });

    const { ZellijPaneIO } = await import("../../src/backend/zellij/pane-io.js");

    const first = new ZellijPaneIO({ session: "main", paneId: "terminal_1" });
    const second = new ZellijPaneIO({ session: "main", paneId: "terminal_2" });

    expect(nodePtySpawnMock).not.toHaveBeenCalled();

    first.resize(120, 40);
    second.resize(90, 30);
    await flushAsyncWork();

    expect(nodePtySpawnMock).toHaveBeenCalledTimes(2);
    expect(firstClient.resize).toHaveBeenCalledWith(120, 40);
    expect(secondClient.resize).toHaveBeenCalledWith(90, 30);

    first.kill();
    second.kill();

    expect(firstClient.kill).toHaveBeenCalledTimes(1);
    expect(secondClient.kill).toHaveBeenCalledTimes(1);
  });

  test("holds the initial resize until the native bridge is ready", async () => {
    const hiddenClient = {
      resize: vi.fn(),
      write: vi.fn(),
      kill: vi.fn(),
      onExit: vi.fn()
    };
    nodePtySpawnMock.mockReturnValue(hiddenClient);

    const fakeBridge = new FakeNativeBridge();
    let resolveBridge: ((bridge: FakeNativeBridge) => void) | null = null;

    const { ZellijPaneIO } = await import("../../src/backend/zellij/pane-io.js");
    const io = new ZellijPaneIO({
      session: "main",
      paneId: "terminal_2",
      nativeBridgeFactory: async () => new Promise((resolve) => {
        resolveBridge = resolve;
      })
    });

    io.resize(132, 41);
    expect(nodePtySpawnMock).not.toHaveBeenCalled();

    resolveBridge?.(fakeBridge);
    await flushAsyncWork();

    expect(fakeBridge.sendCommand).toHaveBeenCalledWith({
      type: "terminal_resize",
      cols: 132,
      rows: 41
    });
    expect(hiddenClient.resize).not.toHaveBeenCalled();

    io.kill();
  });

  test("serializes write batches so Enter cannot overtake earlier text", async () => {
    const hiddenClient = {
      resize: vi.fn(),
      write: vi.fn(),
      kill: vi.fn(),
      onExit: vi.fn()
    };
    nodePtySpawnMock.mockReturnValue(hiddenClient);

    const pendingWriteCallbacks: Array<() => void> = [];
    execFileMock.mockImplementation((_file, args, _options, callback) => {
      if (args.includes("dump-screen")) {
        callback?.(null, "\u001b[mprompt\u001b[m", "");
        return;
      }
      if (args.includes("list-panes")) {
        callback?.(null, JSON.stringify([
          {
            id: 0,
            is_plugin: false,
            cursor_coordinates_in_pane: [7, 1]
          }
        ]), "");
        return;
      }
      if (args.includes("write") || args.includes("write-chars")) {
        pendingWriteCallbacks.push(() => callback?.(null, "", ""));
        return;
      }
      callback?.(null, "", "");
    });

    const { ZellijPaneIO } = await import("../../src/backend/zellij/pane-io.js");
    const io = new ZellijPaneIO({ session: "main", paneId: "terminal_0" });

    await flushAsyncWork();
    execFileMock.mockClear();

    io.write("e");
    await vi.advanceTimersByTimeAsync(12);

    io.write("cho");
    await vi.advanceTimersByTimeAsync(12);

    io.write("\r");
    await vi.advanceTimersByTimeAsync(12);

    const currentWriteCalls = () => execFileMock.mock.calls.filter(([, args]) =>
      (args as string[]).includes("write") || (args as string[]).includes("write-chars")
    );

    expect(currentWriteCalls()).toHaveLength(1);
    expect(currentWriteCalls()[0]?.[1]).toEqual([
      "--session", "main",
      "action", "write-chars",
      "--pane-id", "terminal_0",
      "--",
      "e"
    ]);

    pendingWriteCallbacks.shift()?.();
    await flushAsyncWork();

    expect(currentWriteCalls()).toHaveLength(2);
    expect(currentWriteCalls()[1]?.[1]).toEqual([
      "--session", "main",
      "action", "write-chars",
      "--pane-id", "terminal_0",
      "--",
      "cho"
    ]);

    pendingWriteCallbacks.shift()?.();
    await flushAsyncWork();

    expect(currentWriteCalls()).toHaveLength(3);
    expect(currentWriteCalls()[2]?.[1]).toEqual([
      "--session", "main",
      "action", "write",
      "--pane-id", "terminal_0",
      "13"
    ]);

    pendingWriteCallbacks.shift()?.();
    await flushAsyncWork();

    io.kill();
  });

  test("passes write-chars payloads after -- so leading dashes are treated as text", async () => {
    const hiddenClient = {
      resize: vi.fn(),
      write: vi.fn(),
      kill: vi.fn(),
      onExit: vi.fn()
    };
    nodePtySpawnMock.mockReturnValue(hiddenClient);

    execFileMock.mockImplementation((_file, args, _options, callback) => {
      if (args.includes("dump-screen")) {
        callback?.(null, "\u001b[mprompt\u001b[m", "");
        return;
      }
      if (args.includes("list-panes")) {
        callback?.(null, JSON.stringify([
          {
            id: 0,
            is_plugin: false,
            cursor_coordinates_in_pane: [7, 1]
          }
        ]), "");
        return;
      }
      callback?.(null, "", "");
    });

    const { ZellijPaneIO } = await import("../../src/backend/zellij/pane-io.js");
    const io = new ZellijPaneIO({ session: "main", paneId: "terminal_0" });

    await flushAsyncWork();
    execFileMock.mockClear();

    io.write("-n");
    await vi.advanceTimersByTimeAsync(12);
    await flushAsyncWork();

    const writeCall = execFileMock.mock.calls.find(([, args]) =>
      (args as string[]).includes("write-chars")
    );

    expect(writeCall?.[1]).toEqual([
      "--session", "main",
      "action", "write-chars",
      "--pane-id", "terminal_0",
      "--",
      "-n"
    ]);

    io.kill();
  });

  test("renders bridge pane updates without CLI cursor polling when the bridge supplies cursor", async () => {
    const hiddenClient = {
      resize: vi.fn(),
      write: vi.fn(),
      kill: vi.fn(),
      onExit: vi.fn()
    };
    nodePtySpawnMock.mockReturnValue(hiddenClient);

    const fakeBridge = new FakeNativeBridge();
    execFileMock.mockImplementation((_file, args, _options, callback) => {
      if (args.includes("dump-screen")) {
        callback?.(new Error("dump-screen should not be used in bridge mode"), "", "");
        return;
      }
      callback?.(null, "", "");
    });

    const { ZellijPaneIO } = await import("../../src/backend/zellij/pane-io.js");
    const { createZellijNativeBridgeStateStore } = await import("../../src/backend/zellij/native-bridge-state.js");
    const nativeBridgeStateStore = createZellijNativeBridgeStateStore();
    const io = new ZellijPaneIO({
      session: "main",
      paneId: "terminal_7",
      nativeBridgeFactory: async (options) => {
        expect(options.scrollbackLines).toBe(256);
        return fakeBridge;
      },
      nativeBridgeStateStore,
      scrollbackLines: 256
    });

    const frames: string[] = [];
    io.onData((data) => frames.push(data));

    await flushAsyncWork();
    execFileMock.mockClear();

    fakeBridge.emit({
      type: "pane_render",
      paneId: "terminal_7",
      viewport: ["\u001b[mhello", "\u001b[mworld"],
      scrollback: null,
      isInitial: true,
      cursor: { row: 2, col: 6 }
    });

    await flushAsyncWork();

    expect(execFileMock).not.toHaveBeenCalled();
    // First frame: full clear + viewport (initial render, no previous viewport)
    expect(frames[0]).toBe(
      "\x1b[?25l\x1b[3J\x1b[H\x1b[2J"
      + "\x1b[1;1H\x1b[2K\u001b[mhello"
      + "\x1b[2;1H\x1b[2K\u001b[mworld"
      + "\x1b[m\x1b[2;6H\x1b[?25h"
    );
    expect(nativeBridgeStateStore.getPaneSnapshot("main", "terminal_7")).toEqual({
      session: "main",
      paneId: "terminal_7",
      viewport: ["\u001b[mhello", "\u001b[mworld"],
      scrollback: null,
      updatedAt: expect.any(Number)
    });

    io.kill();
    expect(fakeBridge.kill).toHaveBeenCalledTimes(1);
    expect(nativeBridgeStateStore.getPaneSnapshot("main", "terminal_7")).toBeNull();
  });

  test("emits exit when the native bridge reports that the pane closed", async () => {
    const fakeBridge = new FakeNativeBridge();
    const { ZellijPaneIO } = await import("../../src/backend/zellij/pane-io.js");
    const io = new ZellijPaneIO({
      session: "main",
      paneId: "terminal_4",
      nativeBridgeFactory: async () => fakeBridge
    });

    const exits: number[] = [];
    io.onExit((code) => exits.push(code));

    await flushAsyncWork();

    fakeBridge.emit({
      type: "pane_closed",
      paneId: "terminal_4"
    });

    expect(exits).toEqual([0]);
    expect(fakeBridge.kill).toHaveBeenCalledTimes(1);
  });

  test("reports degraded runtime state when native bridge startup fails", async () => {
    const { ZellijPaneIO } = await import("../../src/backend/zellij/pane-io.js");
    const io = new ZellijPaneIO({
      session: "main",
      paneId: "terminal_4",
      nativeBridgeFactory: async () => {
        throw new Error("bridge unavailable");
      }
    });

    const states: Array<{ streamMode: string; degradedReason?: string; scrollbackPrecision: string }> = [];
    io.onRuntimeStateChange((state) => states.push(state));

    await flushAsyncWork();

    expect(io.getRuntimeState()).toEqual({
      streamMode: "cli-polling",
      degradedReason: "startup_failed",
      scrollbackPrecision: "approximate"
    });
    expect(states.at(-1)).toEqual({
      streamMode: "cli-polling",
      degradedReason: "startup_failed",
      scrollbackPrecision: "approximate"
    });

    io.kill();
  });

  test("prefers bridge commands for writes when the native bridge is active", async () => {
    const hiddenClient = {
      resize: vi.fn(),
      write: vi.fn(),
      kill: vi.fn(),
      onExit: vi.fn()
    };
    nodePtySpawnMock.mockReturnValue(hiddenClient);

    const fakeBridge = new FakeNativeBridge();
    execFileMock.mockImplementation((_file, args, _options, callback) => {
      if (args.includes("list-panes")) {
        callback?.(null, JSON.stringify([
          {
            id: 9,
            is_plugin: false,
            cursor_coordinates_in_pane: [1, 1]
          }
        ]), "");
        return;
      }
      if (args.includes("dump-screen")) {
        callback?.(new Error("dump-screen should not be used in bridge mode"), "", "");
        return;
      }
      callback?.(null, "", "");
    });

    const { ZellijPaneIO } = await import("../../src/backend/zellij/pane-io.js");
    const io = new ZellijPaneIO({
      session: "main",
      paneId: "terminal_9",
      nativeBridgeFactory: async () => fakeBridge
    });

    await flushAsyncWork();
    execFileMock.mockClear();

    io.write("echo");
    await vi.advanceTimersByTimeAsync(12);
    await flushAsyncWork();

    io.write("\r");
    await vi.advanceTimersByTimeAsync(12);
    await flushAsyncWork();

    expect(fakeBridge.sendCommand).toHaveBeenNthCalledWith(1, {
      type: "write_chars",
      chars: "echo"
    });
    expect(fakeBridge.sendCommand).toHaveBeenNthCalledWith(2, {
      type: "write_bytes",
      bytes: [13]
    });
    expect(execFileMock.mock.calls.some(([, args]) => {
      const finalArgs = args as string[];
      return finalArgs.includes("write") || finalArgs.includes("write-chars");
    })).toBe(false);

    io.kill();
  });

  test("falls back to CLI writes if the bridge command path rejects a write", async () => {
    const hiddenClient = {
      resize: vi.fn(),
      write: vi.fn(),
      kill: vi.fn(),
      onExit: vi.fn()
    };
    nodePtySpawnMock.mockReturnValue(hiddenClient);

    const fakeBridge = new FakeNativeBridge();
    fakeBridge.sendCommand.mockReturnValue(false);
    execFileMock.mockImplementation((_file, args, _options, callback) => {
      if (args.includes("list-panes")) {
        callback?.(null, JSON.stringify([
          {
            id: 5,
            is_plugin: false,
            cursor_coordinates_in_pane: [1, 1]
          }
        ]), "");
        return;
      }
      callback?.(null, "", "");
    });

    const { ZellijPaneIO } = await import("../../src/backend/zellij/pane-io.js");
    const io = new ZellijPaneIO({
      session: "main",
      paneId: "terminal_5",
      nativeBridgeFactory: async () => fakeBridge
    });

    await flushAsyncWork();
    execFileMock.mockClear();

    io.write("echo");
    await vi.advanceTimersByTimeAsync(12);
    await flushAsyncWork();

    expect(fakeBridge.sendCommand).toHaveBeenCalledWith({
      type: "write_chars",
      chars: "echo"
    });
    expect(execFileMock.mock.calls.some(([, args]) => (args as string[]).includes("write-chars"))).toBe(true);

    io.kill();
  });

  test("prefers bridge resize and safely falls back to the hidden client", async () => {
    const hiddenClient = {
      resize: vi.fn(),
      write: vi.fn(),
      kill: vi.fn(),
      onExit: vi.fn()
    };
    nodePtySpawnMock.mockReturnValue(hiddenClient);

    const fakeBridge = new FakeNativeBridge();
    const { ZellijPaneIO } = await import("../../src/backend/zellij/pane-io.js");
    const io = new ZellijPaneIO({
      session: "main",
      paneId: "terminal_7",
      nativeBridgeFactory: async () => fakeBridge
    });

    await flushAsyncWork();

    io.resize(120, 40);
    expect(fakeBridge.sendCommand).toHaveBeenCalledWith({
      type: "terminal_resize",
      cols: 120,
      rows: 40
    });
    expect(hiddenClient.resize).not.toHaveBeenCalled();

    fakeBridge.sendCommand.mockReturnValue(false);
    io.resize(80, 24);
    expect(hiddenClient.resize).toHaveBeenCalledWith(80, 24);

    io.kill();
  });

  test("falls back to CLI viewport polling when native bridge startup fails", async () => {
    const hiddenClient = {
      resize: vi.fn(),
      write: vi.fn(),
      kill: vi.fn(),
      onExit: vi.fn()
    };
    nodePtySpawnMock.mockReturnValue(hiddenClient);

    execFileMock.mockImplementation((_file, args, _options, callback) => {
      if (args.includes("dump-screen")) {
        callback?.(null, "\u001b[mprompt", "");
        return;
      }
      if (args.includes("list-panes")) {
        callback?.(null, JSON.stringify([
          {
            id: 0,
            is_plugin: false,
            cursor_coordinates_in_pane: [7, 1]
          }
        ]), "");
        return;
      }
      callback?.(null, "", "");
    });

    const { ZellijPaneIO } = await import("../../src/backend/zellij/pane-io.js");
    const io = new ZellijPaneIO({
      session: "main",
      paneId: "terminal_0",
      nativeBridgeFactory: async () => {
        throw new Error("bridge unavailable");
      }
    });

    const frames: string[] = [];
    io.onData((data) => frames.push(data));

    await flushAsyncWork();

    expect(execFileMock.mock.calls.some(([, args]) => (args as string[]).includes("dump-screen"))).toBe(true);
    expect(frames.at(-1)).toBe(
      "\x1b[?25l\x1b[3J\x1b[H\x1b[2J"
      + "\x1b[1;1H\x1b[2K\u001b[mprompt"
      + "\x1b[m\x1b[1;7H\x1b[?25h"
    );

    io.kill();
  });

  test("falls back to CLI polling if the native bridge exits unexpectedly", async () => {
    const hiddenClient = {
      resize: vi.fn(),
      write: vi.fn(),
      kill: vi.fn(),
      onExit: vi.fn()
    };
    nodePtySpawnMock.mockReturnValue(hiddenClient);

    const fakeBridge = new FakeNativeBridge();
    const recoveredBridge = new FakeNativeBridge();
    const runtimeStates: Array<{ streamMode: string; degradedReason?: string; scrollbackPrecision: string }> = [];
    let bridgeCreations = 0;
    execFileMock.mockImplementation((_file, args, _options, callback) => {
      if (args.includes("dump-screen")) {
        callback?.(null, "\u001b[mfallback", "");
        return;
      }
      if (args.includes("list-panes")) {
        callback?.(null, JSON.stringify([
          {
            id: 3,
            is_plugin: false,
            cursor_coordinates_in_pane: [9, 1]
          }
        ]), "");
        return;
      }
      callback?.(null, "", "");
    });

    const { ZellijPaneIO } = await import("../../src/backend/zellij/pane-io.js");
    const io = new ZellijPaneIO({
      session: "main",
      paneId: "terminal_3",
      nativeBridgeFactory: async () => {
        bridgeCreations += 1;
        return bridgeCreations === 1 ? fakeBridge : recoveredBridge;
      }
    });
    io.onRuntimeStateChange((state) => runtimeStates.push(state));

    await flushAsyncWork();
    execFileMock.mockClear();

    fakeBridge.emitExit(1);
    await flushAsyncWork();

    expect(execFileMock.mock.calls.some(([, args]) => (args as string[]).includes("dump-screen"))).toBe(true);
    expect(io.getRuntimeState()).toEqual({
      streamMode: "cli-polling",
      degradedReason: "bridge_crashed",
      scrollbackPrecision: "approximate"
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await flushAsyncWork();

    expect(io.getRuntimeState()).toEqual({
      streamMode: "native-bridge",
      scrollbackPrecision: "precise"
    });
    expect(runtimeStates).toContainEqual({
      streamMode: "cli-polling",
      degradedReason: "bridge_crashed",
      scrollbackPrecision: "approximate"
    });
    expect(runtimeStates).toContainEqual({
      streamMode: "native-bridge",
      scrollbackPrecision: "precise"
    });

    io.kill();
  });

  test("calibrates resize overhead after first resize detects zellij chrome", async () => {
    const fakeBridge = new FakeNativeBridge();
    const { ZellijPaneIO } = await import("../../src/backend/zellij/pane-io.js");

    // list-panes returns pane_content_columns=118 when 120 was sent
    execFileMock.mockImplementation((_file: unknown, args: string[], _options: unknown, callback: Function) => {
      if (args.includes("list-panes")) {
        callback?.(null, JSON.stringify([
          {
            id: 7,
            is_plugin: false,
            pane_content_columns: 118,
            pane_content_rows: 38,
            cursor_coordinates_in_pane: [1, 1]
          }
        ]), "");
        return;
      }
      callback?.(null, "", "");
    });

    const io = new ZellijPaneIO({
      session: "main",
      paneId: "terminal_7",
      nativeBridgeFactory: async () => fakeBridge
    });

    await flushAsyncWork();
    fakeBridge.sendCommand.mockClear();

    // First resize: overhead is 0, sends raw values
    io.resize(120, 40);
    expect(fakeBridge.sendCommand).toHaveBeenCalledWith({
      type: "terminal_resize",
      cols: 120,
      rows: 40
    });

    // Advance past calibration delay (150ms)
    await vi.advanceTimersByTimeAsync(200);
    await flushAsyncWork();

    // Calibration should have detected overhead: cols=2, rows=2
    expect(io.getResizeOverhead()).toEqual({ cols: 2, rows: 2 });

    // The calibration re-sent resize with compensation
    expect(fakeBridge.sendCommand).toHaveBeenCalledWith({
      type: "terminal_resize",
      cols: 122,
      rows: 42
    });

    io.kill();
  });

  test("does not calibrate when pane content matches requested dimensions", async () => {
    const fakeBridge = new FakeNativeBridge();
    const { ZellijPaneIO } = await import("../../src/backend/zellij/pane-io.js");

    // Pane content matches exactly (no overhead)
    execFileMock.mockImplementation((_file: unknown, args: string[], _options: unknown, callback: Function) => {
      if (args.includes("list-panes")) {
        callback?.(null, JSON.stringify([
          {
            id: 7,
            is_plugin: false,
            pane_content_columns: 120,
            pane_content_rows: 40,
            cursor_coordinates_in_pane: [1, 1]
          }
        ]), "");
        return;
      }
      callback?.(null, "", "");
    });

    const io = new ZellijPaneIO({
      session: "main",
      paneId: "terminal_7",
      nativeBridgeFactory: async () => fakeBridge
    });

    await flushAsyncWork();
    fakeBridge.sendCommand.mockClear();

    io.resize(120, 40);
    await vi.advanceTimersByTimeAsync(200);
    await flushAsyncWork();

    // No overhead detected, no re-send
    expect(io.getResizeOverhead()).toEqual({ cols: 0, rows: 0 });
    expect(fakeBridge.sendCommand).toHaveBeenCalledTimes(1);

    io.kill();
  });

  test("applies cached overhead to subsequent resizes without re-calibration round-trip", async () => {
    const fakeBridge = new FakeNativeBridge();
    const { ZellijPaneIO } = await import("../../src/backend/zellij/pane-io.js");

    let callCount = 0;
    execFileMock.mockImplementation((_file: unknown, args: string[], _options: unknown, callback: Function) => {
      if (args.includes("list-panes")) {
        callCount += 1;
        // First calibration: 120 sent, 118 actual → overhead 2
        // Second calibration: 160+2=162 sent, 160 actual → overhead stays 2
        const cols = callCount <= 2 ? 118 : 160;
        const rows = callCount <= 2 ? 38 : 50;
        callback?.(null, JSON.stringify([
          {
            id: 7,
            is_plugin: false,
            pane_content_columns: cols,
            pane_content_rows: rows,
            cursor_coordinates_in_pane: [1, 1]
          }
        ]), "");
        return;
      }
      callback?.(null, "", "");
    });

    const io = new ZellijPaneIO({
      session: "main",
      paneId: "terminal_7",
      nativeBridgeFactory: async () => fakeBridge
    });

    await flushAsyncWork();
    fakeBridge.sendCommand.mockClear();

    // First resize triggers calibration
    io.resize(120, 40);
    await vi.advanceTimersByTimeAsync(200);
    await flushAsyncWork();

    expect(io.getResizeOverhead()).toEqual({ cols: 2, rows: 2 });
    fakeBridge.sendCommand.mockClear();

    // Second resize immediately applies cached overhead
    io.resize(160, 50);
    expect(fakeBridge.sendCommand).toHaveBeenCalledWith({
      type: "terminal_resize",
      cols: 162,
      rows: 52
    });

    io.kill();
  });

  test("overhead calibration ignores errors gracefully", async () => {
    const fakeBridge = new FakeNativeBridge();
    const { ZellijPaneIO } = await import("../../src/backend/zellij/pane-io.js");

    execFileMock.mockImplementation((_file: unknown, args: string[], _options: unknown, callback: Function) => {
      if (args.includes("list-panes")) {
        callback?.(new Error("zellij not responding"), "", "");
        return;
      }
      callback?.(null, "", "");
    });

    const io = new ZellijPaneIO({
      session: "main",
      paneId: "terminal_7",
      nativeBridgeFactory: async () => fakeBridge
    });

    await flushAsyncWork();

    io.resize(120, 40);
    await vi.advanceTimersByTimeAsync(200);
    await flushAsyncWork();

    // Overhead stays at 0 — calibration error is silently ignored
    expect(io.getResizeOverhead()).toEqual({ cols: 0, rows: 0 });

    io.kill();
  });
});

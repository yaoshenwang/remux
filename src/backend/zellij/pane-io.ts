import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as pty from "node-pty";
import type { PtyProcess, PtyFactory } from "../pty/pty-adapter.js";
import type { ZellijPaneJson } from "./parser.js";
import type {
  WorkspaceDegradedReason,
  WorkspaceRuntimeState
} from "../../shared/protocol.js";
import {
  createZellijNativeBridge,
  type CreateZellijNativeBridgeOptions,
  type ZellijNativeBridgeCommand,
  type ZellijNativeBridge,
  type ZellijNativeBridgeFactory
} from "./native-bridge.js";
import {
  getDefaultZellijNativeBridgeStateStore,
  type ZellijNativeBridgeStateStore
} from "./native-bridge-state.js";

const execFileAsync = promisify(execFile);

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\"'\"'")}'`;

interface ZellijCursorPosition {
  col: number;
  row: number;
}

type StreamMode = "pending" | "native-bridge" | "cli-polling";

export function parseDumpScreenViewport(output: string): string[] {
  const normalized = output
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n");
  const lines = normalized.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

export function buildViewportFrame(
  viewport: string[],
  cursor: ZellijCursorPosition | null
): string {
  const parts: string[] = ["\x1b[?25l", "\x1b[3J\x1b[H\x1b[2J"];

  for (let index = 0; index < viewport.length; index += 1) {
    parts.push(`\x1b[${index + 1};1H\x1b[2K`);
    parts.push(viewport[index]);
  }

  parts.push("\x1b[m");
  if (cursor) {
    parts.push(`\x1b[${cursor.row};${cursor.col}H`);
    parts.push("\x1b[?25h");
  }

  return parts.join("");
}

/**
 * Build a viewport frame that only updates lines that differ from the previous viewport.
 * Falls back to full frame on first render or when dimensions change.
 */
export function buildViewportDiffFrame(
  viewport: string[],
  prevViewport: string[] | null,
  cursor: ZellijCursorPosition | null
): string {
  // Full frame if no previous viewport or dimensions changed
  if (!prevViewport || prevViewport.length !== viewport.length) {
    return buildViewportFrame(viewport, cursor);
  }

  const parts: string[] = ["\x1b[?25l"];
  let dirtyCount = 0;

  for (let index = 0; index < viewport.length; index += 1) {
    if (viewport[index] !== prevViewport[index]) {
      parts.push(`\x1b[${index + 1};1H\x1b[2K`);
      parts.push(viewport[index]);
      dirtyCount += 1;
    }
  }

  // If most lines changed, a full clear+redraw is more efficient
  if (dirtyCount > viewport.length * 0.7) {
    return buildViewportFrame(viewport, cursor);
  }

  // Only cursor changed, no lines dirty
  if (dirtyCount === 0 && !cursor) {
    return "";
  }

  parts.push("\x1b[m");
  if (cursor) {
    parts.push(`\x1b[${cursor.row};${cursor.col}H`);
    parts.push("\x1b[?25h");
  }

  return parts.join("");
}

/**
 * A PtyProcess that mirrors a zellij pane.
 *
 * Preferred output mode:
 * - native bridge subscription to zellij pane-render updates
 *
 * Fallback output mode:
 * - CLI viewport polling via `dump-screen --ansi`
 * - cursor polling via `list-panes --json --all`
 *
 * Input model:
 * - Prefer native bridge write commands when available.
 * - Safely fall back to serialized `zellij action write/write-chars`.
 * - Writes are serialized so later Enter/control keys cannot overtake
 *   earlier text chunks.
 */
export class ZellijPaneIO implements PtyProcess {
  private readonly binary: string;
  private readonly session: string;
  private readonly paneId: string;
  private readonly logger?: Pick<Console, "log" | "error">;
  private readonly env: NodeJS.ProcessEnv;
  private readonly nativeBridgeFactory: ZellijNativeBridgeFactory;
  private readonly nativeBridgeStateStore: ZellijNativeBridgeStateStore;
  private readonly scrollbackLines?: number;

  private dataHandlers: Array<(data: string) => void> = [];
  private exitHandlers: Array<(code: number) => void> = [];
  private hiddenClient: pty.IPty | null = null;
  private nativeBridge: ZellijNativeBridge | null = null;
  private killed = false;
  private streamMode: StreamMode = "pending";
  private runtimeState: WorkspaceRuntimeState = {
    streamMode: "pending",
    scrollbackPrecision: "approximate"
  };

  /** Last full-frame payload sent to the frontend. */
  private lastFrame = "";
  private lastNativeViewport: string[] | null = null;
  private lastNativeScrollback: string[] | null = null;
  private lastCursor: ZellijCursorPosition | null = null;

  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshInFlight = false;
  private refreshQueued = false;

  private refreshBurstUntil = 0;
  private missingPaneCount = 0;
  private pendingResize: { cols: number; rows: number } | null = null;

  /** Overhead compensation for zellij layout chrome (tab bar, status bar, borders). */
  private resizeOverhead = { cols: 0, rows: 0 };
  /** The cols/rows the frontend actually requested (before overhead compensation). */
  private lastRequestedDims: { cols: number; rows: number } | null = null;
  private calibrationTimer: ReturnType<typeof setTimeout> | null = null;

  private writeBuf = "";
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  /** Bridge restart supervisor state */
  private bridgeRestartAttempts = 0;
  private bridgeRestartTimer: ReturnType<typeof setTimeout> | null = null;
  private socketDir?: string;

  /** Stream mode change listeners (for exposing degraded state). */
  private streamModeHandlers: Array<(mode: StreamMode) => void> = [];
  /** Runtime state listeners (stream mode + degraded reason + precision). */
  private runtimeStateHandlers: Array<(state: WorkspaceRuntimeState) => void> = [];
  /** Workspace-level change listeners (for triggering state refresh). */
  private workspaceChangeHandlers: Array<(reason: "session_switch" | "session_renamed") => void> = [];

  private static readonly WRITE_BATCH_MS = 12;
  private static readonly ACTIVE_REFRESH_MS = 40;
  private static readonly IDLE_REFRESH_MS = 250;
  private static readonly ACTIVE_REFRESH_WINDOW_MS = 1_200;
  private static readonly MAX_MISSING_PANE_POLLS = 3;
  private static readonly BRIDGE_RESTART_BASE_MS = 1_000;
  private static readonly BRIDGE_RESTART_MAX_MS = 16_000;
  private static readonly BRIDGE_RESTART_MAX_ATTEMPTS = 5;

  constructor(options: {
    binary?: string;
    session: string;
    paneId: string;
    logger?: Pick<Console, "log" | "error">;
    socketDir?: string;
    nativeBridgeFactory?: ZellijNativeBridgeFactory;
    nativeBridgeStateStore?: ZellijNativeBridgeStateStore;
    scrollbackLines?: number;
  }) {
    this.binary = options.binary ?? "zellij";
    this.session = options.session;
    this.paneId = options.paneId;
    this.logger = options.logger;
    this.nativeBridgeFactory = options.nativeBridgeFactory ?? createZellijNativeBridge;
    this.nativeBridgeStateStore = options.nativeBridgeStateStore ?? getDefaultZellijNativeBridgeStateStore();
    this.scrollbackLines = options.scrollbackLines;
    this.socketDir = options.socketDir;
    this.env = {
      ...process.env,
      ...(options.socketDir ? { ZELLIJ_SOCKET_DIR: options.socketDir } : {})
    };

    void this.initializeStream(options.socketDir);
  }

  /** Current stream mode: "pending", "native-bridge", or "cli-polling". */
  public getStreamMode(): StreamMode {
    return this.streamMode;
  }

  public getRuntimeState(): WorkspaceRuntimeState {
    return { ...this.runtimeState };
  }

  /** Register a listener for stream mode changes. */
  public onStreamModeChange(handler: (mode: StreamMode) => void): void {
    this.streamModeHandlers.push(handler);
  }

  public onRuntimeStateChange(handler: (state: WorkspaceRuntimeState) => void): void {
    this.runtimeStateHandlers.push(handler);
  }

  /** Register a listener for workspace-level changes (session rename, switch). */
  public onWorkspaceChange(handler: (reason: "session_switch" | "session_renamed") => void): void {
    this.workspaceChangeHandlers.push(handler);
  }

  private async initializeStream(socketDir?: string): Promise<void> {
    let bridge: ZellijNativeBridge | null = null;
    try {
      bridge = await this.nativeBridgeFactory(this.buildNativeBridgeOptions(socketDir));
    } catch (error) {
      this.logger?.error?.(`[zellij-native-bridge] ${String(error)}`);
      this.enableCliPollingMode("startup_failed");
      return;
    }

    if (this.killed) {
      bridge?.kill();
      return;
    }

    if (bridge) {
      this.attachNativeBridge(bridge);
      return;
    }

    this.enableUnsupportedMode();
  }

  private buildNativeBridgeOptions(socketDir?: string): CreateZellijNativeBridgeOptions {
    return {
      session: this.session,
      paneId: this.paneId,
      zellijBinary: this.binary,
      socketDir,
      logger: this.logger,
      env: this.env,
      scrollbackLines: this.scrollbackLines
    };
  }

  private attachNativeBridge(bridge: ZellijNativeBridge): void {
    this.setStreamMode("native-bridge");
    this.setRuntimeState({
      streamMode: "native-bridge",
      scrollbackPrecision: "precise"
    });
    this.nativeBridge = bridge;
    this.missingPaneCount = 0;
    this.flushPendingResize();

    bridge.onEvent((event) => {
      if (this.killed) {
        return;
      }
      if (event.type === "pane_render" && event.paneId === this.paneId) {
        this.lastNativeViewport = event.viewport;
        this.lastNativeScrollback = event.scrollback;
        this.nativeBridgeStateStore.updatePaneRender(this.session, this.paneId, {
          viewport: event.viewport,
          scrollback: event.scrollback
        });
        if (event.cursor) {
          this.lastCursor = { row: event.cursor.row, col: event.cursor.col };
        }
        this.emitNativeFrame();
        return;
      }
      if (event.type === "pane_closed" && event.paneId === this.paneId) {
        this.nativeBridgeStateStore.clearPane(this.session, this.paneId);
        this.emitExit(0);
        return;
      }
      if (event.type === "session_renamed" || event.type === "session_switch") {
        // Workspace-level change detected — notify listeners
        for (const handler of this.workspaceChangeHandlers) {
          try { handler(event.type); } catch { /* ignore */ }
        }
        return;
      }
      if (event.type === "error") {
        this.logger?.error?.(`[zellij-native-bridge] ${event.message}`);
      }
    });

    bridge.onExit((code) => {
      if (this.killed || this.streamMode !== "native-bridge") {
        return;
      }
      this.nativeBridge = null;
      this.lastNativeViewport = null;
      this.lastNativeScrollback = null;
      this.nativeBridgeStateStore.clearPane(this.session, this.paneId);
      if (code !== 0 && code !== null) {
        this.logger?.error?.(
          `[zellij-native-bridge] bridge exited with code ${code}, attempting restart`
        );
      }
      // Fall back to CLI polling while we attempt restart
      this.enableCliPollingMode("bridge_crashed");
      this.scheduleBridgeRestart();
    });
  }

  private setStreamMode(mode: StreamMode): void {
    if (this.streamMode === mode) return;
    this.streamMode = mode;
    for (const handler of this.streamModeHandlers) {
      try { handler(mode); } catch { /* ignore */ }
    }
  }

  private setRuntimeState(state: WorkspaceRuntimeState): void {
    if (
      this.runtimeState.streamMode === state.streamMode
      && this.runtimeState.degradedReason === state.degradedReason
      && this.runtimeState.scrollbackPrecision === state.scrollbackPrecision
    ) {
      return;
    }
    this.runtimeState = { ...state };
    for (const handler of this.runtimeStateHandlers) {
      try { handler({ ...state }); } catch { /* ignore */ }
    }
  }

  private enableCliPollingMode(reason?: WorkspaceDegradedReason): void {
    if (this.killed || this.streamMode === "cli-polling") {
      if (reason) {
        this.setRuntimeState({
          streamMode: "cli-polling",
          degradedReason: reason,
          scrollbackPrecision: "approximate"
        });
      }
      return;
    }
    this.setStreamMode("cli-polling");
    this.setRuntimeState({
      streamMode: "cli-polling",
      degradedReason: reason,
      scrollbackPrecision: "approximate"
    });
    this.flushPendingResize();
    this.requestRefresh({ immediate: true, boost: true });
  }

  private enableUnsupportedMode(reason?: WorkspaceDegradedReason): void {
    this.setStreamMode("cli-polling");
    this.setRuntimeState({
      streamMode: "unsupported",
      degradedReason: reason,
      scrollbackPrecision: "approximate"
    });
    this.flushPendingResize();
    this.requestRefresh({ immediate: true, boost: true });
  }

  private scheduleBridgeRestart(): void {
    if (this.killed || this.bridgeRestartTimer) {
      return;
    }
    if (this.bridgeRestartAttempts >= ZellijPaneIO.BRIDGE_RESTART_MAX_ATTEMPTS) {
      this.logger?.log?.(
        `[zellij-native-bridge] giving up restart after ${this.bridgeRestartAttempts} attempts`
      );
      this.setRuntimeState({
        streamMode: "cli-polling",
        degradedReason: "restart_exhausted",
        scrollbackPrecision: "approximate"
      });
      return;
    }
    const delay = Math.min(
      ZellijPaneIO.BRIDGE_RESTART_BASE_MS * (2 ** this.bridgeRestartAttempts),
      ZellijPaneIO.BRIDGE_RESTART_MAX_MS
    );
    this.bridgeRestartAttempts += 1;
    this.logger?.log?.(
      `[zellij-native-bridge] scheduling restart attempt ${this.bridgeRestartAttempts} in ${delay}ms`
    );
    this.bridgeRestartTimer = setTimeout(() => {
      this.bridgeRestartTimer = null;
      void this.attemptBridgeRestart();
    }, delay);
  }

  private async attemptBridgeRestart(): Promise<void> {
    if (this.killed || this.streamMode === "native-bridge") {
      return;
    }
    let bridge: ZellijNativeBridge | null = null;
    try {
      bridge = await this.nativeBridgeFactory(this.buildNativeBridgeOptions(this.socketDir));
    } catch (error) {
      this.logger?.error?.(`[zellij-native-bridge] restart failed: ${String(error)}`);
    }
    if (this.killed) {
      bridge?.kill();
      return;
    }
    if (bridge) {
      this.logger?.log?.("[zellij-native-bridge] restart succeeded, switching back to native bridge");
      this.bridgeRestartAttempts = 0;
      // Stop CLI polling timers
      if (this.refreshTimer) {
        clearTimeout(this.refreshTimer);
        this.refreshTimer = null;
      }
      this.attachNativeBridge(bridge);
      return;
    }
    // Restart failed — schedule another attempt
    this.setRuntimeState({
      streamMode: "cli-polling",
      degradedReason: "bridge_crashed",
      scrollbackPrecision: "approximate"
    });
    this.scheduleBridgeRestart();
  }

  private ensureHiddenClient(): pty.IPty {
    if (this.hiddenClient) {
      return this.hiddenClient;
    }
    const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
    const args = process.platform === "win32"
      ? ["/c", this.binary, "attach", this.session]
      : ["-lc", `exec ${shellQuote(this.binary)} attach ${shellQuote(this.session)}`];
    const client = pty.spawn(shell, args, {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: this.env
    });
    setTimeout(() => {
      try {
        client.write("\x1b");
      } catch {
        // Ignore races when the hidden client exits during setup.
      }
    }, 150);
    client.onExit(() => {
      if (this.hiddenClient === client) {
        this.hiddenClient = null;
      }
    });
    this.hiddenClient = client;
    return client;
  }

  private releaseHiddenClient(): void {
    if (!this.hiddenClient) {
      return;
    }
    this.hiddenClient.kill();
    this.hiddenClient = null;
  }

  private boostRefresh(): void {
    this.refreshBurstUntil = Date.now() + ZellijPaneIO.ACTIVE_REFRESH_WINDOW_MS;
  }

  private currentRefreshDelay(): number {
    return Date.now() < this.refreshBurstUntil
      ? ZellijPaneIO.ACTIVE_REFRESH_MS
      : ZellijPaneIO.IDLE_REFRESH_MS;
  }

  private scheduleRefresh(delay: number): void {
    if (this.killed || this.refreshTimer || this.streamMode !== "cli-polling") {
      return;
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refreshViewport();
    }, delay);
  }

  private requestRefresh(options: { immediate?: boolean; boost?: boolean } = {}): void {
    if (this.killed) {
      return;
    }

    if (options.boost) {
      this.boostRefresh();
    }

    if (this.streamMode === "native-bridge") {
      return;
    }

    if (this.streamMode !== "cli-polling") {
      return;
    }

    if (options.immediate) {
      if (this.refreshTimer) {
        clearTimeout(this.refreshTimer);
        this.refreshTimer = null;
      }
      if (this.refreshInFlight) {
        this.refreshQueued = true;
        return;
      }
      this.scheduleRefresh(0);
      return;
    }

    if (!this.refreshTimer) {
      this.scheduleRefresh(this.currentRefreshDelay());
    }
  }

  private async refreshViewport(): Promise<void> {
    if (this.killed || this.streamMode !== "cli-polling") {
      return;
    }

    if (this.refreshInFlight) {
      this.refreshQueued = true;
      return;
    }

    this.refreshInFlight = true;
    try {
      const [screenResult, panesResult] = await Promise.all([
        execFileAsync(this.binary, [
          "--session", this.session,
          "action", "dump-screen",
          "--pane-id", this.paneId,
          "--ansi"
        ], {
          timeout: 3_000,
          env: this.env,
          encoding: "utf8"
        }),
        execFileAsync(this.binary, [
          "--session", this.session,
          "action", "list-panes",
          "--json",
          "--all"
        ], {
          timeout: 3_000,
          env: this.env,
          encoding: "utf8"
        })
      ]);

      const pane = findPaneFromList(panesResult.stdout, this.paneId);
      if (!pane) {
        this.handleMissingPane(0);
        return;
      }

      this.missingPaneCount = 0;
      const viewport = parseDumpScreenViewport(screenResult.stdout);
      const frame = buildViewportFrame(viewport, parseCursorCoordinates(pane.cursor_coordinates_in_pane));
      this.emitFrame(frame);
    } catch (error) {
      if (isTerminalGoneError(error)) {
        this.handleMissingPane(1);
        return;
      }
      this.logger?.error?.(`[zellij-viewport] ${String(error)}`);
    } finally {
      this.refreshInFlight = false;
      if (this.killed || this.streamMode !== "cli-polling") {
        return;
      }
      if (this.refreshQueued) {
        this.refreshQueued = false;
        this.scheduleRefresh(0);
        return;
      }
      this.scheduleRefresh(this.currentRefreshDelay());
    }
  }

  write(data: string): void {
    if (this.killed) return;
    this.writeBuf += data;
    if (!this.writeTimer) {
      this.writeTimer = setTimeout(() => this.flushWriteBuffer(), ZellijPaneIO.WRITE_BATCH_MS);
    }
    this.requestRefresh({ boost: true });
  }

  private flushWriteBuffer(): void {
    this.writeTimer = null;
    if (this.killed || !this.writeBuf) return;

    const data = this.writeBuf;
    this.writeBuf = "";

    const runWrite = async (): Promise<void> => {
      const bytes = Buffer.from(data, "utf8");
      const bridgeCommand = createBridgeWriteCommand(data, bytes);
      if (this.nativeBridge?.sendCommand(bridgeCommand)) {
        return;
      }

      const hasControlChars = /[\x00-\x1f]/.test(data);

      const args = (hasControlChars && bytes.length <= 256)
        ? [
            "--session", this.session,
            "action", "write",
            "--pane-id", this.paneId,
            ...Array.from(bytes).map(String)
          ]
        : [
            "--session", this.session,
            "action", "write-chars",
            "--pane-id", this.paneId,
            "--",
            data
          ];

      await execFileAsync(this.binary, args, {
        timeout: 3_000,
        env: this.env,
        encoding: "utf8"
      });
    };

    this.writeQueue = this.writeQueue
      .then(runWrite, runWrite)
      .catch((error) => {
        this.logger?.error?.(`[zellij-write] ${String(error)}`);
      })
      .finally(() => {
        if (this.killed) {
          return;
        }
        this.requestRefresh({ immediate: true, boost: true });
        if (this.writeBuf && !this.writeTimer) {
          this.writeTimer = setTimeout(() => this.flushWriteBuffer(), ZellijPaneIO.WRITE_BATCH_MS);
        }
      });
  }

  resize(_cols: number, _rows: number): void {
    if (!_cols || !_rows) {
      return;
    }

    const cols = Math.max(2, Math.floor(_cols));
    const rows = Math.max(2, Math.floor(_rows));
    this.lastRequestedDims = { cols, rows };

    // Apply overhead compensation so that after zellij subtracts its
    // chrome (tab bar, status bar, pane borders) the actual pane content
    // area matches what the frontend requested.
    const compensatedCols = cols + this.resizeOverhead.cols;
    const compensatedRows = rows + this.resizeOverhead.rows;
    this.pendingResize = { cols: compensatedCols, rows: compensatedRows };

    if (this.trySendResizeViaBridge()) {
      this.requestRefresh({ immediate: true, boost: true });
      this.scheduleOverheadCalibration();
      return;
    }

    if (this.streamMode === "pending") {
      return;
    }

    this.ensureHiddenClient().resize(compensatedCols, compensatedRows);
    this.requestRefresh({ immediate: true, boost: true });
    this.scheduleOverheadCalibration();
  }

  onData(handler: (data: string) => void): void {
    this.dataHandlers.push(handler);
  }

  onExit(handler: (code: number) => void): void {
    this.exitHandlers.push(handler);
  }

  /** Previous viewport used for diff rendering. */
  private prevNativeViewport: string[] | null = null;

  private emitNativeFrame(): void {
    if (!this.lastNativeViewport) {
      return;
    }
    const frame = buildViewportDiffFrame(
      this.lastNativeViewport,
      this.prevNativeViewport,
      this.lastCursor
    );
    this.prevNativeViewport = this.lastNativeViewport;
    if (frame) {
      this.emitFrame(frame);
    }
  }

  private emitFrame(frame: string): void {
    if (frame === this.lastFrame) {
      return;
    }
    this.lastFrame = frame;
    for (const handler of this.dataHandlers) {
      handler(frame);
    }
  }

  private handleMissingPane(exitCode: number): void {
    this.missingPaneCount += 1;
    if (this.missingPaneCount >= ZellijPaneIO.MAX_MISSING_PANE_POLLS) {
      this.emitExit(exitCode);
    }
  }

  private emitExit(code: number): void {
    if (this.killed) {
      return;
    }
    this.killed = true;
    this.clearTimers();
    this.releaseNativeBridge();
    this.releaseHiddenClient();
    const exitHandlers = [...this.exitHandlers];
    this.dataHandlers = [];
    this.exitHandlers = [];
    for (const handler of exitHandlers) {
      handler(code);
    }
  }

  kill(): void {
    this.killed = true;
    this.clearTimers();
    this.dataHandlers = [];
    this.exitHandlers = [];
    this.streamModeHandlers = [];
    this.runtimeStateHandlers = [];
    this.workspaceChangeHandlers = [];
    this.releaseNativeBridge();
    this.releaseHiddenClient();
  }

  private releaseNativeBridge(): void {
    this.nativeBridgeStateStore.clearPane(this.session, this.paneId);
    if (!this.nativeBridge) {
      return;
    }
    this.nativeBridge.kill();
    this.nativeBridge = null;
  }

  private clearTimers(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.bridgeRestartTimer) {
      clearTimeout(this.bridgeRestartTimer);
      this.bridgeRestartTimer = null;
    }
    if (this.calibrationTimer) {
      clearTimeout(this.calibrationTimer);
      this.calibrationTimer = null;
    }
  }

  private flushPendingResize(): void {
    if (!this.pendingResize) {
      return;
    }

    if (this.trySendResizeViaBridge()) {
      this.requestRefresh({ immediate: true, boost: true });
      return;
    }

    if (this.streamMode === "pending") {
      return;
    }

    this.ensureHiddenClient().resize(this.pendingResize.cols, this.pendingResize.rows);
  }

  private trySendResizeViaBridge(): boolean {
    if (!this.pendingResize) {
      return false;
    }

    return this.nativeBridge?.sendCommand({
      type: "terminal_resize",
      cols: this.pendingResize.cols,
      rows: this.pendingResize.rows
    }) ?? false;
  }

  private static readonly CALIBRATION_DELAY_MS = 150;

  /**
   * After sending a resize to zellij, query the actual pane content
   * dimensions and adjust the overhead for future resizes.
   */
  private scheduleOverheadCalibration(): void {
    if (this.calibrationTimer) {
      clearTimeout(this.calibrationTimer);
    }
    this.calibrationTimer = setTimeout(() => {
      this.calibrationTimer = null;
      void this.calibrateOverhead();
    }, ZellijPaneIO.CALIBRATION_DELAY_MS);
  }

  private async calibrateOverhead(): Promise<void> {
    if (this.killed || !this.lastRequestedDims) {
      return;
    }
    try {
      const result = await execFileAsync(this.binary, [
        "--session", this.session,
        "action", "list-panes",
        "--json",
        "--all"
      ], {
        timeout: 3_000,
        env: this.env,
        encoding: "utf8"
      });

      if (this.killed || !this.lastRequestedDims) {
        return;
      }

      const pane = findPaneFromList(result.stdout, this.paneId);
      if (!pane) {
        return;
      }

      const actualCols = pane.pane_content_columns;
      const actualRows = pane.pane_content_rows;
      if (!actualCols || !actualRows) {
        return;
      }

      const { cols: requestedCols, rows: requestedRows } = this.lastRequestedDims;
      const colDelta = requestedCols - actualCols;
      const rowDelta = requestedRows - actualRows;

      if (colDelta === 0 && rowDelta === 0) {
        return;
      }

      const newColOverhead = Math.max(0, this.resizeOverhead.cols + colDelta);
      const newRowOverhead = Math.max(0, this.resizeOverhead.rows + rowDelta);

      if (newColOverhead === this.resizeOverhead.cols && newRowOverhead === this.resizeOverhead.rows) {
        return;
      }

      this.resizeOverhead = { cols: newColOverhead, rows: newRowOverhead };
      this.logger?.log?.(
        `[zellij-resize] calibrated overhead: cols=${newColOverhead}, rows=${newRowOverhead}`
      );

      // Re-send resize with corrected overhead
      this.resize(requestedCols, requestedRows);
    } catch {
      // Calibration is best-effort; ignore failures.
    }
  }

  /** Expose overhead for testing. */
  public getResizeOverhead(): { cols: number; rows: number } {
    return { ...this.resizeOverhead };
  }
}

/**
 * PtyFactory that creates ZellijPaneIO instances.
 */
export class ZellijPtyFactory implements PtyFactory {
  private readonly binary: string;
  private readonly logger?: Pick<Console, "log" | "error">;
  private readonly socketDir?: string;
  private readonly nativeBridgeFactory?: ZellijNativeBridgeFactory;
  private readonly nativeBridgeStateStore?: ZellijNativeBridgeStateStore;
  private readonly scrollbackLines?: number;

  constructor(options?: {
    zellijBinary?: string;
    logger?: Pick<Console, "log" | "error">;
    socketDir?: string;
    nativeBridgeFactory?: ZellijNativeBridgeFactory;
    nativeBridgeStateStore?: ZellijNativeBridgeStateStore;
    scrollbackLines?: number;
  }) {
    this.binary = options?.zellijBinary ?? "zellij";
    this.logger = options?.logger;
    this.socketDir = options?.socketDir;
    this.nativeBridgeFactory = options?.nativeBridgeFactory;
    this.nativeBridgeStateStore = options?.nativeBridgeStateStore;
    this.scrollbackLines = options?.scrollbackLines;
  }

  spawnAttach(session: string): PtyProcess {
    const [sessionName, paneId] = session.includes(":")
      ? session.split(":", 2)
      : [session, "terminal_0"];

    return new ZellijPaneIO({
      binary: this.binary,
      session: sessionName,
      paneId,
      logger: this.logger,
      socketDir: this.socketDir,
      nativeBridgeFactory: this.nativeBridgeFactory,
      nativeBridgeStateStore: this.nativeBridgeStateStore,
      scrollbackLines: this.scrollbackLines
    });
  }
}

function parseCursorCoordinates(
  cursorCoordinates: [number, number] | null
): ZellijCursorPosition | null {
  if (!cursorCoordinates) {
    return null;
  }
  const [col, row] = cursorCoordinates;
  if (!Number.isFinite(col) || !Number.isFinite(row)) {
    return null;
  }
  return {
    col: Math.max(1, Math.floor(col)),
    row: Math.max(1, Math.floor(row))
  };
}

function findPaneFromList(json: string, paneId: string): ZellijPaneJson | null {
  const targetId = extractPaneNumericId(paneId);
  if (targetId < 0) {
    return null;
  }

  let panes: ZellijPaneJson[];
  try {
    panes = JSON.parse(json);
  } catch {
    return null;
  }

  if (!Array.isArray(panes)) {
    return null;
  }

  return panes.find((pane) => !pane.is_plugin && pane.id === targetId) ?? null;
}

function extractPaneNumericId(paneId: string): number {
  const match = paneId.match(/^(?:terminal_)?(\d+)$/);
  return match ? parseInt(match[1], 10) : -1;
}

function isTerminalGoneError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("No pane")
    || message.includes("No session named")
    || message.includes("There is no active session")
    || message.includes("not found");
}

function createBridgeWriteCommand(data: string, bytes: Buffer): ZellijNativeBridgeCommand {
  if (/[\x00-\x1f]/.test(data)) {
    return {
      type: "write_bytes",
      bytes: Array.from(bytes)
    };
  }

  return {
    type: "write_chars",
    chars: data
  };
}

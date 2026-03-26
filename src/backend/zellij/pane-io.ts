import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as pty from "node-pty";
import type { PtyProcess, PtyFactory } from "../pty/pty-adapter.js";
import type { ZellijPaneJson } from "./parser.js";
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
 * A PtyProcess that mirrors a zellij pane.
 *
 * Preferred output mode:
 * - native bridge subscription to zellij pane-render updates
 * - low-frequency CLI cursor refresh via `list-panes --json --all`
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

  /** Last full-frame payload sent to the frontend. */
  private lastFrame = "";
  private lastNativeViewport: string[] | null = null;
  private lastNativeScrollback: string[] | null = null;
  private lastCursor: ZellijCursorPosition | null = null;

  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshInFlight = false;
  private refreshQueued = false;

  private cursorTimer: ReturnType<typeof setTimeout> | null = null;
  private cursorInFlight = false;
  private cursorQueued = false;

  private refreshBurstUntil = 0;
  private missingPaneCount = 0;
  private pendingResize: { cols: number; rows: number } | null = null;

  private writeBuf = "";
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  /** Bridge restart supervisor state */
  private bridgeRestartAttempts = 0;
  private bridgeRestartTimer: ReturnType<typeof setTimeout> | null = null;
  private socketDir?: string;

  /** Stream mode change listeners (for exposing degraded state). */
  private streamModeHandlers: Array<(mode: StreamMode) => void> = [];

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

  /** Register a listener for stream mode changes. */
  public onStreamModeChange(handler: (mode: StreamMode) => void): void {
    this.streamModeHandlers.push(handler);
  }

  private async initializeStream(socketDir?: string): Promise<void> {
    let bridge: ZellijNativeBridge | null = null;
    try {
      bridge = await this.nativeBridgeFactory(this.buildNativeBridgeOptions(socketDir));
    } catch (error) {
      this.logger?.error?.(`[zellij-native-bridge] ${String(error)}`);
    }

    if (this.killed) {
      bridge?.kill();
      return;
    }

    if (bridge) {
      this.attachNativeBridge(bridge);
      return;
    }

    this.enableCliPollingMode();
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
        if (!event.cursor) {
          // Bridge didn't provide cursor — fall back to CLI cursor query
          this.requestCursorRefresh({ immediate: true, boost: true });
        }
        return;
      }
      if (event.type === "pane_closed" && event.paneId === this.paneId) {
        this.nativeBridgeStateStore.clearPane(this.session, this.paneId);
        this.emitExit(0);
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
      this.enableCliPollingMode();
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

  private enableCliPollingMode(): void {
    if (this.killed || this.streamMode === "cli-polling") {
      return;
    }
    this.setStreamMode("cli-polling");
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
      this.requestCursorRefresh(options);
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

  private scheduleCursorRefresh(delay: number): void {
    if (this.killed || this.cursorTimer || this.streamMode !== "native-bridge") {
      return;
    }
    this.cursorTimer = setTimeout(() => {
      this.cursorTimer = null;
      void this.refreshCursor();
    }, delay);
  }

  private requestCursorRefresh(options: { immediate?: boolean; boost?: boolean } = {}): void {
    if (this.killed || this.streamMode !== "native-bridge") {
      return;
    }

    if (options.boost) {
      this.boostRefresh();
    }

    if (options.immediate) {
      if (this.cursorTimer) {
        clearTimeout(this.cursorTimer);
        this.cursorTimer = null;
      }
      if (this.cursorInFlight) {
        this.cursorQueued = true;
        return;
      }
      this.scheduleCursorRefresh(0);
      return;
    }

    if (!this.cursorTimer) {
      this.scheduleCursorRefresh(this.currentRefreshDelay());
    }
  }

  private async refreshCursor(): Promise<void> {
    if (this.killed || this.streamMode !== "native-bridge") {
      return;
    }

    if (this.cursorInFlight) {
      this.cursorQueued = true;
      return;
    }

    this.cursorInFlight = true;
    try {
      const panesResult = await execFileAsync(this.binary, [
        "--session", this.session,
        "action", "list-panes",
        "--json",
        "--all"
      ], {
        timeout: 3_000,
        env: this.env,
        encoding: "utf8"
      });

      const pane = findPaneFromList(panesResult.stdout, this.paneId);
      if (!pane) {
        this.handleMissingPane(0);
        return;
      }

      this.missingPaneCount = 0;
      this.lastCursor = parseCursorCoordinates(pane.cursor_coordinates_in_pane);
      this.emitNativeFrame();
    } catch (error) {
      if (isTerminalGoneError(error)) {
        this.handleMissingPane(1);
        return;
      }
      this.logger?.error?.(`[zellij-cursor] ${String(error)}`);
    } finally {
      this.cursorInFlight = false;
      if (this.killed || this.streamMode !== "native-bridge") {
        return;
      }
      if (this.cursorQueued) {
        this.cursorQueued = false;
        this.scheduleCursorRefresh(0);
        return;
      }
      this.scheduleCursorRefresh(this.currentRefreshDelay());
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
    this.pendingResize = { cols, rows };

    if (this.trySendResizeViaBridge()) {
      this.requestRefresh({ immediate: true, boost: true });
      return;
    }

    if (this.streamMode === "pending") {
      return;
    }

    this.ensureHiddenClient().resize(cols, rows);
    this.requestRefresh({ immediate: true, boost: true });
  }

  onData(handler: (data: string) => void): void {
    this.dataHandlers.push(handler);
  }

  onExit(handler: (code: number) => void): void {
    this.exitHandlers.push(handler);
  }

  private emitNativeFrame(): void {
    if (!this.lastNativeViewport) {
      return;
    }
    const frame = buildViewportFrame(this.lastNativeViewport, this.lastCursor);
    this.emitFrame(frame);
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
    if (this.cursorTimer) {
      clearTimeout(this.cursorTimer);
      this.cursorTimer = null;
    }
    if (this.bridgeRestartTimer) {
      clearTimeout(this.bridgeRestartTimer);
      this.bridgeRestartTimer = null;
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

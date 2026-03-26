import fs from "node:fs";
import path from "node:path";
import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import * as pty from "node-pty";

const execFileAsync = promisify(execFile);

const BRIDGE_STARTUP_TIMEOUT_MS = 1_500;
const DISABLED_VALUES = new Set(["0", "false", "off", "disable", "disabled"]);

export interface ZellijVersion {
  major: number;
  minor: number;
  patch: number;
}

export interface ZellijNativeBridgeHelloEvent {
  type: "hello";
  version: string;
  zellijVersion?: string;
}

export interface ZellijNativeBridgePaneRenderEvent {
  type: "pane_render";
  paneId: string;
  viewport: string[];
  scrollback: string[] | null;
  isInitial: boolean;
  cursor?: { row: number; col: number };
}

export interface ZellijNativeBridgePaneClosedEvent {
  type: "pane_closed";
  paneId: string;
}

export interface ZellijNativeBridgeErrorEvent {
  type: "error";
  message: string;
}

export interface ZellijNativeBridgeSessionRenamedEvent {
  type: "session_renamed";
  name: string;
}

export interface ZellijNativeBridgeSessionSwitchEvent {
  type: "session_switch";
  session: string;
}

export type ZellijNativeBridgeEvent =
  | ZellijNativeBridgeHelloEvent
  | ZellijNativeBridgePaneRenderEvent
  | ZellijNativeBridgePaneClosedEvent
  | ZellijNativeBridgeErrorEvent
  | ZellijNativeBridgeSessionRenamedEvent
  | ZellijNativeBridgeSessionSwitchEvent;

export interface ZellijNativeBridgeWriteCharsCommand {
  type: "write_chars";
  chars: string;
}

export interface ZellijNativeBridgeWriteBytesCommand {
  type: "write_bytes";
  bytes: number[];
}

export interface ZellijNativeBridgeTerminalResizeCommand {
  type: "terminal_resize";
  cols: number;
  rows: number;
}

export type ZellijNativeBridgeCommand =
  | ZellijNativeBridgeWriteCharsCommand
  | ZellijNativeBridgeWriteBytesCommand
  | ZellijNativeBridgeTerminalResizeCommand;

export interface ZellijNativeBridge {
  onEvent(handler: (event: ZellijNativeBridgeEvent) => void): void;
  onExit(handler: (code: number | null) => void): void;
  sendCommand(command: ZellijNativeBridgeCommand): boolean;
  kill(): void;
}

export interface CreateZellijNativeBridgeOptions {
  session: string;
  paneId: string;
  zellijBinary?: string;
  socketDir?: string;
  scrollbackLines?: number;
  ansi?: boolean;
  logger?: Pick<Console, "log" | "error">;
  env?: NodeJS.ProcessEnv;
  bridgeBinaryPath?: string;
}

export interface BootstrapZellijSessionOptions {
  session: string;
  defaultShell: string;
  zellijBinary?: string;
  socketDir?: string;
  cwd?: string;
  timeoutMs?: number;
  logger?: Pick<Console, "log" | "error">;
  env?: NodeJS.ProcessEnv;
  bridgeBinaryPath?: string;
}

export type ZellijNativeBridgeFactory = (
  options: CreateZellijNativeBridgeOptions
) => Promise<ZellijNativeBridge | null>;

export const MIN_SUPPORTED_ZELLIJ_VERSION: ZellijVersion = {
  major: 0,
  minor: 44,
  patch: 0
};

export function parseZellijVersion(input: string): ZellijVersion | null {
  const match = input.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return null;
  }
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10)
  };
}

export function compareZellijVersions(left: ZellijVersion, right: ZellijVersion): number {
  if (left.major !== right.major) {
    return left.major - right.major;
  }
  if (left.minor !== right.minor) {
    return left.minor - right.minor;
  }
  return left.patch - right.patch;
}

export function isSupportedZellijVersion(version: ZellijVersion): boolean {
  return compareZellijVersions(version, MIN_SUPPORTED_ZELLIJ_VERSION) >= 0;
}

export function parseZellijBridgeEventLine(line: string): ZellijNativeBridgeEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error(`invalid zellij bridge event: ${line}`);
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`invalid zellij bridge event: ${line}`);
  }

  const event = parsed as Record<string, unknown>;
  if (event.type === "hello") {
    if (typeof event.version !== "string") {
      throw new Error("invalid zellij bridge hello event");
    }
    if (event.zellijVersion !== undefined && typeof event.zellijVersion !== "string") {
      throw new Error("invalid zellij bridge hello event");
    }
    return {
      type: "hello",
      version: event.version,
      zellijVersion: typeof event.zellijVersion === "string" ? event.zellijVersion : undefined
    };
  }

  if (event.type === "pane_render") {
    if (
      typeof event.paneId !== "string"
      || !isStringArray(event.viewport)
      || !isNullableStringArray(event.scrollback)
      || typeof event.isInitial !== "boolean"
    ) {
      throw new Error("invalid zellij bridge pane_render event");
    }
    const result: ZellijNativeBridgePaneRenderEvent = {
      type: "pane_render",
      paneId: event.paneId,
      viewport: event.viewport,
      scrollback: event.scrollback,
      isInitial: event.isInitial
    };
    if (
      event.cursor
      && typeof event.cursor === "object"
      && typeof (event.cursor as Record<string, unknown>).row === "number"
      && typeof (event.cursor as Record<string, unknown>).col === "number"
    ) {
      result.cursor = {
        row: (event.cursor as Record<string, unknown>).row as number,
        col: (event.cursor as Record<string, unknown>).col as number,
      };
    }
    return result;
  }

  if (event.type === "pane_closed") {
    if (typeof event.paneId !== "string") {
      throw new Error("invalid zellij bridge pane_closed event");
    }
    return {
      type: "pane_closed",
      paneId: event.paneId
    };
  }

  if (event.type === "error") {
    if (typeof event.message !== "string") {
      throw new Error("invalid zellij bridge error event");
    }
    return {
      type: "error",
      message: event.message
    };
  }

  if (event.type === "session_renamed") {
    if (typeof event.name !== "string") {
      throw new Error("invalid zellij bridge session_renamed event");
    }
    return { type: "session_renamed", name: event.name };
  }

  if (event.type === "session_switch") {
    if (typeof event.session !== "string") {
      throw new Error("invalid zellij bridge session_switch event");
    }
    return { type: "session_switch", session: event.session };
  }

  throw new Error(`unknown zellij bridge event type: ${String(event.type)}`);
}

export function serializeZellijBridgeCommand(command: ZellijNativeBridgeCommand): string {
  return `${JSON.stringify(command)}\n`;
}

export async function createZellijNativeBridge(
  options: CreateZellijNativeBridgeOptions
): Promise<ZellijNativeBridge | null> {
  const env = { ...process.env, ...options.env };
  if (!isNativeBridgeEnabled(env)) {
    return null;
  }

  const bridgeBinary = resolveZellijNativeBridgeBinary({
    env,
    explicitPath: options.bridgeBinaryPath
  });
  if (!bridgeBinary) {
    options.logger?.log?.("[zellij-native-bridge] binary not found, falling back to CLI viewport mode");
    return null;
  }

  const zellijBinary = options.zellijBinary ?? "zellij";
  const versionOutput = await getZellijVersionOutput(zellijBinary, env, options.logger);
  const parsedVersion = versionOutput ? parseZellijVersion(versionOutput) : null;
  if (!parsedVersion || !isSupportedZellijVersion(parsedVersion)) {
    const displayVersion = versionOutput?.trim() || "unknown";
    options.logger?.log?.(
      `[zellij-native-bridge] zellij ${displayVersion} does not satisfy >= `
      + `${MIN_SUPPORTED_ZELLIJ_VERSION.major}.${MIN_SUPPORTED_ZELLIJ_VERSION.minor}.${MIN_SUPPORTED_ZELLIJ_VERSION.patch}, `
      + "falling back to CLI viewport mode"
    );
    return null;
  }

  const zellijVersion = versionOutput?.trim();
  if (!zellijVersion) {
    options.logger?.log?.("[zellij-native-bridge] empty zellij version output, falling back to CLI viewport mode");
    return null;
  }
  const args = [
    "--session", options.session,
    "--pane-id", options.paneId,
    "--zellij-version", zellijVersion
  ];
  if (options.socketDir) {
    args.push("--socket-dir", options.socketDir);
  }
  if (typeof options.scrollbackLines === "number") {
    args.push("--scrollback", String(options.scrollbackLines));
  }
  if (options.ansi !== false) {
    args.push("--ansi");
  }

  const bridge = process.platform === "win32"
    ? new ManagedChildProcessZellijNativeBridge(
        spawn(bridgeBinary, args, {
          cwd: process.cwd(),
          env,
          stdio: ["pipe", "pipe", "pipe"]
        }) as unknown as ChildProcessWithoutNullStreams,
        options.logger
      )
    : new ManagedPtyZellijNativeBridge(
        pty.spawn(bridgeBinary, args, {
          name: "xterm-256color",
          cols: 80,
          rows: 24,
          cwd: process.cwd(),
          env
        }),
        options.logger
      );
  const ready = await bridge.waitUntilReady();
  if (!ready) {
    bridge.kill();
    options.logger?.log?.("[zellij-native-bridge] bridge startup failed, falling back to CLI viewport mode");
    return null;
  }
  return bridge;
}

export async function bootstrapZellijSession(
  options: BootstrapZellijSessionOptions
): Promise<boolean> {
  const env = { ...process.env, ...options.env };
  const bridgeBinary = resolveZellijNativeBridgeBinary({
    env,
    explicitPath: options.bridgeBinaryPath
  });
  if (!bridgeBinary) {
    options.logger?.log?.("[zellij-native-bridge] bootstrap helper binary not found");
    return false;
  }

  const zellijBinary = options.zellijBinary ?? "zellij";
  const versionOutput = await getZellijVersionOutput(zellijBinary, env, options.logger);
  const parsedVersion = versionOutput ? parseZellijVersion(versionOutput) : null;
  if (!parsedVersion || !isSupportedZellijVersion(parsedVersion)) {
    const displayVersion = versionOutput?.trim() || "unknown";
    options.logger?.log?.(
      `[zellij-native-bridge] zellij ${displayVersion} does not satisfy >= `
      + `${MIN_SUPPORTED_ZELLIJ_VERSION.major}.${MIN_SUPPORTED_ZELLIJ_VERSION.minor}.${MIN_SUPPORTED_ZELLIJ_VERSION.patch}, `
      + "skipping detached bootstrap helper"
    );
    return false;
  }

  const args = [
    "bootstrap-session",
    "--session", options.session,
    "--zellij-binary", zellijBinary,
    "--default-shell", options.defaultShell
  ];
  if (options.socketDir) {
    args.push("--socket-dir", options.socketDir);
  }
  if (options.cwd) {
    args.push("--cwd", options.cwd);
  }

  try {
    await execFileAsync(bridgeBinary, args, {
      env,
      timeout: options.timeoutMs ?? 5_000,
      encoding: "utf8"
    });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`zellij detached bootstrap helper failed: ${message}`);
  }
}

function isNativeBridgeEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env.REMUX_ZELLIJ_NATIVE_BRIDGE;
  if (!raw) {
    return true;
  }
  return !DISABLED_VALUES.has(raw.trim().toLowerCase());
}

function resolveZellijNativeBridgeBinary(options: {
  env: NodeJS.ProcessEnv;
  explicitPath?: string;
}): string | null {
  const envPath = options.explicitPath ?? options.env.REMUX_ZELLIJ_BRIDGE_BIN;
  if (envPath && fs.existsSync(envPath)) {
    return envPath;
  }

  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const packagedBinaryNames = process.platform === "win32"
    ? ["remux-zellij-bridge.exe", "zellij-bridge.exe"]
    : ["remux-zellij-bridge", "zellij-bridge"];
  const devBinaryNames = process.platform === "win32"
    ? ["zellij-bridge.exe", "remux-zellij-bridge.exe"]
    : ["zellij-bridge", "remux-zellij-bridge"];
  const candidates = [
    ...devBinaryNames.map((binaryName) => path.resolve(moduleDir, "../../../native/zellij-bridge/target/release", binaryName)),
    ...devBinaryNames.map((binaryName) => path.resolve(moduleDir, "../../../native/zellij-bridge/target/debug", binaryName)),
    ...packagedBinaryNames.map((binaryName) => path.resolve(moduleDir, binaryName))
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function getZellijVersionOutput(
  zellijBinary: string,
  env: NodeJS.ProcessEnv,
  logger?: Pick<Console, "log" | "error">
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(zellijBinary, ["--version"], {
      env,
      timeout: 3_000,
      encoding: "utf8"
    });
    return stdout;
  } catch (error) {
    logger?.error?.(`[zellij-native-bridge] failed to read zellij version: ${String(error)}`);
    return null;
  }
}

class ManagedChildProcessZellijNativeBridge implements ZellijNativeBridge {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly logger?: Pick<Console, "log" | "error">;
  private readonly dataHandlers: Array<(event: ZellijNativeBridgeEvent) => void> = [];
  private readonly exitHandlers: Array<(code: number | null) => void> = [];
  private readonly lineReader: ReadlineInterface;

  private readyResolved = false;
  private exited = false;
  private readyPromise: Promise<boolean>;
  private readyResolve: ((ready: boolean) => void) | null = null;

  constructor(
    child: ChildProcessWithoutNullStreams,
    logger?: Pick<Console, "log" | "error">
  ) {
    this.child = child;
    this.logger = logger;
    this.lineReader = createInterface({ input: child.stdout });
    this.readyPromise = new Promise<boolean>((resolve) => {
      this.readyResolve = resolve;
    });
    const timeout = setTimeout(() => {
      this.resolveReady(false);
    }, BRIDGE_STARTUP_TIMEOUT_MS);

    this.lineReader.on("line", (line) => {
      try {
        const event = parseZellijBridgeEventLine(line);
        this.dispatchEvent(event);
        if (event.type === "hello") {
          clearTimeout(timeout);
          this.resolveReady(true);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        clearTimeout(timeout);
        this.logger?.error?.(`[zellij-native-bridge] ${message}`);
        this.dispatchEvent({ type: "error", message });
        this.resolveReady(false);
      }
    });

    this.child.stderr.on("data", (chunk: Buffer | string) => {
      const message = chunk.toString("utf8").trim();
      if (message) {
        this.logger?.error?.(`[zellij-native-bridge] ${message}`);
      }
    });

    this.child.on("error", (error) => {
      clearTimeout(timeout);
      this.logger?.error?.(`[zellij-native-bridge] ${String(error)}`);
      this.resolveReady(false);
    });

    this.child.on("close", (code) => {
      clearTimeout(timeout);
      this.resolveReady(false);
      this.emitExit(code);
    });
  }

  onEvent(handler: (event: ZellijNativeBridgeEvent) => void): void {
    this.dataHandlers.push(handler);
  }

  onExit(handler: (code: number | null) => void): void {
    this.exitHandlers.push(handler);
  }

  sendCommand(command: ZellijNativeBridgeCommand): boolean {
    if (this.exited || this.child.killed || this.child.stdin.destroyed || !this.child.stdin.writable) {
      return false;
    }

    try {
      this.child.stdin.write(serializeZellijBridgeCommand(command), "utf8");
      return true;
    } catch (error) {
      this.logger?.error?.(`[zellij-native-bridge] failed to send command: ${String(error)}`);
      return false;
    }
  }

  kill(): void {
    if (this.child.killed) {
      return;
    }
    this.child.kill();
  }

  waitUntilReady(): Promise<boolean> {
    return this.readyPromise;
  }

  private dispatchEvent(event: ZellijNativeBridgeEvent): void {
    for (const handler of this.dataHandlers) {
      handler(event);
    }
  }

  private emitExit(code: number | null): void {
    if (this.exited) {
      return;
    }
    this.exited = true;
    this.lineReader.close();
    for (const handler of this.exitHandlers) {
      handler(code);
    }
  }

  private resolveReady(ready: boolean): void {
    if (this.readyResolved) {
      return;
    }
    this.readyResolved = true;
    this.readyResolve?.(ready);
    this.readyResolve = null;
  }
}

class ManagedPtyZellijNativeBridge implements ZellijNativeBridge {
  private readonly child: pty.IPty;
  private readonly logger?: Pick<Console, "log" | "error">;
  private readonly dataHandlers: Array<(event: ZellijNativeBridgeEvent) => void> = [];
  private readonly exitHandlers: Array<(code: number | null) => void> = [];

  private readyResolved = false;
  private exited = false;
  private readyPromise: Promise<boolean>;
  private readyResolve: ((ready: boolean) => void) | null = null;
  private lineBuffer = "";

  constructor(
    child: pty.IPty,
    logger?: Pick<Console, "log" | "error">
  ) {
    this.child = child;
    this.logger = logger;
    this.readyPromise = new Promise<boolean>((resolve) => {
      this.readyResolve = resolve;
    });
    const timeout = setTimeout(() => {
      this.resolveReady(false);
    }, BRIDGE_STARTUP_TIMEOUT_MS);

    this.child.onData((chunk) => {
      this.lineBuffer += chunk.replaceAll("\r\n", "\n");
      let newlineIndex = this.lineBuffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = this.lineBuffer.slice(0, newlineIndex).replace(/\r$/, "");
        this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
        if (line) {
          try {
            const event = parseZellijBridgeEventLine(line);
            this.dispatchEvent(event);
            if (event.type === "hello") {
              clearTimeout(timeout);
              this.resolveReady(true);
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            clearTimeout(timeout);
            this.logger?.error?.(`[zellij-native-bridge] ${message}`);
            this.dispatchEvent({ type: "error", message });
            this.resolveReady(false);
          }
        }
        newlineIndex = this.lineBuffer.indexOf("\n");
      }
    });

    this.child.onExit(({ exitCode }) => {
      clearTimeout(timeout);
      this.resolveReady(false);
      this.emitExit(exitCode);
    });
  }

  onEvent(handler: (event: ZellijNativeBridgeEvent) => void): void {
    this.dataHandlers.push(handler);
  }

  onExit(handler: (code: number | null) => void): void {
    this.exitHandlers.push(handler);
  }

  sendCommand(command: ZellijNativeBridgeCommand): boolean {
    if (this.exited) {
      return false;
    }

    try {
      this.child.write(serializeZellijBridgeCommand(command));
      return true;
    } catch (error) {
      this.logger?.error?.(`[zellij-native-bridge] failed to send command: ${String(error)}`);
      return false;
    }
  }

  kill(): void {
    this.child.kill();
  }

  waitUntilReady(): Promise<boolean> {
    return this.readyPromise;
  }

  private dispatchEvent(event: ZellijNativeBridgeEvent): void {
    for (const handler of this.dataHandlers) {
      handler(event);
    }
  }

  private emitExit(code: number | null): void {
    if (this.exited) {
      return;
    }
    this.exited = true;
    for (const handler of this.exitHandlers) {
      handler(code);
    }
  }

  private resolveReady(ready: boolean): void {
    if (this.readyResolved) {
      return;
    }
    this.readyResolved = true;
    this.readyResolve?.(ready);
    this.readyResolve = null;
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNullableStringArray(value: unknown): value is string[] | null {
  return value === null || value === undefined || isStringArray(value);
}

import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { RequestHandler } from "express";
import type {
  BackendCapabilities,
  ClientView,
  ControlClientMessage,
  ControlServerMessage,
} from "../shared/protocol.js";
import type { RuntimeConfig } from "./config.js";
import { AuthService } from "./auth/auth-service.js";
import { buildServerCapabilities } from "./server/client-capabilities.js";
import {
  resolvePaneCommandForView,
  sendComposeToRuntime,
} from "./server/compose-submit.js";
import {
  extractTerminalDimensions,
  isObject,
  parseClientMessage,
  sendJson,
} from "./server/socket-protocol.js";
import { randomToken } from "./util/random.js";
import { readRuntimeMetadata } from "./util/runtime-metadata.js";
import {
  buildLegacyClientView,
  buildLegacyScrollback,
  buildLegacyTabHistory,
  buildLegacyWorkspaceSnapshot,
  findRuntimeTabByLegacyIndex,
  resolveLegacyAttachedSession,
} from "./v2/translation.js";
import type {
  RuntimeV2ControlClientMessage,
  RuntimeV2ControlServerMessage,
  RuntimeV2InspectSnapshot,
  RuntimeV2Metadata,
  RuntimeV2SessionSummary,
  RuntimeV2TabSummary,
  RuntimeV2TerminalClientMessage,
  RuntimeV2TerminalServerMessage,
  RuntimeV2TerminalSize,
  RuntimeV2WorkspaceSummary,
} from "./v2/types.js";
import {
  parseRuntimeV2ControlMessage,
  parseRuntimeV2TerminalMessage,
  serializeRuntimeV2ControlMessage,
  serializeRuntimeV2TerminalMessage,
} from "./v2/wire.js";

export interface RunningServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  server: http.Server;
  config: RuntimeConfig;
}

export interface RuntimeV2GatewayServerDependencies {
  authService?: AuthService;
  logger?: Pick<Console, "log" | "error">;
  upstreamBaseUrl?: string;
}

interface RuntimeTargetHandle {
  baseUrl: string;
  stop(): Promise<void>;
}

interface ControlContext {
  socket: WebSocket;
  authed: boolean;
  clientId: string;
  followBackendFocus: boolean;
  messageQueue: Promise<void>;
  terminalClients: Set<DataContext>;
}

interface DataContext {
  socket: WebSocket;
  authed: boolean;
  controlContext?: ControlContext;
  paneBridge?: SharedRuntimeV2PaneBridge;
  terminalSize?: RuntimeV2TerminalSize;
  viewerId: string;
}

const RUNTIME_V2_BACKEND_KIND = "runtime-v2";
const UPLOAD_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_TERMINAL_SIZE: RuntimeV2TerminalSize = { cols: 80, rows: 24 };
const MAX_BUFFERED_TERMINAL_BYTES = 256 * 1024;
const TERMINAL_RESIZE_SETTLE_MS = 120;
const DEFAULT_IDLE_PANE_BRIDGE_GRACE_MS = 30_000;
const TERMINAL_RESET_BYTES = Buffer.from("\u001bc", "utf8");

const backendCapabilities: BackendCapabilities = {
  supportsPaneFocusById: true,
  supportsTabRename: true,
  supportsSessionRename: true,
  supportsPreciseScrollback: true,
  supportsFloatingPanes: false,
  supportsFullscreenPane: true,
};

const runtimeServerCapabilities = buildServerCapabilities({
  backendCapabilities,
  supportsUpload: true,
});

const frontendFallbackRoute = "/{*path}";

const isWebSocketPath = (requestPath: string): boolean => requestPath.startsWith("/ws/");

const sendRaw = (socket: WebSocket, payload: string | Uint8Array | Buffer): void => {
  if (socket.readyState === socket.OPEN) {
    socket.send(payload);
  }
};

const toBuffer = (raw: RawData): Buffer => {
  if (Buffer.isBuffer(raw)) {
    return raw;
  }
  if (raw instanceof ArrayBuffer) {
    return Buffer.from(raw);
  }
  if (Array.isArray(raw)) {
    return Buffer.concat(raw);
  }
  return Buffer.from(raw);
};

const toWsOrigin = (baseUrl: string): string => {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
};

type TerminalSizePolicy = "largest" | "smallest" | "latest";

const areTerminalSizesEqual = (
  left: RuntimeV2TerminalSize,
  right: RuntimeV2TerminalSize,
): boolean => left.cols === right.cols && left.rows === right.rows;

const compareTerminalSizes = (
  left: RuntimeV2TerminalSize,
  right: RuntimeV2TerminalSize,
): number => {
  const areaDelta = (left.cols * left.rows) - (right.cols * right.rows);
  if (areaDelta !== 0) {
    return areaDelta;
  }
  if (left.cols !== right.cols) {
    return left.cols - right.cols;
  }
  return left.rows - right.rows;
};

const resolveTerminalSizePolicy = (): TerminalSizePolicy => {
  const raw = process.env.REMUX_TERMINAL_SIZE_POLICY?.trim().toLowerCase();
  if (raw === "smallest" || raw === "latest" || raw === "largest") {
    return raw;
  }
  return "largest";
};

const resolveIdlePaneBridgeGraceMs = (): number => {
  const raw = process.env.REMUX_IDLE_PANE_BRIDGE_GRACE_MS?.trim();
  if (!raw) {
    return DEFAULT_IDLE_PANE_BRIDGE_GRACE_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_IDLE_PANE_BRIDGE_GRACE_MS;
  }
  return Math.max(0, Math.floor(parsed));
};

const sanitizeFilename = (raw: string): string => {
  let name = raw.replace(/[\\/\0]/g, "").replace(/\.\./g, "");
  name = name.trim();
  if (!name) {
    name = "upload";
  }
  return name;
};

const readAuthHeaders = (req: express.Request): { token?: string; password?: string } => {
  const authHeader = req.headers.authorization;
  return {
    token: authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined,
    password: req.headers["x-password"] as string | undefined,
  };
};

const ensureSocketOpen = (socket: WebSocket): Promise<void> =>
  new Promise((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });

const openWebSocket = async (url: string): Promise<WebSocket> => {
  const socket = new WebSocket(url);
  await ensureSocketOpen(socket);
  return socket;
};

const waitForPort = async (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        if (!address || typeof address === "string") {
          reject(new Error("unable to resolve free port"));
          return;
        }
        resolve(address.port);
      });
    });
  });

const waitForHealth = async (
  baseUrl: string,
  child: ChildProcessWithoutNullStreams | null,
  getStartupError?: () => Error | null,
): Promise<void> => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 30_000) {
    const startupError = getStartupError?.();
    if (startupError) {
      throw startupError;
    }
    if (child && child.exitCode !== null) {
      throw new Error(`remuxd exited before becoming healthy (code ${child.exitCode})`);
    }
    try {
      const response = await fetch(new URL("/healthz", baseUrl));
      if (response.ok) {
        return;
      }
    } catch {
      // keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  const startupError = getStartupError?.();
  if (startupError) {
    throw startupError;
  }
  throw new Error("timed out waiting for remuxd health");
};

const resolveRepoRoot = (): string => {
  const filePath = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(filePath), "../..");
};

const resolveRemuxdCommand = (): { command: string; args: string[]; cwd?: string } => {
  const explicitBinary = process.env.REMUXD_BIN?.trim();
  if (explicitBinary) {
    return { command: explicitBinary, args: [] };
  }

  const repoRoot = resolveRepoRoot();
  return {
    command: "cargo",
    args: ["run", "--manifest-path", path.join(repoRoot, "Cargo.toml"), "-p", "remuxd", "--"],
    cwd: repoRoot,
  };
};

const createManagedRuntimeTarget = async (
  logger: Pick<Console, "log" | "error">,
): Promise<RuntimeTargetHandle> => {
  const overrideBaseUrl = process.env.REMUXD_BASE_URL?.trim();
  if (overrideBaseUrl) {
    await waitForHealth(overrideBaseUrl, null);
    return {
      baseUrl: overrideBaseUrl,
      stop: async () => undefined,
    };
  }

  const port = await waitForPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const resolved = resolveRemuxdCommand();
  let startupError: Error | null = null;
  const child = spawn(
    resolved.command,
    [
      ...resolved.args,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--log-format",
      process.env.REMUXD_LOG_FORMAT ?? "pretty",
    ],
    {
      cwd: resolved.cwd,
      env: process.env,
      stdio: "pipe",
    },
  );

  child.once("error", (error) => {
    startupError = new Error(`failed to start remuxd: ${String(error)}`);
  });

  child.stdout.on("data", (chunk) => {
    logger.log(`[remuxd] ${chunk.toString("utf8").trimEnd()}`);
  });
  child.stderr.on("data", (chunk) => {
    logger.error(`[remuxd] ${chunk.toString("utf8").trimEnd()}`);
  });

  await waitForHealth(baseUrl, child, () => startupError);

  return {
    baseUrl,
    async stop() {
      if (child.exitCode !== null) {
        return;
      }
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
        }, 5_000);
        child.once("close", () => {
          clearTimeout(timeout);
          resolve();
        });
        child.kill("SIGTERM");
      });
    },
  };
};

class RuntimeV2ControlChannel {
  private socket: WebSocket | null = null;
  private summary: RuntimeV2WorkspaceSummary | null = null;
  private metadata: RuntimeV2Metadata | null = null;
  private readonly listeners = new Set<(summary: RuntimeV2WorkspaceSummary) => void>();
  private commandQueue = Promise.resolve();
  private pending:
    | {
        expected: RuntimeV2ControlServerMessage["type"];
        resolve: (message: RuntimeV2ControlServerMessage) => void;
        reject: (error: Error) => void;
      }
    | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly logger: Pick<Console, "log" | "error">,
  ) {}

  async start(): Promise<void> {
    const metadata = await fetch(new URL("/v2/meta", this.baseUrl)).then(async (response) => {
      if (!response.ok) {
        throw new Error(`runtime metadata request failed: ${response.status}`);
      }
      return await response.json() as RuntimeV2Metadata;
    });
    this.metadata = metadata;

    const socket = new WebSocket(`${toWsOrigin(this.baseUrl)}${metadata.controlWebsocketPath}`);
    const initialWorkspace = await new Promise<RuntimeV2WorkspaceSummary>((resolve, reject) => {
      const handleMessage = (raw: RawData) => {
        try {
          const message = JSON.parse(raw.toString("utf8")) as RuntimeV2ControlServerMessage;
          if (message.type === "workspace_snapshot") {
            socket.off("message", handleMessage);
            resolve(message.summary);
          }
        } catch (error) {
          socket.off("message", handleMessage);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      };

      socket.on("message", handleMessage);
      socket.once("open", () => {
        const subscribeMessage: RuntimeV2ControlClientMessage = { type: "subscribe_workspace" };
        socket.send(serializeRuntimeV2ControlMessage(subscribeMessage));
      });
      socket.once("error", reject);
    });

    this.socket = socket;
    this.summary = initialWorkspace;
    socket.on("message", (raw) => {
      this.handleMessage(raw);
    });
    socket.on("close", () => {
      const pending = this.pending;
      this.pending = null;
      pending?.reject(new Error("runtime control socket closed"));
    });
    socket.on("error", (error) => {
      this.logger.error("runtime control socket error", error);
    });
  }

  onWorkspaceSnapshot(listener: (summary: RuntimeV2WorkspaceSummary) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  currentSummary(): RuntimeV2WorkspaceSummary {
    if (!this.summary) {
      throw new Error("runtime summary not available");
    }
    return this.summary;
  }

  currentMetadata(): RuntimeV2Metadata {
    if (!this.metadata) {
      throw new Error("runtime metadata not available");
    }
    return this.metadata;
  }

  async close(): Promise<void> {
    if (!this.socket) {
      return;
    }
    const socket = this.socket;
    this.socket = null;
    await new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
      socket.close();
      setTimeout(resolve, 200);
    });
  }

  async command(message: RuntimeV2ControlClientMessage): Promise<RuntimeV2ControlServerMessage> {
    const expected = message.type === "request_inspect"
      ? "inspect_snapshot"
      : message.type === "request_diagnostics"
        ? "diagnostics_snapshot"
        : "workspace_snapshot";

    const run = async (): Promise<RuntimeV2ControlServerMessage> => {
      if (!this.socket) {
        throw new Error("runtime control socket not connected");
      }
      return await new Promise<RuntimeV2ControlServerMessage>((resolve, reject) => {
        this.pending = { expected, resolve, reject };
        this.socket!.send(serializeRuntimeV2ControlMessage(message), (error) => {
          if (error) {
            this.pending = null;
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
      });
    };

    const next = this.commandQueue.then(run, run);
    this.commandQueue = next.then(() => undefined, () => undefined);
    return await next;
  }

  private handleMessage(raw: RawData): void {
    let message: RuntimeV2ControlServerMessage;
    try {
      message = parseRuntimeV2ControlMessage(raw.toString("utf8"));
    } catch (error) {
      this.logger.error("failed to parse runtime control message", error);
      return;
    }

    if (message.type === "workspace_snapshot") {
      this.summary = message.summary;
      for (const listener of this.listeners) {
        listener(message.summary);
      }
    }

    if (message.type === "command_rejected") {
      const pending = this.pending;
      this.pending = null;
      pending?.reject(new Error(message.reason));
      return;
    }

    if (this.pending && this.pending.expected === message.type) {
      const pending = this.pending;
      this.pending = null;
      pending.resolve(message);
    }
  }
}

export class SharedRuntimeV2PaneBridge {
  private socket: WebSocket | null = null;
  private attachVersion = 0;
  private currentSize: RuntimeV2TerminalSize = DEFAULT_TERMINAL_SIZE;
  private latestSnapshotPayload: Buffer | null = null;
  private latestViewerId: string | null = null;
  private readonly subscribers = new Map<string, WebSocket>();
  private readonly viewerSizes = new Map<string, RuntimeV2TerminalSize>();
  private readonly bufferedChunks: Buffer[] = [];
  private bufferedChunkBytes = 0;
  private mutationQueue = Promise.resolve();
  private resizeSnapshotTimer: ReturnType<typeof setTimeout> | null = null;
  private idleCloseTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly paneId: string,
    private readonly terminalWsUrl: string,
    private readonly logger: Pick<Console, "log" | "error">,
    private readonly sizePolicy: TerminalSizePolicy,
    private readonly onIdle: (paneId: string) => void,
  ) {}

  async subscribe(viewerId: string, browserSocket: WebSocket, size: RuntimeV2TerminalSize): Promise<void> {
    await this.enqueue(async () => {
      this.clearIdleCloseTimer();
      this.subscribers.set(viewerId, browserSocket);
      this.recordViewerSize(viewerId, size);
      const desiredSize = this.resolveDesiredSize();
      await this.ensureAttached(desiredSize);
      if (this.latestSnapshotPayload) {
        sendRaw(browserSocket, this.latestSnapshotPayload);
        for (const chunk of this.bufferedChunks) {
          sendRaw(browserSocket, chunk);
        }
      }
    });
  }

  async unsubscribe(viewerId: string): Promise<void> {
    await this.enqueue(async () => {
      this.subscribers.delete(viewerId);
      this.viewerSizes.delete(viewerId);
      if (this.latestViewerId === viewerId) {
        this.latestViewerId = this.viewerSizes.keys().next().value ?? null;
      }

      if (this.subscribers.size === 0) {
        this.scheduleIdleClose();
        return;
      }

      await this.syncSize();
    });
  }

  async updateViewerSize(viewerId: string, size: RuntimeV2TerminalSize): Promise<void> {
    await this.enqueue(async () => {
      if (!this.subscribers.has(viewerId)) {
        return;
      }
      this.recordViewerSize(viewerId, size);
      await this.syncSize();
    });
  }

  write(input: string | Uint8Array): void {
    if (!this.socket || this.socket.readyState !== this.socket.OPEN) {
      return;
    }
    const payload = typeof input === "string"
      ? Buffer.from(input, "utf8")
      : Buffer.from(input);
    this.socket.send(payload);
  }

  async close(): Promise<void> {
    await this.enqueue(async () => {
      this.clearIdleCloseTimer();
      this.subscribers.clear();
      this.viewerSizes.clear();
      this.latestViewerId = null;
      await this.closeSocket();
      this.onIdle(this.paneId);
    });
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = async (): Promise<void> => {
      await task();
    };

    const next = this.mutationQueue.then(run, run);
    this.mutationQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  private recordViewerSize(viewerId: string, size: RuntimeV2TerminalSize): void {
    this.viewerSizes.set(viewerId, size);
    this.latestViewerId = viewerId;
  }

  private resolveDesiredSize(): RuntimeV2TerminalSize {
    if (this.viewerSizes.size === 0) {
      return DEFAULT_TERMINAL_SIZE;
    }

    if (this.sizePolicy === "latest" && this.latestViewerId) {
      return this.viewerSizes.get(this.latestViewerId) ?? Array.from(this.viewerSizes.values())[0]!;
    }

    const sizes = Array.from(this.viewerSizes.values());
    return sizes.reduce((chosen, candidate) => {
      const delta = compareTerminalSizes(candidate, chosen);
      if (this.sizePolicy === "smallest") {
        return delta < 0 ? candidate : chosen;
      }
      return delta > 0 ? candidate : chosen;
    });
  }

  private async ensureAttached(size: RuntimeV2TerminalSize): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) {
      if (!areTerminalSizesEqual(this.currentSize, size)) {
        this.resize(size);
        this.scheduleSnapshotRequest();
      }
      return;
    }

    this.attachVersion += 1;
    const version = this.attachVersion;

    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }

    const socket = await openWebSocket(this.terminalWsUrl);
    if (version !== this.attachVersion) {
      socket.close();
      return;
    }

    this.socket = socket;
    socket.on("message", (raw, isBinary) => {
      this.handleMessage(version, raw, isBinary);
    });
    socket.on("close", () => {
      if (version === this.attachVersion && this.socket === socket) {
        this.socket = null;
      }
    });
    socket.on("error", (error) => {
      this.logger.error("runtime terminal socket error", error);
    });

    this.currentSize = size;
    const payload: RuntimeV2TerminalClientMessage = {
      type: "attach",
      paneId: this.paneId,
      mode: "interactive",
      size,
    };
    socket.send(serializeRuntimeV2TerminalMessage(payload));
  }

  private resize(size: RuntimeV2TerminalSize): void {
    if (!this.socket || this.socket.readyState !== this.socket.OPEN) {
      return;
    }
    const payload: RuntimeV2TerminalClientMessage = {
      type: "resize",
      size,
    };
    this.socket.send(serializeRuntimeV2TerminalMessage(payload));
    this.currentSize = size;
  }

  private requestSnapshot(): void {
    if (!this.socket) {
      return;
    }
    this.socket.send(serializeRuntimeV2TerminalMessage({ type: "request_snapshot" }));
  }

  private clearPendingSnapshotRequest(): void {
    if (this.resizeSnapshotTimer !== null) {
      clearTimeout(this.resizeSnapshotTimer);
      this.resizeSnapshotTimer = null;
    }
  }

  private clearIdleCloseTimer(): void {
    if (this.idleCloseTimer !== null) {
      clearTimeout(this.idleCloseTimer);
      this.idleCloseTimer = null;
    }
  }

  private scheduleSnapshotRequest(): void {
    this.clearPendingSnapshotRequest();
    this.resizeSnapshotTimer = setTimeout(() => {
      this.resizeSnapshotTimer = null;
      this.requestSnapshot();
    }, TERMINAL_RESIZE_SETTLE_MS);
  }

  private scheduleIdleClose(): void {
    this.clearIdleCloseTimer();
    const graceMs = resolveIdlePaneBridgeGraceMs();
    if (graceMs === 0) {
      void this.enqueue(async () => {
        if (this.subscribers.size > 0) {
          return;
        }
        await this.closeSocket();
        this.onIdle(this.paneId);
      });
      return;
    }
    this.idleCloseTimer = setTimeout(() => {
      this.idleCloseTimer = null;
      void this.enqueue(async () => {
        if (this.subscribers.size > 0) {
          return;
        }
        await this.closeSocket();
        this.onIdle(this.paneId);
      });
    }, graceMs);
  }

  private async syncSize(): Promise<void> {
    const desiredSize = this.resolveDesiredSize();
    await this.ensureAttached(desiredSize);
  }

  private async closeSocket(): Promise<void> {
    this.attachVersion += 1;
    this.clearPendingSnapshotRequest();
    this.clearIdleCloseTimer();
    this.latestSnapshotPayload = null;
    this.bufferedChunks.length = 0;
    this.bufferedChunkBytes = 0;
    this.currentSize = DEFAULT_TERMINAL_SIZE;
    if (!this.socket) {
      return;
    }
    const socket = this.socket;
    this.socket = null;
    await new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
      socket.close();
      setTimeout(resolve, 200);
    });
  }

  private rememberBufferedChunk(chunk: Buffer): void {
    if (!this.latestSnapshotPayload) {
      return;
    }
    this.bufferedChunks.push(chunk);
    this.bufferedChunkBytes += chunk.byteLength;
    while (this.bufferedChunkBytes > MAX_BUFFERED_TERMINAL_BYTES && this.bufferedChunks.length > 0) {
      const removed = this.bufferedChunks.shift();
      this.bufferedChunkBytes -= removed?.byteLength ?? 0;
    }
  }

  private handleMessage(version: number, raw: RawData, isBinary: boolean): void {
    if (version !== this.attachVersion) {
      return;
    }

    if (isBinary) {
      const chunk = toBuffer(raw);
      this.broadcast(chunk);
      this.rememberBufferedChunk(chunk);
      return;
    }

    let message: RuntimeV2TerminalServerMessage;
    try {
      message = parseRuntimeV2TerminalMessage(raw.toString("utf8"));
    } catch (error) {
      this.logger.error("failed to parse runtime terminal message", error);
      return;
    }

    if (message.type === "snapshot") {
      this.clearPendingSnapshotRequest();
      this.latestSnapshotPayload = Buffer.concat([
        TERMINAL_RESET_BYTES,
        Buffer.from(message.replayBase64 ?? message.contentBase64, "base64"),
      ]);
      this.bufferedChunks.length = 0;
      this.bufferedChunkBytes = 0;
      this.broadcast(this.latestSnapshotPayload);
      return;
    }

    if (message.type === "stream") {
      const chunk = Buffer.from(message.chunkBase64, "base64");
      this.broadcast(chunk);
      this.rememberBufferedChunk(chunk);
    }
  }

  private broadcast(payload: Buffer): void {
    for (const subscriber of this.subscribers.values()) {
      sendRaw(subscriber, payload);
    }
  }
}

const findSessionByName = (
  summary: RuntimeV2WorkspaceSummary,
  sessionName: string,
): RuntimeV2SessionSummary | undefined => summary.sessions.find((session) => session.sessionName === sessionName);

const findTabByIndex = (
  summary: RuntimeV2WorkspaceSummary,
  sessionName: string,
  tabIndex: number,
): RuntimeV2TabSummary | undefined => findSessionByName(summary, sessionName)?.tabs[tabIndex];

const resolveActivePaneId = (summary: RuntimeV2WorkspaceSummary): string =>
  summary.activePaneId ?? summary.paneId;

const buildWorkspaceStateMessage = (
  summary: RuntimeV2WorkspaceSummary,
  followBackendFocus: boolean,
): Extract<ControlServerMessage, { type: "workspace_state" }> => ({
  type: "workspace_state",
  workspace: buildLegacyWorkspaceSnapshot(summary),
  clientView: buildLegacyClientView(summary, followBackendFocus),
  runtimeState: {
    streamMode: "native-bridge",
    scrollbackPrecision: "precise",
  },
});

const toRuntimeTerminalSize = (
  dimensions: { cols?: number; rows?: number } | null | undefined,
): RuntimeV2TerminalSize => ({
  cols: dimensions?.cols ?? DEFAULT_TERMINAL_SIZE.cols,
  rows: dimensions?.rows ?? DEFAULT_TERMINAL_SIZE.rows,
});

const writeUnauthorized = (socket: WebSocket): void => {
  if (socket.readyState === socket.OPEN) {
    socket.close(4001, "unauthorized");
  }
};

export const createRemuxV2GatewayServer = (
  config: RuntimeConfig,
  deps: RuntimeV2GatewayServerDependencies = {},
): RunningServer => {
  const logger = deps.logger ?? console;
  const authService = deps.authService ?? new AuthService({ password: config.password, token: config.token });
  const runtimeMetadata = readRuntimeMetadata();
  const terminalSizePolicy = resolveTerminalSizePolicy();

  const app = express();
  app.use(express.json());

  const server = http.createServer(app);
  const controlWss = new WebSocketServer({ noServer: true, perMessageDeflate: true });
  const terminalWss = new WebSocketServer({ noServer: true, perMessageDeflate: true });
  const controlClients = new Set<ControlContext>();
  const terminalClients = new Set<DataContext>();
  const paneBridges = new Map<string, SharedRuntimeV2PaneBridge>();

  let runtimeTarget: RuntimeTargetHandle | null = null;
  let runtimeControl: RuntimeV2ControlChannel | null = null;
  let started = false;
  let stopPromise: Promise<void> | null = null;

  const requireApiAuth: RequestHandler = (req, res, next) => {
    const authResult = authService.verify(readAuthHeaders(req));
    if (!authResult.ok) {
      res.status(401).json({ ok: false, error: "unauthorized" });
      return;
    }
    next();
  };

  const tokenFile = path.join(os.homedir(), ".remux", "github-token");

  app.get("/api/config", (_req, res) => {
    const localWebSocketOrigin = process.env.REMUX_LOCAL_WS_ORIGIN?.trim() || undefined;
    res.json({
      version: runtimeMetadata.version,
      gitBranch: runtimeMetadata.gitBranch,
      gitCommitSha: runtimeMetadata.gitCommitSha,
      gitDirty: runtimeMetadata.gitDirty,
      passwordRequired: authService.requiresPassword(),
      scrollbackLines: config.scrollbackLines,
      pollIntervalMs: config.pollIntervalMs,
      uploadMaxSize: UPLOAD_MAX_BYTES,
      localWebSocketOrigin,
      backendKind: RUNTIME_V2_BACKEND_KIND,
      runtimeMode: RUNTIME_V2_BACKEND_KIND,
    });
  });

  app.get("/api/diagnostics", requireApiAuth, (_req, res) => {
    res.json({
      version: runtimeMetadata.version,
      backendKind: RUNTIME_V2_BACKEND_KIND,
      runtimeMode: RUNTIME_V2_BACKEND_KIND,
      protocolVersion: runtimeControl?.currentMetadata().protocolVersion ?? null,
      upstreamBaseUrl: runtimeTarget?.baseUrl ?? null,
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      uptime: Math.round(process.uptime()),
    });
  });

  app.get("/api/auth/github-token", requireApiAuth, (_req, res) => {
    try {
      const token = fs.readFileSync(tokenFile, "utf8").trim();
      res.json({ token: token || null });
    } catch {
      res.json({ token: null });
    }
  });

  app.post("/api/auth/github-token", requireApiAuth, (req, res) => {
    const { token } = req.body as { token?: string };
    if (typeof token !== "string" || token.trim().length === 0) {
      res.status(400).json({ error: "missing token" });
      return;
    }
    try {
      fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
      fs.writeFileSync(tokenFile, token.trim(), { mode: 0o600 });
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  app.delete("/api/auth/github-token", requireApiAuth, (_req, res) => {
    try {
      fs.rmSync(tokenFile, { force: true });
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  app.post("/api/auth/github/device-code", requireApiAuth, async (req, res) => {
    try {
      const { client_id, scope } = req.body as { client_id: string; scope: string };
      const response = await fetch("https://github.com/login/device/code", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ client_id, scope }),
      });
      res.json(await response.json());
    } catch (error) {
      res.status(502).json({ error: String(error) });
    }
  });

  app.post("/api/auth/github/access-token", requireApiAuth, async (req, res) => {
    try {
      const { client_id, device_code, grant_type } = req.body as {
        client_id: string;
        device_code: string;
        grant_type: string;
      };
      const response = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ client_id, device_code, grant_type }),
      });
      res.json(await response.json());
    } catch (error) {
      res.status(502).json({ error: String(error) });
    }
  });

  app.post(
    "/api/upload",
    express.raw({ limit: UPLOAD_MAX_BYTES, type: "application/octet-stream" }),
    async (req, res) => {
      const authResult = authService.verify(readAuthHeaders(req));
      if (!authResult.ok) {
        res.status(401).json({ ok: false, error: "unauthorized" });
        return;
      }

      const rawFilename = req.headers["x-filename"] as string | undefined;
      if (!rawFilename) {
        res.status(400).json({ ok: false, error: "missing X-Filename header" });
        return;
      }

      const filename = sanitizeFilename(rawFilename);
      const paneCwd = req.headers["x-pane-cwd"] as string | undefined;
      const resolvedDir = await fs.promises.stat(paneCwd || process.cwd()).then(
        (stat) => (stat.isDirectory() ? (paneCwd || process.cwd()) : process.cwd()),
        () => process.cwd(),
      );

      const body = req.body as Buffer;
      let finalName = filename;
      let finalPath = path.join(resolvedDir, finalName);
      try {
        await fs.promises.writeFile(finalPath, body, { flag: "wx" });
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          finalName = `upload-${Date.now()}-${filename}`;
          finalPath = path.join(resolvedDir, finalName);
          await fs.promises.writeFile(finalPath, body);
        } else {
          res.status(500).json({ ok: false, error: "failed to write file" });
          return;
        }
      }

      res.json({ ok: true, path: finalPath, filename: finalName });
    },
  );

  app.use(express.static(config.frontendDir));
  app.get(frontendFallbackRoute, (req, res) => {
    if (isWebSocketPath(req.path) || req.path.startsWith("/api/")) {
      res.status(404).end();
      return;
    }

    res.sendFile(path.join(config.frontendDir, "index.html"), (error) => {
      if (error) {
        res.status(500).send("Frontend not built. Run npm run build:frontend");
      }
    });
  });

  const broadcastWorkspaceState = (): void => {
    if (!runtimeControl) {
      return;
    }
    const summary = runtimeControl.currentSummary();
    for (const client of controlClients) {
      if (!client.authed) {
        continue;
      }
      sendJson(client.socket, buildWorkspaceStateMessage(summary, client.followBackendFocus));
    }
  };

  const retargetTerminalClients = async (): Promise<void> => {
    if (!runtimeControl) {
      return;
    }
    const paneId = resolveActivePaneId(runtimeControl.currentSummary());
    await Promise.all(
      Array.from(terminalClients).map(async (ctx) => {
        if (!ctx.authed) {
          return;
        }
        await attachTerminalClientToPane(ctx, paneId);
      }),
    );
  };

  const getOrCreatePaneBridge = (paneId: string): SharedRuntimeV2PaneBridge => {
    let bridge = paneBridges.get(paneId);
    if (!bridge) {
      if (!runtimeTarget || !runtimeControl) {
        throw new Error("runtime terminal bridge is unavailable");
      }
      const terminalPath = runtimeControl.currentMetadata().terminalWebsocketPath;
      bridge = new SharedRuntimeV2PaneBridge(
        paneId,
        `${toWsOrigin(runtimeTarget.baseUrl)}${terminalPath}`,
        logger,
        terminalSizePolicy,
        (idlePaneId) => {
          paneBridges.delete(idlePaneId);
        },
      );
      paneBridges.set(paneId, bridge);
    }
    return bridge;
  };

  const detachTerminalClient = async (context: DataContext): Promise<void> => {
    const bridge = context.paneBridge;
    context.paneBridge = undefined;
    if (!bridge) {
      return;
    }
    await bridge.unsubscribe(context.viewerId);
  };

  const attachTerminalClientToPane = async (
    context: DataContext,
    paneId: string,
  ): Promise<void> => {
    const size = context.terminalSize ?? DEFAULT_TERMINAL_SIZE;
    if (context.paneBridge?.paneId === paneId) {
      await context.paneBridge.updateViewerSize(context.viewerId, size);
      return;
    }

    await detachTerminalClient(context);
    const bridge = getOrCreatePaneBridge(paneId);
    context.paneBridge = bridge;
    await bridge.subscribe(context.viewerId, context.socket, size);
  };

  const sendAttached = (context: ControlContext): void => {
    if (!runtimeControl) {
      return;
    }
    sendJson(context.socket, {
      type: "attached",
      session: resolveLegacyAttachedSession(runtimeControl.currentSummary()),
    });
  };

  const applyInitialSelection = async (
    message: Extract<ControlClientMessage, { type: "auth" }>,
  ): Promise<void> => {
    if (!runtimeControl) {
      return;
    }

    if (message.session) {
      const session = findSessionByName(runtimeControl.currentSummary(), message.session);
      if (session && session.sessionId !== runtimeControl.currentSummary().activeSessionId) {
        await runtimeControl.command({ type: "select_session", sessionId: session.sessionId });
      }
    }

    if (typeof message.tabIndex === "number") {
      const summary = runtimeControl.currentSummary();
      const sessionName = message.session ?? resolveLegacyAttachedSession(summary);
      const tab = findTabByIndex(summary, sessionName, message.tabIndex);
      if (tab) {
        await runtimeControl.command({ type: "select_tab", tabId: tab.tabId });
      }
    }

    if (message.paneId) {
      await runtimeControl.command({ type: "focus_pane", paneId: message.paneId });
    }
  };

  const sendTabHistory = async (
    context: ControlContext,
    sessionName: string,
    tabIndex: number,
    lines: number,
  ): Promise<void> => {
    if (!runtimeControl) {
      return;
    }
    const summary = runtimeControl.currentSummary();
    const tab = findRuntimeTabByLegacyIndex(summary, sessionName, tabIndex);
    if (!tab) {
      throw new Error(`tab not found: ${sessionName}:${tabIndex}`);
    }

    const snapshots: RuntimeV2InspectSnapshot[] = [];
    for (const pane of tab.panes) {
      const response = await runtimeControl.command({
        type: "request_inspect",
        scope: { type: "pane", paneId: pane.paneId },
      });
      if (response.type !== "inspect_snapshot") {
        throw new Error("unexpected runtime inspect response");
      }
      snapshots.push(response.snapshot);
    }

    sendJson(context.socket, buildLegacyTabHistory(summary, sessionName, tabIndex, lines, snapshots));
  };

  const sendScrollback = async (
    context: ControlContext,
    paneId: string,
    lines: number,
  ): Promise<void> => {
    if (!runtimeControl) {
      return;
    }
    const response = await runtimeControl.command({
      type: "request_inspect",
      scope: { type: "pane", paneId },
    });
    if (response.type !== "inspect_snapshot") {
      throw new Error("unexpected runtime inspect response");
    }
    sendJson(context.socket, buildLegacyScrollback(paneId, lines, response.snapshot));
  };

  const runControlMutation = async (
    message: ControlClientMessage,
    context: ControlContext,
  ): Promise<void> => {
    if (!runtimeControl) {
      throw new Error("runtime control is unavailable");
    }

    switch (message.type) {
      case "auth":
        return;
      case "select_session": {
        const session = findSessionByName(runtimeControl.currentSummary(), message.session);
        if (!session) {
          throw new Error(`session not found: ${message.session}`);
        }
        await runtimeControl.command({ type: "select_session", sessionId: session.sessionId });
        return;
      }
      case "new_session":
        await runtimeControl.command({ type: "create_session", sessionName: message.name });
        return;
      case "close_session": {
        const session = findSessionByName(runtimeControl.currentSummary(), message.session);
        if (!session) {
          throw new Error(`session not found: ${message.session}`);
        }
        await runtimeControl.command({ type: "close_session", sessionId: session.sessionId });
        return;
      }
      case "new_tab": {
        const session = findSessionByName(runtimeControl.currentSummary(), message.session);
        if (!session) {
          throw new Error(`session not found: ${message.session}`);
        }
        await runtimeControl.command({ type: "create_tab", sessionId: session.sessionId, tabTitle: "Shell" });
        return;
      }
      case "select_tab": {
        const tab = findTabByIndex(runtimeControl.currentSummary(), message.session, message.tabIndex);
        if (!tab) {
          throw new Error(`tab not found: ${message.session}:${message.tabIndex}`);
        }
        await runtimeControl.command({ type: "select_tab", tabId: tab.tabId });
        return;
      }
      case "close_tab": {
        const tab = findTabByIndex(runtimeControl.currentSummary(), message.session, message.tabIndex);
        if (!tab) {
          throw new Error(`tab not found: ${message.session}:${message.tabIndex}`);
        }
        await runtimeControl.command({ type: "close_tab", tabId: tab.tabId });
        return;
      }
      case "select_pane":
        await runtimeControl.command({ type: "focus_pane", paneId: message.paneId });
        return;
      case "split_pane":
        await runtimeControl.command({
          type: "split_pane",
          paneId: message.paneId,
          direction: message.direction,
        });
        return;
      case "close_pane":
        await runtimeControl.command({ type: "close_pane", paneId: message.paneId });
        return;
      case "toggle_fullscreen":
        await runtimeControl.command({ type: "toggle_pane_zoom", paneId: message.paneId });
        return;
      case "capture_scrollback":
        await sendScrollback(context, message.paneId, message.lines ?? config.scrollbackLines);
        return;
      case "capture_tab_history": {
        const sessionName = message.session ?? resolveLegacyAttachedSession(runtimeControl.currentSummary());
        await sendTabHistory(context, sessionName, message.tabIndex, message.lines ?? config.scrollbackLines);
        return;
      }
      case "send_compose": {
        const terminalClient = Array.from(context.terminalClients)[0];
        if (!terminalClient?.paneBridge) {
          return;
        }
        sendComposeToRuntime({
          runtime: terminalClient.paneBridge,
          text: message.text,
          submitMode: "delayed",
          paneCommand: resolvePaneCommandForView(
            buildLegacyWorkspaceSnapshot(runtimeControl.currentSummary()),
            buildLegacyClientView(runtimeControl.currentSummary(), context.followBackendFocus),
          ),
        });
        return;
      }
      case "rename_session": {
        const session = findSessionByName(runtimeControl.currentSummary(), message.session);
        if (!session) {
          throw new Error(`session not found: ${message.session}`);
        }
        await runtimeControl.command({
          type: "rename_session",
          sessionId: session.sessionId,
          sessionName: message.newName,
        });
        return;
      }
      case "rename_tab": {
        const tab = findTabByIndex(runtimeControl.currentSummary(), message.session, message.tabIndex);
        if (!tab) {
          throw new Error(`tab not found: ${message.session}:${message.tabIndex}`);
        }
        await runtimeControl.command({
          type: "rename_tab",
          tabId: tab.tabId,
          tabTitle: message.newName,
        });
        return;
      }
      case "set_follow_focus":
        context.followBackendFocus = message.follow;
        sendJson(context.socket, buildWorkspaceStateMessage(runtimeControl.currentSummary(), context.followBackendFocus));
        return;
      default: {
        const exhaustive: never = message;
        return exhaustive;
      }
    }
  };

  const shutdownControlContext = async (context: ControlContext): Promise<void> => {
    for (const terminalClient of context.terminalClients) {
      if (terminalClient.socket.readyState === terminalClient.socket.OPEN) {
        terminalClient.socket.close();
      }
      await detachTerminalClient(terminalClient);
    }
    context.terminalClients.clear();
  };

  controlWss.on("connection", (socket) => {
    const context: ControlContext = {
      socket,
      authed: false,
      clientId: randomToken(12),
      followBackendFocus: false,
      messageQueue: Promise.resolve(),
      terminalClients: new Set(),
    };
    controlClients.add(context);

    socket.on("message", (rawData) => {
      const raw = rawData.toString("utf8");
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (parsed.type === "ping") {
          if (socket.readyState === socket.OPEN) {
            socket.send(JSON.stringify({
              type: "pong",
              ...(typeof parsed.timestamp === "number" ? { timestamp: parsed.timestamp } : {}),
            }));
          }
          return;
        }
      } catch {
        // Continue to normal parsing.
      }
      const message = parseClientMessage(raw);
      if (!message) {
        sendJson(socket, { type: "error", message: "invalid message format" });
        return;
      }

      context.messageQueue = context.messageQueue.then(async () => {
        if (!context.authed) {
          if (message.type !== "auth") {
            sendJson(socket, { type: "auth_error", reason: "auth required" });
            return;
          }
          const authResult = authService.verify({
            token: message.token,
            password: message.password,
          });
          if (!authResult.ok) {
            sendJson(socket, {
              type: "auth_error",
              reason: authResult.reason ?? "unauthorized",
            });
            return;
          }

          context.authed = true;
          await applyInitialSelection(message);
          sendJson(socket, {
            type: "auth_ok",
            clientId: context.clientId,
            requiresPassword: authService.requiresPassword(),
            capabilities: backendCapabilities,
            serverCapabilities: runtimeServerCapabilities,
            backendKind: RUNTIME_V2_BACKEND_KIND,
          });
          sendAttached(context);
          if (runtimeControl) {
            sendJson(socket, buildWorkspaceStateMessage(runtimeControl.currentSummary(), context.followBackendFocus));
          }
          return;
        }

        try {
          await runControlMutation(message, context);
        } catch (error) {
          sendJson(socket, {
            type: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }).catch((error) => {
        sendJson(socket, {
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      });
    });

    socket.on("close", () => {
      controlClients.delete(context);
      void shutdownControlContext(context);
    });
  });

  terminalWss.on("connection", (socket) => {
    const context: DataContext = {
      socket,
      authed: false,
      viewerId: randomToken(12),
    };
    terminalClients.add(context);

    socket.on("message", async (rawData, isBinary) => {
      if (!context.authed) {
        if (isBinary) {
          writeUnauthorized(socket);
          return;
        }
        const authMessage = parseClientMessage(rawData.toString("utf8"));
        if (!authMessage || authMessage.type !== "auth" || !authMessage.clientId) {
          writeUnauthorized(socket);
          return;
        }
        const authResult = authService.verify({
          token: authMessage.token,
          password: authMessage.password,
        });
        if (!authResult.ok) {
          writeUnauthorized(socket);
          return;
        }
        const controlContext = Array.from(controlClients).find(
          (candidate) => candidate.clientId === authMessage.clientId && candidate.authed,
        );
        if (!controlContext || !runtimeControl || !runtimeTarget) {
          writeUnauthorized(socket);
          return;
        }

        context.authed = true;
        context.controlContext = controlContext;
        context.terminalSize = toRuntimeTerminalSize(extractTerminalDimensions(authMessage));
        controlContext.terminalClients.add(context);
        await attachTerminalClientToPane(context, resolveActivePaneId(runtimeControl.currentSummary()));
        return;
      }

      if (!context.paneBridge) {
        return;
      }

      if (isBinary) {
        context.paneBridge.write(toBuffer(rawData));
        return;
      }

      const text = rawData.toString("utf8");
      if (text.startsWith("{")) {
        try {
          const payload = JSON.parse(text) as unknown;
          if (
            isObject(payload)
            && payload.type === "ping"
          ) {
            return;
          }
          if (
            isObject(payload)
            && payload.type === "resize"
            && typeof payload.cols === "number"
            && typeof payload.rows === "number"
          ) {
            context.terminalSize = { cols: payload.cols, rows: payload.rows };
            await context.paneBridge.updateViewerSize(context.viewerId, context.terminalSize);
            return;
          }
        } catch {
          // treat as terminal input below
        }
      }

      context.paneBridge.write(text);
    });

    socket.on("close", () => {
      terminalClients.delete(context);
      context.controlContext?.terminalClients.delete(context);
      void detachTerminalClient(context);
    });
  });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/ws/control") {
      controlWss.handleUpgrade(request, socket, head, (websocket) => {
        controlWss.emit("connection", websocket, request);
      });
      return;
    }
    if (url.pathname === "/ws/terminal") {
      terminalWss.handleUpgrade(request, socket, head, (websocket) => {
        terminalWss.emit("connection", websocket, request);
      });
      return;
    }
    socket.destroy();
  });

  return {
    config,
    server,
    async start() {
      if (started) {
        return;
      }

      try {
        const { openDb } = await import("@microsoft/snapfeed-server");
        fs.mkdirSync(path.join(os.homedir(), ".remux"), { recursive: true });
        const feedbackDb = openDb({ path: path.join(os.homedir(), ".remux", "feedback.db") });

        app.post("/api/telemetry/events", (req, res) => {
          const body = req.body as { events?: Array<Record<string, unknown>> };
          const events = body?.events;
          if (!Array.isArray(events) || events.length === 0) {
            res.status(400).json({ error: "events array required" });
            return;
          }

          const insert = feedbackDb.prepare(
            `INSERT OR IGNORE INTO ui_telemetry
              (session_id, seq, ts, event_type, page, target, detail_json, screenshot)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          );
          const insertMany = feedbackDb.transaction((rows: Array<Record<string, unknown>>) => {
            for (const event of rows) {
              insert.run(
                event.session_id,
                event.seq,
                event.ts,
                event.event_type,
                event.page ?? null,
                event.target ?? null,
                event.detail ? JSON.stringify(event.detail) : null,
                event.screenshot ?? null,
              );
            }
          });
          insertMany(events);
          res.json({ accepted: events.length });
        });
      } catch (error) {
        logger.error("snapfeed init failed:", String(error));
      }

      runtimeTarget = deps.upstreamBaseUrl
        ? { baseUrl: deps.upstreamBaseUrl, stop: async () => undefined }
        : await createManagedRuntimeTarget(logger);
      runtimeControl = new RuntimeV2ControlChannel(runtimeTarget.baseUrl, logger);
      await runtimeControl.start();
      runtimeControl.onWorkspaceSnapshot(() => {
        broadcastWorkspaceState();
        void retargetTerminalClients();
      });

      const initialSummary = runtimeControl.currentSummary();
      if (config.defaultSession && initialSummary.sessions.length === 1) {
        const onlySession = initialSummary.sessions[0]!;
        if (onlySession.sessionName !== config.defaultSession) {
          await runtimeControl.command({
            type: "rename_session",
            sessionId: onlySession.sessionId,
            sessionName: config.defaultSession,
          });
        }
      }

      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          server.off("error", onError);
          reject(error);
        };
        server.once("error", onError);
        server.listen(config.port, config.host, () => {
          server.off("error", onError);
          started = true;
          resolve();
        });
      });
    },
    async stop() {
      if (!started) {
        return;
      }
      if (stopPromise) {
        await stopPromise;
        return;
      }
      stopPromise = (async () => {
        await Promise.all(Array.from(controlClients).map((context) => shutdownControlContext(context)));
        controlWss.close();
        terminalWss.close();
        await Promise.all(Array.from(paneBridges.values()).map((bridge) => bridge.close()));
        paneBridges.clear();
        await runtimeControl?.close();
        await runtimeTarget?.stop();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        });
        started = false;
      })();
      await stopPromise;
    },
  };
};

export { frontendFallbackRoute, isWebSocketPath };

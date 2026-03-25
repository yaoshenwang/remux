import { createRequire } from "node:module";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import type { RequestHandler } from "express";
import type { RuntimeConfig } from "./config.js";
import type {
  ControlClientMessage,
  ControlServerMessage,
  ClientView,
  SessionState,
  WorkspaceSnapshot
} from "../shared/protocol.js";
import { randomToken } from "./util/random.js";
import { AuthService } from "./auth/auth-service.js";
import type { MultiplexerBackend } from "./multiplexer/types.js";
import { buildSnapshot } from "./multiplexer/types.js";
import { TerminalRuntime } from "./pty/terminal-runtime.js";
import type { PtyFactory } from "./pty/pty-adapter.js";
import { TmuxStateMonitor } from "./state/state-monitor.js";
import { ClientViewStore } from "./view/client-view-store.js";

interface ControlContext {
  socket: WebSocket;
  authed: boolean;
  clientId: string;
  messageQueue: Promise<void>;
  runtime?: TerminalRuntime;
  baseSession?: string;
  attachedSession?: string;
  terminalClients: Set<DataContext>;
  /** Pending resize from terminal WS received before runtime was created */
  pendingResize?: { cols: number; rows: number };
}

interface DataContext {
  socket: WebSocket;
  authed: boolean;
  controlClientId?: string;
  controlContext?: ControlContext;
}

export interface ServerDependencies {
  backend: MultiplexerBackend;
  ptyFactory: PtyFactory;
  authService?: AuthService;
  logger?: Pick<Console, "log" | "error">;
  /** Callback to switch the backend at runtime. Returns the new deps. */
  onSwitchBackend?: (kind: "tmux" | "zellij" | "conpty") => ServerDependencies | null;
  extensions?: import("./extensions.js").Extensions;
}

export interface RunningServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  server: http.Server;
  config: RuntimeConfig;
}

export const frontendFallbackRoute = "/{*path}";

export const isWebSocketPath = (requestPath: string): boolean => requestPath.startsWith("/ws/");

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const getSingleParam = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? value.join("/") : (value ?? "");

const controlClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("auth"), token: z.string().optional(), password: z.string().optional(), clientId: z.string().optional(), session: z.string().optional() }),
  z.object({ type: z.literal("select_session"), session: z.string() }),
  z.object({ type: z.literal("new_session"), name: z.string() }),
  z.object({ type: z.literal("close_session"), session: z.string() }),
  z.object({ type: z.literal("new_tab"), session: z.string() }),
  z.object({ type: z.literal("select_tab"), session: z.string(), tabIndex: z.number() }),
  z.object({ type: z.literal("close_tab"), session: z.string(), tabIndex: z.number() }),
  z.object({ type: z.literal("select_pane"), paneId: z.string() }),
  z.object({ type: z.literal("split_pane"), paneId: z.string(), direction: z.enum(["right", "down"]) }),
  z.object({ type: z.literal("close_pane"), paneId: z.string() }),
  z.object({ type: z.literal("toggle_fullscreen"), paneId: z.string() }),
  z.object({ type: z.literal("capture_scrollback"), paneId: z.string(), lines: z.number().optional() }),
  z.object({ type: z.literal("send_compose"), text: z.string() }),
  z.object({ type: z.literal("rename_session"), session: z.string(), newName: z.string() }),
  z.object({ type: z.literal("rename_tab"), session: z.string(), tabIndex: z.number(), newName: z.string() }),
  z.object({ type: z.literal("set_follow_focus"), follow: z.boolean() })
]);

const parseClientMessage = (raw: string): ControlClientMessage | null => {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const result = controlClientMessageSchema.safeParse(parsed);
    if (!result.success) {
      return null;
    }
    return result.data as ControlClientMessage;
  } catch {
    return null;
  }
};

const sendJson = (socket: WebSocket, payload: ControlServerMessage): void => {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
};

const summarizeClientMessage = (message: ControlClientMessage): string => {
  if (message.type === "auth") {
    return JSON.stringify({
      type: message.type,
      tokenPresent: Boolean(message.token),
      passwordPresent: Boolean(message.password),
      clientIdPresent: Boolean(message.clientId)
    });
  }
  if (message.type === "send_compose") {
    return JSON.stringify({
      type: message.type,
      textLength: message.text.length
    });
  }
  return JSON.stringify({ type: message.type });
};

const summarizeState = (state: WorkspaceSnapshot): string => {
  const sessions = state.sessions.map((session) => {
    const activeTab =
      session.tabs.find((tab) => tab.active) ?? session.tabs[0];
    const activePane = activeTab?.panes.find((pane) => pane.active) ?? activeTab?.panes[0];
    return `${session.name}[attached=${session.attached}]` +
      `{tab=${activeTab ? `${activeTab.index}:${activeTab.name}` : "none"},` +
      `pane=${activePane ? `${activePane.id}:zoom=${activePane.zoomed}` : "none"},` +
      `tabs=${session.tabs.length}}`;
  });
  return `capturedAt=${state.capturedAt}; sessions=${sessions.join(" | ")}`;
};

const REMUX_SESSION_PREFIX = "remux-client-";

const isManagedMobileSession = (name: string): boolean => name.startsWith(REMUX_SESSION_PREFIX);

const buildMobileSessionName = (clientId: string): string => `${REMUX_SESSION_PREFIX}${clientId}`;

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const createRemuxServer = (
  config: RuntimeConfig,
  deps: ServerDependencies
): RunningServer => {
  const logger = deps.logger ?? console;
  const verboseDebug = process.env.REMUX_VERBOSE_DEBUG === "1";
  const verboseLog = (...args: unknown[]): void => {
    if (verboseDebug) {
      logger.log(...args);
    }
  };
  const authService = deps.authService ?? new AuthService({ password: config.password, token: config.token });
  const viewStore = new ClientViewStore();

  const app = express();
  app.use(express.json());

  const readAuthHeaders = (req: express.Request): { token?: string; password?: string } => {
    const authHeader = req.headers.authorization;
    return {
      token: authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined,
      password: req.headers["x-password"] as string | undefined
    };
  };

  const requireApiAuth: RequestHandler = (req, res, next) => {
    const authResult = authService.verify(readAuthHeaders(req));
    if (!authResult.ok) {
      res.status(401).json({ ok: false, error: "unauthorized" });
      return;
    }
    next();
  };

  const UPLOAD_MAX_BYTES = 50 * 1024 * 1024; // 50 MB

  const require = createRequire(import.meta.url);
  const pkgVersion: string = (require("../../package.json") as { version: string }).version;

  app.get("/api/config", (_req, res) => {
    res.json({
      version: pkgVersion,
      passwordRequired: authService.requiresPassword(),
      scrollbackLines: config.scrollbackLines,
      pollIntervalMs: config.pollIntervalMs,
      uploadMaxSize: UPLOAD_MAX_BYTES,
      backendKind: deps.backend.kind
    });
  });

  app.post("/api/switch-backend", async (req, res) => {
    const authResult = authService.verify(readAuthHeaders(req));
    if (!authResult.ok) {
      res.status(401).json({ ok: false, error: "unauthorized" });
      return;
    }

    const body = req.body as { backend?: string };
    const newKind = body?.backend;
    if (newKind !== "tmux" && newKind !== "zellij" && newKind !== "conpty") {
      res.status(400).json({ ok: false, error: "invalid backend, must be tmux|zellij|conpty" });
      return;
    }

    if (newKind === deps.backend.kind) {
      res.json({ ok: true, backend: deps.backend.kind });
      return;
    }

    if (!deps.onSwitchBackend) {
      res.status(501).json({ ok: false, error: "backend switching not supported" });
      return;
    }

    const newDeps = deps.onSwitchBackend(newKind);
    if (!newDeps) {
      res.status(400).json({ ok: false, error: `backend '${newKind}' is not available` });
      return;
    }

    logger.log(`switching backend: ${deps.backend.kind} → ${newKind}`);

    // Disconnect all clients — close control sockets so they trigger full reconnect
    monitor?.stop();
    await Promise.all(Array.from(controlClients).map((ctx) => shutdownControlContext(ctx)));
    for (const ctx of controlClients) {
      if (ctx.socket.readyState === ctx.socket.OPEN) {
        ctx.socket.close(4000, "backend switching");
      }
    }
    controlClients.clear();

    // Swap the backend
    deps.backend = newDeps.backend;
    deps.ptyFactory = newDeps.ptyFactory;

    // Restart state monitor
    monitor = new TmuxStateMonitor(
      deps.backend,
      config.pollIntervalMs,
      broadcastState,
      (error) => logger.error(error)
    );
    try {
      await monitor.start();
    } catch (error) {
      logger.error("monitor restart failed after backend switch", error);
    }

    logger.log(`backend switched to ${deps.backend.kind}`);
    res.json({ ok: true, backend: deps.backend.kind });
  });

  const sanitizeFilename = (raw: string): string => {
    // Strip path separators, null bytes, and parent directory traversal
    let name = raw.replace(/[\\/\0]/g, "").replace(/\.\./g, "");
    name = name.trim();
    if (!name) {
      name = "upload";
    }
    return name;
  };

  app.post(
    "/api/upload",
    express.raw({ limit: UPLOAD_MAX_BYTES, type: "application/octet-stream" }),
    async (req, res) => {
      // Auth check
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
      const uploadDir = paneCwd || process.cwd();

      try {
        // Verify upload directory exists
        const dirStat = await fs.promises.stat(uploadDir);
        if (!dirStat.isDirectory()) {
          res.status(400).json({ ok: false, error: "upload directory is not a directory" });
          return;
        }
      } catch {
        // Fall back to cwd if the pane CWD doesn't exist
        // (this can happen if the pane's CWD was removed)
      }

      const resolvedDir = await fs.promises.stat(uploadDir).then(
        (stat) => (stat.isDirectory() ? uploadDir : process.cwd()),
        () => process.cwd()
      );

      const body = req.body as Buffer;

      // Atomic write with wx flag to avoid overwrites and race conditions.
      // If the file exists, retry with a timestamped name.
      let finalName = filename;
      let finalPath = path.join(resolvedDir, finalName);
      try {
        await fs.promises.writeFile(finalPath, body, { flag: "wx" });
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") {
          finalName = `upload-${Date.now()}-${filename}`;
          finalPath = path.join(resolvedDir, finalName);
          try {
            await fs.promises.writeFile(finalPath, body);
          } catch (retryErr) {
            logger.error("file upload write error (retry)", retryErr);
            res.status(500).json({ ok: false, error: "failed to write file" });
            return;
          }
        } else {
          logger.error("file upload write error", err);
          res.status(500).json({ ok: false, error: "failed to write file" });
          return;
        }
      }
      logger.log("file uploaded", finalPath, `bytes=${body.length}`);
      res.json({ ok: true, path: finalPath, filename: finalName });
    }
  );

  // Extension routes: push notifications + state API.
  if (deps.extensions) {
    app.use(requireApiAuth, deps.extensions.notificationRoutes);

    app.get("/api/state/:session", requireApiAuth, (req, res) => {
      const snapshot = deps.extensions!.getSnapshot(getSingleParam(req.params.session));
      if (snapshot) {
        res.json(snapshot);
      } else {
        res.status(404).json({ error: "session not found or no state tracked" });
      }
    });

    app.get("/api/scrollback/:session", requireApiAuth, (req, res) => {
      const sessionName = getSingleParam(req.params.session);
      const from = parseInt(req.query.from as string) || 0;
      const count = parseInt(req.query.count as string) || 100;
      const lines = deps.extensions!.getScrollback(sessionName, from, count);
      res.json({ from, count: lines.length, lines });
    });

    app.get("/api/gastown/:session", requireApiAuth, (req, res) => {
      const info = deps.extensions!.getGastownInfo(getSingleParam(req.params.session));
      res.json(info);
    });

    app.get("/api/stats/bandwidth", requireApiAuth, (_req, res) => {
      res.json(deps.extensions!.getBandwidthStats());
    });

    // File browser API: list and read files in the working directory.
    app.get("/api/files", requireApiAuth, (_req, res) => {
      try {
        const cwd = process.cwd();
        const entries = fs.readdirSync(cwd, { withFileTypes: true })
          .filter((e) => !e.name.startsWith("."))
          .map((e) => ({
            name: e.name,
            type: e.isDirectory() ? "directory" : "file",
          }));
        res.json({ path: cwd, entries });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.get("/api/files/*filePath", requireApiAuth, (req, res) => {
      const rawPath = Array.isArray(req.params.filePath)
        ? req.params.filePath.join("/")
        : String(req.params.filePath ?? "");
      const filePath = path.resolve(process.cwd(), rawPath);
      // Security: ensure the resolved path is within cwd.
      if (!filePath.startsWith(process.cwd())) {
        res.status(403).json({ error: "path traversal not allowed" });
        return;
      }
      try {
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
          const entries = fs.readdirSync(filePath, { withFileTypes: true })
            .filter((e) => !e.name.startsWith("."))
            .map((e) => ({
              name: e.name,
              type: e.isDirectory() ? "directory" : "file",
            }));
          res.json({ path: filePath, entries });
        } else {
          // Limit file reads to 1MB.
          if (stat.size > 1_048_576) {
            res.status(413).json({ error: "file too large (>1MB)" });
            return;
          }
          const content = fs.readFileSync(filePath, "utf8");
          res.json({ path: filePath, content, size: stat.size });
        }
      } catch (err) {
        res.status(404).json({ error: `not found: ${rawPath}` });
      }
    });
  }

  app.use(express.static(config.frontendDir));
  app.get(frontendFallbackRoute, (req, res) => {
    if (isWebSocketPath(req.path)) {
      res.status(404).end();
      return;
    }

    res.sendFile(path.join(config.frontendDir, "index.html"), (error) => {
      if (error) {
        res.status(500).send("Frontend not built. Run npm run build:frontend");
      }
    });
  });

  const server = http.createServer(app);
  const controlWss = new WebSocketServer({ noServer: true, perMessageDeflate: true });
  const terminalWss = new WebSocketServer({ noServer: true, perMessageDeflate: true });
  const controlClients = new Set<ControlContext>();
  const terminalClients = new Set<DataContext>();

  let monitor: TmuxStateMonitor | undefined;
  let started = false;
  let stopPromise: Promise<void> | null = null;
  let latestSnapshot: WorkspaceSnapshot | undefined;
  const isNonGroupedBackend = (): boolean => !deps.backend.createGroupedSession;

  const waitForWorkspace = async (
    predicate: (snapshot: WorkspaceSnapshot) => boolean,
    options?: { timeoutMs?: number; intervalMs?: number }
  ): Promise<WorkspaceSnapshot> => {
    const timeoutMs = options?.timeoutMs ?? Math.max(config.pollIntervalMs * 4, 1_500);
    const intervalMs = options?.intervalMs ?? 100;
    const deadline = Date.now() + timeoutMs;
    let lastSnapshot = latestSnapshot ?? await buildSnapshot(deps.backend);
    if (predicate(lastSnapshot)) {
      return lastSnapshot;
    }
    while (Date.now() < deadline) {
      await sleep(intervalMs);
      lastSnapshot = await buildSnapshot(deps.backend);
      if (predicate(lastSnapshot)) {
        return lastSnapshot;
      }
    }
    return lastSnapshot;
  };

  const buildSingleSessionSnapshot = async (sessionName: string): Promise<WorkspaceSnapshot> => {
    const tabs = await deps.backend.listTabs(sessionName);
    const tabsWithPanes = await Promise.all(
      tabs.map(async (tab) => ({
        ...tab,
        panes: await deps.backend.listPanes(sessionName, tab.index)
      }))
    );
    const session: SessionState = {
      name: sessionName,
      attached: false,
      tabCount: tabsWithPanes.length,
      tabs: tabsWithPanes
    };
    return {
      capturedAt: new Date().toISOString(),
      sessions: [session]
    };
  };

  const waitForSessionSnapshot = async (
    sessionName: string,
    options?: { timeoutMs?: number; intervalMs?: number }
  ): Promise<WorkspaceSnapshot> => {
    const timeoutMs = options?.timeoutMs ?? Math.max(config.pollIntervalMs * 4, 1_500);
    const intervalMs = options?.intervalMs ?? 100;
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;

    while (Date.now() < deadline) {
      try {
        const snapshot = await buildSingleSessionSnapshot(sessionName);
        const session = snapshot.sessions[0];
        if (session && session.tabs.length > 0) {
          return snapshot;
        }
      } catch (error) {
        lastError = error;
      }
      await sleep(intervalMs);
    }

    if (lastError) {
      throw lastError;
    }
    return buildSingleSessionSnapshot(sessionName);
  };

  const broadcastSnapshotNow = (snapshot: WorkspaceSnapshot): void => {
    latestSnapshot = snapshot;
    broadcastState(snapshot);
  };

  const buildClientState = (
    baseSessions: WorkspaceSnapshot,
    fullState: WorkspaceSnapshot,
    client: ControlContext
  ): { workspace: WorkspaceSnapshot; clientView: ClientView } => {
    const view = viewStore.getView(client.clientId);
    if (!view) {
      const defaultView: ClientView = {
        sessionName: "",
        tabIndex: 0,
        paneId: "terminal_0",
        followBackendFocus: false,
      };
      return { workspace: baseSessions, clientView: defaultView };
    }

    // For tmux grouped sessions, find the mobile session to get per-client zoomed state
    const mobileSession = deps.backend.createGroupedSession
      ? fullState.sessions.find((s) => s.name === buildMobileSessionName(client.clientId))
      : undefined;

    // Overlay view onto workspace: mark the viewed tab/pane as active
    const sessions = baseSessions.sessions.map((session) => {
      if (session.name !== view.sessionName) return session;
      return {
        ...session,
        tabs: session.tabs.map((tab) => {
          const mobileTab = mobileSession?.tabs.find((mt) => mt.index === tab.index);
          return {
            ...tab,
            active: tab.index === view.tabIndex,
            panes: tab.panes.map((pane) => {
              const mobilePane = mobileTab?.panes.find((mp) => mp.id === pane.id);
              return {
                ...pane,
                active: pane.id === view.paneId,
                zoomed: mobilePane?.zoomed ?? pane.zoomed
              };
            })
          };
        })
      };
    });

    return {
      workspace: { ...baseSessions, sessions },
      clientView: view,
    };
  };

  const primeViewPaneContext = async (
    view: ClientView | undefined,
    paneId: string
  ): Promise<void> => {
    if (!view || !isNonGroupedBackend() || view.paneId !== paneId) {
      return;
    }
    await deps.backend.listPanes(view.sessionName, view.tabIndex);
  };

  const broadcastState = (state: WorkspaceSnapshot): void => {
    const baseSessions: WorkspaceSnapshot = {
      ...state,
      sessions: state.sessions.filter(
        (session) => !isManagedMobileSession(session.name)
      )
    };
    latestSnapshot = baseSessions;

    // Snapshot prev views before reconcile to detect changes
    const prevViews = new Map<string, { session: string; paneId: string }>();
    if (!deps.backend.createGroupedSession) {
      for (const client of controlClients) {
        if (!client.authed || !client.runtime) continue;
        const v = viewStore.getView(client.clientId);
        if (v) prevViews.set(client.clientId, { session: v.sessionName, paneId: v.paneId });
      }
    }

    // For tmux: sync ClientViewStore from the grouped mobile session's
    // real active tab/pane (user may switch via tmux keybinds directly)
    if (deps.backend.createGroupedSession) {
      for (const client of controlClients) {
        if (!client.authed) continue;
        const view = viewStore.getView(client.clientId);
        if (!view) continue;
        const mobileSession = state.sessions.find(
          (s) => s.name === buildMobileSessionName(client.clientId)
        );
        if (!mobileSession) continue;
        const activeTab = mobileSession.tabs.find((t) => t.active);
        const activePane = activeTab?.panes.find((p) => p.active);
        if (activeTab && activeTab.index !== view.tabIndex) {
          viewStore.selectTab(client.clientId, activeTab.index, baseSessions);
        }
        if (activePane && activePane.id !== view.paneId) {
          viewStore.selectPane(client.clientId, activePane.id);
        }
      }
    }

    // Reconcile all client views
    viewStore.reconcile(baseSessions);

    // Reattach runtime if view changed (non-tmux backends only)
    for (const [clientId, prev] of prevViews) {
      const newView = viewStore.getView(clientId);
      if (!newView || (newView.paneId === prev.paneId && newView.sessionName === prev.session)) continue;
      const ctx = getControlContext(clientId);
      if (ctx?.runtime) {
        ctx.runtime.attachToSession(`${newView.sessionName}:${newView.paneId}`);
      }
    }

    verboseLog(
      "broadcast workspace_state",
      `authedControlClients=${[...controlClients].filter((client) => client.authed).length}`,
      summarizeState(baseSessions)
    );
    for (const client of controlClients) {
      if (client.authed) {
        const { workspace, clientView } = buildClientState(baseSessions, state, client);
        sendJson(client.socket, { type: "workspace_state", workspace, clientView });
      }
    }
  };

  const getControlContext = (clientId: string): ControlContext | undefined =>
    Array.from(controlClients).find((candidate) => candidate.clientId === clientId);

  const resetControlAttachment = async (context: ControlContext): Promise<void> => {
    await context.runtime?.shutdown();
    context.runtime = undefined;

    if (deps.backend.createGroupedSession) {
      const mobileSession = buildMobileSessionName(context.clientId);
      try {
        await deps.backend.killSession(mobileSession);
      } catch (error) {
        logger.error("failed to cleanup mobile session", mobileSession, error);
      }
    }

    viewStore.removeClient(context.clientId);
  };

  const getOrCreateRuntime = (context: ControlContext): TerminalRuntime => {
    if (context.runtime) {
      return context.runtime;
    }

    const runtime = new TerminalRuntime(deps.ptyFactory);
    runtime.on("data", (chunk) => {
      verboseLog("runtime data chunk", context.clientId, `bytes=${Buffer.byteLength(chunk, "utf8")}`);
      // Feed into extensions (state tracker + notifications).
      deps.extensions?.onTerminalData(context.baseSession ?? context.clientId, chunk);
      for (const terminalClient of context.terminalClients) {
        if (terminalClient.authed && terminalClient.socket.readyState === terminalClient.socket.OPEN) {
          terminalClient.socket.send(chunk);
        }
      }
    });
    runtime.on("attach", (session) => {
      verboseLog("runtime attached session", context.clientId, session);
    });
    runtime.on("exit", (code) => {
      logger.log(`PTY exited with code ${code} (${context.clientId})`);
      deps.extensions?.onSessionExit(context.baseSession ?? context.clientId, code);
      sendJson(context.socket, { type: "info", message: "terminal client exited" });
    });
    context.runtime = runtime;
    // Apply any pending resize received before runtime existed
    if (context.pendingResize) {
      runtime.resize(context.pendingResize.cols, context.pendingResize.rows);
    }
    return runtime;
  };

  const attachRuntimeToView = (context: ControlContext): void => {
    const view = viewStore.getView(context.clientId);
    if (!view) return;
    const runtime = getOrCreateRuntime(context);
    // For zellij/conpty: PTY expects "session:paneId" format
    // For tmux with grouped sessions: PTY expects the mobile session name
    if (deps.backend.createGroupedSession) {
      // tmux path: runtime attaches to the mobile (grouped) session
      const mobileSession = buildMobileSessionName(context.clientId);
      runtime.attachToSession(mobileSession);
    } else {
      // zellij/conpty path: runtime attaches to "session:paneId"
      runtime.attachToSession(`${view.sessionName}:${view.paneId}`);
    }
  };

  const attachControlToBaseSession = async (
    context: ControlContext,
    baseSession: string,
    snapshotForInit?: WorkspaceSnapshot
  ): Promise<void> => {
    const runtime = getOrCreateRuntime(context);

    if (deps.backend.createGroupedSession) {
      // tmux path: create grouped session for per-client view isolation
      const mobileSession = buildMobileSessionName(context.clientId);
      const sessions = await deps.backend.listSessions();
      const hasMobileSession = sessions.some((session) => session.name === mobileSession);
      const oldView = viewStore.getView(context.clientId);
      const needsRecreate = hasMobileSession && oldView && oldView.sessionName !== baseSession;

      if (needsRecreate) {
        await runtime.shutdown();
        await deps.backend.killSession(mobileSession);
      }
      if (!hasMobileSession || needsRecreate) {
        await deps.backend.createGroupedSession(mobileSession, baseSession);
      }

      // Build a snapshot to init the view
      const snapshot = await buildSnapshot(deps.backend);
      const filteredSnapshot: WorkspaceSnapshot = {
        ...snapshot,
        sessions: snapshot.sessions.filter((s) => !isManagedMobileSession(s.name))
      };
      viewStore.initView(context.clientId, baseSession, filteredSnapshot);

      runtime.attachToSession(mobileSession);
    } else {
      // zellij/conpty path: no grouped sessions, use ClientViewStore
      const oldView = viewStore.getView(context.clientId);
      if (oldView && oldView.sessionName !== baseSession) {
        await runtime.shutdown();
      }

      // Build only the target session snapshot here so new-session attach does
      // not wait on a full multi-session zellij workspace scan before sending
      // the authoritative "attached" event back to the client.
      const snapshot = snapshotForInit ?? await waitForSessionSnapshot(baseSession);
      const view = viewStore.initView(context.clientId, baseSession, snapshot);

      // PTY expects "session:paneId" format
      runtime.attachToSession(`${baseSession}:${view.paneId}`);

      // Detect if a tmux launcher is running inside the zellij pane and warn the user
      if (deps.backend.kind === "zellij") {
        const sessionState = snapshot.sessions.find((s) => s.name === baseSession);
        const activeTab = sessionState?.tabs.find((t) => t.index === view.tabIndex);
        const activePane = activeTab?.panes.find((p) => p.id === view.paneId);
        if (activePane?.currentCommand && /\btmux\b/.test(activePane.currentCommand)) {
          sendJson(context.socket, {
            type: "info",
            message: "Detected tmux running inside zellij pane. "
              + "Add [ -n \"$REMUX\" ] && exit to your tmux launcher script "
              + "to prevent it from starting inside remux."
          });
        }
      }
    }

    context.baseSession = baseSession;
    context.attachedSession = deps.backend.createGroupedSession
      ? buildMobileSessionName(context.clientId)
      : undefined;
    deps.extensions?.onSessionCreated(baseSession);
    sendJson(context.socket, { type: "attached", session: baseSession });
  };

  const ensureAttachedSession = async (
    context: ControlContext,
    forceSession?: string
  ): Promise<void> => {
    const sessions = latestSnapshot
      ? latestSnapshot.sessions
        .filter((session) => !isManagedMobileSession(session.name))
        .map((session) => ({
          name: session.name,
          attached: session.attached,
          tabCount: session.tabCount
        }))
      : (await deps.backend.listSessions()).filter(
        (session) => !isManagedMobileSession(session.name)
      );

    if (forceSession && sessions.some((s) => s.name === forceSession)) {
      logger.log("attach session (forced)", forceSession);
      await attachControlToBaseSession(context, forceSession);
      return;
    }
    logger.log(
      "sessions discovered",
      sessions.map((session) => `${session.name}:${session.attached ? "attached" : "detached"}`).join(",")
    );
    if (sessions.length === 0) {
      await deps.backend.createSession(config.defaultSession);
      logger.log("created default session", config.defaultSession);
      await attachControlToBaseSession(context, config.defaultSession);
      return;
    }

    if (sessions.length === 1) {
      logger.log("attach only session", sessions[0].name);
      await attachControlToBaseSession(context, sessions[0].name);
      return;
    }

    logger.log("show session picker", sessions.length);
    sendJson(context.socket, { type: "session_picker", sessions });
  };

  const runControlMutation = async (
    message: ControlClientMessage,
    context: ControlContext
  ): Promise<void> => {
    const view = viewStore.getView(context.clientId);
    switch (message.type) {
      case "select_session":
        await attachControlToBaseSession(context, message.session);
        return;
      case "new_session":
        await deps.backend.createSession(message.name);
        if (isNonGroupedBackend()) {
          const sessionSnapshot = await waitForSessionSnapshot(message.name);
          await attachControlToBaseSession(context, message.name, sessionSnapshot);
          return;
        }
        await attachControlToBaseSession(context, message.name);
        return;
      case "close_session": {
        const liveSessions = (await deps.backend.listSessions()).filter(
          (session) => !isManagedMobileSession(session.name)
        );
        if (liveSessions.length <= 1) {
          sendJson(context.socket, {
            type: "info",
            message: "cannot kill the last session"
          });
          return;
        }

        const affectedClients = Array.from(controlClients).filter((client) => {
          if (!client.authed) {
            return false;
          }
          return viewStore.getView(client.clientId)?.sessionName === message.session;
        });

        for (const client of affectedClients) {
          await resetControlAttachment(client);
        }

        await deps.backend.killSession(message.session);

        for (const client of affectedClients) {
          await ensureAttachedSession(client);
        }
        return;
      }
      case "new_tab": {
        const sessionForNew = view?.sessionName;
        if (!sessionForNew) {
          throw new Error("no attached session");
        }
        await deps.backend.newTab(sessionForNew);
        // New tab becomes active — update view to the new tab
        if (isNonGroupedBackend()) {
          const snapshot = await waitForWorkspace((candidate) => {
            const session = candidate.sessions.find((s) => s.name === sessionForNew);
            const activeTab = session?.tabs.find((t) => t.active) ?? session?.tabs.at(-1);
            return Boolean(activeTab && activeTab.panes.length > 0);
          });
          const session = snapshot.sessions.find((s) => s.name === sessionForNew);
          const activeTab = session?.tabs.find((t) => t.active) ?? session?.tabs.at(-1);
          if (activeTab) {
            viewStore.selectTab(context.clientId, activeTab.index, snapshot);
            const updatedView = viewStore.getView(context.clientId);
            if (updatedView) {
              const runtime = getOrCreateRuntime(context);
              runtime.attachToSession(`${updatedView.sessionName}:${updatedView.paneId}`);
            }
          }
          broadcastSnapshotNow(snapshot);
        }
        return;
      }
      case "select_tab": {
        if (!view) throw new Error("no attached session");
        // Update view store
        const snapshot = latestSnapshot ?? await buildSnapshot(deps.backend);
        viewStore.selectTab(context.clientId, message.tabIndex, snapshot);
        if (isNonGroupedBackend()) {
          await deps.backend.selectTab(view.sessionName, message.tabIndex);
        }
        // Switch terminal stream
        if (deps.backend.createGroupedSession) {
          // tmux: select window on the mobile session
          const mobileSession = buildMobileSessionName(context.clientId);
          await deps.backend.selectTab(mobileSession, message.tabIndex);
        } else {
          // zellij/conpty: re-attach PTY to new pane
          const updatedView = viewStore.getView(context.clientId);
          if (updatedView) {
            const runtime = getOrCreateRuntime(context);
            runtime.attachToSession(`${updatedView.sessionName}:${updatedView.paneId}`);
          }
        }
        return;
      }
      case "close_tab": {
        const baseForKill = view?.sessionName;
        if (!baseForKill) {
          throw new Error("no attached session");
        }
        const tabs = await deps.backend.listTabs(baseForKill);
        if (tabs.length <= 1) {
          sendJson(context.socket, {
            type: "info",
            message: "cannot kill the last window"
          });
          return;
        }
        await deps.backend.closeTab(baseForKill, message.tabIndex);
        return;
      }
      case "select_pane": {
        if (!view) throw new Error("no attached session");
        await primeViewPaneContext(view, message.paneId);
        viewStore.selectPane(context.clientId, message.paneId);
        if (isNonGroupedBackend() && deps.backend.capabilities.supportsPaneFocusById) {
          await deps.backend.focusPane(message.paneId);
        }
        if (deps.backend.createGroupedSession) {
          // tmux: select the pane directly
          await deps.backend.focusPane(message.paneId);
        } else {
          // zellij/conpty: re-attach PTY
          const runtime = getOrCreateRuntime(context);
          runtime.attachToSession(`${view.sessionName}:${message.paneId}`);
        }
        return;
      }
      case "split_pane":
        await primeViewPaneContext(view, message.paneId);
        await deps.backend.splitPane(message.paneId, message.direction);
        return;
      case "close_pane": {
        await primeViewPaneContext(view, message.paneId);
        // Guard: prevent killing the last pane of the last tab (would destroy session)
        const baseForKillPane = view?.sessionName;
        if (baseForKillPane) {
          const allTabs = await deps.backend.listTabs(baseForKillPane);
          if (allTabs.length <= 1) {
            const tabForPane = allTabs[0];
            if (tabForPane) {
              const panes = await deps.backend.listPanes(baseForKillPane, tabForPane.index);
              if (panes.length <= 1) {
                sendJson(context.socket, {
                  type: "info",
                  message: "cannot kill the last pane"
                });
                return;
              }
            }
          }
        }
        await deps.backend.closePane(message.paneId);
        return;
      }
      case "toggle_fullscreen":
        await primeViewPaneContext(view, message.paneId);
        await deps.backend.toggleFullscreen(message.paneId);
        return;
      case "capture_scrollback": {
        await primeViewPaneContext(view, message.paneId);
        const lines = message.lines ?? config.scrollbackLines;
        const result = await deps.backend.capturePane(message.paneId, { lines });
        sendJson(context.socket, {
          type: "scrollback",
          paneId: message.paneId,
          lines,
          text: result.text,
          paneWidth: result.paneWidth,
          isApproximate: result.isApproximate
        });
        return;
      }
      case "send_compose":
        context.runtime?.write(`${message.text}\r`);
        return;
      case "rename_session": {
        await deps.backend.renameSession(message.session, message.newName);
        // Update all client views
        viewStore.renameSession(message.session, message.newName);
        let renamedSnapshot: WorkspaceSnapshot | undefined;
        if (isNonGroupedBackend()) {
          renamedSnapshot = await waitForWorkspace((snapshot) =>
            snapshot.sessions.some((session) => session.name === message.newName)
          );
        }
        // Reattach runtimes for zellij/conpty
        if (isNonGroupedBackend()) {
          for (const client of controlClients) {
            const clientView = viewStore.getView(client.clientId);
            if (client.authed && clientView && clientView.sessionName === message.newName && client.runtime) {
              client.runtime.attachToSession(`${message.newName}:${clientView.paneId}`);
            }
          }
          if (renamedSnapshot) {
            broadcastSnapshotNow(renamedSnapshot);
          }
        }
        for (const client of controlClients) {
          const clientView = viewStore.getView(client.clientId);
          if (client.authed && clientView && clientView.sessionName === message.newName) {
            sendJson(client.socket, { type: "attached", session: message.newName });
          }
        }
        return;
      }
      case "rename_tab": {
        const baseForRename = view?.sessionName;
        if (!baseForRename) {
          throw new Error("no attached session");
        }
        await deps.backend.renameTab(baseForRename, message.tabIndex, message.newName);
        return;
      }
      case "set_follow_focus":
        viewStore.setFollowFocus(context.clientId, message.follow);
        return;
      case "auth":
        return;
      default: {
        const _: never = message;
        return _;
      }
    }
  };

  const shutdownControlContext = async (context: ControlContext): Promise<void> => {
    for (const terminalClient of context.terminalClients) {
      if (terminalClient.socket.readyState === terminalClient.socket.OPEN) {
        terminalClient.socket.close();
      }
    }
    context.terminalClients.clear();
    await resetControlAttachment(context);
  };

  controlWss.on("connection", (socket) => {
    const context: ControlContext = {
      socket,
      authed: false,
      clientId: randomToken(12),
      messageQueue: Promise.resolve(),
      terminalClients: new Set<DataContext>()
    };
    controlClients.add(context);
    logger.log("control ws connected", context.clientId);

    socket.on("message", async (rawData) => {
      const raw = rawData.toString("utf8");

      // Handle ping/pong for RTT measurement (bypass zod validation).
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (parsed.type === "ping" && typeof parsed.timestamp === "number") {
          if (socket.readyState === socket.OPEN) {
            socket.send(JSON.stringify({ type: "pong", timestamp: parsed.timestamp }));
          }
          return;
        }
      } catch { /* not JSON or not a ping — continue to normal parsing */ }

      const message = parseClientMessage(raw);
      if (!message) {
        sendJson(socket, { type: "error", message: "invalid message format" });
        return;
      }
      context.messageQueue = context.messageQueue.then(async () => {
        logger.log("control ws message", context.clientId, message.type);
        verboseLog("control ws payload", context.clientId, summarizeClientMessage(message));

        try {
          if (!context.authed) {
            if (message.type !== "auth") {
              sendJson(socket, { type: "auth_error", reason: "auth required" });
              return;
            }

            const authResult = authService.verify({
              token: message.token,
              password: message.password
            });
            if (!authResult.ok) {
              logger.log("control ws auth failed", context.clientId, authResult.reason ?? "unknown");
              sendJson(socket, {
                type: "auth_error",
                reason: authResult.reason ?? "unauthorized"
              });
              return;
            }

            context.authed = true;
            logger.log("control ws auth ok", context.clientId);
            sendJson(socket, {
              type: "auth_ok",
              clientId: context.clientId,
              requiresPassword: authService.requiresPassword(),
              capabilities: deps.backend.capabilities,
              backendKind: deps.backend.kind
            });
            try {
              await ensureAttachedSession(context, message.session);
            } catch (error) {
              logger.error("initial attach failed", error);
              sendJson(socket, {
                type: "error",
                message: error instanceof Error ? error.message : String(error)
              });
            }
            await monitor?.forcePublish();
            return;
          }

          try {
            verboseLog("control mutation start", context.clientId, message.type);
            await runControlMutation(message, context);
            verboseLog("control mutation done", context.clientId, message.type);
          } finally {
            verboseLog("force publish start", context.clientId, message.type);
            await monitor?.forcePublish();
            verboseLog("force publish done", context.clientId, message.type);
          }
        } catch (error) {
          logger.error("control ws error", context.clientId, error);
          sendJson(socket, {
            type: "error",
            message: error instanceof Error ? error.message : String(error)
          });
        }
      }).catch((error) => {
        logger.error("control ws error", context.clientId, error);
        sendJson(socket, {
          type: "error",
          message: error instanceof Error ? error.message : String(error)
        });
      });
    });

    socket.on("close", () => {
      controlClients.delete(context);
      void shutdownControlContext(context);
      logger.log("control ws closed", context.clientId);
    });
  });

  terminalWss.on("connection", (socket) => {
    const ctx: DataContext = { socket, authed: false };
    terminalClients.add(ctx);
    logger.log("terminal ws connected");

    socket.on("message", (rawData, isBinary) => {
      if (!ctx.authed) {
        if (isBinary) {
          socket.close(4001, "auth required");
          return;
        }

        const authMessage = parseClientMessage(rawData.toString("utf8"));
        if (!authMessage || authMessage.type !== "auth") {
          socket.close(4001, "auth required");
          return;
        }
        const clientId = authMessage.clientId;
        if (!clientId) {
          socket.close(4001, "unauthorized");
          return;
        }

        const authResult = authService.verify({
          token: authMessage.token,
          password: authMessage.password
        });
        if (!authResult.ok) {
          logger.log("terminal ws auth failed", authResult.reason ?? "unknown");
          socket.close(4001, "unauthorized");
          return;
        }
        const controlContext = getControlContext(clientId);
        if (!controlContext || !controlContext.authed) {
          socket.close(4001, "unauthorized");
          return;
        }

        ctx.authed = true;
        ctx.controlClientId = clientId;
        ctx.controlContext = controlContext;
        controlContext.terminalClients.add(ctx);
        logger.log("terminal ws auth ok");

        // Replay cached viewport to this late-joining client (fixes blank
        // terminal when subscribe initial event fired before WS connected)
        controlContext.runtime?.replayLast((data) => {
          if (socket.readyState === socket.OPEN) {
            socket.send(data);
          }
        });
        return;
      }

      if (isBinary) {
        let buf: Buffer;
        if (Buffer.isBuffer(rawData)) {
          buf = rawData;
        } else if (rawData instanceof ArrayBuffer) {
          buf = Buffer.from(rawData);
        } else if (Array.isArray(rawData)) {
          buf = Buffer.concat(rawData);
        } else {
          buf = Buffer.from(rawData);
        }
        verboseLog("terminal ws binary input", `bytes=${buf.length}`);
        ctx.controlContext?.runtime?.write(buf.toString("utf8"));
        return;
      }

      const text = rawData.toString("utf8");
      if (text.startsWith("{")) {
        try {
          const payload = JSON.parse(text) as unknown;
          if (
            isObject(payload) &&
            payload.type === "resize" &&
            typeof payload.cols === "number" &&
            typeof payload.rows === "number"
          ) {
            if (ctx.controlContext?.runtime) {
              ctx.controlContext.runtime.resize(payload.cols, payload.rows);
            }
            // Store resize so it can be applied when runtime is created later
            if (ctx.controlContext) {
              ctx.controlContext.pendingResize = { cols: payload.cols, rows: payload.rows };
            }
            verboseLog("terminal ws resize", `${payload.cols}x${payload.rows}`);
            return;
          }
        } catch {
          // fall through and treat as terminal input
        }
      }

      ctx.controlContext?.runtime?.write(text);
      verboseLog("terminal ws text input", `bytes=${Buffer.byteLength(text, "utf8")}`);
    });

    socket.on("close", () => {
      terminalClients.delete(ctx);
      ctx.controlContext?.terminalClients.delete(ctx);
      logger.log("terminal ws closed");
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
      logger.log("server start requested", `${config.host}:${config.port}`);
      monitor = new TmuxStateMonitor(
        deps.backend,
        config.pollIntervalMs,
        broadcastState,
        (error) => logger.error(error)
      );
      await monitor.start();
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          server.off("error", onError);
          reject(error);
        };

        server.once("error", onError);
        server.listen(config.port, config.host, () => {
          server.off("error", onError);
          started = true;
          logger.log("server listening", `${config.host}:${(server.address() as { port: number }).port}`);
          resolve();
        });
      });

      // Broadcast bandwidth stats every 5 seconds to all authed control clients.
      if (deps.extensions) {
        setInterval(() => {
          const stats = deps.extensions!.getBandwidthStats();
          const msg = JSON.stringify({ type: "bandwidth_stats", stats });
          for (const client of controlClients) {
            if (client.authed && client.socket.readyState === client.socket.OPEN) {
              client.socket.send(msg);
            }
          }
        }, 5000);
      }
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
        logger.log("server shutdown begin");
        monitor?.stop();
        await Promise.all(Array.from(controlClients).map((context) => shutdownControlContext(context)));
        controlWss.close();
        terminalWss.close();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        });
        logger.log("server shutdown complete");
      })();

      try {
        await stopPromise;
      } finally {
        started = false;
        stopPromise = null;
      }
    }
  };
};

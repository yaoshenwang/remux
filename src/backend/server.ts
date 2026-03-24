import { createRequire } from "node:module";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import type { RuntimeConfig } from "./config.js";
import type {
  ControlClientMessage,
  ControlServerMessage,
  SessionState,
  SessionSummary,
  StateSnapshot
} from "../shared/protocol.js";
import { randomToken } from "./util/random.js";
import { AuthService } from "./auth/auth-service.js";
import type { SessionGateway } from "./tmux/types.js";
import { TerminalRuntime } from "./pty/terminal-runtime.js";
import type { PtyFactory } from "./pty/pty-adapter.js";
import { TmuxStateMonitor } from "./state/state-monitor.js";

interface VirtualView {
  activeWindowIndex: number;
  activePaneId: string;
}

interface ControlContext {
  socket: WebSocket;
  authed: boolean;
  clientId: string;
  runtime?: TerminalRuntime;
  attachedSession?: string;
  baseSession?: string;
  terminalClients: Set<DataContext>;
  /** Pending resize from terminal WS received before runtime was created */
  pendingResize?: { cols: number; rows: number };
  /** For Zellij: server-side view state (replaces tmux session groups) */
  virtualView?: VirtualView;
}

interface DataContext {
  socket: WebSocket;
  authed: boolean;
  controlClientId?: string;
  controlContext?: ControlContext;
}

export interface ServerDependencies {
  tmux: SessionGateway;
  ptyFactory: PtyFactory;
  backendKind?: "tmux" | "zellij" | "conpty";
  authService?: AuthService;
  logger?: Pick<Console, "log" | "error">;
  /** Callback to switch the backend at runtime. Returns the new deps. */
  onSwitchBackend?: (kind: "tmux" | "zellij" | "conpty") => ServerDependencies | null;
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

const controlClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("auth"), token: z.string().optional(), password: z.string().optional(), clientId: z.string().optional(), session: z.string().optional() }),
  z.object({ type: z.literal("select_session"), session: z.string() }),
  z.object({ type: z.literal("new_session"), name: z.string() }),
  z.object({ type: z.literal("new_window"), session: z.string() }),
  z.object({ type: z.literal("select_window"), session: z.string(), windowIndex: z.number(), stickyZoom: z.boolean().optional() }),
  z.object({ type: z.literal("kill_window"), session: z.string(), windowIndex: z.number() }),
  z.object({ type: z.literal("select_pane"), paneId: z.string(), stickyZoom: z.boolean().optional() }),
  z.object({ type: z.literal("split_pane"), paneId: z.string(), orientation: z.enum(["h", "v"]) }),
  z.object({ type: z.literal("kill_pane"), paneId: z.string() }),
  z.object({ type: z.literal("zoom_pane"), paneId: z.string() }),
  z.object({ type: z.literal("capture_scrollback"), paneId: z.string(), lines: z.number().optional() }),
  z.object({ type: z.literal("send_compose"), text: z.string() }),
  z.object({ type: z.literal("rename_session"), session: z.string(), newName: z.string() }),
  z.object({ type: z.literal("rename_window"), session: z.string(), windowIndex: z.number(), newName: z.string() })
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

const summarizeState = (state: StateSnapshot): string => {
  const sessions = state.sessions.map((session) => {
    const activeWindow =
      session.windowStates.find((windowState) => windowState.active) ?? session.windowStates[0];
    const activePane = activeWindow?.panes.find((pane) => pane.active) ?? activeWindow?.panes[0];
    return `${session.name}[attached=${session.attached}]` +
      `{window=${activeWindow ? `${activeWindow.index}:${activeWindow.name}` : "none"},` +
      `pane=${activePane ? `${activePane.id}:zoom=${activePane.zoomed}` : "none"},` +
      `windows=${session.windowStates.length}}`;
  });
  return `capturedAt=${state.capturedAt}; sessions=${sessions.join(" | ")}`;
};

const REMUX_SESSION_PREFIX = "remux-client-";

const isManagedMobileSession = (name: string): boolean => name.startsWith(REMUX_SESSION_PREFIX);

const buildMobileSessionName = (clientId: string): string => `${REMUX_SESSION_PREFIX}${clientId}`;

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
  let isZellij = deps.backendKind === "zellij";
  let currentBackendKind = deps.backendKind ?? "tmux";
  const authService = deps.authService ?? new AuthService({ password: config.password, token: config.token });

  const app = express();
  app.use(express.json());

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
      backendKind: currentBackendKind
    });
  });

  app.post("/api/switch-backend", async (req, res) => {
    const authHeader = req.headers.authorization;
    const switchToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
    const authResult = authService.verify({ token: switchToken });
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

    if (newKind === currentBackendKind) {
      res.json({ ok: true, backend: currentBackendKind });
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

    logger.log(`switching backend: ${currentBackendKind} → ${newKind}`);

    // Disconnect all clients (they will auto-reconnect)
    monitor?.stop();
    await Promise.all(Array.from(controlClients).map((ctx) => shutdownControlContext(ctx)));

    // Swap the backend
    deps.tmux = newDeps.tmux;
    deps.ptyFactory = newDeps.ptyFactory;
    deps.backendKind = newDeps.backendKind;
    currentBackendKind = newDeps.backendKind ?? newKind;
    isZellij = currentBackendKind === "zellij";

    // Restart state monitor
    monitor = new TmuxStateMonitor(
      deps.tmux,
      config.pollIntervalMs,
      broadcastState,
      (error) => logger.error(error)
    );
    try {
      await monitor.start();
    } catch (error) {
      logger.error("monitor restart failed after backend switch", error);
    }

    logger.log(`backend switched to ${currentBackendKind}`);
    res.json({ ok: true, backend: currentBackendKind });
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
      const authHeader = req.headers.authorization;
      const uploadToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
      const uploadPassword = req.headers["x-password"] as string | undefined;
      const authResult = authService.verify({ token: uploadToken, password: uploadPassword });
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

  const buildClientState = (
    baseSessions: SessionState[],
    fullState: StateSnapshot,
    client: ControlContext
  ): StateSnapshot => {
    if (!client.baseSession) {
      return { ...fullState, sessions: baseSessions };
    }

    // Zellij path: use server-side virtual view instead of grouped session
    if (isZellij && client.virtualView) {
      const sessions = baseSessions.map((session) => {
        if (session.name !== client.baseSession) return session;
        return {
          ...session,
          windowStates: session.windowStates.map((window) => ({
            ...window,
            active: window.index === client.virtualView!.activeWindowIndex,
            panes: window.panes.map((pane) => ({
              ...pane,
              active: pane.id === client.virtualView!.activePaneId
            }))
          }))
        };
      });
      return { ...fullState, sessions };
    }

    // tmux path: use grouped session's active flags
    if (!client.attachedSession) {
      return { ...fullState, sessions: baseSessions };
    }

    const mobileSession = fullState.sessions.find(
      (session) => session.name === client.attachedSession
    );
    if (!mobileSession) {
      return { ...fullState, sessions: baseSessions };
    }

    const sessions = baseSessions.map((session) => {
      if (session.name !== client.baseSession) {
        return session;
      }
      return {
        ...session,
        windowStates: session.windowStates.map((window) => {
          const mobileWindow = mobileSession.windowStates.find(
            (mw) => mw.index === window.index
          );
          if (!mobileWindow) {
            return { ...window, active: false };
          }
          return {
            ...window,
            active: mobileWindow.active,
            panes: window.panes.map((pane) => {
              const mobilePane = mobileWindow.panes.find((mp) => mp.id === pane.id);
              return {
                ...pane,
                active: mobilePane?.active ?? pane.active,
                zoomed: mobilePane?.zoomed ?? pane.zoomed
              };
            })
          };
        })
      };
    });

    return { ...fullState, sessions };
  };

  const broadcastState = (state: StateSnapshot): void => {
    const baseSessions = state.sessions.filter(
      (session) => !isManagedMobileSession(session.name)
    );
    verboseLog(
      "broadcast tmux_state",
      `authedControlClients=${[...controlClients].filter((client) => client.authed).length}`,
      summarizeState({ ...state, sessions: baseSessions })
    );
    for (const client of controlClients) {
      if (client.authed) {
        const clientState = buildClientState(baseSessions, state, client);
        sendJson(client.socket, { type: "tmux_state", state: clientState });
      }
    }
  };

  const getControlContext = (clientId: string): ControlContext | undefined =>
    Array.from(controlClients).find((candidate) => candidate.clientId === clientId);

  const getOrCreateRuntime = (context: ControlContext): TerminalRuntime => {
    if (context.runtime) {
      return context.runtime;
    }

    const runtime = new TerminalRuntime(deps.ptyFactory);
    runtime.on("data", (chunk) => {
      verboseLog("runtime data chunk", context.clientId, `bytes=${Buffer.byteLength(chunk, "utf8")}`);
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
      logger.log(`tmux PTY exited with code ${code} (${context.clientId})`);
      sendJson(context.socket, { type: "info", message: "tmux client exited" });
    });
    context.runtime = runtime;
    // Apply any pending resize received before runtime existed
    if (context.pendingResize) {
      runtime.resize(context.pendingResize.cols, context.pendingResize.rows);
    }
    return runtime;
  };

  const attachControlToBaseSession = async (
    context: ControlContext,
    baseSession: string
  ): Promise<void> => {
    const runtime = getOrCreateRuntime(context);

    if (isZellij) {
      // Zellij path: no grouped sessions, use virtual view tracking.
      // Attach PTY to the first pane of the first tab in this session.
      if (context.baseSession && context.baseSession !== baseSession) {
        await runtime.shutdown();
      }
      context.baseSession = baseSession;
      context.attachedSession = baseSession;

      // Initialize virtual view with the active tab/pane (not necessarily the first)
      const windows = await deps.tmux.listWindows(baseSession);
      const activeWindow = windows.find((w) => w.active) ?? windows[0];
      let activePaneId = "terminal_0";
      if (activeWindow) {
        const panes = await deps.tmux.listPanes(baseSession, activeWindow.index);
        const activePane = panes.find((p) => p.active) ?? panes[0];
        if (activePane) activePaneId = activePane.id;
        context.virtualView = {
          activeWindowIndex: activeWindow.index,
          activePaneId
        };
      } else {
        context.virtualView = { activeWindowIndex: 0, activePaneId };
      }

      // ZellijPtyFactory expects "session:paneId" format
      runtime.attachToSession(`${baseSession}:${activePaneId}`);
      sendJson(context.socket, { type: "attached", session: baseSession });
      return;
    }

    // tmux path: create grouped session for per-client view isolation
    const mobileSession = buildMobileSessionName(context.clientId);
    const sessions = await deps.tmux.listSessions();
    const hasMobileSession = sessions.some((session) => session.name === mobileSession);
    const needsRecreate = hasMobileSession && context.baseSession && context.baseSession !== baseSession;

    if (needsRecreate) {
      await runtime.shutdown();
      await deps.tmux.killSession(mobileSession);
    }
    if (!hasMobileSession || needsRecreate) {
      await deps.tmux.createGroupedSession(mobileSession, baseSession);
    }

    context.baseSession = baseSession;
    context.attachedSession = mobileSession;
    runtime.attachToSession(mobileSession);
    sendJson(context.socket, { type: "attached", session: baseSession });
  };

  const ensureAttachedSession = async (
    context: ControlContext,
    forceSession?: string
  ): Promise<void> => {
    const sessions = (await deps.tmux.listSessions()).filter(
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
      await deps.tmux.createSession(config.defaultSession);
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
    const attachedSession = context.attachedSession;
    switch (message.type) {
      case "select_session":
        await attachControlToBaseSession(context, message.session);
        return;
      case "new_session":
        await deps.tmux.createSession(message.name);
        await attachControlToBaseSession(context, message.name);
        return;
      case "new_window": {
        const sessionForNew = isZellij ? context.baseSession : attachedSession;
        if (!sessionForNew) {
          throw new Error("no attached session");
        }
        await deps.tmux.newWindow(sessionForNew);
        return;
      }
      case "select_window": {
        if (isZellij && context.virtualView && context.baseSession) {
          // Zellij: update virtual view, switch pane I/O subscription
          context.virtualView.activeWindowIndex = message.windowIndex;
          const panes = await deps.tmux.listPanes(context.baseSession, message.windowIndex);
          const activePane = panes.find((pane) => pane.active) ?? panes[0];
          if (activePane) {
            context.virtualView.activePaneId = activePane.id;
            const runtime = getOrCreateRuntime(context);
            runtime.attachToSession(`${context.baseSession}:${activePane.id}`);
          }
          return;
        }
        if (!attachedSession) {
          throw new Error("no attached session");
        }
        await deps.tmux.selectWindow(attachedSession, message.windowIndex);
        if (message.stickyZoom === true) {
          const panes = await deps.tmux.listPanes(attachedSession, message.windowIndex);
          const activePane = panes.find((pane) => pane.active) ?? panes[0];
          if (activePane && !(await deps.tmux.isPaneZoomed(activePane.id))) {
            await deps.tmux.zoomPane(activePane.id);
          }
        }
        return;
      }
      case "kill_window": {
        // Structural operations target the base session to avoid destroying
        // the grouped mobile session when the last window is killed.
        const baseForKill = context.baseSession;
        if (!baseForKill) {
          throw new Error("no attached session");
        }
        const windows = await deps.tmux.listWindows(baseForKill);
        if (windows.length <= 1) {
          sendJson(context.socket, {
            type: "info",
            message: "cannot kill the last window"
          });
          return;
        }
        await deps.tmux.killWindow(baseForKill, message.windowIndex);
        return;
      }
      case "select_pane":
        if (isZellij && context.virtualView && context.baseSession) {
          context.virtualView.activePaneId = message.paneId;
          const runtime = getOrCreateRuntime(context);
          runtime.attachToSession(`${context.baseSession}:${message.paneId}`);
          return;
        }
        await deps.tmux.selectPane(message.paneId);
        if (message.stickyZoom === true && !(await deps.tmux.isPaneZoomed(message.paneId))) {
          await deps.tmux.zoomPane(message.paneId);
        }
        return;
      case "split_pane":
        await deps.tmux.splitWindow(message.paneId, message.orientation);
        return;
      case "kill_pane": {
        // Guard: prevent killing the last pane of the last window (would destroy session group)
        const baseForKillPane = context.baseSession;
        if (baseForKillPane) {
          const allWindows = await deps.tmux.listWindows(baseForKillPane);
          if (allWindows.length <= 1) {
            // Find which window this pane belongs to and check its pane count
            const windowForPane = allWindows[0];
            if (windowForPane) {
              const panes = await deps.tmux.listPanes(baseForKillPane, windowForPane.index);
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
        await deps.tmux.killPane(message.paneId);
        return;
      }
      case "zoom_pane":
        await deps.tmux.zoomPane(message.paneId);
        return;
      case "capture_scrollback": {
        const lines = message.lines ?? config.scrollbackLines;
        const { text, paneWidth } = await deps.tmux.capturePane(message.paneId, lines);
        sendJson(context.socket, {
          type: "scrollback",
          paneId: message.paneId,
          lines,
          text,
          paneWidth
        });
        return;
      }
      case "send_compose":
        context.runtime?.write(`${message.text}\r`);
        return;
      case "rename_session": {
        await deps.tmux.renameSession(message.session, message.newName);
        // Update all clients attached to the renamed session
        for (const client of controlClients) {
          if (client.authed && client.baseSession === message.session) {
            client.baseSession = message.newName;
            // For Zellij, attachedSession IS the base session — update it
            // and reattach the runtime to use the new session name.
            if (isZellij) {
              client.attachedSession = message.newName;
              if (client.virtualView && client.runtime) {
                client.runtime.attachToSession(
                  `${message.newName}:${client.virtualView.activePaneId}`
                );
              }
            }
            sendJson(client.socket, { type: "attached", session: message.newName });
          }
        }
        return;
      }
      case "rename_window": {
        const baseForRename = context.baseSession;
        if (!baseForRename) {
          throw new Error("no attached session");
        }
        await deps.tmux.renameWindow(baseForRename, message.windowIndex, message.newName);
        return;
      }
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
    await context.runtime?.shutdown();
    context.runtime = undefined;
    if (context.attachedSession) {
      // For Zellij, attachedSession IS the base session — don't kill it
      if (!isZellij) {
        try {
          await deps.tmux.killSession(context.attachedSession);
        } catch (error) {
          logger.error("failed to cleanup mobile session", context.attachedSession, error);
        }
      }
      context.attachedSession = undefined;
    }
    context.virtualView = undefined;
  };

  controlWss.on("connection", (socket) => {
    const context: ControlContext = {
      socket,
      authed: false,
      clientId: randomToken(12),
      terminalClients: new Set<DataContext>()
    };
    controlClients.add(context);
    logger.log("control ws connected", context.clientId);

    socket.on("message", async (rawData) => {
      const message = parseClientMessage(rawData.toString("utf8"));
      if (!message) {
        sendJson(socket, { type: "error", message: "invalid message format" });
        return;
      }
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
            requiresPassword: authService.requiresPassword()
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
        deps.tmux,
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

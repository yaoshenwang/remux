import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import type { RequestHandler } from "express";
import type { RuntimeConfig } from "./config.js";
import type {
  ControlClientMessage,
  ControlServerMessage,
  ClientView,
  SessionState,
  TabState,
  WorkspaceSnapshot
} from "../shared/protocol.js";
import { randomToken } from "./util/random.js";
import { AuthService } from "./auth/auth-service.js";
import type { MultiplexerBackend } from "./multiplexer/types.js";
import { buildSnapshot } from "./multiplexer/types.js";
import type { PtyFactory } from "./pty/pty-adapter.js";
import { TmuxStateMonitor } from "./state/state-monitor.js";
import { ClientViewStore } from "./view/client-view-store.js";
import { TabHistoryStore } from "./history/tab-history-store.js";
import { readRuntimeMetadata } from "./util/runtime-metadata.js";
import { registerControlSocketHandlers } from "./server/control-socket.js";
import { registerHttpRoutes } from "./server/http-routes.js";
import {
  buildServerCapabilities,
  type DeviceCapabilityDependencies,
  type NotificationTransport,
} from "./server/client-capabilities.js";
import type { AdapterRegistry } from "./adapters/registry.js";
import type { SemanticEventTransport } from "./server/semantic-event-transport.js";
import {
  buildMobileSessionName,
  createSessionAttachService,
  findCreatedTab,
  isManagedMobileSession,
  sameSessionTopology,
} from "./server/session-attach-service.js";
import {
  isObject,
  sendJson,
  summarizeState,
} from "./server/socket-protocol.js";
import { registerTerminalSocketHandlers } from "./server/terminal-socket.js";
import type { ControlContext, DataContext } from "./server/types.js";

export interface ServerDependencies {
  backend: MultiplexerBackend;
  ptyFactory: PtyFactory;
  authService?: AuthService;
  logger?: Pick<Console, "log" | "error">;
  /** Callback to switch the backend at runtime. Returns the new deps. */
  onSwitchBackend?: (kind: "tmux" | "zellij" | "conpty") => ServerDependencies | null;
  extensions?: import("./extensions.js").Extensions;
  notificationTransport?: NotificationTransport;
  device?: DeviceCapabilityDependencies;
  adapterRegistry?: AdapterRegistry;
  semanticTransport?: SemanticEventTransport;
}

export interface RunningServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  server: http.Server;
  config: RuntimeConfig;
}

export const frontendFallbackRoute = "/{*path}";

export const isWebSocketPath = (requestPath: string): boolean => requestPath.startsWith("/ws/");

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

  // GitHub token storage — persists across origins/sessions.
  const tokenFile = path.join(os.homedir(), ".remux", "github-token");

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
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.delete("/api/auth/github-token", requireApiAuth, (_req, res) => {
    try {
      fs.rmSync(tokenFile, { force: true });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // GitHub OAuth Device Flow proxy (GitHub doesn't support CORS).
  app.post("/api/auth/github/device-code", requireApiAuth, async (req, res) => {
    try {
      const { client_id, scope } = req.body as { client_id: string; scope: string };
      const resp = await fetch("https://github.com/login/device/code", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ client_id, scope }),
      });
      const data = await resp.json();
      res.json(data);
    } catch (err) {
      res.status(502).json({ error: String(err) });
    }
  });

  app.post("/api/auth/github/access-token", requireApiAuth, async (req, res) => {
    try {
      const { client_id, device_code, grant_type } = req.body as {
        client_id: string; device_code: string; grant_type: string;
      };
      const resp = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ client_id, device_code, grant_type }),
      });
      const data = await resp.json();
      res.json(data);
    } catch (err) {
      res.status(502).json({ error: String(err) });
    }
  });

  const UPLOAD_MAX_BYTES = 50 * 1024 * 1024; // 50 MB

  const resolveServerCapabilities = () => buildServerCapabilities({
    backendCapabilities: deps.backend.capabilities,
    supportsUpload: true,
    extensions: deps.extensions,
    notificationTransport: deps.notificationTransport,
    device: deps.device,
    adapterRegistry: deps.adapterRegistry,
    semanticTransport: deps.semanticTransport,
  });

  const runtimeMetadata = readRuntimeMetadata();

  const server = http.createServer(app);
  const controlWss = new WebSocketServer({ noServer: true, perMessageDeflate: true });
  const terminalWss = new WebSocketServer({ noServer: true, perMessageDeflate: true });
  const controlClients = new Set<ControlContext>();
  const terminalClients = new Set<DataContext>();

  let monitor: TmuxStateMonitor | undefined;
  let started = false;
  let stopPromise: Promise<void> | null = null;
  const latestSnapshotRef = { current: undefined as WorkspaceSnapshot | undefined };
  const tabHistoryStore = new TabHistoryStore();
  const knownSessionTopologies = new Map<string, SessionState>();
  const isNonGroupedBackend = (): boolean => !deps.backend.createGroupedSession;
  const getControlContext = (clientId: string): ControlContext | undefined =>
    Array.from(controlClients).find((candidate) => candidate.clientId === clientId);

  const sessionAttachService = createSessionAttachService({
    config,
    controlClients,
    deps,
    getControlContext,
    knownSessionTopologies,
    latestSnapshotRef,
    logger,
    tabHistoryStore,
    viewStore,
  });

  const broadcastSnapshotNow = (snapshot: WorkspaceSnapshot): void => {
    latestSnapshotRef.current = snapshot;
    broadcastState(snapshot);
  };

  const broadcastState = (state: WorkspaceSnapshot): void => {
    const previousSnapshot = latestSnapshotRef.current;
    const baseSessions: WorkspaceSnapshot = {
      ...state,
      sessions: state.sessions.filter(
        (session) => !isManagedMobileSession(session.name)
      )
    };
    latestSnapshotRef.current = baseSessions;
    tabHistoryStore.recordSnapshot(baseSessions);

    // Snapshot prev views before reconcile to detect changes
    const prevViews = new Map<string, { session: string; paneId: string }>();
    if (!deps.backend.createGroupedSession) {
      for (const client of controlClients) {
        if (!client.authed || !client.runtime) continue;
        const v = viewStore.getView(client.clientId);
        if (v) prevViews.set(client.clientId, { session: v.sessionName, paneId: v.paneId });
      }

      const previousNames = new Set(previousSnapshot?.sessions.map((session) => session.name) ?? []);
      const currentNames = new Set(baseSessions.sessions.map((session) => session.name));
      const addedSessions = baseSessions.sessions.filter((session) => !previousNames.has(session.name));
      const missingViewedSessions = Array.from(new Set(
        Array.from(controlClients)
          .filter((client) => client.authed)
          .map((client) => viewStore.getView(client.clientId)?.sessionName)
          .filter((sessionName): sessionName is string => (
            typeof sessionName === "string" && !currentNames.has(sessionName)
          ))
      ));

      if (addedSessions.length === 1 && missingViewedSessions.length === 1) {
        const missingSession = missingViewedSessions[0];
        const lastKnownSession = knownSessionTopologies.get(missingSession);
        if (lastKnownSession && sameSessionTopology(lastKnownSession, addedSessions[0])) {
          viewStore.renameSession(missingSession, addedSessions[0].name);
        }
      }
    }

    for (const session of baseSessions.sessions) {
      knownSessionTopologies.set(session.name, session);
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
        const { workspace, clientView } = sessionAttachService.buildClientState(baseSessions, state, client);
        sendJson(client.socket, { type: "workspace_state", workspace, clientView });
      }
    }
  };

  const runControlMutation = async (
    message: ControlClientMessage,
    context: ControlContext
  ): Promise<void> => {
    const view = viewStore.getView(context.clientId);
    switch (message.type) {
      case "select_session":
        await sessionAttachService.attachControlToBaseSession(context, message.session);
        return;
      case "new_session":
        await deps.backend.createSession(message.name, { cwd: await sessionAttachService.resolveViewCwd(view) });
        if (isNonGroupedBackend()) {
          const sessionSnapshot = await sessionAttachService.waitForSessionSnapshot(message.name);
          await sessionAttachService.attachControlToBaseSession(context, message.name, sessionSnapshot);
          return;
        }
        await sessionAttachService.attachControlToBaseSession(context, message.name);
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
          await sessionAttachService.resetControlAttachment(client);
        }

        await deps.backend.killSession(message.session);

        for (const client of affectedClients) {
          await sessionAttachService.ensureAttachedSession(client, undefined, { refreshSessions: true });
        }
        return;
      }
      case "new_tab": {
        const sessionForNew = view?.sessionName;
        if (!sessionForNew) {
          throw new Error("no attached session");
        }
        const previousSnapshot = latestSnapshotRef.current ?? await buildSnapshot(deps.backend);
        const previousSession = previousSnapshot.sessions.find((session) => session.name === sessionForNew);
        await deps.backend.newTab(sessionForNew, { cwd: await sessionAttachService.resolveViewCwd(view) });
        // New tab becomes active — update view to the new tab
        if (isNonGroupedBackend()) {
          let snapshot = await sessionAttachService.waitForWorkspace((candidate) => {
            const session = candidate.sessions.find((s) => s.name === sessionForNew);
            const createdTab = findCreatedTab(previousSession, session);
            return Boolean(createdTab && createdTab.panes.length > 0);
          });
          let session = snapshot.sessions.find((s) => s.name === sessionForNew);
          let createdTab = findCreatedTab(previousSession, session) ?? session?.tabs.at(-1);

          if (createdTab && !createdTab.active) {
            const createdTabIndex = createdTab.index;
            await deps.backend.selectTab(sessionForNew, createdTabIndex);
            snapshot = await sessionAttachService.waitForWorkspace((candidate) => {
              const candidateSession = candidate.sessions.find((entry) => entry.name === sessionForNew);
              const candidateTab = candidateSession?.tabs.find((tab) => tab.index === createdTabIndex);
              return Boolean(candidateTab?.active && candidateTab.panes.length > 0);
            });
            session = snapshot.sessions.find((entry) => entry.name === sessionForNew);
            createdTab = session?.tabs.find((tab) => tab.index === createdTabIndex) ?? createdTab;
          }

          if (createdTab) {
            viewStore.selectTab(context.clientId, createdTab.index, snapshot);
            const updatedView = viewStore.getView(context.clientId);
            if (updatedView) {
              const runtime = sessionAttachService.getOrCreateRuntime(context);
              runtime.attachToSession(`${updatedView.sessionName}:${updatedView.paneId}`);
            }
          }
          broadcastSnapshotNow(snapshot);
        } else {
          const snapshot = await sessionAttachService.waitForSessionSnapshot(sessionForNew);
          const session = snapshot.sessions[0];
          const activeTab = session?.tabs.find((tab) => tab.active) ?? session?.tabs.at(-1);
          if (activeTab) {
            viewStore.selectTab(context.clientId, activeTab.index, snapshot);
            await deps.backend.selectTab(buildMobileSessionName(context.clientId), activeTab.index);
          }
        }
        return;
      }
      case "select_tab": {
        if (!view) throw new Error("no attached session");
        // Update view store
        const snapshot = latestSnapshotRef.current ?? await buildSnapshot(deps.backend);
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
            const runtime = sessionAttachService.getOrCreateRuntime(context);
            runtime.attachToSession(`${updatedView.sessionName}:${updatedView.paneId}`);
          }
        }
        tabHistoryStore.recordEvent({
          sessionName: view.sessionName,
          tabIndex: message.tabIndex,
          tabName: snapshot.sessions.find((session) => session.name === view.sessionName)?.tabs.find((tab) => tab.index === message.tabIndex)?.name ?? `tab-${message.tabIndex}`,
          text: `Viewed tab ${message.tabIndex}`
        });
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
        await sessionAttachService.primeViewPaneContext(view, message.paneId);
        viewStore.selectPane(context.clientId, message.paneId);
        if (isNonGroupedBackend() && deps.backend.capabilities.supportsPaneFocusById) {
          await deps.backend.focusPane(message.paneId);
        }
        if (deps.backend.createGroupedSession) {
          // tmux: select the pane directly
          await deps.backend.focusPane(message.paneId);
        } else {
          // zellij/conpty: re-attach PTY
          const runtime = sessionAttachService.getOrCreateRuntime(context);
          runtime.attachToSession(`${view.sessionName}:${message.paneId}`);
        }
        tabHistoryStore.recordEvent({
          sessionName: view.sessionName,
          tabIndex: view.tabIndex,
          tabName: latestSnapshotRef.current?.sessions.find((session) => session.name === view.sessionName)?.tabs.find((tab) => tab.index === view.tabIndex)?.name ?? `tab-${view.tabIndex}`,
          text: `Focused pane ${message.paneId}`,
          paneId: message.paneId
        });
        return;
      }
      case "split_pane":
        await sessionAttachService.primeViewPaneContext(view, message.paneId);
        await deps.backend.splitPane(message.paneId, message.direction);
        return;
      case "close_pane": {
        await sessionAttachService.primeViewPaneContext(view, message.paneId);
        const snapshotForPane = latestSnapshotRef.current ?? await buildSnapshot(deps.backend);
        const paneLocation = snapshotForPane.sessions.flatMap((session) =>
          session.tabs.map((tab) => ({ session, tab }))
        ).flatMap(({ session, tab }) =>
          tab.panes
            .filter((pane) => pane.id === message.paneId)
            .map((pane) => ({ sessionName: session.name, tab, pane }))
        )[0];
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
        if (paneLocation) {
          const archived = await deps.backend.capturePane(message.paneId, { lines: config.scrollbackLines });
          tabHistoryStore.recordPaneCapture({
            sessionName: paneLocation.sessionName,
            tabIndex: paneLocation.tab.index,
            tabName: paneLocation.tab.name,
            paneId: paneLocation.pane.id,
            paneIndex: paneLocation.pane.index,
            command: paneLocation.pane.currentCommand,
            title: `Pane ${paneLocation.pane.index} · ${paneLocation.pane.currentCommand} · ${paneLocation.pane.id}`,
            text: archived.text,
            paneWidth: archived.paneWidth,
            isApproximate: archived.isApproximate,
            archived: true,
            lines: config.scrollbackLines
          });
        }
        await deps.backend.closePane(message.paneId);
        return;
      }
      case "toggle_fullscreen":
        await sessionAttachService.primeViewPaneContext(view, message.paneId);
        await deps.backend.toggleFullscreen(message.paneId);
        if (view) {
          tabHistoryStore.recordEvent({
            sessionName: view.sessionName,
            tabIndex: view.tabIndex,
            tabName: latestSnapshotRef.current?.sessions.find((session) => session.name === view.sessionName)?.tabs.find((tab) => tab.index === view.tabIndex)?.name ?? `tab-${view.tabIndex}`,
            text: `Toggled fullscreen for ${message.paneId}`,
            paneId: message.paneId
          });
        }
        return;
      case "capture_scrollback": {
        await sessionAttachService.primeViewPaneContext(view, message.paneId);
        const lines = message.lines ?? config.scrollbackLines;
        const result = await deps.backend.capturePane(message.paneId, { lines });
        const paneSnapshot = latestSnapshotRef.current ?? await buildSnapshot(deps.backend);
        const paneLocation = paneSnapshot.sessions.flatMap((session) =>
          session.tabs.map((tab) => ({ session, tab }))
        ).flatMap(({ session, tab }) =>
          tab.panes
            .filter((pane) => pane.id === message.paneId)
            .map((pane) => ({ sessionName: session.name, tab, pane }))
        )[0];
        if (paneLocation) {
          tabHistoryStore.recordPaneCapture({
            sessionName: paneLocation.sessionName,
            tabIndex: paneLocation.tab.index,
            tabName: paneLocation.tab.name,
            paneId: paneLocation.pane.id,
            paneIndex: paneLocation.pane.index,
            command: paneLocation.pane.currentCommand,
            title: `Pane ${paneLocation.pane.index} · ${paneLocation.pane.currentCommand} · ${paneLocation.pane.id}`,
            text: result.text,
            paneWidth: result.paneWidth,
            isApproximate: result.isApproximate,
            archived: false,
            lines
          });
        }
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
      case "capture_tab_history": {
        const sessionName = message.session ?? view?.sessionName;
        if (!sessionName) {
          throw new Error("no attached session");
        }
        const lines = message.lines ?? config.scrollbackLines;
        sendJson(context.socket, await sessionAttachService.buildTabHistoryPayload(sessionName, message.tabIndex, lines));
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
          renamedSnapshot = await sessionAttachService.waitForWorkspace((snapshot) =>
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
        if (latestSnapshotRef.current) {
          broadcastSnapshotNow(latestSnapshotRef.current);
        }
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
    await sessionAttachService.resetControlAttachment(context);
  };

  const handleSwitchBackend: RequestHandler = async (req, res) => {
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

    monitor?.stop();
    await Promise.all(Array.from(controlClients).map((ctx) => shutdownControlContext(ctx)));
    for (const ctx of controlClients) {
      if (ctx.socket.readyState === ctx.socket.OPEN) {
        ctx.socket.close(4000, "backend switching");
      }
    }
    controlClients.clear();

    deps.backend = newDeps.backend;
    deps.ptyFactory = newDeps.ptyFactory;

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
  };

  registerHttpRoutes({
    app,
    authService,
    config,
    deps,
    frontendFallbackRoute,
    handleSwitchBackend,
    isWebSocketPath,
    logger,
    readAuthHeaders,
    requireApiAuth,
    runtimeMetadata,
    uploadMaxBytes: UPLOAD_MAX_BYTES,
  });

  registerControlSocketHandlers({
    authService,
    controlClients,
    controlWss,
    logger,
    resolveServerCapabilities,
    runControlMutation,
    sessionAttachService,
    shutdownControlContext,
    verboseLog,
    getBackendCapabilities: () => deps.backend.capabilities,
    getBackendKind: () => deps.backend.kind,
    getMonitor: () => monitor,
  });

  registerTerminalSocketHandlers({
    authService,
    getControlContext,
    logger,
    terminalClients,
    terminalWss,
    verboseLog,
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

      // Initialize snapfeed telemetry — use openDb directly, skip createExpressRouter
      // (which uses require('express') that fails in ESM).
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
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          );
          const insertMany = feedbackDb.transaction((rows: typeof events) => {
            for (const e of rows) {
              insert.run(
                e.session_id, e.seq, e.ts, e.event_type,
                e.page ?? null, e.target ?? null,
                e.detail ? JSON.stringify(e.detail) : null,
                e.screenshot ?? null,
              );
            }
          });
          insertMany(events);
          res.json({ accepted: events.length });
        });

        logger.log("snapfeed telemetry enabled at /api/telemetry/events");
      } catch (err) { logger.error("snapfeed init failed:", String(err)); }

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

import type {
  ClientView,
  ControlServerMessage,
  SessionState,
  TabState,
  WorkspaceSnapshot,
} from "../../shared/protocol.js";
import type { WorkspaceRuntimeState } from "../../shared/contracts/workspace.js";
import type { RuntimeConfig } from "../config.js";
import type { ServerDependencies } from "../server.js";
import { buildSnapshot } from "../multiplexer/types.js";
import { TerminalRuntime } from "../pty/terminal-runtime.js";
import { TabHistoryStore } from "../history/tab-history-store.js";
import { ClientViewStore } from "../view/client-view-store.js";
import type { ControlContext } from "./types.js";
import { sendJson } from "./socket-protocol.js";

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const REMUX_SESSION_PREFIX = "remux-client-";

export const isManagedMobileSession = (name: string): boolean => name.startsWith(REMUX_SESSION_PREFIX);

export const buildMobileSessionName = (clientId: string): string => `${REMUX_SESSION_PREFIX}${clientId}`;

export const findCreatedTab = (
  previousSession: SessionState | undefined,
  nextSession: SessionState | undefined
): TabState | undefined => {
  if (!nextSession) {
    return undefined;
  }
  const previousTabIndexes = new Set(previousSession?.tabs.map((tab) => tab.index) ?? []);
  return nextSession.tabs.find((tab) => !previousTabIndexes.has(tab.index));
};

export const sameSessionTopology = (left: SessionState, right: SessionState): boolean => {
  const leftPaneIds = left.tabs
    .flatMap((tab) => tab.panes.map((pane) => pane.id))
    .sort();
  const rightPaneIds = right.tabs
    .flatMap((tab) => tab.panes.map((pane) => pane.id))
    .sort();

  if (leftPaneIds.length !== rightPaneIds.length) {
    return false;
  }

  return leftPaneIds.every((paneId, index) => paneId === rightPaneIds[index]);
};

export interface SessionAttachServiceOptions {
  config: RuntimeConfig;
  controlClients: Set<ControlContext>;
  deps: ServerDependencies;
  getControlContext: (clientId: string) => ControlContext | undefined;
  knownSessionTopologies: Map<string, SessionState>;
  latestSnapshotRef: { current: WorkspaceSnapshot | undefined };
  logger: Pick<Console, "log" | "error">;
  onRuntimeStateChange?: (
    context: ControlContext,
    state: WorkspaceRuntimeState | null
  ) => void | Promise<void>;
  onRuntimeWorkspaceChange?: (
    context: ControlContext,
    reason: "session_switch" | "session_renamed"
  ) => void | Promise<void>;
  tabHistoryStore: TabHistoryStore;
  viewStore: ClientViewStore;
}

export interface SessionAttachService {
  applyInitialViewHint: (context: ControlContext, hint: { tabIndex?: number; paneId?: string }) => Promise<void>;
  attachControlToBaseSession: (
    context: ControlContext,
    baseSession: string,
    snapshotForInit?: WorkspaceSnapshot
  ) => Promise<void>;
  buildClientState: (
    baseSessions: WorkspaceSnapshot,
    fullState: WorkspaceSnapshot,
    client: ControlContext
  ) => {
    workspace: WorkspaceSnapshot;
    clientView: ClientView;
    runtimeState: WorkspaceRuntimeState | null;
  };
  buildTabHistoryPayload: (
    sessionName: string,
    tabIndex: number,
    lines: number
  ) => Promise<Extract<ControlServerMessage, { type: "tab_history" }>>;
  ensureAttachedSession: (
    context: ControlContext,
    forceSession?: string,
    options?: { refreshSessions?: boolean }
  ) => Promise<void>;
  getOrCreateRuntime: (context: ControlContext) => TerminalRuntime;
  primeViewPaneContext: (view: ClientView | undefined, paneId: string) => Promise<void>;
  resetControlAttachment: (context: ControlContext) => Promise<void>;
  resolveViewCwd: (view: ClientView | undefined) => Promise<string | undefined>;
  waitForSessionSnapshot: (
    sessionName: string,
    options?: { timeoutMs?: number; intervalMs?: number }
  ) => Promise<WorkspaceSnapshot>;
  waitForWorkspace: (
    predicate: (snapshot: WorkspaceSnapshot) => boolean,
    options?: { timeoutMs?: number; intervalMs?: number }
  ) => Promise<WorkspaceSnapshot>;
}

export const createSessionAttachService = ({
  config,
  controlClients,
  deps,
  getControlContext,
  knownSessionTopologies,
  latestSnapshotRef,
  logger,
  onRuntimeStateChange,
  onRuntimeWorkspaceChange,
  tabHistoryStore,
  viewStore,
}: SessionAttachServiceOptions): SessionAttachService => {
  const isNonGroupedBackend = (): boolean => !deps.backend.createGroupedSession;

  const waitForWorkspace = async (
    predicate: (snapshot: WorkspaceSnapshot) => boolean,
    options?: { timeoutMs?: number; intervalMs?: number }
  ): Promise<WorkspaceSnapshot> => {
    const timeoutMs = options?.timeoutMs ?? Math.max(config.pollIntervalMs * 4, 1_500);
    const intervalMs = options?.intervalMs ?? 100;
    const deadline = Date.now() + timeoutMs;
    let lastSnapshot = latestSnapshotRef.current ?? await buildSnapshot(deps.backend);
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

  const findPaneLocation = (
    snapshot: WorkspaceSnapshot,
    paneId: string
  ): { sessionName: string; tab: SessionState["tabs"][number]; pane: SessionState["tabs"][number]["panes"][number] } | null => {
    for (const session of snapshot.sessions) {
      for (const tab of session.tabs) {
        const pane = tab.panes.find((entry) => entry.id === paneId);
        if (pane) {
          return { sessionName: session.name, tab, pane };
        }
      }
    }
    return null;
  };

  const findViewPane = (
    snapshot: WorkspaceSnapshot,
    view: ClientView
  ): SessionState["tabs"][number]["panes"][number] | null => {
    const session = snapshot.sessions.find((entry) => entry.name === view.sessionName);
    const tab = session?.tabs.find((entry) => entry.index === view.tabIndex);
    return tab?.panes.find((entry) => entry.id === view.paneId) ?? null;
  };

  const resolveViewCwd = async (view: ClientView | undefined): Promise<string | undefined> => {
    if (!view) {
      return undefined;
    }

    const sessionSnapshot = await buildSingleSessionSnapshot(view.sessionName);
    const pane = findViewPane(sessionSnapshot, view);
    if (pane?.currentPath) {
      return pane.currentPath;
    }

    const paneFromLatest = latestSnapshotRef.current ? findViewPane(latestSnapshotRef.current, view) : null;
    return paneFromLatest?.currentPath || undefined;
  };

  const getOrCreateRuntime = (context: ControlContext): TerminalRuntime => {
    if (context.runtime) {
      return context.runtime;
    }

    const runtime = new TerminalRuntime(deps.ptyFactory);
    runtime.on("data", (chunk) => {
      deps.extensions?.onTerminalData(context.baseSession ?? context.clientId, chunk);
      for (const terminalClient of context.terminalClients) {
        if (terminalClient.authed && terminalClient.socket.readyState === terminalClient.socket.OPEN) {
          terminalClient.socket.send(chunk);
        }
      }
    });
    runtime.on("attach", (session) => {
      logger.log("runtime attached session", context.clientId, session);
    });
    runtime.on("resize", (cols, rows) => {
      const trackedSession = context.baseSession ?? context.clientId;
      deps.extensions?.onSessionResize(trackedSession, cols, rows);
    });
    runtime.on("exit", (code) => {
      logger.log(`PTY exited with code ${code} (${context.clientId})`);
      deps.extensions?.onSessionExit(context.baseSession ?? context.clientId, code);
      sendJson(context.socket, { type: "info", message: "terminal client exited" });
    });
    runtime.on("runtimeState", (state) => {
      context.runtimeState = state;
      void Promise.resolve(onRuntimeStateChange?.(context, state)).catch((error) => {
        logger.error("runtime state callback failed", error);
      });
    });
    runtime.on("workspaceChange", (reason) => {
      void Promise.resolve(onRuntimeWorkspaceChange?.(context, reason)).catch((error) => {
        logger.error("workspace change callback failed", error);
      });
    });
    context.runtime = runtime;
    context.runtimeState = runtime.currentRuntimeState();
    if (context.pendingResize) {
      runtime.resize(context.pendingResize.cols, context.pendingResize.rows);
    }
    return runtime;
  };

  const buildClientState = (
    baseSessions: WorkspaceSnapshot,
    fullState: WorkspaceSnapshot,
    client: ControlContext
  ): { workspace: WorkspaceSnapshot; clientView: ClientView; runtimeState: WorkspaceRuntimeState | null } => {
    const runtimeState = client.runtimeState ?? client.runtime?.currentRuntimeState() ?? null;
    const view = viewStore.getView(client.clientId);
    if (!view) {
      const defaultView: ClientView = {
        sessionName: "",
        tabIndex: 0,
        paneId: "terminal_0",
        followBackendFocus: false,
      };
      return { workspace: baseSessions, clientView: defaultView, runtimeState };
    }

    if (deps.backend.kind === "zellij") {
      return {
        workspace: baseSessions,
        clientView: view,
        runtimeState,
      };
    }

    const mobileSession = deps.backend.createGroupedSession
      ? fullState.sessions.find((session) => session.name === buildMobileSessionName(client.clientId))
      : undefined;

    const sessions = baseSessions.sessions.map((session) => {
      if (session.name !== view.sessionName) {
        return session;
      }
      return {
        ...session,
        tabs: session.tabs.map((tab) => {
          const mobileTab = mobileSession?.tabs.find((entry) => entry.index === tab.index);
          return {
            ...tab,
            active: tab.index === view.tabIndex,
            panes: tab.panes.map((pane) => {
              const mobilePane = mobileTab?.panes.find((entry) => entry.id === pane.id);
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
      runtimeState,
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

  const resetControlAttachment = async (context: ControlContext): Promise<void> => {
    await context.runtime?.shutdown();
    context.runtime = undefined;
    context.runtimeState = null;
    context.baseSession = undefined;
    context.attachedSession = undefined;
    context.pendingResize = undefined;

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

  const attachControlToBaseSession = async (
    context: ControlContext,
    baseSession: string,
    snapshotForInit?: WorkspaceSnapshot
  ): Promise<void> => {
    const runtime = getOrCreateRuntime(context);
    const initialTrackerSize = context.pendingResize ?? { cols: 200, rows: 50 };
    context.baseSession = baseSession;
    deps.extensions?.onSessionCreated(baseSession, initialTrackerSize.cols, initialTrackerSize.rows);

    if (deps.backend.createGroupedSession) {
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

      const snapshot = await buildSnapshot(deps.backend);
      const filteredSnapshot: WorkspaceSnapshot = {
        ...snapshot,
        sessions: snapshot.sessions.filter((session) => !isManagedMobileSession(session.name))
      };
      viewStore.initView(context.clientId, baseSession, filteredSnapshot);
      runtime.attachToSession(mobileSession);
    } else {
      const oldView = viewStore.getView(context.clientId);
      if (oldView && oldView.sessionName !== baseSession) {
        await runtime.shutdown();
      }

      await deps.backend.reviveSession?.(baseSession);
      const snapshot = snapshotForInit ?? await waitForSessionSnapshot(baseSession);
      for (const session of snapshot.sessions) {
        knownSessionTopologies.set(session.name, session);
      }
      const view = viewStore.initView(context.clientId, baseSession, snapshot);
      runtime.attachToSession(`${baseSession}:${view.paneId}`);

      if (deps.backend.kind === "zellij") {
        const sessionState = snapshot.sessions.find((session) => session.name === baseSession);
        const activeTab = sessionState?.tabs.find((tab) => tab.index === view.tabIndex);
        const activePane = activeTab?.panes.find((pane) => pane.id === view.paneId);
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

    context.attachedSession = deps.backend.createGroupedSession
      ? buildMobileSessionName(context.clientId)
      : undefined;
    sendJson(context.socket, { type: "attached", session: baseSession });
  };

  const ensureAttachedSession = async (
    context: ControlContext,
    forceSession?: string,
    options?: { refreshSessions?: boolean }
  ): Promise<void> => {
    const sessions = options?.refreshSessions || !latestSnapshotRef.current
      ? (await deps.backend.listSessions()).filter(
          (session) => !isManagedMobileSession(session.name)
        )
      : latestSnapshotRef.current.sessions
          .filter((session) => !isManagedMobileSession(session.name))
          .map((session) => ({
            name: session.name,
            attached: session.attached,
            tabCount: session.tabCount,
            lifecycle: session.lifecycle
          }));

    if (forceSession && sessions.some((session) => session.name === forceSession)) {
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

    const liveSessions = sessions.filter((session) => session.lifecycle !== "exited");

    if (liveSessions.length === 1) {
      logger.log("attach only live session", liveSessions[0].name);
      await attachControlToBaseSession(context, liveSessions[0].name);
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

  const applyInitialViewHint = async (
    context: ControlContext,
    hint: { tabIndex?: number; paneId?: string }
  ): Promise<void> => {
    if (hint.tabIndex === undefined && !hint.paneId) {
      return;
    }

    const view = viewStore.getView(context.clientId);
    if (!view) {
      return;
    }

    const sessionSnapshot = await buildSingleSessionSnapshot(view.sessionName);
    const session = sessionSnapshot.sessions[0];
    if (!session) {
      return;
    }

    let targetTab = hint.tabIndex !== undefined
      ? session.tabs.find((entry) => entry.index === hint.tabIndex)
      : undefined;

    if (!targetTab && hint.paneId) {
      targetTab = session.tabs.find((entry) => entry.panes.some((pane) => pane.id === hint.paneId));
    }

    if (!targetTab) {
      return;
    }

    if (targetTab.index !== view.tabIndex) {
      viewStore.selectTab(context.clientId, targetTab.index, sessionSnapshot);
      if (deps.backend.createGroupedSession) {
        await deps.backend.selectTab(buildMobileSessionName(context.clientId), targetTab.index);
      } else {
        await deps.backend.selectTab(view.sessionName, targetTab.index);
      }
    }

    const targetPane = hint.paneId
      ? targetTab.panes.find((pane) => pane.id === hint.paneId)
      : undefined;
    if (targetPane) {
      viewStore.selectPane(context.clientId, targetPane.id);
      if (deps.backend.createGroupedSession || deps.backend.capabilities.supportsPaneFocusById) {
        await deps.backend.focusPane(targetPane.id);
      }
    }

    if (isNonGroupedBackend()) {
      const updatedView = viewStore.getView(context.clientId);
      if (updatedView) {
        const runtime = getOrCreateRuntime(context);
        runtime.attachToSession(`${updatedView.sessionName}:${updatedView.paneId}`);
      }
    }
  };

  const buildTabHistoryPayload = async (
    sessionName: string,
    tabIndex: number,
    lines: number
  ): Promise<Extract<ControlServerMessage, { type: "tab_history" }>> => {
    const sessionSnapshot = await buildSingleSessionSnapshot(sessionName);
    const session = sessionSnapshot.sessions[0];
    const tab = session?.tabs.find((entry) => entry.index === tabIndex);
    if (!tab) {
      throw new Error(`tab not found: ${sessionName}:${tabIndex}`);
    }

    const paneCaptures = await Promise.all(
      tab.panes.map(async (pane) => {
        const result = await deps.backend.capturePane(pane.id, { lines });
        const capture = {
          paneId: pane.id,
          paneIndex: pane.index,
          command: pane.currentCommand,
          title: `Pane ${pane.index} · ${pane.currentCommand} · ${pane.id}`,
          text: result.text,
          paneWidth: result.paneWidth,
          isApproximate: result.isApproximate,
          archived: false,
          lines,
          capturedAt: new Date().toISOString()
        };
        tabHistoryStore.recordPaneCapture({
          sessionName,
          tabIndex,
          tabName: tab.name,
          ...capture
        });
        return capture;
      })
    );

    return {
      type: "tab_history",
      ...tabHistoryStore.buildTabHistory({
        sessionName,
        tab,
        lines,
        paneCaptures
      })
    };
  };

  return {
    applyInitialViewHint,
    attachControlToBaseSession,
    buildClientState,
    buildTabHistoryPayload,
    ensureAttachedSession,
    getOrCreateRuntime,
    primeViewPaneContext,
    resetControlAttachment,
    resolveViewCwd,
    waitForSessionSnapshot,
    waitForWorkspace,
  };
};

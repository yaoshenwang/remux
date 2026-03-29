import { Suspense, lazy, startTransition, useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import { Toolbar, type ToolbarHandle } from "./components/Toolbar";
import { AppHeader } from "./components/AppHeader";
import { TerminalStage } from "./components/TerminalStage";
import { ComposeBar } from "./components/ComposeBar";
import { PinnedSnippetsBar, SnippetPicker, SnippetTemplatePanel } from "./components/SnippetPanels";
import { AiQuickActionsBar } from "./components/AiQuickActionsBar";
import { openRemuxFeedbackDialog } from "./feedback/trigger";
import { SessionSection } from "./components/sidebar/SessionSection";
import { AppearanceSection } from "./components/sidebar/AppearanceSection";
import { SnippetsSection } from "./components/sidebar/SnippetsSection";
import { inferAttachedSessionFromWorkspace } from "./ui-state";
import {
  assignSnippetSortOrders,
  extractSnippetVariables,
  fillSnippetTemplate,
  getPinnedSnippets,
  getSnippetStorageKey,
  groupSnippets,
  normalizeSnippets,
  type SnippetGroup,
  type SnippetRecord as Snippet
} from "./snippets";
import {
  getTabOrderKey,
  reorderSessionState,
  reorderSessionTabs,
} from "./workspace-order";
import { deriveTopStatus, formatBytes } from "./app-status";
import { deriveSnippetPickerState } from "./compose-picker";
import type { PendingSnippetExecution } from "./app-types";
import { useFileUpload } from "./hooks/useFileUpload";
import { useViewportLayout } from "./mobile-layout";
import { buildControlAuthHint } from "./launch-context";
import { useTerminalRuntime } from "./hooks/useTerminalRuntime";
import { useTerminalDiagnostics } from "./hooks/useTerminalDiagnostics";
import { useRemuxConnection } from "./hooks/useRemuxConnection";
import { useClientPreferences } from "./hooks/useClientPreferences";
import { useWorkspaceState } from "./hooks/useWorkspaceState";
import { detectAiToolContext, detectAiToolContextFromViewport } from "./ai-tool-profile";
import {
  buildInspectSnapshotFromServerHistory,
  type TabInspectSnapshot
} from "./inspect-state";
import {
  debugLog,
  debugMode,
  initialLaunchContext,
  token
} from "./remux-runtime";
import { attachWebSocketKeepAlive } from "./websocket-keepalive";
import { resolveReconnectDelay, shouldPauseReconnect } from "./reconnect-policy";
import type {
  ClientDiagnosticDetails,
  SessionState,
  TabState,
  WorkspaceRuntimeState,
} from "../shared/protocol";
import { AppShell } from "./screens/AppShell";
import { SessionPickerScreen } from "./screens/SessionPickerScreen";
import { WorkspaceScreen } from "./screens/WorkspaceScreen";
import { createTerminalInputBatcher } from "./terminal-input-batcher";

declare global {
  interface Window {
    __remuxDebugEvents?: Array<{
      at: string;
      event: string;
      payload?: unknown;
    }>;
    __remuxDebugState?: unknown;
  }
}

const LazyBandwidthStatsModal = lazy(() => import("./components/BandwidthStatsModal"));
const LazyPasswordOverlay = lazy(() => import("./components/PasswordOverlay"));
const LazyUploadToast = lazy(() => import("./components/UploadToast"));

const getTerminalChunkLength = (chunk: string | Uint8Array): number =>
  typeof chunk === "string" ? chunk.length : chunk.byteLength;

const terminalChunkHasBell = (chunk: string | Uint8Array): boolean =>
  typeof chunk === "string" ? chunk.includes("\x07") : chunk.includes(0x07);

export const App = () => {
  const terminalSocketRef = useRef<WebSocket | null>(null);
  const stopTerminalKeepAliveRef = useRef<(() => void) | null>(null);
  /** Deferred terminal auth credentials — stored on auth_ok, consumed on attached. */
  const pendingTerminalAuthRef = useRef<{ password: string; clientId: string } | null>(null);
  /** Persistent terminal auth credentials for reconnection (not cleared after use). */
  const terminalAuthRef = useRef<{ password: string; clientId: string } | null>(null);
  const terminalReconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const terminalReconnectAttemptRef = useRef(0);
  const launchContextRef = useRef(initialLaunchContext);
  const readTerminalGeometryRef = useRef<() => { cols: number; rows: number } | null>(() => null);
  const suppressHistoryGapRef = useRef((_: string) => {});
  const recordDiagnosticActionRef = useRef((_: string, __: string, ___?: string) => {});

  const attachedSessionRef = useRef("");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [composeText, setComposeText] = useState("");
  const [lastReportedTerminalGeometry, setLastReportedTerminalGeometry] = useState<{
    cols: number;
    rows: number;
    source: string;
  } | null>(null);

  // ── Preferences hook ──
  const prefs = useClientPreferences();
  const { theme, sidebarCollapsed, setSidebarCollapsed, stickyZoom,
    scrollFontSize, workspaceOrder, setWorkspaceOrder } = prefs;

  const [viewMode, setViewMode] = useState<"inspect" | "terminal">("terminal");
  const [terminalViewState, setTerminalViewState] = useState<"idle" | "connecting" | "restoring" | "live" | "stale">("idle");
  const [runtimeState, setRuntimeState] = useState<WorkspaceRuntimeState | null>(null);
  const viewModeRef = useRef(viewMode);
  useEffect(() => { viewModeRef.current = viewMode; }, [viewMode]);
  const terminalViewStateRef = useRef(terminalViewState);
  useEffect(() => { terminalViewStateRef.current = terminalViewState; }, [terminalViewState]);
  const terminalHasReplayRef = useRef(false);
  const awaitingTerminalReplayRef = useRef(false);
  const [inspectLineCount, setInspectLineCount] = useState(1000);
  const [inspectPaneFilter, setInspectPaneFilter] = useState("all");
  const [inspectSearchQuery, setInspectSearchQuery] = useState("");
  const [inspectSnapshot, setInspectSnapshot] = useState<TabInspectSnapshot | null>(null);
  const [inspectLoading, setInspectLoading] = useState(false);
  const [inspectErrorMessage, setInspectErrorMessage] = useState("");
  const {
    mobileLandscape,
    mobileLayout,
    viewportHeight,
    viewportOffsetLeft,
    viewportOffsetTop,
  } = useViewportLayout();
  const terminalInputBatcherRef = useRef(createTerminalInputBatcher((payload) => {
    const socket = terminalSocketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    debugLog("send_terminal", { bytes: payload.byteLength });
    socket.send(payload);
    return true;
  }));
  const flushPendingTerminalTransport = useCallback((): void => {
    terminalInputBatcherRef.current.flushBufferedInput();
  }, []);
  const sendRawDirectToSocket = useCallback((data: string): void => {
    if (!data) {
      return;
    }

    const socket = terminalSocketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      terminalInputBatcherRef.current.bufferWhileDisconnected(data);
      debugLog("send_terminal.queued", {
        readyState: socket?.readyState,
        bytes: data.length,
        queuedBytes: terminalInputBatcherRef.current.getBufferedLength()
      });
      return;
    }

    terminalInputBatcherRef.current.enqueue(data);
  }, []);
  const sendRawToSocket = useCallback((data: string): void => {
    sendRawDirectToSocket(data);
  }, [sendRawDirectToSocket]);

  // ── Connection hook ──
  // Ref to hold connection actions for use inside callbacks before `connection` is assigned.
  const connectionActionsRef = useRef<{
    setStatusMessage: (msg: string) => void;
    setErrorMessage: (msg: string) => void;
    serverConfig: import("./app-types").ServerConfig | null;
  }>({ setStatusMessage: () => {}, setErrorMessage: () => {}, serverConfig: null });

  const connection = useRemuxConnection({
    onAuthOk: (passwordValue, clientId) => {
      pendingTerminalAuthRef.current = { password: passwordValue, clientId };
      terminalAuthRef.current = { password: passwordValue, clientId };
      terminalReconnectAttemptRef.current = 0;
      // Request notification permission for bell alerts.
      if (typeof Notification !== "undefined" && Notification.permission === "default") {
        void Notification.requestPermission();
      }
    },
    onControlMessage: (message) => {
      switch (message.type) {
        case "attached": {
          workspace.onAttached(message.session);
          attachedSessionRef.current = message.session;
          recordDiagnosticActionRef.current("runtime.attached", `Attached session ${message.session}`);
          launchContextRef.current = null;
          setDrawerOpen(false);
          connectionActionsRef.current.setStatusMessage(
            terminalHasReplayRef.current ? "restoring live view…" : "connecting live view…"
          );
          if (pendingTerminalAuthRef.current) {
            const auth = pendingTerminalAuthRef.current;
            pendingTerminalAuthRef.current = null;
            if (attachedSessionRef.current === message.session) {
              openTerminalSocket(auth.password, auth.clientId);
            }
          }
          notifyTerminalResizeRef.current({ notify: true, retryUntilVisible: true });
          return;
        }
        case "session_picker": {
          launchContextRef.current = null;
          suppressHistoryGapRef.current("session picker");
          resetTerminalBufferRef.current();
          attachedSessionRef.current = "";
          awaitingTerminalReplayRef.current = false;
          terminalHasReplayRef.current = false;
          setTerminalViewState("idle");
          setRuntimeState(null);
          recordDiagnosticActionRef.current("runtime.session_picker", "Session picker shown");
          workspace.onSessionPicker(message.sessions);
          return;
        }
        case "workspace_state": {
          const inferredAttachedSession = inferAttachedSessionFromWorkspace(
            message.workspace.sessions,
            message.clientView ?? null
          );
          if (inferredAttachedSession) {
            attachedSessionRef.current = inferredAttachedSession;
          }
          workspace.onWorkspaceState(message.workspace, message.clientView ?? null);
          setRuntimeState(message.runtimeState ?? null);
          if (inferredAttachedSession && terminalViewStateRef.current === "live") {
            connectionActionsRef.current.setStatusMessage(`attached: ${inferredAttachedSession}`);
          }
          return;
        }
        case "error":
          connectionActionsRef.current.setErrorMessage(message.message);
          if (viewModeRef.current === "inspect") {
            setInspectErrorMessage(message.message);
          }
          return;
        case "info":
          connectionActionsRef.current.setStatusMessage(message.message);
          return;
        case "scrollback":
          return;
        case "bell": {
          setBellSessions((current) => new Set(current).add(message.session));
          // Show browser notification when tab is not focused.
          if (document.hidden && Notification.permission === "granted") {
            new Notification("Terminal Bell", {
              body: `Session "${message.session}" rang the bell`,
              tag: `bell-${message.session}`,
            });
          }
          return;
        }
        case "tab_history": {
          const pending = inspectRequestRef.current;
          if (!pending) return;
          if (pending.sessionName !== message.sessionName || pending.tabIndex !== message.tabIndex) return;
          if (inspectRequestTimerRef.current) {
            clearTimeout(inspectRequestTimerRef.current);
            inspectRequestTimerRef.current = null;
          }
          inspectAutoScrollPendingRef.current = pending.scrollToLatest;
          startTransition(() => {
            setInspectSnapshot(buildInspectSnapshotFromServerHistory(message));
            setInspectLoading(false);
            setInspectErrorMessage("");
          });
          return;
        }
      }
    },
    onControlClose: () => {
      if (viewModeRef.current === "inspect") {
        setInspectErrorMessage("Inspect disconnected. Reconnecting…");
      }
      recordDiagnosticActionRef.current("control.close", "Control websocket closed");
      if (terminalReconnectTimerRef.current) {
        clearTimeout(terminalReconnectTimerRef.current);
        terminalReconnectTimerRef.current = null;
      }
      terminalSocketRef.current?.close();
      terminalSocketRef.current = null;
      setTerminalViewState(terminalHasReplayRef.current ? "stale" : "connecting");
    },
    getAuthPayload: () => buildControlAuthHint(
      attachedSessionRef.current,
      launchContextRef.current,
      readTerminalGeometryRef.current()
    ),
  });

  const { authReady, serverConfig, capabilities, errorMessage, statusMessage, password,
    needsPasswordInput, passwordErrorMessage, bandwidthStats, retryRequired, sendControl } = connection;
  const { resolvedSocketOrigin } = connection;

  // Keep connectionActionsRef in sync so callbacks always access latest
  connectionActionsRef.current = {
    setStatusMessage: connection.setStatusMessage,
    setErrorMessage: connection.setErrorMessage,
    serverConfig,
  };

  // Forward refs for use in connection callbacks (avoids stale closures)
  const resetTerminalBufferRef = useRef(() => {});
  const notifyTerminalResizeRef = useRef((_: { notify?: boolean; retryUntilVisible?: boolean } = {}) => {});

  const toolbarRef = useRef<ToolbarHandle>(null);
  const {
    fileInputRef,
    focusTerminal,
    readTerminalBuffer,
    readTerminalGeometry,
    requestTerminalFit,
    resetTerminalBuffer,
    readTerminalViewport,
    scrollbackContentRef,
    terminalContainerRef,
    terminalRef,
    writeToTerminal
  } = useTerminalRuntime({
    onSendRaw: sendRawToSocket,
    onBeforeReset: (reason) => {
      suppressHistoryGapRef.current(reason);
    },
    onResizeSent: ({ cols, rows, source }) => {
      setLastReportedTerminalGeometry({ cols, rows, source });
    },
    mobileLayout,
    setStatusMessage: connection.setStatusMessage,
    terminalVisible: viewMode === "terminal",
    terminalSocketRef,
    theme,
    toolbarRef
  });

  // Keep forwarded refs in sync
  useEffect(() => {
    resetTerminalBufferRef.current = resetTerminalBuffer;
  }, [resetTerminalBuffer]);
  useEffect(() => {
    notifyTerminalResizeRef.current = requestTerminalFit;
  }, [requestTerminalFit]);
  useEffect(() => {
    readTerminalGeometryRef.current = readTerminalGeometry;
  }, [readTerminalGeometry]);

  // ── Terminal socket management ──
  const openTerminalSocket = useCallback((passwordValue: string, clientId: string): void => {
    debugLog("terminal_socket.open.begin", { hasPassword: Boolean(passwordValue) });
    recordDiagnosticActionRef.current("terminal.connect.begin", "Open live terminal socket");
    if (terminalReconnectTimerRef.current) {
      clearTimeout(terminalReconnectTimerRef.current);
      terminalReconnectTimerRef.current = null;
    }
    terminalInputBatcherRef.current.clear();
    awaitingTerminalReplayRef.current = true;
    setTerminalViewState(terminalHasReplayRef.current ? "restoring" : "connecting");
    connectionActionsRef.current.setStatusMessage(
      terminalHasReplayRef.current ? "restoring live view…" : "connecting live view…"
    );
    if (terminalSocketRef.current) {
      stopTerminalKeepAliveRef.current?.();
      stopTerminalKeepAliveRef.current = null;
      terminalSocketRef.current.onclose = null;
      terminalSocketRef.current.close();
    }

    const socket = new WebSocket(`${resolvedSocketOrigin}/ws/terminal`);
    socket.binaryType = "arraybuffer";
    socket.onopen = () => {
      debugLog("terminal_socket.onopen");
      const terminalGeometry = readTerminalGeometry();
      if (terminalGeometry) {
        setLastReportedTerminalGeometry({
          cols: terminalGeometry.cols,
          rows: terminalGeometry.rows,
          source: "auth"
        });
      }
      socket.send(JSON.stringify({
        type: "auth",
        token,
        password: passwordValue || undefined,
        clientId,
        ...(terminalGeometry ?? {})
      }));
      stopTerminalKeepAliveRef.current?.();
      stopTerminalKeepAliveRef.current = attachWebSocketKeepAlive(socket, {
        intervalMs: 25_000,
        createPayload: () => JSON.stringify({ type: "ping" }),
      });
      recordDiagnosticActionRef.current("terminal.connect.open", "Live terminal socket opened");
      flushPendingTerminalTransport();
      requestTerminalFit({ notify: true, retryUntilVisible: true });
    };
    const applyTerminalChunk = (chunk: string | Uint8Array): void => {
      if (awaitingTerminalReplayRef.current && getTerminalChunkLength(chunk) > 0) {
        awaitingTerminalReplayRef.current = false;
        terminalHasReplayRef.current = true;
        terminalReconnectAttemptRef.current = 0;
        setTerminalViewState("live");
        connectionActionsRef.current.setStatusMessage(
          attachedSessionRef.current ? `attached: ${attachedSessionRef.current}` : "terminal connected"
        );
      }
      writeToTerminal(chunk);
      if (terminalChunkHasBell(chunk) && attachedSessionRef.current) {
        setBellSessions((current) => new Set(current).add(attachedSessionRef.current));
      }
    };
    socket.onmessage = (event) => {
      debugLog("terminal_socket.onmessage", {
        type: typeof event.data,
        bytes: typeof event.data === "string"
          ? event.data.length
          : event.data instanceof ArrayBuffer
            ? event.data.byteLength
            : 0
      });
      if (typeof event.data === "string") {
        applyTerminalChunk(event.data);
        return;
      }
      if (event.data instanceof ArrayBuffer) {
        applyTerminalChunk(new Uint8Array(event.data));
        return;
      }
      if (event.data instanceof Blob) {
        void event.data.arrayBuffer().then((buffer) => {
          applyTerminalChunk(new Uint8Array(buffer));
        });
      }
    };
    socket.onclose = (event) => {
      debugLog("terminal_socket.onclose", { code: event.code, reason: event.reason });
      stopTerminalKeepAliveRef.current?.();
      stopTerminalKeepAliveRef.current = null;
      terminalInputBatcherRef.current.clear();
      awaitingTerminalReplayRef.current = false;
      setTerminalViewState(terminalHasReplayRef.current ? "stale" : "connecting");
      recordDiagnosticActionRef.current("terminal.connect.close", `Live terminal socket closed (${event.code})`);
      if (event.code === 4001) {
        connectionActionsRef.current.setErrorMessage("terminal authentication failed");
        return;
      }
      // Auto-reconnect terminal socket if control socket is still alive
      const auth = terminalAuthRef.current;
      const controlAlive = connection.controlSocketRef.current?.readyState === WebSocket.OPEN;
      if (!auth || !controlAlive) {
        connectionActionsRef.current.setStatusMessage("reconnecting live view…");
        return;
      }
      const attempt = terminalReconnectAttemptRef.current;
      if (shouldPauseReconnect(attempt)) {
        connectionActionsRef.current.setStatusMessage("terminal reconnect failed — switch tab to retry");
        return;
      }
      terminalReconnectAttemptRef.current += 1;
      const delay = resolveReconnectDelay(attempt, 1_000, 8_000);
      debugLog("terminal_socket.reconnect.schedule", { attempt, delay });
      connectionActionsRef.current.setStatusMessage(`reconnecting live view in ${(delay / 1000).toFixed(0)}s…`);
      terminalReconnectTimerRef.current = setTimeout(() => {
        terminalReconnectTimerRef.current = null;
        const stillAlive = connection.controlSocketRef.current?.readyState === WebSocket.OPEN;
        const currentAuth = terminalAuthRef.current;
        if (stillAlive && currentAuth) {
          openTerminalSocket(currentAuth.password, currentAuth.clientId);
        }
      }, delay);
    };
    socket.onerror = () => {
      debugLog("terminal_socket.onerror");
    };
    terminalSocketRef.current = socket;
  }, [flushPendingTerminalTransport, readTerminalGeometry, requestTerminalFit, resolvedSocketOrigin, writeToTerminal]);

  useEffect(() => () => {
    stopTerminalKeepAliveRef.current?.();
    stopTerminalKeepAliveRef.current = null;
    if (terminalReconnectTimerRef.current) {
      clearTimeout(terminalReconnectTimerRef.current);
      terminalReconnectTimerRef.current = null;
    }
  }, []);

  const [snippets, setSnippets] = useState<Snippet[]>(() => {
    try {
      const stored = localStorage.getItem(getSnippetStorageKey());
      if (!stored) return [];
      return normalizeSnippets(JSON.parse(stored));
    } catch {
      return [];
    }
  });
  const [editingSnippet, setEditingSnippet] = useState<Snippet | null>(null);
  const [collapsedSnippetGroups, setCollapsedSnippetGroups] = useState<Record<string, boolean>>({});
  const [pendingSnippetExecution, setPendingSnippetExecution] = useState<PendingSnippetExecution | null>(null);

  const [statsVisible, setStatsVisible] = useState(false);
  const [activeAiViewportTool, setActiveAiViewportTool] = useState<ReturnType<typeof detectAiToolContextFromViewport>>(null);
  const inspectRequestRef = useRef<{
    requestKey: string;
    sessionName: string;
    tabIndex: number;
    scrollToLatest: boolean;
  } | null>(null);
  const inspectRequestTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastInspectRequestKeyRef = useRef<string | null>(null);
  const inspectLineCountInitializedRef = useRef(false);
  const inspectAutoScrollPendingRef = useRef(false);
  const nextInspectScrollModeRef = useRef<"latest" | "preserve">("latest");

  const [renamingSession, setRenamingSession] = useState<string | null>(null);
  const [renameSessionValue, setRenameSessionValue] = useState("");
  const [renamingWindow, setRenamingWindow] = useState<{ session: string; index: number } | null>(null);
  const [renameWindowValue, setRenameWindowValue] = useState("");
  const renameHandledByKeyRef = useRef(false);

  const [dragOver, setDragOver] = useState(false);
  const [uploadToast, setUploadToast] = useState<{ path: string; filename: string } | null>(null);
  const [bellSessions, setBellSessions] = useState<Set<string>>(new Set());

  const [draggedSessionName, setDraggedSessionName] = useState<string | null>(null);
  const [draggedTabKey, setDraggedTabKey] = useState<string | null>(null);
  const [draggedSnippetId, setDraggedSnippetId] = useState<string | null>(null);
  const [sessionDropTarget, setSessionDropTarget] = useState<string | null>(null);
  const [tabDropTarget, setTabDropTarget] = useState<string | null>(null);
  const [snippetDropTarget, setSnippetDropTarget] = useState<string | null>(null);

  const workspace = useWorkspaceState(workspaceOrder);
  const {
    snapshot,
    clientView,
    attachedSession,
    pendingSessionAttachment,
    sessionChoices,
    awaitingSessionSelection,
    awaitingSessionAttachment,
    activeSession,
    activeTab,
    activePane,
    orderedSessions,
    orderedActiveTabs,
  } = workspace;

  const reportDiagnostic = useCallback((payload: {
    session?: string;
    tabIndex?: number;
    paneId?: string;
    diagnostic: ClientDiagnosticDetails;
  }): void => {
    const socket = connection.controlSocketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    socket.send(JSON.stringify({
      type: "report_client_diagnostic",
      ...payload,
    }));
  }, [connection.controlSocketRef]);

  const {
    activeRedlineCount,
    activeRedlineSummary,
    recordAction: recordDiagnosticAction,
    suppressHistoryGap,
  } = useTerminalDiagnostics({
    activePaneId: activePane?.id ?? null,
    activeTabIndex: activeTab?.index ?? null,
    activeTabName: activeTab?.name ?? "unknown",
    attachedSession: attachedSession || attachedSessionRef.current,
    lastReportedGeometry: lastReportedTerminalGeometry,
    readTerminalBuffer,
    readTerminalGeometry,
    reportDiagnostic,
    terminalContainerRef,
    terminalRef,
    terminalViewState,
    theme,
    viewMode,
  });

  useEffect(() => {
    suppressHistoryGapRef.current = suppressHistoryGap;
  }, [suppressHistoryGap]);

  useEffect(() => {
    recordDiagnosticActionRef.current = recordDiagnosticAction;
  }, [recordDiagnosticAction]);

  const uploadFile = useFileUpload({
    activePane,
    password,
    serverConfig,
    setStatusMessage: connection.setStatusMessage,
    setUploadToast,
    token
  });

  const headerTabs = useMemo(
    () => orderedActiveTabs.map((tab) => ({
      canClose: orderedActiveTabs.length > 1,
      index: tab.index,
      isActive: tab.index === activeTab?.index,
      isRenaming: renamingWindow?.session === activeSession?.name && renamingWindow?.index === tab.index,
      key: getTabOrderKey(tab),
      label: mobileLayout ? `${tab.index}:${tab.name}` : `${tab.index}: ${tab.name}`,
      name: tab.name
    })),
    [activeSession?.name, activeTab?.index, mobileLayout, orderedActiveTabs, renamingWindow]
  );
  const groupedSnippetList: SnippetGroup[] = useMemo(
    () => groupSnippets(snippets),
    [snippets]
  );
  const pinnedSnippets = useMemo(
    () => getPinnedSnippets(snippets).slice(0, 8),
    [snippets]
  );
  const snippetPickerState = useMemo(
    () => deriveSnippetPickerState(composeText, snippets),
    [composeText, snippets]
  );
  const snippetPickerQuery = snippetPickerState.query;
  const visibleQuickSnippetResults = snippetPickerState.visibleResults;
  const [quickSnippetIndex, setQuickSnippetIndex] = useState(0);

  const topStatus = useMemo(() => deriveTopStatus({
    authReady,
    awaitingSessionAttachment,
    awaitingSessionSelection,
    errorMessage,
    pendingSessionAttachment,
    statusMessage
  }), [
    authReady,
    awaitingSessionAttachment,
    awaitingSessionSelection,
    errorMessage,
    pendingSessionAttachment,
    statusMessage
  ]);

  useEffect(() => {
    localStorage.setItem(getSnippetStorageKey(), JSON.stringify(snippets));
  }, [snippets]);

  useEffect(() => {
    setQuickSnippetIndex(0);
  }, [snippetPickerQuery]);

  const requestTabInspect = useCallback((
    session: SessionState,
    tab: TabState,
    options?: { scrollToLatest?: boolean }
  ): void => {
    if (!authReady || connection.controlSocketRef.current?.readyState !== WebSocket.OPEN) {
      return;
    }

    if (inspectRequestTimerRef.current) {
      clearTimeout(inspectRequestTimerRef.current);
      inspectRequestTimerRef.current = null;
    }

    const requestKey = `${session.name}:${tab.index}:${inspectLineCount}:${tab.panes.map((pane) => pane.id).join(",")}`;
    inspectRequestRef.current = {
      requestKey,
      sessionName: session.name,
      tabIndex: tab.index,
      scrollToLatest: options?.scrollToLatest ?? true
    };
    lastInspectRequestKeyRef.current = requestKey;
    setInspectLoading(true);
    setInspectErrorMessage("");
    setInspectSnapshot((current) => (
      current && current.sessionName === session.name && current.tabIndex === tab.index
        ? current
        : null
    ));

    if (tab.panes.length === 0) {
      setInspectLoading(false);
      return;
    }

    inspectRequestTimerRef.current = setTimeout(() => {
      const pending = inspectRequestRef.current;
      if (!pending || pending.requestKey !== requestKey) {
        return;
      }
      setInspectLoading(false);
      setInspectErrorMessage("Inspect history request timed out");
    }, 500);
    sendControl({
      type: "capture_tab_history",
      session: session.name,
      tabIndex: tab.index,
      lines: inspectLineCount
    });
  }, [authReady, inspectLineCount, sendControl]);

  const scrollInspectToLatest = useCallback((): void => {
    const container = scrollbackContentRef.current;
    if (!container) {
      return;
    }
    container.scrollTop = container.scrollHeight;
  }, [scrollbackContentRef]);

  // Theme and sidebar persistence now handled by useClientPreferences

  useEffect(() => {
    if (!serverConfig?.scrollbackLines || inspectLineCountInitializedRef.current) {
      return;
    }
    setInspectLineCount(serverConfig.scrollbackLines);
    inspectLineCountInitializedRef.current = true;
  }, [serverConfig?.scrollbackLines]);

  useEffect(() => {
    if (!mobileLayout) {
      setDrawerOpen(false);
    }
  }, [mobileLayout]);

  useEffect(() => {
    if (attachedSession) {
      attachedSessionRef.current = attachedSession;
    }
  }, [attachedSession]);

  useEffect(() => {
    const activeBellSession = attachedSession || activeSession?.name;
    if (!activeBellSession) {
      return;
    }
    setBellSessions((current) => {
      if (!current.has(activeBellSession)) {
        return current;
      }
      const next = new Set(current);
      next.delete(activeBellSession);
      return next;
    });
  }, [activeSession?.name, attachedSession]);

  useEffect(() => {
    if (inspectPaneFilter === "all") {
      return;
    }
    if (!inspectSnapshot?.sections.some((section) => section.paneId === inspectPaneFilter)) {
      setInspectPaneFilter("all");
    }
  }, [inspectPaneFilter, inspectSnapshot]);

  useEffect(() => {
    if (
      !sessionChoices ||
      attachedSession ||
      pendingSessionAttachment ||
      snapshot.sessions.length !== 1
    ) {
      return;
    }

    const [onlySession] = snapshot.sessions;
    workspace.beginSessionAttachment(onlySession.name);
    workspace.clearLocalSelection();
    connection.setStatusMessage(`attaching: ${onlySession.name}`);
    setDrawerOpen(false);
    sendControl({ type: "select_session", session: onlySession.name });
  }, [attachedSession, pendingSessionAttachment, sessionChoices, snapshot.sessions, sendControl, workspace, connection]);

  useEffect(() => {
    return () => {
      if (inspectRequestTimerRef.current) {
        clearTimeout(inspectRequestTimerRef.current);
      }
      terminalSocketRef.current?.close();
    };
  }, []);

  useEffect(() => {
    if (!inspectSnapshot || !inspectAutoScrollPendingRef.current) {
      return;
    }

    inspectAutoScrollPendingRef.current = false;
    requestAnimationFrame(scrollInspectToLatest);
  }, [inspectSnapshot, scrollInspectToLatest]);

  useEffect(() => {
    if (viewMode !== "inspect") {
      if (inspectRequestTimerRef.current) {
        clearTimeout(inspectRequestTimerRef.current);
        inspectRequestTimerRef.current = null;
      }
      inspectRequestRef.current = null;
      lastInspectRequestKeyRef.current = null;
      setInspectLoading(false);
      return;
    }

    if (!authReady || !activeSession || !activeTab) {
      return;
    }

    const requestKey = `${activeSession.name}:${activeTab.index}:${inspectLineCount}:${activeTab.panes.map((pane) => pane.id).join(",")}`;
    if (lastInspectRequestKeyRef.current === requestKey) {
      return;
    }

    const scrollToLatest = nextInspectScrollModeRef.current !== "preserve";
    nextInspectScrollModeRef.current = "latest";
    requestTabInspect(activeSession, activeTab, { scrollToLatest });
  }, [activeSession, activeTab, authReady, inspectLineCount, requestTabInspect, viewMode]);

  // Re-fit terminal when switching to terminal mode
  useEffect(() => {
    if (viewMode === "terminal") {
      requestTerminalFit({ notify: true, retryUntilVisible: true });
      const timer = setTimeout(() => {
        requestTerminalFit({ notify: true, retryUntilVisible: true });
      }, 150);
      return () => clearTimeout(timer);
    }
  }, [requestTerminalFit, viewMode]);

  const activeAiCommandTool = useMemo(
    () => detectAiToolContext(activePane),
    [activePane?.currentCommand, activePane?.currentPath, activePane?.id]
  );

  useEffect(() => {
    if (viewMode !== "terminal" || !activePane || activeAiCommandTool) {
      setActiveAiViewportTool(null);
      return;
    }

    let cancelled = false;
    const runDetection = () => {
      const detected = detectAiToolContextFromViewport(activePane, readTerminalViewport());
      if (!cancelled) {
        setActiveAiViewportTool((current) => (
          current?.signature === detected?.signature
            ? current
            : detected
        ));
      }
    };

    runDetection();
    const timer = window.setInterval(runDetection, 900);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [
    activeAiCommandTool,
    activePane?.currentCommand,
    activePane?.currentPath,
    activePane?.id,
    readTerminalViewport,
    viewMode,
  ]);

  // No dynamic font-size calculation — CSS handles responsive sizing via clamp()

  useEffect(() => {
    if (!debugMode) {
      return;
    }
    const sessionSummary = snapshot.sessions.map((session) => {
      const aTab =
        session.tabs.find((tab) => tab.active) ?? session.tabs[0];
      const aPane = aTab?.panes.find((pane) => pane.active) ?? aTab?.panes[0];
      return {
        name: session.name,
        attached: session.attached,
        activeTab: aTab ? `${aTab.index}:${aTab.name}` : null,
        activePane: aPane?.id ?? null,
        activePaneZoomed: aPane?.zoomed ?? null
      };
    });
    const derived = {
      attachedSession,
      activeSession: activeSession?.name ?? null,
      activeTab: activeTab ? `${activeTab.index}:${activeTab.name}` : null,
      activePane: activePane?.id ?? null,
      activePaneZoomed: activePane?.zoomed ?? null,
      backendKind: serverConfig?.backendKind ?? null,
      topStatus,
      snapshotCapturedAt: snapshot.capturedAt,
      sessions: sessionSummary
    };
    window.__remuxDebugState = derived;
    debugLog("derived_state", derived);
  }, [activePane, activeSession, activeTab, attachedSession, serverConfig?.backendKind, snapshot, topStatus]);

  useEffect(() => {
    const handlePaste = (event: ClipboardEvent): void => {
      const items = event.clipboardData?.items;
      if (!items) return;

      for (const item of items) {
        if (item.kind === "file") {
          event.preventDefault();
          const file = item.getAsFile();
          if (file) {
            uploadFile(file);
          }
          return;
        }
      }
    };

    document.addEventListener("paste", handlePaste, true);
    return () => document.removeEventListener("paste", handlePaste, true);
  }, [uploadFile]);

  const createSession = (): void => {
    const name = window.prompt("Session name", "main");
    if (!name) {
      return;
    }
    workspace.beginSessionAttachment(name);
    workspace.clearLocalSelection();
    connection.setStatusMessage(`attaching: ${name}`);
    sendControl({ type: "new_session", name });
  };

  const persistSnippetPatch = useCallback((updater: (current: Snippet[]) => Snippet[]): void => {
    setSnippets((current) => assignSnippetSortOrders(updater(current)));
  }, []);

  const executeSnippet = useCallback((snippet: Snippet): void => {
    const variables = extractSnippetVariables(snippet.command);
    if (variables.length > 0) {
      setPendingSnippetExecution({
        snippet,
        variables,
        values: Object.fromEntries(
          variables.map((variable) => [variable, snippet.lastUsedVars?.[variable] ?? ""])
        )
      });
      return;
    }

    sendRawToSocket(`${snippet.command}${snippet.autoEnter ? "\r" : ""}`);
    focusTerminal();
  }, [focusTerminal, sendRawToSocket]);

  const runPendingSnippet = useCallback((): void => {
    if (!pendingSnippetExecution) {
      return;
    }

    const command = fillSnippetTemplate(
      pendingSnippetExecution.snippet.command,
      pendingSnippetExecution.values
    );

    persistSnippetPatch((current) => current.map((snippet) => (
      snippet.id === pendingSnippetExecution.snippet.id
        ? {
            ...snippet,
            lastUsedVars: {
              ...(snippet.lastUsedVars ?? {}),
              ...pendingSnippetExecution.values
            }
          }
        : snippet
    )));

    sendRawToSocket(`${command}${pendingSnippetExecution.snippet.autoEnter ? "\r" : ""}`);
    setPendingSnippetExecution(null);
    focusTerminal();
  }, [focusTerminal, pendingSnippetExecution, persistSnippetPatch, sendRawToSocket]);

  const selectTab = (tab: TabState): void => {
    if (!activeSession) {
      return;
    }
    const switchingTabs = tab.index !== activeTab?.index;
    workspace.selectWindowIndex(tab.index);
    sendControl({ type: "select_tab", session: activeSession.name, tabIndex: tab.index });
    if (stickyZoom && capabilities?.supportsFullscreenPane && switchingTabs) {
      const pane = tab.panes.find((p) => p.active) ?? tab.panes[0];
      if (pane && !pane.zoomed) {
        sendControl({ type: "toggle_fullscreen", paneId: pane.id });
      }
    }
  };

  const closeHeaderTab = (tabIndex: number): void => {
    if (!activeSession) {
      return;
    }
    if (tabIndex === activeTab?.index) {
      workspace.clearLocalSelection();
    }
    if (renamingWindow?.session === activeSession.name && renamingWindow.index === tabIndex) {
      setRenamingWindow(null);
    }
    sendControl({ type: "close_tab", session: activeSession.name, tabIndex });
  };

  const renameHeaderTab = (tabIndex: number, newName: string): void => {
    if (!activeSession || !newName.trim()) {
      return;
    }
    sendControl({ type: "rename_tab", session: activeSession.name, tabIndex, newName: newName.trim() });
  };

  const reorderHeaderTabs = (draggedKey: string, targetKey: string): void => {
    if (!activeSession || draggedKey === targetKey) {
      return;
    }
    setWorkspaceOrder((current) => reorderSessionTabs(current, activeSession.name, draggedKey, targetKey));
  };

  const sendCompose = (): void => {
    const text = composeText.trim();
    if (!text) {
      return;
    }
    sendRawToSocket(`${text}\r`);
    setComposeText("");
    focusTerminal();
  };

  const beginDrag = (
    event: DragEvent<HTMLElement>,
    type: "session" | "tab" | "snippet",
    value: string
  ): void => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", `${type}:${value}`);
  };

  const handleComposeFilePaste = (event: ReactClipboardEvent<HTMLInputElement>): void => {
    const items = event.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.kind === "file") {
        event.preventDefault();
        const file = item.getAsFile();
        if (file) uploadFile(file);
        return;
      }
    }
  };

  const handleComposeKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (snippetPickerQuery !== null && visibleQuickSnippetResults.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        event.stopPropagation();
        setQuickSnippetIndex((current) => (current + 1) % visibleQuickSnippetResults.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        setQuickSnippetIndex((current) => (
          current === 0 ? visibleQuickSnippetResults.length - 1 : current - 1
        ));
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        executeSnippet(visibleQuickSnippetResults[quickSnippetIndex] ?? visibleQuickSnippetResults[0]);
        setComposeText("");
        return;
      }
    }
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      sendCompose();
    }
  };

  const refreshInspect = useCallback((): void => {
    if (!activeSession || !activeTab) {
      return;
    }
    lastInspectRequestKeyRef.current = null;
    requestTabInspect(activeSession, activeTab, { scrollToLatest: true });
  }, [activeSession, activeTab, requestTabInspect]);

  const loadMoreInspect = useCallback((): void => {
    const step = serverConfig?.scrollbackLines ?? 1000;
    nextInspectScrollModeRef.current = "preserve";
    setInspectLineCount((current) => current + step);
  }, [serverConfig?.scrollbackLines]);

  const mobileInspectMode = mobileLayout && viewMode === "inspect";
  const activeAiTool = useMemo(() => (
    activeAiCommandTool ?? activeAiViewportTool
  ), [
    activeAiCommandTool,
    activeAiViewportTool,
  ]);
  const terminalStatusMessage = useMemo(() => {
    if (viewMode !== "terminal") {
      return undefined;
    }

    switch (terminalViewState) {
      case "connecting":
        return "Connecting live view…";
      case "restoring":
        return "Restoring live view…";
      case "stale":
        return "Reconnecting live view…";
      default:
        return undefined;
    }
  }, [terminalViewState, viewMode]);

  return (
    <AppShell
      drawerOpen={drawerOpen}
      mobileLandscape={mobileLandscape}
      mobileLayout={mobileLayout}
      onCloseDrawer={() => setDrawerOpen(false)}
      sidebarCollapsed={sidebarCollapsed}
      viewportHeight={viewportHeight}
      viewportOffsetLeft={viewportOffsetLeft}
      viewportOffsetTop={viewportOffsetTop}
      sidebar={(
        <aside className={`sidebar drawer${drawerOpen ? " open" : ""}`}>
          <div className="sidebar-header">
            <span className="sidebar-brand">REMUX</span>
          </div>
          <SessionSection
            attachedSession={attachedSession}
            bellSessions={bellSessions}
            createSession={createSession}
            mobileLayout={mobileLayout}
            renameHandledByKeyRef={renameHandledByKeyRef}
            renameSessionValue={renameSessionValue}
            renamingSession={renamingSession}
            selectedSessionName={activeSession?.name}
            sessionDropTarget={sessionDropTarget}
            sessions={orderedSessions}
            setDraggedSessionName={setDraggedSessionName}
            setRenameSessionValue={setRenameSessionValue}
            setRenamingSession={setRenamingSession}
            setSelectedPaneId={workspace.selectPaneId}
            setSelectedWindowIndex={workspace.selectWindowIndex}
            setSessionDropTarget={setSessionDropTarget}
            snapshot={snapshot}
            beginDrag={beginDrag}
            draggedSessionName={draggedSessionName}
            onCloseSession={(sessionName) => sendControl({ type: "close_session", session: sessionName })}
            onRenameSession={(sessionName, newName) => sendControl({ type: "rename_session", session: sessionName, newName })}
            onReorderSessions={(draggedName, targetName) => setWorkspaceOrder((current) => reorderSessionState(current, draggedName, targetName))}
            onSelectSession={(sessionName) => {
              workspace.beginSessionAttachment(sessionName);
              workspace.clearLocalSelection();
              sendControl({ type: "select_session", session: sessionName });
            }}
            supportsSessionRename={capabilities?.supportsSessionRename ?? false}
          />

          <AppearanceSection
            followBackendFocus={clientView?.followBackendFocus ?? false}
            onToggleFollowBackendFocus={() => sendControl({
              type: "set_follow_focus",
              follow: !(clientView?.followBackendFocus ?? false)
            })}
            onResetScrollFontSize={prefs.resetScrollFontSize}
            onSetTheme={prefs.setTheme}
            onUpdateScrollFontSize={prefs.setScrollFontSize}
            scrollFontSize={scrollFontSize}
            showFollowFocus={serverConfig?.backendKind === "runtime-v2"}
            theme={theme}
          />

          <SnippetsSection
            beginDrag={beginDrag}
            collapsedSnippetGroups={collapsedSnippetGroups}
            draggedSnippetId={draggedSnippetId}
            editingSnippet={editingSnippet}
            groupedSnippetList={groupedSnippetList}
            mobileLayout={mobileLayout}
            onDeleteSnippet={(snippetId) => persistSnippetPatch((current) => current.filter((entry) => entry.id !== snippetId))}
            onPersistSnippetPatch={persistSnippetPatch}
            onSetCollapsedSnippetGroups={setCollapsedSnippetGroups}
            onSetDraggedSnippetId={setDraggedSnippetId}
            onSetEditingSnippet={setEditingSnippet}
            onSetSnippetDropTarget={setSnippetDropTarget}
            snippetDropTarget={snippetDropTarget}
            snippets={snippets}
          />

          {serverConfig?.version && (
            <div className="drawer-footer-info">
              <p className="drawer-version">v{serverConfig.version}</p>
              {(serverConfig.gitBranch || serverConfig.gitCommitSha || serverConfig.gitDirty !== undefined) && (
                <p className="drawer-runtime-meta">
                  {[serverConfig.gitBranch, serverConfig.gitCommitSha?.slice(0, 8), serverConfig.gitDirty ? "dirty" : undefined]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              )}
            </div>
          )}
        </aside>
      )}
    >
      <WorkspaceScreen
        header={(
          <AppHeader
        activeTabLabel={activeTab ? `${activeTab.index}: ${activeTab.name}` : "-"}
        awaitingSessionSelection={awaitingSessionSelection}
        bandwidthStats={bandwidthStats}
        beginDrag={beginDrag}
        draggedTabKey={draggedTabKey}
        mobileLayout={mobileLayout}
        onCloseTab={closeHeaderTab}
        onCreateTab={activeSession ? () => sendControl({ type: "new_tab", session: activeSession.name }) : undefined}
        onOpenFeedback={() => {
          if (!openRemuxFeedbackDialog()) {
            connection.setStatusMessage("feedback target unavailable");
          }
        }}
        onRenameTab={renameHeaderTab}
        onReorderTabs={reorderHeaderTabs}
        onSelectTab={(tabIndex) => {
          const tab = orderedActiveTabs.find((entry) => entry.index === tabIndex);
          if (tab) {
            selectTab(tab);
          }
        }}
        onSetDraggedTabKey={setDraggedTabKey}
        onSetRenameTabValue={setRenameWindowValue}
        onSetRenamingTab={(tabIndex) => {
          if (!activeSession || tabIndex === null) {
            setRenamingWindow(null);
            return;
          }
          setRenamingWindow({ session: activeSession.name, index: tabIndex });
        }}
        onSetTabDropTarget={setTabDropTarget}
        onToggleDrawer={() => setDrawerOpen((value) => !value)}
        onToggleSidebarCollapsed={() => setSidebarCollapsed((value) => !value)}
        onToggleStats={() => setStatsVisible((value) => !value)}
        onToggleViewMode={() => {
          setViewMode((mode) => mode === "inspect" ? "terminal" : "inspect");
        }}
        renameHandledByKeyRef={renameHandledByKeyRef}
        renameTabValue={renameWindowValue}
        sidebarCollapsed={sidebarCollapsed}
        serverConfig={serverConfig}
        supportsTabRename={capabilities?.supportsTabRename ?? false}
        tabDropTarget={tabDropTarget}
        tabs={headerTabs}
        topStatus={topStatus}
        viewMode={viewMode}
        inspectPrecision={inspectSnapshot?.precision}
        runtimeState={runtimeState}
        formatBytes={formatBytes}
          />
        )}
        terminalStage={(
          <TerminalStage
        activeRedlineCount={activeRedlineCount}
        activeRedlineSummary={activeRedlineSummary}
        dragOver={dragOver}
        inspectErrorMessage={inspectErrorMessage}
        inspectLineCount={inspectLineCount}
        inspectLoading={inspectLoading}
        inspectPaneFilter={inspectPaneFilter}
        inspectSearchQuery={inspectSearchQuery}
        inspectSnapshot={inspectSnapshot}
        mobileLayout={mobileLayout}
        onInspectLoadMore={loadMoreInspect}
        onInspectPaneFilterChange={setInspectPaneFilter}
        onInspectRefresh={refreshInspect}
        onInspectSearchQueryChange={setInspectSearchQuery}
        onFocusTerminal={focusTerminal}
        onDragLeave={() => setDragOver(false)}
        onDragOver={(event) => {
          event.preventDefault();
          setDragOver(true);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragOver(false);
          const file = event.dataTransfer.files[0];
          if (file) {
            uploadFile(file);
          }
        }}
        scrollFontSize={scrollFontSize}
        scrollbackContentRef={scrollbackContentRef}
        terminalStatusMessage={terminalStatusMessage}
        terminalContainerRef={terminalContainerRef}
        viewMode={viewMode}
          />
        )}
        bottomRail={(
          <div className="workspace-bottom-rail">
            <input
              ref={fileInputRef}
              type="file"
              style={{ display: "none" }}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) {
                  uploadFile(file);
                }
                event.target.value = "";
              }}
            />
            <AiQuickActionsBar
              hidden={viewMode !== "terminal"}
              onFocusTerminal={focusTerminal}
              onSendRaw={sendRawToSocket}
              tool={activeAiTool}
            />
            <Toolbar
              ref={toolbarRef}
              sendRaw={sendRawToSocket}
              onFocusTerminal={focusTerminal}
              fileInputRef={fileInputRef}
              mobileLayout={mobileLayout}
              setStatusMessage={connection.setStatusMessage}
              snippets={snippets}
              onExecuteSnippet={executeSnippet}
              hidden={viewMode !== "terminal"}
            />
            {mobileInspectMode ? null : (
              <PinnedSnippetsBar
                snippets={pinnedSnippets}
                onEditSnippet={setEditingSnippet}
                onExecuteSnippet={executeSnippet}
                onOpenDrawer={() => setDrawerOpen(true)}
              />
            )}
            {mobileInspectMode ? null : (
              <SnippetTemplatePanel
                pendingExecution={pendingSnippetExecution}
                onCancel={() => setPendingSnippetExecution(null)}
                onChangeValue={(variable, value) => setPendingSnippetExecution((current) => (
                  current
                    ? {
                        ...current,
                        values: {
                          ...current.values,
                          [variable]: value
                        }
                      }
                    : current
                ))}
                onRun={runPendingSnippet}
              />
            )}
            {mobileInspectMode ? null : (
              <ComposeBar
                composeText={composeText}
                onChange={setComposeText}
                onFilePaste={handleComposeFilePaste}
                onKeyDown={handleComposeKeyDown}
                onSend={sendCompose}
              />
            )}
            {mobileInspectMode ? null : (
              <SnippetPicker
                activeIndex={quickSnippetIndex}
                onExecuteSnippet={executeSnippet}
                onHoverIndex={setQuickSnippetIndex}
                onPickComplete={() => setComposeText("")}
                query={snippetPickerQuery}
                snippets={visibleQuickSnippetResults}
              />
            )}
          </div>
        )}
        fileInput={null}
        toolbar={null}
        pinnedSnippetsBar={null}
        snippetTemplatePanel={null}
        composeBar={null}
        snippetPicker={null}
      />

      <Suspense fallback={null}>
        <SessionPickerScreen
          mobileLayout={mobileLayout}
          sessions={sessionChoices}
          onSelectSession={(sessionName) => {
            workspace.beginSessionAttachment(sessionName);
            workspace.clearLocalSelection();
            sendControl({ type: "select_session", session: sessionName });
          }}
        />
      </Suspense>

      {/* Legacy overlay scrollback removed — now inline in scroll viewMode */}

      <Suspense fallback={null}>
        {statsVisible && <LazyBandwidthStatsModal onClose={() => setStatsVisible(false)} stats={bandwidthStats} />}
      </Suspense>

      <Suspense fallback={null}>
        {(needsPasswordInput || retryRequired) && (
          <LazyPasswordOverlay
            onChange={(value) => {
              connection.setPassword(value);
            }}
            onSubmit={needsPasswordInput ? connection.submitPassword : connection.retryConnection}
            password={password}
            passwordErrorMessage={needsPasswordInput ? passwordErrorMessage : errorMessage}
            showPasswordField={needsPasswordInput}
            submitLabel={needsPasswordInput ? "Connect" : "Retry"}
            title={needsPasswordInput ? "Password Required" : "Connection Lost"}
          />
        )}
      </Suspense>

      <Suspense fallback={null}>
        {uploadToast && (
          <LazyUploadToast
            path={uploadToast.path}
            onDismiss={() => setUploadToast(null)}
            onInsert={() => {
              const quoted = `'${uploadToast.path.replace(/'/g, "'\\''")}'`;
              sendRawToSocket(quoted);
              setUploadToast(null);
            }}
          />
        )}
      </Suspense>

      {!token && (
        <div className="overlay">
          <div className="card">URL missing `token` query parameter.</div>
        </div>
      )}
    </AppShell>
  );
};

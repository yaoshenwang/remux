import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ClipboardEvent as ReactClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import { Toolbar, type ToolbarHandle } from "./components/Toolbar";
import { AppHeader } from "./components/AppHeader";
import { TerminalStage } from "./components/TerminalStage";
import { ComposeBar } from "./components/ComposeBar";
import { PinnedSnippetsBar, SnippetPicker, SnippetTemplatePanel } from "./components/SnippetPanels";
import { SessionSection } from "./components/sidebar/SessionSection";
import { AppearanceSection } from "./components/sidebar/AppearanceSection";
import { SnippetsSection } from "./components/sidebar/SnippetsSection";
import {
  inferAttachedSessionFromWorkspace,
  isAwaitingSessionAttachment,
  isAwaitingSessionSelection,
  resolveActiveSession,
  shouldUsePaneViewportCols
} from "./ui-state";
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
  normalizeWorkspaceOrder,
  orderSessions,
  orderTabs,
  reorderSessionState,
  reorderSessionTabs,
  WORKSPACE_ORDER_STORAGE_KEY,
  type WorkspaceOrderState
} from "./workspace-order";
import { deriveTopStatus, formatBytes } from "./app-status";
import { deriveSnippetPickerState } from "./compose-picker";
import type { BandwidthStats, PendingSnippetExecution, ServerConfig } from "./app-types";
import { useFileUpload } from "./hooks/useFileUpload";
import { matchesMobileLayout, useViewportLayout } from "./mobile-layout";
import { useTerminalRuntime } from "./hooks/useTerminalRuntime";
import {
  buildInspectSnapshotFromServerHistory,
  type TabInspectSnapshot
} from "./inspect-state";
import {
  debugLog,
  debugMode,
  formatPasswordError,
  parseMessage,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  token,
  wsOrigin
} from "./remux-runtime";
import type {
  PaneState,
  SessionState,
  SessionSummary,
  WorkspaceSnapshot,
  TabState,
  ClientView,
  BackendCapabilities
} from "../shared/protocol";

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

const getInitialStickyZoom = (): boolean => {
  const stored = localStorage.getItem("remux-sticky-zoom");
  if (stored === "true") {
    return true;
  }
  if (stored === "false") {
    return false;
  }
  return matchesMobileLayout();
};

const LazyBandwidthStatsModal = lazy(() => import("./components/BandwidthStatsModal"));
const LazyPasswordOverlay = lazy(() => import("./components/PasswordOverlay"));
const LazySessionPickerOverlay = lazy(() => import("./components/SessionPickerOverlay"));
const LazyUploadToast = lazy(() => import("./components/UploadToast"));

export const App = () => {
  const controlSocketRef = useRef<WebSocket | null>(null);
  const terminalSocketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  /** Set to true when user-initiated or expected close (e.g. auth error) */
  const suppressReconnectRef = useRef(false);
  /** Zellij pane viewport width — used to match xterm cols to pane content. */
  const paneViewportColsRef = useRef(0);
  /** Deferred terminal auth credentials — stored on auth_ok, consumed on attached. */
  const pendingTerminalAuthRef = useRef<{ password: string; clientId: string } | null>(null);

  const [serverConfig, setServerConfig] = useState<ServerConfig | null>(null);
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [statusMessage, setStatusMessage] = useState<string>("");
  const [password, setPassword] = useState(sessionStorage.getItem("remux-password") ?? "");
  const [needsPasswordInput, setNeedsPasswordInput] = useState(false);
  const [passwordErrorMessage, setPasswordErrorMessage] = useState("");
  const [authReady, setAuthReady] = useState(false);

  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot>({ sessions: [], capturedAt: "" });
  const [capabilities, setCapabilities] = useState<BackendCapabilities | null>(null);
  const [clientView, setClientView] = useState<ClientView | null>(null);
  const [attachedSession, setAttachedSession] = useState<string>("");
  const attachedSessionRef = useRef("");
  const [pendingSessionAttachment, setPendingSessionAttachment] = useState<string | null>(null);
  const [sessionChoices, setSessionChoices] = useState<SessionSummary[] | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() =>
    localStorage.getItem("remux-sidebar-collapsed") === "true"
  );
  const [composeText, setComposeText] = useState("");

  const [viewMode, setViewMode] = useState<"inspect" | "terminal">("terminal");
  const [scrollFontSize, setScrollFontSize] = useState<number>(
    Number(localStorage.getItem("remux-scroll-font-size")) || 0
  );
  const [inspectLineCount, setInspectLineCount] = useState(1000);
  const [inspectPaneFilter, setInspectPaneFilter] = useState("all");
  const [inspectSearchQuery, setInspectSearchQuery] = useState("");
  const [inspectSnapshot, setInspectSnapshot] = useState<TabInspectSnapshot | null>(null);
  const [inspectLoading, setInspectLoading] = useState(false);
  const [inspectErrorMessage, setInspectErrorMessage] = useState("");
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    const stored = localStorage.getItem("remux-theme");
    if (stored === "light") return "light";
    return "dark"; // migrate old themes (midnight, amber, etc.) to dark
  });
  const [stickyZoom, setStickyZoom] = useState(getInitialStickyZoom);
  const { mobileLandscape, mobileLayout, viewportHeight } = useViewportLayout();
  const sendRawToSocket = useCallback((data: string): void => {
    const socket = terminalSocketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      debugLog("send_terminal.blocked", {
        readyState: socket?.readyState,
        bytes: data.length
      });
      return;
    }
    debugLog("send_terminal", { bytes: data.length });
    socket.send(data);
  }, []);

  const toolbarRef = useRef<ToolbarHandle>(null);
  const {
    copySelection,
    fileInputRef,
    fitAddonRef,
    focusTerminal,
    resetTerminalBuffer,
    scrollbackContentRef,
    sendTerminalResize,
    terminalContainerRef,
    terminalRef
  } = useTerminalRuntime({
    onSendRaw: sendRawToSocket,
    mobileLayout,
    paneViewportColsRef,
    serverConfig,
    setStatusMessage,
    terminalSocketRef,
    theme,
    toolbarRef
  });
  const notifyTerminalResize = useCallback(() => {
    sendTerminalResize(terminalSocketRef);
  }, [sendTerminalResize]);

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
  const [workspaceOrder, setWorkspaceOrder] = useState<WorkspaceOrderState>(() => {
    try {
      const stored = localStorage.getItem(WORKSPACE_ORDER_STORAGE_KEY);
      if (!stored) {
        return { sessions: [], tabsBySession: {} };
      }
      return normalizeWorkspaceOrder(JSON.parse(stored));
    } catch {
      return { sessions: [], tabsBySession: {} };
    }
  });

  const [bandwidthStats, setBandwidthStats] = useState<BandwidthStats | null>(null);
  const [statsVisible, setStatsVisible] = useState(false);
  const rttTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const inspectRequestRef = useRef<{
    requestKey: string;
    sessionName: string;
    tabIndex: number;
  } | null>(null);
  const inspectRequestTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastInspectRequestKeyRef = useRef<string | null>(null);
  const inspectLineCountInitializedRef = useRef(false);

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

  // Local selection state for instant UI feedback before server snapshot arrives
  const [selectedWindowIndex, setSelectedWindowIndex] = useState<number | null>(null);
  const [selectedPaneId, setSelectedPaneId] = useState<string | null>(null);
  const awaitingSessionSelection = isAwaitingSessionSelection(sessionChoices, attachedSession);
  const awaitingSessionAttachment = isAwaitingSessionAttachment(
    pendingSessionAttachment,
    attachedSession
  );

  const activeSession: SessionState | undefined = useMemo(() => {
    return resolveActiveSession(
      snapshot.sessions,
      attachedSession,
      awaitingSessionSelection,
      awaitingSessionAttachment
    );
  }, [snapshot.sessions, attachedSession, awaitingSessionSelection, awaitingSessionAttachment]);

  const activeTab: TabState | undefined = useMemo(() => {
    if (!activeSession) {
      return undefined;
    }
    // Use local selection if it still exists in the snapshot
    if (selectedWindowIndex !== null) {
      const selected = activeSession.tabs.find(
        (tab) => tab.index === selectedWindowIndex
      );
      if (selected) {
        return selected;
      }
    }
    return activeSession.tabs.find((tab) => tab.active) ?? activeSession.tabs[0];
  }, [activeSession, selectedWindowIndex]);

  const activePane: PaneState | undefined = useMemo(() => {
    if (!activeTab) {
      return undefined;
    }
    // Use local selection if it still exists in the snapshot
    if (selectedPaneId !== null) {
      const selected = activeTab.panes.find((pane) => pane.id === selectedPaneId);
      if (selected) {
        return selected;
      }
    }
    return activeTab.panes.find((pane) => pane.active) ?? activeTab.panes[0];
  }, [activeTab, selectedPaneId]);
  const uploadFile = useFileUpload({
    activePane,
    password,
    serverConfig,
    setStatusMessage,
    setUploadToast,
    token
  });

  const orderedSessions = useMemo(
    () => orderSessions(snapshot.sessions, workspaceOrder),
    [snapshot.sessions, workspaceOrder]
  );
  const orderedActiveTabs = useMemo(
    () => activeSession ? orderTabs(activeSession.name, activeSession.tabs, workspaceOrder) : [],
    [activeSession, workspaceOrder]
  );
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

  const sendControl = (payload: Record<string, unknown>): void => {
    if (controlSocketRef.current?.readyState !== WebSocket.OPEN) {
      debugLog("send_control.blocked", {
        payload,
        readyState: controlSocketRef.current?.readyState
      });
      setErrorMessage("control websocket disconnected");
      return;
    }
    setErrorMessage("");
    debugLog("send_control", payload);
    controlSocketRef.current.send(JSON.stringify(payload));
  };

  useEffect(() => {
    localStorage.setItem(getSnippetStorageKey(), JSON.stringify(snippets));
  }, [snippets]);

  useEffect(() => {
    localStorage.setItem(WORKSPACE_ORDER_STORAGE_KEY, JSON.stringify(workspaceOrder));
  }, [workspaceOrder]);

  useEffect(() => {
    setQuickSnippetIndex(0);
  }, [snippetPickerQuery]);

  const requestTabInspect = useCallback((session: SessionState, tab: TabState): void => {
    if (!authReady || controlSocketRef.current?.readyState !== WebSocket.OPEN) {
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
      tabIndex: tab.index
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

  const cancelReconnect = (): void => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  };

  const scheduleReconnect = (passwordValue: string): void => {
    if (suppressReconnectRef.current) {
      return;
    }
    cancelReconnect();
    const attempt = reconnectAttemptRef.current++;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
    debugLog("reconnect.schedule", { attempt, delay });
    setStatusMessage(`reconnecting in ${(delay / 1000).toFixed(0)}s...`);
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      debugLog("reconnect.attempt", { attempt });
      setStatusMessage("reconnecting...");
      openControlSocket(passwordValue);
    }, delay);
  };

  const openTerminalSocket = (passwordValue: string, clientId: string): void => {
    debugLog("terminal_socket.open.begin", { hasPassword: Boolean(passwordValue) });
    if (terminalSocketRef.current) {
      terminalSocketRef.current.onclose = null;
      terminalSocketRef.current.close();
    }

    const socket = new WebSocket(`${wsOrigin}/ws/terminal`);
    socket.onopen = () => {
      debugLog("terminal_socket.onopen");
      socket.send(JSON.stringify({ type: "auth", token, password: passwordValue || undefined, clientId }));
      setStatusMessage("terminal connected");
      let retries = 0;
      const tryFit = () => {
        if (fitAddonRef.current && terminalRef.current) {
          fitAddonRef.current.fit();
          if (terminalRef.current.cols < 20 && retries < 5) {
            retries++;
            setTimeout(tryFit, 200);
            return;
          }
          if (terminalRef.current.cols < 20) {
            terminalRef.current.resize(80, 24);
          }
        }
        notifyTerminalResize();
      };
      setTimeout(tryFit, 300);
    };
    socket.onmessage = (event) => {
      debugLog("terminal_socket.onmessage", {
        type: typeof event.data,
        bytes: typeof event.data === "string" ? event.data.length : 0
      });
      const data = typeof event.data === "string" ? event.data : "";
      terminalRef.current?.write(data);
      if (data.includes("\x07") && attachedSession) {
        setBellSessions((current) => new Set(current).add(attachedSession));
      }
    };
    socket.onclose = (event) => {
      debugLog("terminal_socket.onclose", { code: event.code, reason: event.reason });
      if (event.code === 4001) {
        setErrorMessage("terminal authentication failed");
      }
    };
    socket.onerror = () => {
      debugLog("terminal_socket.onerror");
    };
    terminalSocketRef.current = socket;
  };

  const openControlSocket = (passwordValue: string): void => {
    debugLog("control_socket.open.begin", { hasPassword: Boolean(passwordValue) });
    cancelReconnect();
    if (controlSocketRef.current) {
      controlSocketRef.current.onclose = null;
      controlSocketRef.current.close();
    }

    const socket = new WebSocket(`${wsOrigin}/ws/control`);
    socket.onopen = () => {
      debugLog("control_socket.onopen");
      socket.send(JSON.stringify({
        type: "auth",
        token,
        password: passwordValue || undefined,
        ...(attachedSessionRef.current ? { session: attachedSessionRef.current } : {})
      }));
    };
    socket.onmessage = (event) => {
      debugLog("control_socket.onmessage.raw", { bytes: String(event.data).length });
      try {
        const raw = JSON.parse(String(event.data)) as Record<string, unknown>;
        if (raw.type === "bandwidth_stats" && raw.stats) {
          setBandwidthStats(raw.stats as BandwidthStats);
          return;
        }
        if (raw.type === "pong" && typeof raw.timestamp === "number") {
          const rtt = Math.round(performance.now() - raw.timestamp);
          setBandwidthStats((prev) => prev ? { ...prev, rttMs: rtt } : null);
          return;
        }
      } catch {
        // continue to typed parsing
      }

      const message = parseMessage(String(event.data));
      if (!message) {
        debugLog("control_socket.onmessage.parse_error", { raw: String(event.data) });
        return;
      }
      debugLog("control_socket.onmessage", { type: message.type });

      switch (message.type) {
        case "auth_ok": {
          reconnectAttemptRef.current = 0;
          suppressReconnectRef.current = false;
          setErrorMessage("");
          setPasswordErrorMessage("");
          setAuthReady(true);
          setNeedsPasswordInput(false);
          if (message.requiresPassword && passwordValue) {
            sessionStorage.setItem("remux-password", passwordValue);
          } else {
            sessionStorage.removeItem("remux-password");
          }
          if (message.capabilities) setCapabilities(message.capabilities);
          pendingTerminalAuthRef.current = { password: passwordValue, clientId: message.clientId };
          return;
        }
        case "auth_error": {
          suppressReconnectRef.current = true;
          setErrorMessage(message.reason);
          setAuthReady(false);
          const passwordAuthFailed =
            message.reason === "invalid password" || Boolean(serverConfig?.passwordRequired);
          if (passwordAuthFailed) {
            setNeedsPasswordInput(true);
            setPasswordErrorMessage(formatPasswordError(message.reason));
            sessionStorage.removeItem("remux-password");
          }
          return;
        }
        case "attached": {
          resetTerminalBuffer();
          setAttachedSession(message.session);
          attachedSessionRef.current = message.session;
          setPendingSessionAttachment(null);
          setSelectedWindowIndex(null);
          setSelectedPaneId(null);
          setSessionChoices(null);
          setDrawerOpen(false);
          setStatusMessage(`attached: ${message.session}`);
          if (pendingTerminalAuthRef.current) {
            openTerminalSocket(
              pendingTerminalAuthRef.current.password,
              pendingTerminalAuthRef.current.clientId
            );
            pendingTerminalAuthRef.current = null;
          }
          fitAddonRef.current?.fit();
          notifyTerminalResize();
          return;
        }
        case "session_picker": {
          resetTerminalBuffer();
          setAttachedSession("");
          attachedSessionRef.current = "";
          setPendingSessionAttachment(null);
          setSelectedWindowIndex(null);
          setSelectedPaneId(null);
          setSessionChoices(message.sessions);
          return;
        }
        case "workspace_state": {
          setSnapshot(message.workspace);
          if (message.clientView) setClientView(message.clientView);
          const inferredAttachedSession = inferAttachedSessionFromWorkspace(
            message.workspace.sessions,
            message.clientView ?? null
          );
          if (inferredAttachedSession) {
            setAttachedSession(inferredAttachedSession);
            attachedSessionRef.current = inferredAttachedSession;
            setPendingSessionAttachment(null);
            setSessionChoices(null);
            setStatusMessage(`attached: ${inferredAttachedSession}`);
          }
          setSelectedWindowIndex(null);
          setSelectedPaneId(null);
          if (message.clientView && shouldUsePaneViewportCols(serverConfig?.backendKind)) {
            const session = message.workspace.sessions.find((entry) => entry.name === message.clientView!.sessionName);
            const tab = session?.tabs.find((entry) => entry.index === message.clientView!.tabIndex);
            const pane = tab?.panes.find((entry) => entry.id === message.clientView!.paneId);
            const paneWidth = pane?.width ?? 0;
            if (paneWidth > 0) {
              paneViewportColsRef.current = paneWidth;
              const terminal = terminalRef.current;
              if (terminal && terminal.cols !== paneWidth) {
                terminal.resize(paneWidth, terminal.rows);
                notifyTerminalResize();
              }
            }
          } else {
            paneViewportColsRef.current = 0;
          }
          return;
        }
        case "error":
          setErrorMessage(message.message);
          if (viewMode === "inspect") {
            setInspectErrorMessage(message.message);
          }
          return;
        case "info":
          setStatusMessage(message.message);
          return;
        case "scrollback":
          return;
        case "tab_history": {
          const pending = inspectRequestRef.current;
          if (!pending) {
            return;
          }
          if (pending.sessionName !== message.sessionName || pending.tabIndex !== message.tabIndex) {
            return;
          }
          if (inspectRequestTimerRef.current) {
            clearTimeout(inspectRequestTimerRef.current);
            inspectRequestTimerRef.current = null;
          }
          setInspectSnapshot(buildInspectSnapshotFromServerHistory(message));
          setInspectLoading(false);
          setInspectErrorMessage("");
          return;
        }
      }
    };
    socket.onclose = () => {
      debugLog("control_socket.onclose");
      setAuthReady(false);
      setErrorMessage("");
      if (viewMode === "inspect") {
        setInspectErrorMessage("Inspect disconnected. Reconnecting…");
      }
      terminalSocketRef.current?.close();
      terminalSocketRef.current = null;
      scheduleReconnect(passwordValue);
    };
    controlSocketRef.current = socket;
  };

  // Theme effect: apply data-theme attribute and persist selection
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("remux-theme", theme);
  }, [theme]);

  useEffect(() => {
    if (!token) {
      setErrorMessage("Missing token in URL");
      return;
    }

    debugLog("config.fetch.begin");
    fetch("/api/config")
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`config request failed: ${response.status}`);
        }
        const config = (await response.json()) as ServerConfig;
        debugLog("config.fetch.ok", config);
        setServerConfig(config);

        if (config.passwordRequired && !password) {
          debugLog("config.fetch.password_required");
          setNeedsPasswordInput(true);
          setPasswordErrorMessage("");
          return;
        }

        openControlSocket(password);
      })
      .catch((error: Error) => {
        debugLog("config.fetch.error", { message: error.message });
        setErrorMessage(error.message);
      });
  }, []);

  useEffect(() => {
    localStorage.setItem("remux-sidebar-collapsed", sidebarCollapsed ? "true" : "false");
  }, [sidebarCollapsed]);

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
      setSessionChoices(null);
    }
  }, [attachedSession]);

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
    setPendingSessionAttachment(onlySession.name);
    setStatusMessage(`attaching: ${onlySession.name}`);
    setDrawerOpen(false);
    sendControl({ type: "select_session", session: onlySession.name });
  }, [attachedSession, pendingSessionAttachment, sessionChoices, snapshot.sessions]);

  useEffect(() => {
    return () => {
      if (inspectRequestTimerRef.current) {
        clearTimeout(inspectRequestTimerRef.current);
      }
      controlSocketRef.current?.close();
      terminalSocketRef.current?.close();
    };
  }, []);

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

    requestTabInspect(activeSession, activeTab);
  }, [activeSession, activeTab, authReady, inspectLineCount, requestTabInspect, viewMode]);

  // Re-fit terminal when switching to terminal mode
  useEffect(() => {
    if (viewMode === "terminal" && fitAddonRef.current) {
      // Double-fit: once immediately, once after CSS settles
      const doFit = () => {
        fitAddonRef.current?.fit();
        notifyTerminalResize();
      };
      requestAnimationFrame(doFit);
      const timer = setTimeout(doFit, 150);
      return () => clearTimeout(timer);
    }
  }, [fitAddonRef, notifyTerminalResize, viewMode]);

  // No dynamic font-size calculation — CSS handles responsive sizing via clamp()

  // Persist sticky zoom state — only when user explicitly toggles (not on
  // programmatic defaults like the zellij fallback below).
  const stickyZoomUserSetRef = useRef(false);
  useEffect(() => {
    if (!stickyZoomUserSetRef.current) return;
    localStorage.setItem("remux-sticky-zoom", stickyZoom ? "true" : "false");
  }, [stickyZoom]);

  // Default sticky zoom OFF for zellij when user has no stored preference.
  // Does NOT persist to localStorage so it won't affect other backends.
  useEffect(() => {
    if (!serverConfig) return;
    const stored = localStorage.getItem("remux-sticky-zoom");
    if (stored !== null) return;
    if (serverConfig.backendKind === "zellij") {
      setStickyZoom(false);
    }
  }, [serverConfig]);

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
      topStatus,
      snapshotCapturedAt: snapshot.capturedAt,
      sessions: sessionSummary
    };
    window.__remuxDebugState = derived;
    debugLog("derived_state", derived);
  }, [attachedSession, activeSession, activeTab, activePane, snapshot, topStatus]);

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

  const submitPassword = (): void => {
    setPasswordErrorMessage("");
    openControlSocket(password);
  };

  const createSession = (): void => {
    const name = window.prompt("Session name", "main");
    if (!name) {
      return;
    }
    setPendingSessionAttachment(name);
    setStatusMessage(`attaching: ${name}`);
    setSessionChoices(null);
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
    setSelectedWindowIndex(tab.index);
    setSelectedPaneId(null);
    sendControl({ type: "select_tab", session: activeSession.name, tabIndex: tab.index });
    if (stickyZoom && capabilities?.supportsFullscreenPane && !tab.active) {
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
      setSelectedWindowIndex(null);
      setSelectedPaneId(null);
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
    sendControl({ type: "send_compose", text });
    setComposeText("");
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
    requestTabInspect(activeSession, activeTab);
  }, [activeSession, activeTab, requestTabInspect]);

  const loadMoreInspect = useCallback((): void => {
    const step = serverConfig?.scrollbackLines ?? 1000;
    setInspectLineCount((current) => current + step);
  }, [serverConfig?.scrollbackLines]);

  return (
    <div
      className={`app-shell${sidebarCollapsed ? " sidebar-collapsed" : ""}${mobileLayout ? " mobile-layout" : ""}${mobileLandscape ? " mobile-landscape" : ""}`}
      style={{ "--app-height": `${viewportHeight}px` } as CSSProperties}
    >
      <div className="main-content">
      <AppHeader
        activeTabLabel={activeTab ? `${activeTab.index}: ${activeTab.name}` : "-"}
        awaitingSessionSelection={awaitingSessionSelection}
        bandwidthStats={bandwidthStats}
        beginDrag={beginDrag}
        draggedTabKey={draggedTabKey}
        mobileLayout={mobileLayout}
        onCloseTab={closeHeaderTab}
        onCreateTab={activeSession ? () => sendControl({ type: "new_tab", session: activeSession.name }) : undefined}
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
        onToggleViewMode={() => setViewMode((mode) => mode === "inspect" ? "terminal" : "inspect")}
        renameHandledByKeyRef={renameHandledByKeyRef}
        renameTabValue={renameWindowValue}
        sidebarCollapsed={sidebarCollapsed}
        serverConfig={serverConfig}
        supportsTabRename={capabilities?.supportsTabRename ?? false}
        tabDropTarget={tabDropTarget}
        tabs={headerTabs}
        topStatus={topStatus}
        viewMode={viewMode}
        supportsPreciseScrollback={capabilities?.supportsPreciseScrollback ?? true}
        formatBytes={formatBytes}
      />

      <TerminalStage
        dragOver={dragOver}
        inspectErrorMessage={inspectErrorMessage}
        inspectLineCount={inspectLineCount}
        inspectLoading={inspectLoading}
        inspectPaneFilter={inspectPaneFilter}
        inspectSearchQuery={inspectSearchQuery}
        inspectSnapshot={inspectSnapshot}
        onInspectLoadMore={loadMoreInspect}
        onInspectPaneFilterChange={setInspectPaneFilter}
        onInspectRefresh={refreshInspect}
        onInspectSearchQueryChange={setInspectSearchQuery}
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
        terminalContainerRef={terminalContainerRef}
        viewMode={viewMode}
      />

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

      <Toolbar
        ref={toolbarRef}
        sendRaw={sendRawToSocket}
        onFocusTerminal={focusTerminal}
        fileInputRef={fileInputRef}
        setStatusMessage={setStatusMessage}
        snippets={snippets}
        onExecuteSnippet={executeSnippet}
        hidden={viewMode !== "terminal"}
      />

      <PinnedSnippetsBar
        snippets={pinnedSnippets}
        onEditSnippet={setEditingSnippet}
        onExecuteSnippet={executeSnippet}
        onOpenDrawer={() => setDrawerOpen(true)}
      />

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

      <ComposeBar
        composeText={composeText}
        onChange={setComposeText}
        onFilePaste={handleComposeFilePaste}
        onKeyDown={handleComposeKeyDown}
        onSend={sendCompose}
      />
      <SnippetPicker
        activeIndex={quickSnippetIndex}
        onExecuteSnippet={executeSnippet}
        onHoverIndex={setQuickSnippetIndex}
        onPickComplete={() => setComposeText("")}
        query={snippetPickerQuery}
        snippets={visibleQuickSnippetResults}
      />

      </div>{/* end main-content */}

      <aside className={`sidebar drawer${drawerOpen ? " open" : ""}`}>
        <div className="sidebar-header">
          <span className="sidebar-brand">REMUX</span>
          <button
            className="sidebar-close"
            onClick={() => setDrawerOpen(false)}
            data-testid="drawer-close"
            aria-label="Close sidebar"
          >
            <span className="sidebar-close-icon" aria-hidden="true">×</span>
          </button>
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
          setSelectedPaneId={setSelectedPaneId}
          setSelectedWindowIndex={setSelectedWindowIndex}
          setSessionDropTarget={setSessionDropTarget}
          snapshot={snapshot}
          beginDrag={beginDrag}
          draggedSessionName={draggedSessionName}
          onCloseSession={(sessionName) => sendControl({ type: "close_session", session: sessionName })}
          onRenameSession={(sessionName, newName) => sendControl({ type: "rename_session", session: sessionName, newName })}
          onReorderSessions={(draggedName, targetName) => setWorkspaceOrder((current) => reorderSessionState(current, draggedName, targetName))}
          onSelectSession={(sessionName) => sendControl({ type: "select_session", session: sessionName })}
          supportsSessionRename={capabilities?.supportsSessionRename ?? false}
        />

        <AppearanceSection
          onResetScrollFontSize={() => {
            setScrollFontSize(0);
            localStorage.removeItem("remux-scroll-font-size");
          }}
          onSetTheme={setTheme}
          onUpdateScrollFontSize={(value) => {
            setScrollFontSize(value);
            localStorage.setItem("remux-scroll-font-size", String(value));
          }}
          scrollFontSize={scrollFontSize}
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
                {serverConfig.backendKind && (
                  <div className="drawer-backend-switcher">
                    <span className="drawer-backend-label">Backend:</span>
                    {(["tmux", "zellij", "conpty"] as const).map((kind) => (
                      <button
                        key={kind}
                        className={`drawer-backend-btn${serverConfig.backendKind === kind ? " active" : ""}`}
                        disabled={serverConfig.backendKind === kind}
                        onClick={async () => {
                          const token = new URLSearchParams(window.location.search).get("token");
                          try {
                            const resp = await fetch("/api/switch-backend", {
                              method: "POST",
                              headers: {
                                "Content-Type": "application/json",
                                ...(token ? { Authorization: `Bearer ${token}` } : {}),
                                ...(password ? { "X-Password": password } : {})
                              },
                              body: JSON.stringify({ backend: kind })
                            });
                            if (resp.ok) {
                              // Refresh config to update backendKind display
                              const newConfig = await fetch("/api/config").then((r) => r.json());
                              setServerConfig(newConfig);
                            } else {
                              const err = await resp.json().catch(() => ({}));
                              setErrorMessage(`Switch failed: ${(err as {error?: string}).error ?? resp.statusText}`);
                            }
                          } catch {
                            setErrorMessage("Failed to switch backend");
                          }
                        }}
                      >{kind}</button>
                    ))}
                  </div>
                )}
              </div>
            )}
      </aside>

      {drawerOpen && <div className="sidebar-backdrop" onClick={() => setDrawerOpen(false)} data-testid="drawer-backdrop" />}

      <Suspense fallback={null}>
        <LazySessionPickerOverlay
          mobileLayout={mobileLayout}
          sessions={sessionChoices}
          onSelectSession={(sessionName) => sendControl({ type: "select_session", session: sessionName })}
        />
      </Suspense>

      {/* Legacy overlay scrollback removed — now inline in scroll viewMode */}

      <Suspense fallback={null}>
        {statsVisible && <LazyBandwidthStatsModal onClose={() => setStatsVisible(false)} stats={bandwidthStats} />}
      </Suspense>

      <Suspense fallback={null}>
        {needsPasswordInput && (
          <LazyPasswordOverlay
            onChange={(value) => {
              setPassword(value);
              if (passwordErrorMessage) {
                setPasswordErrorMessage("");
              }
            }}
            onSubmit={submitPassword}
            password={password}
            passwordErrorMessage={passwordErrorMessage}
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
    </div>
  );
};

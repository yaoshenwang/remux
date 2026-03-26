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
  orderSessions,
  orderTabs,
  reorderSessionState,
  reorderSessionTabs,
} from "./workspace-order";
import { deriveTopStatus, formatBytes } from "./app-status";
import { deriveSnippetPickerState } from "./compose-picker";
import type { PendingSnippetExecution } from "./app-types";
import { useFileUpload } from "./hooks/useFileUpload";
import { useViewportLayout } from "./mobile-layout";
import { useTerminalRuntime } from "./hooks/useTerminalRuntime";
import { useRemuxConnection } from "./hooks/useRemuxConnection";
import { useClientPreferences } from "./hooks/useClientPreferences";
import {
  buildInspectSnapshotFromServerHistory,
  type TabInspectSnapshot
} from "./inspect-state";
import {
  debugLog,
  debugMode,
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
  ControlServerMessage
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

const LazyBandwidthStatsModal = lazy(() => import("./components/BandwidthStatsModal"));
const LazyPasswordOverlay = lazy(() => import("./components/PasswordOverlay"));
const LazySessionPickerOverlay = lazy(() => import("./components/SessionPickerOverlay"));
const LazyUploadToast = lazy(() => import("./components/UploadToast"));

export const App = () => {
  /** Zellij pane viewport width — used to match xterm cols to pane content. */
  const paneViewportColsRef = useRef(0);
  const terminalSocketRef = useRef<WebSocket | null>(null);
  /** Deferred terminal auth credentials — stored on auth_ok, consumed on attached. */
  const pendingTerminalAuthRef = useRef<{ password: string; clientId: string } | null>(null);

  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot>({ sessions: [], capturedAt: "" });
  const [clientView, setClientView] = useState<ClientView | null>(null);
  const [attachedSession, setAttachedSession] = useState<string>("");
  const attachedSessionRef = useRef("");
  const [pendingSessionAttachment, setPendingSessionAttachment] = useState<string | null>(null);
  const [sessionChoices, setSessionChoices] = useState<SessionSummary[] | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [composeText, setComposeText] = useState("");

  // ── Preferences hook ──
  const prefs = useClientPreferences();
  const { theme, sidebarCollapsed, setSidebarCollapsed, stickyZoom, setStickyZoom,
    scrollFontSize, workspaceOrder, setWorkspaceOrder } = prefs;

  const [viewMode, setViewMode] = useState<"inspect" | "terminal">("terminal");
  const viewModeRef = useRef(viewMode);
  useEffect(() => { viewModeRef.current = viewMode; }, [viewMode]);
  const [inspectLineCount, setInspectLineCount] = useState(1000);
  const [inspectPaneFilter, setInspectPaneFilter] = useState("all");
  const [inspectSearchQuery, setInspectSearchQuery] = useState("");
  const [inspectSnapshot, setInspectSnapshot] = useState<TabInspectSnapshot | null>(null);
  const [inspectLoading, setInspectLoading] = useState(false);
  const [inspectErrorMessage, setInspectErrorMessage] = useState("");
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
    },
    onControlMessage: (message) => {
      switch (message.type) {
        case "attached": {
          resetTerminalBufferRef.current();
          setAttachedSession(message.session);
          attachedSessionRef.current = message.session;
          setPendingSessionAttachment(null);
          setSelectedWindowIndex(null);
          setSelectedPaneId(null);
          setSessionChoices(null);
          setDrawerOpen(false);
          connectionActionsRef.current.setStatusMessage(`attached: ${message.session}`);
          if (pendingTerminalAuthRef.current) {
            openTerminalSocket(
              pendingTerminalAuthRef.current.password,
              pendingTerminalAuthRef.current.clientId
            );
            pendingTerminalAuthRef.current = null;
          }
          notifyTerminalResizeRef.current({ notify: true, retryUntilVisible: true });
          return;
        }
        case "session_picker": {
          resetTerminalBufferRef.current();
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
            connectionActionsRef.current.setStatusMessage(`attached: ${inferredAttachedSession}`);
          }
          setSelectedWindowIndex(null);
          setSelectedPaneId(null);
          if (message.clientView && shouldUsePaneViewportCols(connectionActionsRef.current.serverConfig?.backendKind)) {
            const session = message.workspace.sessions.find((entry) => entry.name === message.clientView!.sessionName);
            const tab = session?.tabs.find((entry: TabState) => entry.index === message.clientView!.tabIndex);
            const pane = tab?.panes.find((entry: PaneState) => entry.id === message.clientView!.paneId);
            const paneWidth = pane?.width ?? 0;
            if (paneWidth > 0) {
              paneViewportColsRef.current = paneWidth;
              notifyTerminalResizeRef.current({ notify: true, retryUntilVisible: true });
            }
          } else {
            paneViewportColsRef.current = 0;
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
        case "tab_history": {
          const pending = inspectRequestRef.current;
          if (!pending) return;
          if (pending.sessionName !== message.sessionName || pending.tabIndex !== message.tabIndex) return;
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
    },
    onControlClose: () => {
      if (viewModeRef.current === "inspect") {
        setInspectErrorMessage("Inspect disconnected. Reconnecting…");
      }
      terminalSocketRef.current?.close();
      terminalSocketRef.current = null;
    },
    getAttachedSession: () => attachedSessionRef.current,
  });

  const { authReady, serverConfig, capabilities, errorMessage, statusMessage, password,
    needsPasswordInput, passwordErrorMessage, bandwidthStats, sendControl } = connection;

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
    copySelection,
    fileInputRef,
    focusTerminal,
    requestTerminalFit,
    resetTerminalBuffer,
    scrollbackContentRef,
    terminalContainerRef,
    terminalRef
  } = useTerminalRuntime({
    onSendRaw: sendRawToSocket,
    mobileLayout,
    paneViewportColsRef,
    serverConfig,
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

  // ── Terminal socket management ──
  const openTerminalSocket = useCallback((passwordValue: string, clientId: string): void => {
    debugLog("terminal_socket.open.begin", { hasPassword: Boolean(passwordValue) });
    if (terminalSocketRef.current) {
      terminalSocketRef.current.onclose = null;
      terminalSocketRef.current.close();
    }

    const socket = new WebSocket(`${wsOrigin}/ws/terminal`);
    socket.onopen = () => {
      debugLog("terminal_socket.onopen");
      socket.send(JSON.stringify({ type: "auth", token, password: passwordValue || undefined, clientId }));
      connectionActionsRef.current.setStatusMessage("terminal connected");
      requestTerminalFit({ notify: true, retryUntilVisible: true });
    };
    socket.onmessage = (event) => {
      debugLog("terminal_socket.onmessage", {
        type: typeof event.data,
        bytes: typeof event.data === "string" ? event.data.length : 0
      });
      const data = typeof event.data === "string" ? event.data : "";
      terminalRef.current?.write(data);
      if (data.includes("\x07") && attachedSessionRef.current) {
        setBellSessions((current) => new Set(current).add(attachedSessionRef.current));
      }
    };
    socket.onclose = (event) => {
      debugLog("terminal_socket.onclose", { code: event.code, reason: event.reason });
      if (event.code === 4001) {
        connectionActionsRef.current.setErrorMessage("terminal authentication failed");
      }
    };
    socket.onerror = () => {
      debugLog("terminal_socket.onerror");
    };
    terminalSocketRef.current = socket;
  }, [connection, requestTerminalFit, terminalRef]);

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
    setStatusMessage: connection.setStatusMessage,
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

  useEffect(() => {
    localStorage.setItem(getSnippetStorageKey(), JSON.stringify(snippets));
  }, [snippets]);

  useEffect(() => {
    setQuickSnippetIndex(0);
  }, [snippetPickerQuery]);

  const requestTabInspect = useCallback((session: SessionState, tab: TabState): void => {
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
    connection.setStatusMessage(`attaching: ${onlySession.name}`);
    setDrawerOpen(false);
    sendControl({ type: "select_session", session: onlySession.name });
  }, [attachedSession, pendingSessionAttachment, sessionChoices, snapshot.sessions]);

  useEffect(() => {
    return () => {
      if (inspectRequestTimerRef.current) {
        clearTimeout(inspectRequestTimerRef.current);
      }
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
    if (viewMode === "terminal") {
      requestTerminalFit({ notify: true, retryUntilVisible: true });
      const timer = setTimeout(() => {
        requestTerminalFit({ notify: true, retryUntilVisible: true });
      }, 150);
      return () => clearTimeout(timer);
    }
  }, [requestTerminalFit, viewMode]);

  // No dynamic font-size calculation — CSS handles responsive sizing via clamp()

  // Default sticky zoom OFF for zellij when user has no stored preference.
  useEffect(() => {
    if (!serverConfig) return;
    const stored = localStorage.getItem("remux-sticky-zoom");
    if (stored !== null) return;
    if (serverConfig.backendKind === "zellij") {
      setStickyZoom(false);
    }
  }, [serverConfig, setStickyZoom]);

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

  const createSession = (): void => {
    const name = window.prompt("Session name", "main");
    if (!name) {
      return;
    }
    setPendingSessionAttachment(name);
    connection.setStatusMessage(`attaching: ${name}`);
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
        setStatusMessage={connection.setStatusMessage}
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
          followBackendFocus={clientView?.followBackendFocus ?? false}
          onToggleFollowBackendFocus={() => sendControl({
            type: "set_follow_focus",
            follow: !(clientView?.followBackendFocus ?? false)
          })}
          onResetScrollFontSize={prefs.resetScrollFontSize}
          onSetTheme={prefs.setTheme}
          onUpdateScrollFontSize={prefs.setScrollFontSize}
          scrollFontSize={scrollFontSize}
          showFollowFocus={serverConfig?.backendKind === "zellij"}
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
                              // serverConfig is managed by the connection hook — trigger a page reload
                              window.location.reload();
                            } else {
                              const err = await resp.json().catch(() => ({}));
                              connection.setErrorMessage(`Switch failed: ${(err as {error?: string}).error ?? resp.statusText}`);
                            }
                          } catch {
                            connection.setErrorMessage("Failed to switch backend");
                          }
                        }}
                      >{kind}</button>
                    ))}
                  </div>
                )}
              </div>
            )}
      </aside>

      {mobileLayout && drawerOpen && (
        <button
          className="sidebar-close mobile-drawer-close"
          onClick={() => setDrawerOpen(false)}
          data-testid="drawer-close"
          aria-label="Close sidebar"
        >
          <span className="sidebar-close-icon" aria-hidden="true">×</span>
        </button>
      )}

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
              connection.setPassword(value);
            }}
            onSubmit={connection.submitPassword}
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

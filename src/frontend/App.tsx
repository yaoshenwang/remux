import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { themes } from "./themes";
import { ansiToHtml } from "./ansi-to-html";
import { deriveContext, formatContext } from "./context-label";
import { Toolbar, type ToolbarHandle } from "./components/Toolbar";
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
  filterSnippets,
  getPinnedSnippets,
  getSnippetStorageKey,
  groupSnippets,
  normalizeSnippets,
  reorderById,
  type SnippetGroup,
  type SnippetRecord as Snippet
} from "./snippets";
import {
  moveSessionOrder,
  moveSessionTabOrder,
  normalizeWorkspaceOrder,
  orderSessions,
  orderTabs,
  reorderSessionState,
  reorderSessionTabs,
  WORKSPACE_ORDER_STORAGE_KEY,
  getTabOrderKey,
  type WorkspaceOrderState
} from "./workspace-order";
import type {
  ControlServerMessage,
  PaneState,
  SessionState,
  SessionSummary,
  WorkspaceSnapshot,
  TabState,
  ClientView,
  BackendCapabilities
} from "../shared/protocol";

interface ServerConfig {
  version?: string;
  passwordRequired: boolean;
  scrollbackLines: number;
  pollIntervalMs: number;
  uploadMaxSize?: number;
  backendKind?: "tmux" | "zellij" | "conpty";
}

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

const query = new URLSearchParams(window.location.search);
const token = query.get("token") ?? "";
const debugMode = query.get("debug") === "1";

const wsOrigin = (() => {
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${window.location.host}`;
})();

const isMobileDevice = (): boolean =>
  window.matchMedia("(max-width: 768px), (pointer: coarse)").matches;

const getPreferredTerminalFontSize = (): number => {
  return isMobileDevice() ? 12 : 14;
};

const getInitialStickyZoom = (): boolean => {
  const stored = localStorage.getItem("remux-sticky-zoom");
  if (stored === "true") {
    return true;
  }
  if (stored === "false") {
    return false;
  }
  return window.matchMedia("(max-width: 768px)").matches;
};

const parseMessage = (raw: string): ControlServerMessage | null => {
  try {
    return JSON.parse(raw) as ControlServerMessage;
  } catch {
    return null;
  }
};

const debugLog = (event: string, payload?: unknown): void => {
  if (!debugMode) {
    return;
  }
  const entry = {
    at: new Date().toISOString(),
    event,
    payload
  };
  const current = window.__remuxDebugEvents ?? [];
  current.push(entry);
  if (current.length > 500) {
    current.splice(0, current.length - 500);
  }
  window.__remuxDebugEvents = current;
  console.log("[remux-debug]", entry.at, event, payload ?? "");
};

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 8000;

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
};

interface PendingSnippetExecution {
  snippet: Snippet;
  variables: string[];
  values: Record<string, string>;
}

export const App = () => {
  const terminalContainerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const serializeAddonRef = useRef<SerializeAddon | null>(null);
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

  const [scrollbackHtml, setScrollbackHtml] = useState("");
  const scrollbackContentRef = useRef<HTMLDivElement | null>(null);

  const [viewMode, setViewMode] = useState<"scroll" | "terminal">("terminal");
  const [scrollFontSize, setScrollFontSize] = useState<number>(
    Number(localStorage.getItem("remux-scroll-font-size")) || 0
  );

  const toolbarRef = useRef<ToolbarHandle>(null);

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

  const [theme, setTheme] = useState(() => {
    const stored = localStorage.getItem("remux-theme");
    if (stored === "light") return "light";
    return "dark"; // migrate old themes (midnight, amber, etc.) to dark
  });
  const [stickyZoom, setStickyZoom] = useState(getInitialStickyZoom);

  // Bandwidth stats
  const [bandwidthStats, setBandwidthStats] = useState<{
    rawBytesPerSec: number;
    compressedBytesPerSec: number;
    savedPercent: number;
    fullSnapshotsSent: number;
    diffUpdatesSent: number;
    avgChangedRowsPerDiff: number;
    totalRawBytes: number;
    totalCompressedBytes: number;
    totalSavedBytes: number;
    rttMs: number | null;
    protocol: string;
  } | null>(null);
  const [statsVisible, setStatsVisible] = useState(false);
  const rttTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [renamingSession, setRenamingSession] = useState<string | null>(null);
  const [renameSessionValue, setRenameSessionValue] = useState("");
  const [renamingWindow, setRenamingWindow] = useState<{ session: string; index: number } | null>(null);
  const [renameWindowValue, setRenameWindowValue] = useState("");
  const renameHandledByKeyRef = useRef(false);

  const [dragOver, setDragOver] = useState(false);
  const [uploadToast, setUploadToast] = useState<{ path: string; filename: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Bell tracking: sessions that have rung the bell since last viewed.
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

  const orderedSessions = useMemo(
    () => orderSessions(snapshot.sessions, workspaceOrder),
    [snapshot.sessions, workspaceOrder]
  );
  const orderedActiveTabs = useMemo(
    () => activeSession ? orderTabs(activeSession.name, activeSession.tabs, workspaceOrder) : [],
    [activeSession, workspaceOrder]
  );
  const groupedSnippetList: SnippetGroup[] = useMemo(
    () => groupSnippets(snippets),
    [snippets]
  );
  const pinnedSnippets = useMemo(
    () => getPinnedSnippets(snippets).slice(0, 8),
    [snippets]
  );
  const snippetPickerQuery = composeText.startsWith("/") ? composeText.slice(1) : null;
  const quickSnippetResults = useMemo(
    () => snippetPickerQuery === null ? [] : filterSnippets(snippets, snippetPickerQuery),
    [snippetPickerQuery, snippets]
  );
  const visibleQuickSnippetResults = quickSnippetResults.slice(0, 8);
  const [quickSnippetIndex, setQuickSnippetIndex] = useState(0);

  const topStatus = useMemo(() => {
    if (errorMessage) {
      return { kind: "error", label: errorMessage };
    }
    if (awaitingSessionSelection) {
      return { kind: "pending", label: "select session" };
    }
    if (awaitingSessionAttachment && pendingSessionAttachment) {
      return { kind: "pending", label: `attaching: ${pendingSessionAttachment}` };
    }
    if (statusMessage.toLowerCase().includes("disconnected") || statusMessage.toLowerCase().includes("reconnect")) {
      return { kind: "warn", label: statusMessage };
    }
    if (statusMessage.toLowerCase().includes("connected") || statusMessage.startsWith("attached:")) {
      return { kind: "ok", label: statusMessage };
    }
    if (statusMessage) {
      return { kind: "pending", label: statusMessage };
    }
    if (authReady) {
      return { kind: "ok", label: "connected" };
    }
    return { kind: "pending", label: "connecting" };
  }, [
    authReady,
    awaitingSessionAttachment,
    awaitingSessionSelection,
    errorMessage,
    pendingSessionAttachment,
    statusMessage
  ]);

  // Session color palette for tab bar color-coding.
  const sessionColors = useMemo(() => {
    const palette = ["#3b82f6", "#22c55e", "#f59e0b", "#a855f7", "#ec4899", "#06b6d4", "#ef4444", "#84cc16"];
    const colorMap = new Map<string, string>();
    snapshot.sessions.forEach((session, i) => {
      colorMap.set(session.name, palette[i % palette.length]);
    });
    return colorMap;
  }, [snapshot.sessions]);

  // Build flat tab list: one tab per tab across all sessions.
  const tabs = useMemo(() => {
    const result: Array<{
      key: string;
      label: string;
      sessionName: string;
      windowIndex: number;
      isActive: boolean;
      hasBell: boolean;
      color: string;
    }> = [];

    for (const session of snapshot.sessions) {
      for (const tab of session.tabs) {
        const isActive =
          session.name === (attachedSession || activeSession?.name) &&
          tab.index === activeTab?.index;
        result.push({
          key: `${session.name}:${tab.index}`,
          label: session.tabs.length > 1
            ? `${session.name}/${tab.name}`
            : session.name,
          sessionName: session.name,
          windowIndex: tab.index,
          isActive,
          hasBell: bellSessions.has(session.name) && !isActive,
          color: sessionColors.get(session.name) ?? "#3b82f6",
        });
      }
    }
    return result;
  }, [snapshot.sessions, attachedSession, activeSession, activeTab, bellSessions, sessionColors]);

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
  const sendRawToSocketRef = useRef(sendRawToSocket);
  const setStatusMessageRef = useRef(setStatusMessage);
  sendRawToSocketRef.current = sendRawToSocket;
  setStatusMessageRef.current = setStatusMessage;

  useEffect(() => {
    localStorage.setItem(getSnippetStorageKey(), JSON.stringify(snippets));
  }, [snippets]);

  useEffect(() => {
    localStorage.setItem(WORKSPACE_ORDER_STORAGE_KEY, JSON.stringify(workspaceOrder));
  }, [workspaceOrder]);

  useEffect(() => {
    setQuickSnippetIndex(0);
  }, [snippetPickerQuery]);

  const sendTerminalResize = (): void => {
    const socket = terminalSocketRef.current;
    const terminal = terminalRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN || !terminal) {
      debugLog("send_terminal_resize.blocked", {
        socketReadyState: socket?.readyState,
        hasTerminal: Boolean(terminal)
      });
      return;
    }
    debugLog("send_terminal_resize", { cols: terminal.cols, rows: terminal.rows });
    socket.send(
      JSON.stringify({
        type: "resize",
        cols: terminal.cols,
        rows: terminal.rows
      })
    );
  };

  const readTerminalBuffer = (): string => {
    const addon = serializeAddonRef.current;
    if (!addon) return "";
    // Serialize full terminal buffer including scrollback
    return addon.serialize({ scrollback: 10000 });
  };

  const formatPasswordError = (reason: string): string => {
    if (reason === "invalid password") {
      return "Wrong password. Try again.";
    }
    return reason;
  };

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
      socket.send(
        JSON.stringify({ type: "auth", token, password: passwordValue || undefined, clientId })
      );
      setStatusMessage("terminal connected");
      // Retry fit until cols are reasonable — layout may not be settled on first try
      let retries = 0;
      const tryFit = () => {
        if (fitAddonRef.current && terminalRef.current) {
          fitAddonRef.current.fit();
          if (terminalRef.current.cols < 20 && retries < 5) {
            retries++;
            setTimeout(tryFit, 200);
            return;
          }
          // Final fallback: if still too narrow, force 80x24
          if (terminalRef.current.cols < 20) {
            terminalRef.current.resize(80, 24);
          }
        }
        sendTerminalResize();
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
      // Detect bell character — mark the current session as having a bell.
      if (data.includes("\x07") && attachedSession) {
        setBellSessions((prev) => new Set(prev).add(attachedSession));
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
    // Strip onclose before closing to prevent triggering reconnect for intentional close
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

      // Handle bandwidth_stats and pong (not in typed protocol).
      try {
        const raw = JSON.parse(String(event.data)) as Record<string, unknown>;
        if (raw.type === "bandwidth_stats" && raw.stats) {
          setBandwidthStats(raw.stats as typeof bandwidthStats & object);
          return;
        }
        if (raw.type === "pong" && typeof raw.timestamp === "number") {
          const rtt = Math.round(performance.now() - raw.timestamp);
          setBandwidthStats((prev) => prev ? { ...prev, rttMs: rtt } : null);
          return;
        }
      } catch { /* not our extension message — continue */ }

      const message = parseMessage(String(event.data));
      if (!message) {
        debugLog("control_socket.onmessage.parse_error", { raw: String(event.data) });
        return;
      }
      debugLog("control_socket.onmessage", { type: message.type });

      switch (message.type) {
        case "auth_ok":
          debugLog("control_socket.auth_ok", {
            clientId: message.clientId,
            requiresPassword: message.requiresPassword
          });
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
          // Defer terminal WS until "attached" — the server hasn't created
          // the PTY runtime until session attach completes.
          pendingTerminalAuthRef.current = { password: passwordValue, clientId: message.clientId };
          return;
        case "auth_error":
          debugLog("control_socket.auth_error", { reason: message.reason });
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
        case "attached":
          debugLog("control_socket.attached", { session: message.session });
          resetTerminalBuffer();
          setAttachedSession(message.session);
          attachedSessionRef.current = message.session;
          setPendingSessionAttachment(null);
          setSelectedWindowIndex(null);
          setSelectedPaneId(null);
          setSessionChoices(null);
          setDrawerOpen(false);
          setStatusMessage(`attached: ${message.session}`);
          // Now open terminal socket — PTY runtime is ready
          if (pendingTerminalAuthRef.current) {
            openTerminalSocket(
              pendingTerminalAuthRef.current.password,
              pendingTerminalAuthRef.current.clientId
            );
            pendingTerminalAuthRef.current = null;
          }
          if (fitAddonRef.current) {
            fitAddonRef.current.fit();
          }
          sendTerminalResize();
          return;
        case "session_picker":
          debugLog("control_socket.session_picker", {
            sessions: message.sessions.map((session) => ({
              name: session.name,
              attached: session.attached,
              tabCount: session.tabCount
            }))
          });
          resetTerminalBuffer();
          setAttachedSession("");
          attachedSessionRef.current = "";
          setPendingSessionAttachment(null);
          setSelectedWindowIndex(null);
          setSelectedPaneId(null);
          setSessionChoices(message.sessions);
          return;
        case "workspace_state":
          debugLog("control_socket.workspace_state", {
            capturedAt: message.workspace.capturedAt,
            sessionCount: message.workspace.sessions.length,
            sessions: message.workspace.sessions.map((session) => {
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
            })
          });
          setSnapshot(message.workspace);
          if (message.clientView) setClientView(message.clientView);
          const inferredAttachedSession = inferAttachedSessionFromWorkspace(
            message.workspace.sessions,
            message.clientView
          );
          if (inferredAttachedSession) {
            setAttachedSession(inferredAttachedSession);
            attachedSessionRef.current = inferredAttachedSession;
            setPendingSessionAttachment(null);
            setSessionChoices(null);
            setStatusMessage(`attached: ${inferredAttachedSession}`);
          }
          // Clear local selections — the server now sends per-client active state,
          // so the snapshot already reflects this client's active tab/pane.
          setSelectedWindowIndex(null);
          setSelectedPaneId(null);

          // Sync xterm columns to the pane's viewport width so the terminal
          // fills exactly the pane content area (no empty right half on wide
          // screens, no truncation on narrow screens).
          if (message.clientView && shouldUsePaneViewportCols(serverConfig?.backendKind)) {
            const session = message.workspace.sessions.find(
              (s) => s.name === message.clientView!.sessionName
            );
            const tab = session?.tabs.find(
              (t) => t.index === message.clientView!.tabIndex
            );
            const pane = tab?.panes.find(
              (p) => p.id === message.clientView!.paneId
            );
            const paneWidth = pane?.width ?? 0;
            if (paneWidth > 0) {
              paneViewportColsRef.current = paneWidth;
              const terminal = terminalRef.current;
              if (terminal && terminal.cols !== paneWidth) {
                terminal.resize(paneWidth, terminal.rows);
                sendTerminalResize();
              }
            }
          } else {
            paneViewportColsRef.current = 0;
          }
          return;
        case "scrollback":
          // Legacy handler — scroll mode now reads from xterm buffer directly
          return;
        case "error":
          debugLog("control_socket.error", { message: message.message });
          setErrorMessage(message.message);
          return;
        case "info":
          debugLog("control_socket.info", { message: message.message });
          setStatusMessage(message.message);
          return;
      }
    };

    socket.onclose = () => {
      debugLog("control_socket.onclose");
      setAuthReady(false);
      setErrorMessage("");
      // Close terminal socket too — it will be re-opened on reconnect
      terminalSocketRef.current?.close();
      terminalSocketRef.current = null;
      scheduleReconnect(passwordValue);
    };

    controlSocketRef.current = socket;
  };

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

  // Persist sidebar collapsed state
  useEffect(() => {
    localStorage.setItem("remux-sidebar-collapsed", sidebarCollapsed ? "true" : "false");
  }, [sidebarCollapsed]);

  // Theme effect: apply data-theme attribute, persist, update xterm theme
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("remux-theme", theme);
    const themeConfig = themes[theme];
    if (themeConfig && terminalRef.current) {
      terminalRef.current.options.theme = themeConfig.xterm;
    }
  }, [theme]);

  useEffect(() => {
    if (attachedSession) {
      setSessionChoices(null);
    }
  }, [attachedSession]);

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
    if (!terminalContainerRef.current || terminalRef.current) {
      return;
    }

    const initialFontSize = getPreferredTerminalFontSize();
    const themeConfig = themes[theme];
    const terminal = new Terminal({
      cursorBlink: true,
      scrollback: 10000,
      fontFamily: "'MesloLGS NF', 'MesloLGM NF', 'Hack Nerd Font', 'FiraCode Nerd Font', 'JetBrainsMono Nerd Font', 'DejaVu Sans Mono Nerd Font', 'Symbols Nerd Font Mono', Menlo, Monaco, 'Courier New', monospace",
      fontSize: initialFontSize,
      theme: themeConfig?.xterm ?? {
        background: "#0d1117",
        foreground: "#d1e4ff",
        cursor: "#93c5fd"
      }
    });
    const fitAddon = new FitAddon();
    const serializeAddon = new SerializeAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(serializeAddon);
    terminal.attachCustomKeyEventHandler((event) => {
      const modifierKey = navigator.platform.toLowerCase().includes("mac")
        ? event.metaKey
        : event.ctrlKey;
      const key = event.key.toLowerCase();

      if (modifierKey && key === "c" && terminal.hasSelection()) {
        void copySelection();
        event.preventDefault();
        return false;
      }

      if (modifierKey && key === "v") {
        void navigator.clipboard.readText()
          .then((text) => {
            if (text) {
              sendRawToSocketRef.current(text);
              focusTerminal();
            }
          })
          .catch(() => {
            setStatusMessageRef.current("clipboard read failed");
          });
        event.preventDefault();
        return false;
      }

      return true;
    });
    terminal.open(terminalContainerRef.current);
    requestAnimationFrame(() => {
      fitAddon.fit();
      terminal.focus();
    });

    const disposable = terminal.onData((data) => {
      const output = toolbarRef.current?.applyModifiersAndClear(data) ?? data;
      sendRawToSocket(output);
    });

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    serializeAddonRef.current = serializeAddon;

    const fitAndNotifyResize = () => {
      // Skip resize when container is hidden (e.g. scroll mode sets display:none)
      // to avoid shrinking the tmux pane to near-zero columns
      const container = terminalContainerRef.current;
      if (!container || container.clientWidth === 0 || container.clientHeight === 0) {
        return;
      }
      const preferredFontSize = getPreferredTerminalFontSize();
      if (terminal.options.fontSize !== preferredFontSize) {
        terminal.options.fontSize = preferredFontSize;
      }
      fitAddon.fit();
      const paneCols = paneViewportColsRef.current;
      if (
        shouldUsePaneViewportCols(serverConfig?.backendKind) &&
        paneCols > 0 &&
        terminal.cols !== paneCols
      ) {
        terminal.resize(paneCols, terminal.rows);
      }
      sendTerminalResize();
    };

    const resizeObserver = new ResizeObserver(() => {
      fitAndNotifyResize();
    });
    resizeObserver.observe(terminalContainerRef.current);

    return () => {
      resizeObserver.disconnect();
      disposable.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      serializeAddonRef.current = null;
    };
  }, [serverConfig?.backendKind, sendRawToSocket]);

  useEffect(() => {
    if (shouldUsePaneViewportCols(serverConfig?.backendKind)) {
      return;
    }
    paneViewportColsRef.current = 0;
  }, [serverConfig?.backendKind]);

  useEffect(() => {
    return () => {
      controlSocketRef.current?.close();
      terminalSocketRef.current?.close();
    };
  }, []);

  const scrollViewActive = viewMode === "scroll";

  // Read xterm buffer and update scroll view HTML
  const refreshScrollView = (): void => {
    const el = scrollbackContentRef.current;
    if (!el) return;
    const raw = readTerminalBuffer();
    if (!raw) return;
    const isAtBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 30;
    const html = ansiToHtml(raw);
    if (html !== scrollbackHtml) {
      setScrollbackHtml(html);
      el.innerHTML = html;
      if (isAtBottom) {
        requestAnimationFrame(() => {
          el.scrollTop = el.scrollHeight;
        });
      }
    }
  };

  // When entering scroll mode: read buffer + subscribe to terminal writes
  useEffect(() => {
    if (!scrollViewActive || !authReady) return;

    // Initial read + scroll to bottom
    const raw = readTerminalBuffer();
    if (raw) {
      const html = ansiToHtml(raw);
      setScrollbackHtml(html);
      requestAnimationFrame(() => {
        const el = scrollbackContentRef.current;
        if (el) {
          el.innerHTML = html;
          el.scrollTop = el.scrollHeight;
        }
      });
    }

    // Subscribe to terminal writes — update scroll view when new data arrives
    const terminal = terminalRef.current;
    if (!terminal) return;

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const disposable = terminal.onWriteParsed(() => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => refreshScrollView(), 80);
    });

    return () => {
      disposable.dispose();
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  }, [scrollViewActive, authReady]);

  // Re-fit terminal when switching to terminal mode
  useEffect(() => {
    if (viewMode === "terminal" && fitAddonRef.current) {
      // Double-fit: once immediately, once after CSS settles
      const doFit = () => {
        fitAddonRef.current?.fit();
        sendTerminalResize();
      };
      requestAnimationFrame(doFit);
      const timer = setTimeout(doFit, 150);
      return () => clearTimeout(timer);
    }
  }, [viewMode]);

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

  // Handle paste events for non-text content (images, files)
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
      // Text paste: let xterm.js handle it normally
    };

    // Use capture phase so we intercept before xterm.js's internal paste handler
    document.addEventListener("paste", handlePaste, true);
    return () => document.removeEventListener("paste", handlePaste, true);
  }, [activePane, serverConfig, password]);

  const submitPassword = (): void => {
    setPasswordErrorMessage("");
    openControlSocket(password);
  };

  const resetTerminalBuffer = useCallback((): void => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }
    terminal.reset();
    const themeConfig = themes[theme];
    if (themeConfig) {
      terminal.options.theme = themeConfig.xterm;
    }
  }, [theme]);

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

  const copySelection = async (): Promise<void> => {
    let text = window.getSelection()?.toString() || "";
    const terminalSelection = terminalRef.current?.hasSelection()
      ? terminalRef.current.getSelection()
      : "";
    if (!text && terminalSelection) {
      text = terminalSelection;
    }
    if (!text) {
      // Fallback: copy terminal buffer with ANSI codes stripped
      const raw = readTerminalBuffer();
      text = raw.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
    }
    await navigator.clipboard.writeText(text);
    setStatusMessage("Copied to clipboard");
  };

  const uploadFile = (file: File): void => {
    const maxSize = serverConfig?.uploadMaxSize ?? 50 * 1024 * 1024;
    if (file.size > maxSize) {
      setStatusMessage(`file too large (max ${Math.round(maxSize / 1024 / 1024)}MB)`);
      return;
    }

    const paneCwd = activePane?.currentPath ?? "";
    if (serverConfig?.backendKind === "zellij" && !paneCwd) {
      setStatusMessage(`uploading ${file.name}... (zellij uses server cwd)`);
    } else {
      setStatusMessage(`uploading ${file.name}...`);
    }

    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/upload");
    xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.setRequestHeader("X-Filename", file.name);
    if (paneCwd) {
      xhr.setRequestHeader("X-Pane-Cwd", paneCwd);
    }
    if (password) {
      xhr.setRequestHeader("X-Password", password);
    }

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        const pct = Math.round((event.loaded / event.total) * 100);
        setStatusMessage(`uploading ${file.name}... ${pct}%`);
      }
    };

    xhr.onload = () => {
      if (xhr.status === 200) {
        try {
          const result = JSON.parse(xhr.responseText) as { ok: boolean; path: string; filename: string };
          if (result.ok) {
            setStatusMessage(`uploaded: ${result.filename}`);
            setUploadToast({ path: result.path, filename: result.filename });
            return;
          }
        } catch { /* fall through */ }
      }
      setStatusMessage(`upload failed (${xhr.status})`);
    };

    xhr.onerror = () => {
      setStatusMessage("upload failed (network error)");
    };

    xhr.send(file);
  };

  const focusTerminal = useCallback((): void => {
    terminalRef.current?.focus();
  }, []);

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

  return (
    <div className={`app-shell${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
      <div className="main-content">
      <header className="tab-bar">
        <button
          onClick={() => setDrawerOpen((value) => !value)}
          className="tab-bar-burger"
          data-testid="drawer-toggle"
          title="Open sidebar"
        >
          ☰
        </button>
        <button
          onClick={() => setSidebarCollapsed((v) => !v)}
          className="tab-bar-sidebar-toggle"
          title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {sidebarCollapsed ? "▶" : "◀"}
        </button>
        {awaitingSessionSelection && (
          <div className="top-title">Select Session</div>
        )}
        <div className="tab-list" data-testid="tab-list" style={awaitingSessionSelection ? { display: "none" } : undefined}>
          {tabs.map((tab) => (
            <button
              key={tab.key}
              className={`tab${tab.isActive ? " active" : ""}${tab.hasBell ? " bell" : ""}`}
              onClick={() => {
                const currentSession = attachedSession || activeSession?.name;
                if (tab.sessionName !== currentSession) {
                  sendControl({ type: "select_session", session: tab.sessionName });
                  setSelectedWindowIndex(tab.windowIndex);
                  setSelectedPaneId(null);
                } else {
                  const tabState = activeSession?.tabs.find((t) => t.index === tab.windowIndex);
                  if (tabState) {
                    selectTab(tabState);
                  } else {
                    sendControl({ type: "select_tab", session: tab.sessionName, tabIndex: tab.windowIndex });
                    setSelectedWindowIndex(tab.windowIndex);
                  }
                }
              }}
            >
              <span className="tab-dot" style={{ background: tab.color }} />
              {tab.hasBell && <span className="tab-bell">🔔</span>}
              <span className="tab-label">{tab.label}</span>
            </button>
          ))}
          <button
            className="tab tab-new"
            onClick={() => activeSession && sendControl({ type: "new_tab", session: activeSession.name })}
            disabled={!activeSession}
            title="New tab"
          >
            +
          </button>
        </div>
        <div className="tab-bar-actions">
          <span
            className={`top-status ${topStatus.kind}`}
            title={topStatus.label}
            aria-label={`Status: ${topStatus.label}`}
            data-testid="top-status-indicator"
          />
          {bandwidthStats && (
            <button
              className={`bandwidth-indicator ${bandwidthStats.savedPercent > 50 ? "good" : bandwidthStats.savedPercent > 20 ? "ok" : "low"}`}
              onClick={() => setStatsVisible((v) => !v)}
              title={`Bandwidth: ${formatBytes(bandwidthStats.compressedBytesPerSec)}/s (${bandwidthStats.savedPercent}% saved). Click for details.`}
            >
              ↓{formatBytes(bandwidthStats.compressedBytesPerSec)}/s
              {bandwidthStats.savedPercent > 0 && <span className="saved-badge">{bandwidthStats.savedPercent}%</span>}
            </button>
          )}
          <button
            className={`top-btn${viewMode === "terminal" ? " active" : ""}`}
            title="Toggle between terminal view and scrollback history"
            onClick={() => {
              setViewMode((m) => m === "scroll" ? "terminal" : "scroll");
            }}
          >
            {viewMode === "scroll" ? "Term" : "Scroll"}
            {viewMode === "scroll" && capabilities && !capabilities.supportsPreciseScrollback && (
              <span className="experimental-badge" title="Scrollback is approximate for this backend"> (approx)</span>
            )}
          </button>
        </div>
      </header>

      <main className="terminal-wrap">
        <div
          className="terminal-host"
          ref={terminalContainerRef}
          data-testid="terminal-host"
          style={viewMode !== "terminal" ? { display: "none" } : undefined}
          onContextMenu={(event) => event.preventDefault()}
          onDragOver={(event) => {
            event.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragOver(false);
            const file = event.dataTransfer.files[0];
            if (file) {
              uploadFile(file);
            }
          }}
        >
          {dragOver && (
            <div className="upload-overlay">
              <span>Drop file to upload</span>
            </div>
          )}
        </div>
        {viewMode === "scroll" && (
          <div
            className="scrollback-main"
            ref={scrollbackContentRef}
            data-testid="scrollback-main"
            style={scrollFontSize > 0 ? { fontSize: `${scrollFontSize}px` } as React.CSSProperties : undefined}
          />
        )}
      </main>

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

      {pinnedSnippets.length > 0 && (
        <section className="snippet-pinned-bar" data-testid="snippet-pinned-bar">
          {pinnedSnippets.map((snippet) => (
            <button
              key={snippet.id}
              type="button"
              data-testid={`pinned-snippet-${snippet.id}`}
              onClick={() => executeSnippet(snippet)}
              onContextMenu={(event) => {
                event.preventDefault();
                setEditingSnippet({ ...snippet });
                setDrawerOpen(true);
              }}
              onPointerDown={(event) => {
                const target = event.currentTarget;
                window.setTimeout(() => {
                  if (target.matches(":active")) {
                    setEditingSnippet({ ...snippet });
                    setDrawerOpen(true);
                  }
                }, 550);
              }}
            >
              {snippet.icon ? `${snippet.icon} ` : ""}{snippet.label}
            </button>
          ))}
        </section>
      )}

      {pendingSnippetExecution && (
        <section className="snippet-template-panel" data-testid="snippet-template-panel">
          <div className="snippet-template-title">
            Fill template: {pendingSnippetExecution.snippet.label}
          </div>
          <div className="snippet-template-grid">
            {pendingSnippetExecution.variables.map((variable) => (
              <label key={variable} className="snippet-template-field">
                <span>{variable}</span>
                <input
                  value={pendingSnippetExecution.values[variable] ?? ""}
                  onChange={(event) => setPendingSnippetExecution((current) => (
                    current
                      ? {
                          ...current,
                          values: {
                            ...current.values,
                            [variable]: event.target.value
                          }
                        }
                      : current
                  ))}
                  placeholder={variable}
                />
              </label>
            ))}
          </div>
          <div className="snippet-form-actions">
            <button
              type="button"
              onClick={runPendingSnippet}
              disabled={pendingSnippetExecution.variables.some(
                (variable) => !(pendingSnippetExecution.values[variable] ?? "").trim()
              )}
            >
              Run
            </button>
            <button type="button" onClick={() => setPendingSnippetExecution(null)}>Cancel</button>
          </div>
        </section>
      )}

      <section className="compose-bar" data-testid="compose-bar">
        <input
          data-testid="compose-input"
          value={composeText}
          onChange={(event) => setComposeText(event.target.value)}
          onKeyDown={(event) => {
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
                executeSnippet(
                  visibleQuickSnippetResults[quickSnippetIndex] ?? visibleQuickSnippetResults[0]
                );
                setComposeText("");
                return;
              }
            }
            if (event.key === "Enter") {
              event.preventDefault();
              event.stopPropagation();
              sendCompose();
            }
          }}
          onPaste={(event) => {
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
          }}
          placeholder="Compose command"
          title="Type a command here and press Enter to send it to the terminal"
        />
        <button
          data-testid="compose-send"
          onClick={sendCompose}
          title="Send the composed command to the terminal"
          disabled={!composeText.trim()}
        >
          Send
        </button>
      </section>
      {snippetPickerQuery !== null && (
        <section className="snippet-picker" data-testid="snippet-picker">
          {visibleQuickSnippetResults.length > 0 ? (
            visibleQuickSnippetResults.map((snippet, index) => (
              <button
                key={snippet.id}
                type="button"
                className={`snippet-picker-item${index === quickSnippetIndex ? " active" : ""}`}
                onMouseEnter={() => setQuickSnippetIndex(index)}
                onClick={() => {
                  executeSnippet(snippet);
                  setComposeText("");
                }}
              >
                <span>{snippet.icon ? `${snippet.icon} ` : ""}{snippet.label}</span>
                <small>{snippet.group?.trim() || "Ungrouped"}</small>
              </button>
            ))
          ) : (
            <div className="snippet-picker-empty">No matching quick phrases</div>
          )}
        </section>
      )}

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

            <h3>Sessions</h3>
            <ul data-testid="sessions-list">
              {orderedSessions.map((session) => (
                <li
                  key={session.name}
                  data-testid={`session-item-${session.name}`}
                  data-session-name={session.name}
                  className={sessionDropTarget === session.name ? "drawer-sort-target" : undefined}
                  onDragOver={(event) => {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                  }}
                  onDragEnter={(event) => {
                    event.preventDefault();
                    if (draggedSessionName && draggedSessionName !== session.name) {
                      setSessionDropTarget(session.name);
                      setWorkspaceOrder((current) => reorderSessionState(current, draggedSessionName, session.name));
                    }
                  }}
                  onDragLeave={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                      setSessionDropTarget((current) => current === session.name ? null : current);
                    }
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    if (!draggedSessionName || draggedSessionName === session.name) {
                      setSessionDropTarget(null);
                      return;
                    }
                    setWorkspaceOrder((current) => reorderSessionState(current, draggedSessionName, session.name));
                    setDraggedSessionName(null);
                    setSessionDropTarget(null);
                  }}
                >
                  {renamingSession === session.name ? (
                    <input
                      className="rename-input"
                      value={renameSessionValue}
                      onChange={(e) => setRenameSessionValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && renameSessionValue.trim()) {
                          renameHandledByKeyRef.current = true;
                          sendControl({ type: "rename_session", session: session.name, newName: renameSessionValue.trim() });
                          setRenamingSession(null);
                        } else if (e.key === "Escape") {
                          renameHandledByKeyRef.current = true;
                          setRenamingSession(null);
                        }
                      }}
                      onBlur={() => {
                        if (renameHandledByKeyRef.current) {
                          renameHandledByKeyRef.current = false;
                          return;
                        }
                        if (renameSessionValue.trim() && renameSessionValue.trim() !== session.name) {
                          sendControl({ type: "rename_session", session: session.name, newName: renameSessionValue.trim() });
                        }
                        setRenamingSession(null);
                      }}
                      autoFocus
                      data-testid="rename-session-input"
                    />
                  ) : (
                    <div className="drawer-item-row">
                      <button
                        draggable
                        onClick={() => sendControl({ type: "select_session", session: session.name })}
                        onDragStart={(event) => {
                          beginDrag(event, "session", session.name);
                          setDraggedSessionName(session.name);
                        }}
                        onDragEnd={() => {
                          setDraggedSessionName(null);
                          setSessionDropTarget(null);
                        }}
                        onDoubleClick={capabilities?.supportsSessionRename ? (e) => {
                          e.preventDefault();
                          setRenamingSession(session.name);
                          setRenameSessionValue(session.name);
                        } : undefined}
                        className={`drawer-item-main${
                          session.name === (attachedSession || activeSession?.name) ? " active" : ""
                        }`}
                        data-testid={`session-drag-target-${session.name}`}
                      >
                        <span className="item-name">{session.name} {session.attached ? "*" : ""}</span>
                        {(() => {
                          const aw = session.tabs.find((t) => t.active) ?? session.tabs[0];
                          const label = aw ? formatContext(deriveContext(aw.panes)) : "";
                          return label ? <span className="item-context">{label}</span> : null;
                        })()}
                      </button>
                      <button
                        type="button"
                        className="drawer-close-action"
                        onClick={(event) => {
                          event.stopPropagation();
                          if (
                            session.name === activeSession?.name ||
                            session.name === attachedSession ||
                            snapshot.sessions.length <= 1
                          ) {
                            setSelectedWindowIndex(null);
                            setSelectedPaneId(null);
                          }
                          sendControl({ type: "close_session", session: session.name });
                        }}
                        disabled={snapshot.sessions.length <= 1}
                        data-testid={`close-session-${session.name}`}
                        aria-label={`Close session ${session.name}`}
                        title={`Close session ${session.name}`}
                      >
                        <span aria-hidden="true">×</span>
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
            <button
              className="drawer-section-action"
              onClick={createSession}
              data-testid="new-session-button"
              title="Create a new terminal session"
            >
              + New Session
            </button>
            <h3>Tabs ({activeSession?.name ?? "-"})</h3>
            <ul data-testid="tabs-list">
              {activeSession
                ? orderedActiveTabs.map((tab) => (
                    <li
                      key={`${activeSession.name}-${tab.index}`}
                      data-testid={`tab-item-${activeSession.name}-${tab.index}`}
                      data-tab-key={getTabOrderKey(tab)}
                      className={tabDropTarget === getTabOrderKey(tab) ? "drawer-sort-target" : undefined}
                      onDragOver={(event) => {
                        event.preventDefault();
                        event.dataTransfer.dropEffect = "move";
                      }}
                      onDragEnter={(event) => {
                        event.preventDefault();
                        const targetKey = getTabOrderKey(tab);
                        if (draggedTabKey && draggedTabKey !== targetKey) {
                          setTabDropTarget(targetKey);
                          setWorkspaceOrder((current) => reorderSessionTabs(
                            current,
                            activeSession.name,
                            draggedTabKey,
                            targetKey
                          ));
                        }
                      }}
                      onDragLeave={(event) => {
                        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                          setTabDropTarget((current) => current === getTabOrderKey(tab) ? null : current);
                        }
                      }}
                      onDrop={(event) => {
                        event.preventDefault();
                        const targetKey = getTabOrderKey(tab);
                        if (!draggedTabKey || draggedTabKey === targetKey) {
                          setTabDropTarget(null);
                          return;
                        }
                        setWorkspaceOrder((current) => reorderSessionTabs(
                          current,
                          activeSession.name,
                          draggedTabKey,
                          targetKey
                        ));
                        setDraggedTabKey(null);
                        setTabDropTarget(null);
                      }}
                    >
                      {renamingWindow?.session === activeSession.name && renamingWindow?.index === tab.index ? (
                        <input
                          className="rename-input"
                          value={renameWindowValue}
                          onChange={(e) => setRenameWindowValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && renameWindowValue.trim()) {
                              renameHandledByKeyRef.current = true;
                              sendControl({ type: "rename_tab", session: activeSession.name, tabIndex: tab.index, newName: renameWindowValue.trim() });
                              setRenamingWindow(null);
                            } else if (e.key === "Escape") {
                              renameHandledByKeyRef.current = true;
                              setRenamingWindow(null);
                            }
                          }}
                          onBlur={() => {
                            if (renameHandledByKeyRef.current) {
                              renameHandledByKeyRef.current = false;
                              return;
                            }
                            if (renameWindowValue.trim() && renameWindowValue.trim() !== tab.name) {
                              sendControl({ type: "rename_tab", session: activeSession.name, tabIndex: tab.index, newName: renameWindowValue.trim() });
                            }
                            setRenamingWindow(null);
                          }}
                          autoFocus
                          data-testid="rename-tab-input"
                        />
                      ) : (
                        <div className="drawer-item-row">
                          <button
                            draggable
                            onClick={() => selectTab(tab)}
                            onDragStart={(event) => {
                              beginDrag(event, "tab", getTabOrderKey(tab));
                              setDraggedTabKey(getTabOrderKey(tab));
                            }}
                            onDragEnd={() => {
                              setDraggedTabKey(null);
                              setTabDropTarget(null);
                            }}
                            onDoubleClick={capabilities?.supportsTabRename ? (e) => {
                              e.preventDefault();
                              setRenamingWindow({ session: activeSession.name, index: tab.index });
                              setRenameWindowValue(tab.name);
                            } : undefined}
                            className={`drawer-item-main${tab.index === activeTab?.index ? " active" : ""}`}
                            data-testid={`tab-drag-target-${activeSession.name}-${tab.index}`}
                          >
                            <span className="item-name">
                              {tab.index}: {tab.name}
                              {tab.index === activeTab?.index ? " *" : ""}
                            </span>
                            {(() => {
                              const label = formatContext(deriveContext(tab.panes));
                              return label ? <span className="item-context">{label}</span> : null;
                            })()}
                          </button>
                          <button
                            type="button"
                            className="drawer-close-action"
                            onClick={(event) => {
                              event.stopPropagation();
                              if (tab.index === activeTab?.index) {
                                setSelectedWindowIndex(null);
                                setSelectedPaneId(null);
                              }
                              sendControl({
                                type: "close_tab",
                                session: activeSession.name,
                                tabIndex: tab.index
                              });
                            }}
                            disabled={activeSession.tabs.length <= 1}
                            data-testid={`close-tab-${activeSession.name}-${tab.index}`}
                            aria-label={`Close tab ${tab.index} in session ${activeSession.name}`}
                            title={`Close tab ${tab.index}`}
                          >
                            <span aria-hidden="true">×</span>
                          </button>
                        </div>
                      )}
                    </li>
                  ))
                : null}
            </ul>
            <button
              className="drawer-section-action"
              onClick={() =>
                activeSession && sendControl({ type: "new_tab", session: activeSession.name })
              }
              disabled={!activeSession}
              data-testid="new-tab-button"
            >
              + New Tab
            </button>

            <h3>Appearance</h3>
            <div className="theme-toggle">
              <button
                className={theme === "dark" ? "active" : ""}
                onClick={() => setTheme("dark")}
              >
                Dark
              </button>
              <button
                className={theme === "light" ? "active" : ""}
                onClick={() => setTheme("light")}
              >
                Light
              </button>
            </div>

            <h3>Font Size</h3>
            <div className="drawer-grid" style={{ gridTemplateColumns: "auto 1fr auto", alignItems: "center" }}>
              <button onClick={() => {
                const v = Math.max(8, (scrollFontSize || 14) - 1);
                setScrollFontSize(v);
                localStorage.setItem("remux-scroll-font-size", String(v));
              }}>A-</button>
              <span style={{ textAlign: "center" }}>{scrollFontSize || "Auto"}</span>
              <button onClick={() => {
                const v = Math.min(24, (scrollFontSize || 14) + 1);
                setScrollFontSize(v);
                localStorage.setItem("remux-scroll-font-size", String(v));
              }}>A+</button>
            </div>
            <button className="drawer-section-action" onClick={() => {
              setScrollFontSize(0);
              localStorage.removeItem("remux-scroll-font-size");
            }}>Reset to Auto</button>

            <h3>Snippets</h3>
            {groupedSnippetList.map((group) => {
              const collapsed = collapsedSnippetGroups[group.name] === true;
              return (
                <div className="snippet-group" key={group.name}>
                  <button
                    type="button"
                    className="snippet-group-toggle"
                    onClick={() => setCollapsedSnippetGroups((current) => ({
                      ...current,
                      [group.name]: !collapsed
                    }))}
                  >
                    {group.name} {collapsed ? "▼" : "▲"}
                  </button>
                  {!collapsed && (
                    <div className="snippet-list">
                      {group.snippets.map((s) => (
                        <div
                          className="snippet-item"
                          key={s.id}
                          draggable
                          data-testid={`snippet-item-${s.id}`}
                          onDragStart={(event) => {
                            beginDrag(event, "snippet", s.id);
                            setDraggedSnippetId(s.id);
                          }}
                          onDragEnd={() => {
                            setDraggedSnippetId(null);
                            setSnippetDropTarget(null);
                          }}
                          onDragOver={(event) => {
                            event.preventDefault();
                            event.dataTransfer.dropEffect = "move";
                          }}
                          onDragEnter={(event) => {
                            event.preventDefault();
                            if (draggedSnippetId && draggedSnippetId !== s.id) {
                              setSnippetDropTarget(s.id);
                              persistSnippetPatch((current) => reorderById(
                                current.map((snippet) => (
                                  snippet.id === draggedSnippetId
                                    ? { ...snippet, group: s.group }
                                    : snippet
                                )),
                                draggedSnippetId,
                                s.id
                              ));
                            }
                          }}
                          onDragLeave={(event) => {
                            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                              setSnippetDropTarget((current) => current === s.id ? null : current);
                            }
                          }}
                          onDrop={(event) => {
                            event.preventDefault();
                            if (!draggedSnippetId || draggedSnippetId === s.id) {
                              setSnippetDropTarget(null);
                              return;
                            }
                            persistSnippetPatch((current) => reorderById(
                              current.map((snippet) => (
                                snippet.id === draggedSnippetId
                                  ? { ...snippet, group: s.group }
                                  : snippet
                              )),
                              draggedSnippetId,
                              s.id
                            ));
                            setDraggedSnippetId(null);
                            setSnippetDropTarget(null);
                          }}
                          style={snippetDropTarget === s.id ? { borderColor: "var(--border-active)" } : undefined}
                        >
                          <span className="snippet-label">{s.icon ? `${s.icon} ` : ""}{s.label}</span>
                          <span className="snippet-cmd">
                            [{s.group?.trim() || "Ungrouped"}] {s.command}{s.autoEnter ? " ↵" : ""}
                          </span>
                          <button onClick={() => setEditingSnippet({ ...s })}>&#x270E;</button>
                          <button
                            onClick={() => persistSnippetPatch((current) => current.filter((x) => x.id !== s.id))}
                          >
                            &times;
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
            {editingSnippet ? (
              <div className="snippet-form">
                <input
                  placeholder="Label (button text)"
                  value={editingSnippet.label}
                  onChange={(e) => setEditingSnippet({ ...editingSnippet, label: e.target.value })}
                />
                <input
                  placeholder="Emoji / icon"
                  value={editingSnippet.icon ?? ""}
                  onChange={(e) => setEditingSnippet({ ...editingSnippet, icon: e.target.value || undefined })}
                />
                <input
                  placeholder="Group"
                  value={editingSnippet.group ?? ""}
                  onChange={(e) => setEditingSnippet({ ...editingSnippet, group: e.target.value || undefined })}
                />
                <input
                  placeholder="Command"
                  value={editingSnippet.command}
                  onChange={(e) => setEditingSnippet({ ...editingSnippet, command: e.target.value })}
                />
                <label className="snippet-checkbox">
                  <input
                    type="checkbox"
                    checked={editingSnippet.autoEnter}
                    onChange={(e) => setEditingSnippet({ ...editingSnippet, autoEnter: e.target.checked })}
                  />
                  Auto Enter
                </label>
                <label className="snippet-checkbox">
                  <input
                    type="checkbox"
                    checked={editingSnippet.pinned === true}
                    onChange={(e) => setEditingSnippet({ ...editingSnippet, pinned: e.target.checked })}
                  />
                  Pinned
                </label>
                <div className="snippet-form-actions">
                  <button onClick={() => {
                    if (!editingSnippet.label.trim() || !editingSnippet.command.trim()) return;
                    persistSnippetPatch((current) => {
                      const exists = current.some((s) => s.id === editingSnippet.id);
                      return exists
                        ? current.map((s) => s.id === editingSnippet.id ? editingSnippet : s)
                        : [...current, { ...editingSnippet, sortOrder: current.length }];
                    });
                    setEditingSnippet(null);
                  }}>Save</button>
                  <button onClick={() => setEditingSnippet(null)}>Cancel</button>
                </div>
              </div>
            ) : (
              <button className="drawer-section-action" onClick={() => setEditingSnippet({
                id: crypto.randomUUID(),
                label: "",
                command: "",
                autoEnter: true,
                pinned: false,
                sortOrder: snippets.length
              })}>+ Add Snippet</button>
            )}

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

      {sessionChoices && (
        <div className="overlay" data-testid="session-picker-overlay">
          <div className="card">
            <h2>Select Session</h2>
            {sessionChoices.map((session) => (
              <button
                key={session.name}
                onClick={() => sendControl({ type: "select_session", session: session.name })}
              >
                {session.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Legacy overlay scrollback removed — now inline in scroll viewMode */}

      {statsVisible && bandwidthStats && (
        <div className="overlay" onClick={() => setStatsVisible(false)}>
          <div className="card stats-card" onClick={(e) => e.stopPropagation()}>
            <div className="stats-header">
              <h2>Bandwidth Stats</h2>
              <button onClick={() => setStatsVisible(false)} title="Close">×</button>
            </div>
            <div className="stats-grid">
              <div className="stats-section">
                <h3>Terminal Stream</h3>
                <div className="stats-row"><span>Raw</span><span>{formatBytes(bandwidthStats.rawBytesPerSec)}/s</span></div>
                <div className="stats-row"><span>Compressed</span><span>{formatBytes(bandwidthStats.compressedBytesPerSec)}/s</span></div>
                <div className="stats-row highlight"><span>Saved</span><span>{bandwidthStats.savedPercent}%</span></div>
              </div>
              <div className="stats-section">
                <h3>State Diffs</h3>
                <div className="stats-row"><span>Full snapshots</span><span>{bandwidthStats.fullSnapshotsSent}</span></div>
                <div className="stats-row"><span>Diff updates</span><span>{bandwidthStats.diffUpdatesSent}</span></div>
                <div className="stats-row"><span>Avg rows/diff</span><span>{bandwidthStats.avgChangedRowsPerDiff}</span></div>
              </div>
              <div className="stats-section">
                <h3>Totals</h3>
                <div className="stats-row"><span>Raw data</span><span>{formatBytes(bandwidthStats.totalRawBytes)}</span></div>
                <div className="stats-row"><span>Transferred</span><span>{formatBytes(bandwidthStats.totalCompressedBytes)}</span></div>
                <div className="stats-row highlight"><span>Saved</span><span>{formatBytes(bandwidthStats.totalSavedBytes)}</span></div>
              </div>
              <div className="stats-section">
                <h3>Connection</h3>
                <div className="stats-row"><span>RTT</span><span>{bandwidthStats.rttMs !== null ? `${bandwidthStats.rttMs}ms` : "measuring..."}</span></div>
                <div className="stats-row"><span>Protocol</span><span>{bandwidthStats.protocol}</span></div>
              </div>
            </div>
          </div>
        </div>
      )}

      {needsPasswordInput && (
        <div className="overlay">
          <div className="card">
            <h2>Password Required</h2>
            <input
              type="password"
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                if (passwordErrorMessage) {
                  setPasswordErrorMessage("");
                }
              }}
              placeholder="Enter password"
            />
            {passwordErrorMessage && (
              <p className="password-error" data-testid="password-error">
                {passwordErrorMessage}
              </p>
            )}
            <button onClick={submitPassword}>Connect</button>
          </div>
        </div>
      )}

      {uploadToast && (
        <div className="upload-toast">
          <span className="upload-toast-path">{uploadToast.path}</span>
          <button
            onClick={() => {
              const quoted = `'${uploadToast.path.replace(/'/g, "'\\''")}'`;
              sendRawToSocket(quoted);
              setUploadToast(null);
            }}
            title="Insert the uploaded file path into the terminal"
          >
            Insert
          </button>
          <button onClick={() => setUploadToast(null)} title="Dismiss this notification">×</button>
        </div>
      )}

      {!token && (
        <div className="overlay">
          <div className="card">URL missing `token` query parameter.</div>
        </div>
      )}
    </div>
  );
};

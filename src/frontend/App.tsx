import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { themes } from "./themes";
import { ansiToHtml } from "./ansi-to-html";
import { deriveContext, formatContext } from "./context-label";
import { Toolbar, type ToolbarHandle, type Snippet } from "./components/Toolbar";
import {
  isAwaitingSessionSelection,
  resolveActiveSession,
  shouldUsePaneViewportCols
} from "./ui-state";
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

const getPreferredTerminalFontSize = (): number => {
  return window.matchMedia("(max-width: 768px), (pointer: coarse)").matches ? 12 : 14;
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
  const [sessionChoices, setSessionChoices] = useState<SessionSummary[] | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [composeEnabled, setComposeEnabled] = useState(true);
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
      const stored = localStorage.getItem("remux-snippets");
      if (!stored) return [];
      const parsed: unknown = JSON.parse(stored);
      return Array.isArray(parsed) ? parsed as Snippet[] : [];
    } catch {
      return [];
    }
  });
  const [editingSnippet, setEditingSnippet] = useState<Snippet | null>(null);

  const [theme, setTheme] = useState(localStorage.getItem("remux-theme") ?? "midnight");
  const [stickyZoom, setStickyZoom] = useState(getInitialStickyZoom);

  const [renamingSession, setRenamingSession] = useState<string | null>(null);
  const [renameSessionValue, setRenameSessionValue] = useState("");
  const [renamingWindow, setRenamingWindow] = useState<{ session: string; index: number } | null>(null);
  const [renameWindowValue, setRenameWindowValue] = useState("");
  const renameHandledByKeyRef = useRef(false);

  const [dragOver, setDragOver] = useState(false);
  const [uploadToast, setUploadToast] = useState<{ path: string; filename: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Local selection state for instant UI feedback before server snapshot arrives
  const [selectedWindowIndex, setSelectedWindowIndex] = useState<number | null>(null);
  const [selectedPaneId, setSelectedPaneId] = useState<string | null>(null);
  const awaitingSessionSelection = isAwaitingSessionSelection(sessionChoices, attachedSession);

  const activeSession: SessionState | undefined = useMemo(() => {
    return resolveActiveSession(snapshot.sessions, attachedSession, awaitingSessionSelection);
  }, [snapshot.sessions, attachedSession, awaitingSessionSelection]);

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

  const topStatus = useMemo(() => {
    if (errorMessage) {
      return { kind: "error", label: errorMessage };
    }
    if (awaitingSessionSelection) {
      return { kind: "pending", label: "select session" };
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
  }, [authReady, awaitingSessionSelection, errorMessage, statusMessage]);

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
      terminalRef.current?.write(typeof event.data === "string" ? event.data : "");
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
          setAttachedSession(message.session);
          attachedSessionRef.current = message.session;
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
          setAttachedSession("");
          attachedSessionRef.current = "";
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

  const createSession = (): void => {
    const name = window.prompt("Session name", "main");
    if (!name) {
      return;
    }
    sendControl({ type: "new_session", name });
  };

  const copySelection = async (): Promise<void> => {
    let text = window.getSelection()?.toString() || "";
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

    setStatusMessage(`uploading ${file.name}...`);
    const paneCwd = activePane?.currentPath ?? "";

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

  return (
    <div className="app-shell">
      <header className="topbar">
        <button
          onClick={() => setDrawerOpen((value) => !value)}
          className="icon-btn"
          data-testid="drawer-toggle"
        >
          =
        </button>
        <div className="top-title">
          {awaitingSessionSelection
            ? "Select Session"
            : `Tab: ${activeTab ? `${activeTab.index}: ${activeTab.name}` : "-"}`}
          {serverConfig?.backendKind === "zellij" && (
            <span className="experimental-badge" title="Zellij support is experimental">(experimental)</span>
          )}
        </div>
        <div className="top-actions">
          <span
            className={`top-status ${topStatus.kind}`}
            title={topStatus.label}
            aria-label={`Status: ${topStatus.label}`}
            data-testid="top-status-indicator"
          />
          <button
            className={`top-btn${viewMode === "terminal" ? " active" : ""}`}
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
        hidden={viewMode !== "terminal"}
      />

      {composeEnabled && (
        <section className="compose-bar">
          <input
            value={composeText}
            onChange={(event) => setComposeText(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (event.key === "Enter") {
                sendControl({ type: "send_compose", text: composeText });
                setComposeText("");
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
          />
          <button
            onClick={() => {
              sendControl({ type: "send_compose", text: composeText });
              setComposeText("");
            }}
          >
            Send
          </button>
        </section>
      )}

      {drawerOpen && (
        <div
          className="drawer-backdrop"
          onClick={() => setDrawerOpen(false)}
          data-testid="drawer-backdrop"
        >
          <aside className="drawer" onClick={(event) => event.stopPropagation()}>
            <button
              className="drawer-close"
              onClick={() => setDrawerOpen(false)}
              data-testid="drawer-close"
              aria-label="Close drawer"
            >
              ←
            </button>

            <h3>Sessions</h3>
            <ul data-testid="sessions-list">
              {snapshot.sessions.map((session) => (
                <li key={session.name}>
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
                    <button
                      onClick={() => sendControl({ type: "select_session", session: session.name })}
                      onDoubleClick={capabilities?.supportsSessionRename ? (e) => {
                        e.preventDefault();
                        setRenamingSession(session.name);
                        setRenameSessionValue(session.name);
                      } : undefined}
                      className={session.name === (attachedSession || activeSession?.name) ? "active" : ""}
                    >
                      <span className="item-name">{session.name} {session.attached ? "*" : ""}</span>
                      {(() => {
                        const aw = session.tabs.find((t) => t.active) ?? session.tabs[0];
                        const label = aw ? formatContext(deriveContext(aw.panes)) : "";
                        return label ? <span className="item-context">{label}</span> : null;
                      })()}
                    </button>
                  )}
                </li>
              ))}
            </ul>
            <button
              className="drawer-section-action"
              onClick={createSession}
              data-testid="new-session-button"
            >
              + New Session
            </button>
            <button
              className="drawer-section-action"
              onClick={() => {
                if (!activeSession) return;
                setSelectedWindowIndex(null);
                setSelectedPaneId(null);
                sendControl({ type: "close_session", session: activeSession.name });
              }}
              disabled={!activeSession || snapshot.sessions.length <= 1}
              data-testid="close-session-button"
            >
              Close Session
            </button>

            <h3>Tabs ({activeSession?.name ?? "-"})</h3>
            <ul data-testid="tabs-list">
              {activeSession
                ? activeSession.tabs.map((tab) => (
                    <li key={`${activeSession.name}-${tab.index}`}>
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
                        <button
                          onClick={() => selectTab(tab)}
                          onDoubleClick={capabilities?.supportsTabRename ? (e) => {
                            e.preventDefault();
                            setRenamingWindow({ session: activeSession.name, index: tab.index });
                            setRenameWindowValue(tab.name);
                          } : undefined}
                          className={tab.index === activeTab?.index ? "active" : ""}
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

            <h3>Panes ({activeTab ? `${activeTab.index}` : "-"})</h3>
            <ul>
              {activeTab
                ? activeTab.panes.map((pane) => {
                    const isActive = pane.id === activePane?.id;
                    return (
                      <li key={pane.id}>
                        <button
                          onClick={() => {
                            setSelectedPaneId(pane.id);
                            sendControl({ type: "select_pane", paneId: pane.id });
                            if (stickyZoom && capabilities?.supportsFullscreenPane && !isActive && !pane.zoomed) {
                              sendControl({ type: "toggle_fullscreen", paneId: pane.id });
                            }
                          }}
                          className={isActive ? "active" : ""}
                        >
                          %{pane.index}: {pane.currentCommand} {isActive ? "*" : ""}
                          {isActive && pane.zoomed ? (
                            <span
                              className="pane-zoom-indicator on"
                              title="Active pane is zoomed"
                              aria-label="Pane zoom: on"
                              data-testid="active-pane-zoom-indicator"
                            >
                              🔍
                            </span>
                          ) : null}
                        </button>
                      </li>
                    );
                  })
                : null}
            </ul>
            <div className="drawer-grid">
              <button
                onClick={() =>
                  activePane &&
                  sendControl({ type: "split_pane", paneId: activePane.id, direction: "right" })
                }
                disabled={!activePane}
              >
                Split H
              </button>
              <button
                onClick={() =>
                  activePane &&
                  sendControl({ type: "split_pane", paneId: activePane.id, direction: "down" })
                }
                disabled={!activePane}
              >
                Split V
              </button>
            </div>
            <button
              className="drawer-section-action"
              onClick={() =>
                activePane && sendControl({ type: "toggle_fullscreen", paneId: activePane.id })
              }
              disabled={!activePane || !activeTab || activeTab.paneCount <= 1 || !capabilities?.supportsFullscreenPane}
            >
              Zoom Pane
            </button>
            <button
              className={`drawer-section-action${stickyZoom ? " active" : ""}`}
              onClick={() => { stickyZoomUserSetRef.current = true; setStickyZoom((v) => !v); }}
              disabled={!capabilities?.supportsFullscreenPane}
              data-testid="sticky-zoom-toggle"
            >
              Sticky Zoom: {stickyZoom ? "On" : "Off"}
            </button>

            <button
              className="drawer-section-action"
              onClick={() => {
                if (!activePane) return;
                setSelectedPaneId(null);
                sendControl({ type: "close_pane", paneId: activePane.id });
              }}
              disabled={!activePane}
            >
              Close Pane
            </button>
            <button
              className="drawer-section-action"
              onClick={() => {
                if (!activeSession || !activeTab) return;
                setSelectedWindowIndex(null);
                setSelectedPaneId(null);
                sendControl({
                  type: "close_tab",
                  session: activeSession.name,
                  tabIndex: activeTab.index
                });
              }}
              disabled={!activeSession || !activeTab}
            >
              Close Tab
            </button>

            <h3>Appearance</h3>
            <div className="theme-picker" style={{ gridTemplateColumns: "repeat(2, 1fr)" }}>
              {Object.entries(themes).map(([key, config]) => (
                <button
                  key={key}
                  className={theme === key ? "active" : ""}
                  onClick={() => setTheme(key)}
                >
                  {config.name}
                </button>
              ))}
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
            <div className="snippet-list">
              {snippets.map((s) => (
                <div className="snippet-item" key={s.id}>
                  <span className="snippet-label">{s.label}</span>
                  <span className="snippet-cmd">{s.command}{s.autoEnter ? " ↵" : ""}</span>
                  <button onClick={() => setEditingSnippet({ ...s })}>&#x270E;</button>
                  <button onClick={() => {
                    const next = snippets.filter((x) => x.id !== s.id);
                    setSnippets(next);
                    localStorage.setItem("remux-snippets", JSON.stringify(next));
                  }}>&times;</button>
                </div>
              ))}
            </div>
            {editingSnippet ? (
              <div className="snippet-form">
                <input
                  placeholder="Label (button text)"
                  value={editingSnippet.label}
                  onChange={(e) => setEditingSnippet({ ...editingSnippet, label: e.target.value })}
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
                <div className="snippet-form-actions">
                  <button onClick={() => {
                    if (!editingSnippet.label.trim() || !editingSnippet.command.trim()) return;
                    const exists = snippets.some((s) => s.id === editingSnippet.id);
                    const next = exists
                      ? snippets.map((s) => s.id === editingSnippet.id ? editingSnippet : s)
                      : [...snippets, editingSnippet];
                    setSnippets(next);
                    localStorage.setItem("remux-snippets", JSON.stringify(next));
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
                autoEnter: true
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
        </div>
      )}

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
              // Shell-quote the path to handle spaces and metacharacters
              const quoted = `'${uploadToast.path.replace(/'/g, "'\\''")}'`;
              sendRawToSocket(quoted);
              setUploadToast(null);
            }}
          >
            Insert
          </button>
          <button onClick={() => setUploadToast(null)}>×</button>
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

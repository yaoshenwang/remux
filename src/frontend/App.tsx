import { useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { themes } from "./themes";
import { ansiToHtml } from "./ansi-to-html";
import { deriveContext, formatContext } from "./context-label";
import type {
  ControlServerMessage,
  TmuxPaneState,
  TmuxSessionState,
  TmuxSessionSummary,
  TmuxStateSnapshot,
  TmuxWindowState
} from "../shared/protocol";

interface ServerConfig {
  version?: string;
  passwordRequired: boolean;
  scrollbackLines: number;
  pollIntervalMs: number;
  uploadMaxSize?: number;
}

type ModifierKey = "ctrl" | "alt" | "shift" | "meta";
type ModifierMode = "off" | "sticky" | "locked";

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

  const [serverConfig, setServerConfig] = useState<ServerConfig | null>(null);
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [statusMessage, setStatusMessage] = useState<string>("");
  const [password, setPassword] = useState(sessionStorage.getItem("remux-password") ?? "");
  const [needsPasswordInput, setNeedsPasswordInput] = useState(false);
  const [passwordErrorMessage, setPasswordErrorMessage] = useState("");
  const [authReady, setAuthReady] = useState(false);

  const [snapshot, setSnapshot] = useState<TmuxStateSnapshot>({ sessions: [], capturedAt: "" });
  const [attachedSession, setAttachedSession] = useState<string>("");
  const attachedSessionRef = useRef("");
  const [sessionChoices, setSessionChoices] = useState<TmuxSessionSummary[] | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [composeEnabled, setComposeEnabled] = useState(() => isMobileDevice());
  const [composeText, setComposeText] = useState("");

  const [scrollbackHtml, setScrollbackHtml] = useState("");
  const scrollbackContentRef = useRef<HTMLDivElement | null>(null);

  const [viewMode, setViewMode] = useState<"scroll" | "terminal">("terminal");
  const [scrollFontSize, setScrollFontSize] = useState<number>(
    Number(localStorage.getItem("remux-scroll-font-size")) || 0
  );

  const [modifiers, setModifiers] = useState<Record<ModifierKey, ModifierMode>>({
    ctrl: "off",
    alt: "off",
    shift: "off",
    meta: "off"
  });
  const modifierTapRef = useRef<{ key: ModifierKey; at: number } | null>(null);

  const [theme, setTheme] = useState(localStorage.getItem("remux-theme") ?? "midnight");
  const [toolbarExpanded, setToolbarExpanded] = useState(
    localStorage.getItem("remux-toolbar-expanded") === "true"
  );
  const [toolbarDeepExpanded, setToolbarDeepExpanded] = useState(false);
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

  // Local selection state for instant UI feedback before server snapshot arrives
  const [selectedWindowIndex, setSelectedWindowIndex] = useState<number | null>(null);
  const [selectedPaneId, setSelectedPaneId] = useState<string | null>(null);

  const activeSession: TmuxSessionState | undefined = useMemo(() => {
    const selected = snapshot.sessions.find((session) => session.name === attachedSession);
    if (selected) {
      return selected;
    }
    return snapshot.sessions.find((session) => session.attached) ?? snapshot.sessions[0];
  }, [snapshot.sessions, attachedSession]);

  const activeWindow: TmuxWindowState | undefined = useMemo(() => {
    if (!activeSession) {
      return undefined;
    }
    // Use local selection if it still exists in the snapshot
    if (selectedWindowIndex !== null) {
      const selected = activeSession.windowStates.find(
        (window) => window.index === selectedWindowIndex
      );
      if (selected) {
        return selected;
      }
    }
    return activeSession.windowStates.find((window) => window.active) ?? activeSession.windowStates[0];
  }, [activeSession, selectedWindowIndex]);

  const activePane: TmuxPaneState | undefined = useMemo(() => {
    if (!activeWindow) {
      return undefined;
    }
    // Use local selection if it still exists in the snapshot
    if (selectedPaneId !== null) {
      const selected = activeWindow.panes.find((pane) => pane.id === selectedPaneId);
      if (selected) {
        return selected;
      }
    }
    return activeWindow.panes.find((pane) => pane.active) ?? activeWindow.panes[0];
  }, [activeWindow, selectedPaneId]);

  const topStatus = useMemo(() => {
    if (errorMessage) {
      return { kind: "error", label: errorMessage };
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
  }, [authReady, errorMessage, statusMessage]);

  // Session color palette for tab bar color-coding.
  const sessionColors = useMemo(() => {
    const palette = ["#3b82f6", "#22c55e", "#f59e0b", "#a855f7", "#ec4899", "#06b6d4", "#ef4444", "#84cc16"];
    const colorMap = new Map<string, string>();
    snapshot.sessions.forEach((session, i) => {
      colorMap.set(session.name, palette[i % palette.length]);
    });
    return colorMap;
  }, [snapshot.sessions]);

  // Build flat tab list: one tab per window across all sessions.
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
      for (const win of session.windowStates) {
        const isActive =
          session.name === (attachedSession || activeSession?.name) &&
          win.index === activeWindow?.index;
        result.push({
          key: `${session.name}:${win.index}`,
          label: session.windowStates.length > 1
            ? `${session.name}/${win.name}`
            : session.name,
          sessionName: session.name,
          windowIndex: win.index,
          isActive,
          hasBell: bellSessions.has(session.name) && !isActive,
          color: sessionColors.get(session.name) ?? "#3b82f6",
        });
      }
    }
    return result;
  }, [snapshot.sessions, attachedSession, activeSession, activeWindow, bellSessions, sessionColors]);

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

  const clearStickyModifiers = (): void => {
    setModifiers((previous) => ({
      ctrl: previous.ctrl === "sticky" ? "off" : previous.ctrl,
      alt: previous.alt === "sticky" ? "off" : previous.alt,
      shift: previous.shift === "sticky" ? "off" : previous.shift,
      meta: previous.meta === "sticky" ? "off" : previous.meta
    }));
  };

  const applyModifiers = (input: string): string => {
    let output = input;

    if (modifiers.shift !== "off" && output.length === 1 && /^[a-z]$/.test(output)) {
      output = output.toUpperCase();
    }

    if (modifiers.ctrl !== "off" && output.length === 1) {
      output = String.fromCharCode(output.toUpperCase().charCodeAt(0) & 31);
    }

    if (modifiers.alt !== "off" || modifiers.meta !== "off") {
      output = `\u001b${output}`;
    }

    clearStickyModifiers();
    return output;
  };

  const sendTerminal = (input: string, withModifiers = true): void => {
    const socket = terminalSocketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      debugLog("send_terminal.blocked", {
        readyState: socket?.readyState,
        withModifiers,
        bytes: input.length
      });
      return;
    }
    const output = withModifiers ? applyModifiers(input) : input;
    debugLog("send_terminal", { withModifiers, inputBytes: input.length, outputBytes: output.length });
    socket.send(output);
  };

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

  const toggleModifier = (key: ModifierKey): void => {
    const now = Date.now();
    const isDoubleTap =
      modifierTapRef.current &&
      modifierTapRef.current.key === key &&
      now - modifierTapRef.current.at <= 300;

    modifierTapRef.current = { key, at: now };

    setModifiers((previous) => {
      const current = previous[key];
      let next: ModifierMode;

      if (current === "locked") {
        next = "off";
      } else if (isDoubleTap) {
        next = "locked";
      } else {
        next = current === "sticky" ? "off" : "sticky";
      }

      return {
        ...previous,
        [key]: next
      };
    });
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
          openTerminalSocket(passwordValue, message.clientId);
          // Start RTT measurement pings.
          if (rttTimerRef.current) clearInterval(rttTimerRef.current);
          rttTimerRef.current = setInterval(() => {
            if (controlSocketRef.current?.readyState === WebSocket.OPEN) {
              controlSocketRef.current.send(JSON.stringify({ type: "ping", timestamp: performance.now() }));
            }
          }, 10_000);
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
              windows: session.windows
            }))
          });
          setSessionChoices(message.sessions);
          return;
        case "tmux_state":
          debugLog("control_socket.tmux_state", {
            capturedAt: message.state.capturedAt,
            sessionCount: message.state.sessions.length,
            sessions: message.state.sessions.map((session) => {
              const activeWindow =
                session.windowStates.find((windowState) => windowState.active) ?? session.windowStates[0];
              const activePane = activeWindow?.panes.find((pane) => pane.active) ?? activeWindow?.panes[0];
              return {
                name: session.name,
                attached: session.attached,
                activeWindow: activeWindow ? `${activeWindow.index}:${activeWindow.name}` : null,
                activePane: activePane?.id ?? null,
                activePaneZoomed: activePane?.zoomed ?? null
              };
            })
          });
          setSnapshot(message.state);
          // Clear local selections — the server now sends per-client active state,
          // so the snapshot already reflects this client's active window/pane.
          setSelectedWindowIndex(null);
          setSelectedPaneId(null);
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
      sendTerminal(data);
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
  }, []);

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

  // Persist toolbar expanded state
  useEffect(() => {
    localStorage.setItem("remux-toolbar-expanded", toolbarExpanded ? "true" : "false");
  }, [toolbarExpanded]);

  // Persist sticky zoom state
  useEffect(() => {
    localStorage.setItem("remux-sticky-zoom", stickyZoom ? "true" : "false");
  }, [stickyZoom]);

  useEffect(() => {
    if (!debugMode) {
      return;
    }
    const sessionSummary = snapshot.sessions.map((session) => {
      const activeWindow =
        session.windowStates.find((windowState) => windowState.active) ?? session.windowStates[0];
      const activePane = activeWindow?.panes.find((pane) => pane.active) ?? activeWindow?.panes[0];
      return {
        name: session.name,
        attached: session.attached,
        activeWindow: activeWindow ? `${activeWindow.index}:${activeWindow.name}` : null,
        activePane: activePane?.id ?? null,
        activePaneZoomed: activePane?.zoomed ?? null
      };
    });
    const derived = {
      attachedSession,
      activeSession: activeSession?.name ?? null,
      activeWindow: activeWindow ? `${activeWindow.index}:${activeWindow.name}` : null,
      activePane: activePane?.id ?? null,
      activePaneZoomed: activePane?.zoomed ?? null,
      topStatus,
      snapshotCapturedAt: snapshot.capturedAt,
      sessions: sessionSummary
    };
    window.__remuxDebugState = derived;
    debugLog("derived_state", derived);
  }, [attachedSession, activeSession, activeWindow, activePane, snapshot, topStatus]);

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

  const focusTerminal = (): void => {
    terminalRef.current?.focus();
  };

  const selectWindow = (windowState: TmuxWindowState): void => {
    if (!activeSession) {
      return;
    }
    setSelectedWindowIndex(windowState.index);
    setSelectedPaneId(null);
    sendControl({
      type: "select_window",
      session: activeSession.name,
      windowIndex: windowState.index,
      ...(stickyZoom && !windowState.active ? { stickyZoom: true } : {})
    });
  };

  return (
    <div className="app-shell">
      <header className="tab-bar">
        <button
          onClick={() => setDrawerOpen((value) => !value)}
          className="tab-bar-burger"
          data-testid="drawer-toggle"
          title="Open sidebar — manage panes, themes, and advanced options"
        >
          ☰
        </button>
        <div className="tab-list" role="tablist">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              role="tab"
              aria-selected={tab.isActive}
              className={`tab${tab.isActive ? " active" : ""}${tab.hasBell ? " bell" : ""}`}
              style={{
                borderBottomColor: tab.isActive ? tab.color : "transparent",
                ["--tab-color" as string]: tab.color,
              }}
              title={`Session: ${tab.sessionName}, Window: ${tab.windowIndex}${tab.hasBell ? " (bell)": ""}`}
              onClick={() => {
                // Clear bell for this session when switching to it.
                setBellSessions((prev) => {
                  const next = new Set(prev);
                  next.delete(tab.sessionName);
                  return next;
                });
                if (tab.sessionName !== (attachedSession || activeSession?.name)) {
                  sendControl({ type: "select_session", session: tab.sessionName });
                } else if (tab.windowIndex !== activeWindow?.index) {
                  sendControl({
                    type: "select_window",
                    session: tab.sessionName,
                    windowIndex: tab.windowIndex,
                    ...(stickyZoom ? { stickyZoom: true } : {}),
                  });
                  setSelectedWindowIndex(tab.windowIndex);
                }
              }}
            >
              <span className="tab-dot" style={{ backgroundColor: tab.color }} />
              {tab.hasBell && <span className="tab-bell">🔔</span>}
              <span className="tab-label">{tab.label}</span>
            </button>
          ))}
          <button
            className="tab tab-new"
            onClick={createSession}
            title="Create a new terminal session"
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

      {viewMode === "terminal" && <section className={`toolbar${isMobileDevice() ? "" : " desktop-hidden"}`} onMouseUp={focusTerminal}>
        {/* Row 1: Esc, Ctrl, Alt, Cmd, /, @, Hm, ↑, Ed */}
        <div className="toolbar-main">
          <button onClick={() => sendTerminal("\u001b")} title="Escape key — cancel current operation or exit insert mode">Esc</button>
          <button className={`modifier ${modifiers.ctrl}`} onClick={() => toggleModifier("ctrl")} title="Ctrl modifier — tap for sticky (one use), double-tap for locked">Ctrl</button>
          <button className={`modifier ${modifiers.alt}`} onClick={() => toggleModifier("alt")} title="Alt modifier — tap for sticky, double-tap for locked">Alt</button>
          <button className={`modifier ${modifiers.meta}`} onClick={() => toggleModifier("meta")} title="Cmd/Meta modifier — tap for sticky, double-tap for locked">Cmd</button>
          <button onClick={() => sendTerminal("/")} title="Forward slash — useful for search and file paths">/</button>
          <button onClick={() => sendTerminal("@")} title="At sign">@</button>
          <button onClick={() => sendTerminal("\u001b[H")} title="Home key — move cursor to start of line">Hm</button>
          <button onClick={() => sendTerminal("\u001b[A")} title="Up arrow — previous command or move cursor up">↑</button>
          <button onClick={() => sendTerminal("\u001b[F")} title="End key — move cursor to end of line">Ed</button>
        </div>

        {/* Row 2: ^C, ^B, ^R, Sft, Tab, Enter, ..., ←, ↓, → */}
        <div className="toolbar-main">
          <button className="danger" onClick={() => sendTerminal("\u0003", false)} title="Ctrl+C — interrupt current process">^C</button>
          <button onClick={() => sendTerminal("\u0002", false)} title="Ctrl+B — tmux prefix key (for tmux commands)">^B</button>
          <button onClick={() => sendTerminal("\u0012", false)} title="Ctrl+R — reverse history search">^R</button>
          <button className={`modifier ${modifiers.shift}`} onClick={() => toggleModifier("shift")} title="Shift modifier — tap for sticky, double-tap for locked">Sft</button>
          <button onClick={() => sendTerminal("\t")} title="Tab — autocomplete commands and file paths">Tab</button>
          <button onClick={() => sendTerminal("\r")} title="Enter — execute command or confirm">Enter</button>
          <button
            className="toolbar-expand-btn"
            title="Show more keys — Del, Insert, PgUp, PgDn, Paste, Upload, F-keys"
            onClick={() => {
              setToolbarExpanded((v) => !v);
              if (toolbarExpanded) {
                setToolbarDeepExpanded(false);
              }
            }}
          >
            {toolbarExpanded ? "..." : "..."}
          </button>
          <button onClick={() => sendTerminal("\u001b[D")} title="Left arrow — move cursor left">←</button>
          <button onClick={() => sendTerminal("\u001b[B")} title="Down arrow — next command or move cursor down">↓</button>
          <button onClick={() => sendTerminal("\u001b[C")} title="Right arrow — move cursor right">→</button>
        </div>

        {/* Expanded section (collapsible) */}
        <div className={`toolbar-row-secondary ${toolbarExpanded ? "expanded" : ""}`}>
          <button onClick={() => sendTerminal("\u0004", false)} title="Ctrl+D — end of input / logout">^D</button>
          <button onClick={() => sendTerminal("\u000c", false)} title="Ctrl+L — clear screen">^L</button>
          <button
            title="Paste clipboard contents into the terminal"
            onClick={async () => {
              try {
                const clip = await navigator.clipboard.readText();
                sendTerminal(clip, false);
              } catch {
                setStatusMessage("clipboard read failed");
              }
            }}
          >
            Paste
          </button>
          <button
            title="Upload a file from your device to the terminal's working directory"
            onClick={() => fileInputRef.current?.click()}
          >
            Upload
          </button>
          {/* file input moved outside toolbar for scroll mode access */}
          <button onClick={() => sendTerminal("\u001b[3~")} title="Delete key — delete character under cursor">Del</button>
          <button onClick={() => sendTerminal("\u001b[2~")} title="Insert key — toggle insert/overwrite mode">Insert</button>
          <button onClick={() => sendTerminal("\u001b[5~")} title="Page Up — scroll up one page">PgUp</button>
          <button onClick={() => sendTerminal("\u001b[6~")} title="Page Down — scroll down one page">PgDn</button>
          <button
            className="toolbar-expand-btn"
            onClick={() => setToolbarDeepExpanded((v) => !v)}
          >
            {toolbarDeepExpanded ? "F-Keys ▲" : "F-Keys ▼"}
          </button>
        </div>

        {/* F-keys row (collapsible from within expanded) */}
        {toolbarExpanded && (
          <div className={`toolbar-row-deep ${toolbarDeepExpanded ? "expanded" : ""}`}>
            <div className="toolbar-row-deep-fkeys">
              {[
                "\u001bOP", "\u001bOQ", "\u001bOR", "\u001bOS",
                "\u001b[15~", "\u001b[17~", "\u001b[18~", "\u001b[19~",
                "\u001b[20~", "\u001b[21~", "\u001b[23~", "\u001b[24~"
              ].map((seq, i) => (
                <button key={`f${i + 1}`} onClick={() => sendTerminal(seq, false)}>
                  F{i + 1}
                </button>
              ))}
            </div>
          </div>
        )}
      </section>}

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
            title="Type a command here and press Enter to send it to the terminal"
          />
          <button
            onClick={() => {
              sendControl({ type: "send_compose", text: composeText });
              setComposeText("");
            }}
            title="Send the composed command to the terminal"
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
                      onDoubleClick={(e) => {
                        e.preventDefault();
                        setRenamingSession(session.name);
                        setRenameSessionValue(session.name);
                      }}
                      className={session.name === (attachedSession || activeSession?.name) ? "active" : ""}
                    >
                      <span className="item-name">{session.name} {session.attached ? "*" : ""}</span>
                      {(() => {
                        const aw = session.windowStates.find((w) => w.active) ?? session.windowStates[0];
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
              title="Create a new terminal session"
            >
              + New Session
            </button>

            <h3>Windows ({activeSession?.name ?? "-"})</h3>
            <ul data-testid="windows-list">
              {activeSession
                ? activeSession.windowStates.map((windowState) => (
                    <li key={`${activeSession.name}-${windowState.index}`}>
                      {renamingWindow?.session === activeSession.name && renamingWindow?.index === windowState.index ? (
                        <input
                          className="rename-input"
                          value={renameWindowValue}
                          onChange={(e) => setRenameWindowValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && renameWindowValue.trim()) {
                              renameHandledByKeyRef.current = true;
                              sendControl({ type: "rename_window", session: activeSession.name, windowIndex: windowState.index, newName: renameWindowValue.trim() });
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
                            if (renameWindowValue.trim() && renameWindowValue.trim() !== windowState.name) {
                              sendControl({ type: "rename_window", session: activeSession.name, windowIndex: windowState.index, newName: renameWindowValue.trim() });
                            }
                            setRenamingWindow(null);
                          }}
                          autoFocus
                          data-testid="rename-window-input"
                        />
                      ) : (
                        <button
                          onClick={() => selectWindow(windowState)}
                          onDoubleClick={(e) => {
                            e.preventDefault();
                            setRenamingWindow({ session: activeSession.name, index: windowState.index });
                            setRenameWindowValue(windowState.name);
                          }}
                          className={windowState.index === activeWindow?.index ? "active" : ""}
                        >
                          <span className="item-name">
                            {windowState.index}: {windowState.name}
                            {windowState.index === activeWindow?.index ? " *" : ""}
                          </span>
                          {(() => {
                            const label = formatContext(deriveContext(windowState.panes));
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
                activeSession && sendControl({ type: "new_window", session: activeSession.name })
              }
              disabled={!activeSession}
              data-testid="new-window-button"
              title="Create a new window in the current session"
            >
              + New Window
            </button>

            <h3>Panes ({activeWindow ? `${activeWindow.index}` : "-"})</h3>
            <ul>
              {activeWindow
                ? activeWindow.panes.map((pane) => {
                    const isActive = pane.id === activePane?.id;
                    return (
                      <li key={pane.id}>
                        <button
                          onClick={() => {
                            setSelectedPaneId(pane.id);
                            sendControl({
                              type: "select_pane",
                              paneId: pane.id,
                              ...(stickyZoom && !isActive ? { stickyZoom: true } : {})
                            });
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
                  sendControl({ type: "split_pane", paneId: activePane.id, orientation: "h" })
                }
                disabled={!activePane}
                title="Split pane horizontally — create a side-by-side layout"
              >
                Split H
              </button>
              <button
                onClick={() =>
                  activePane &&
                  sendControl({ type: "split_pane", paneId: activePane.id, orientation: "v" })
                }
                disabled={!activePane}
                title="Split pane vertically — create a top-bottom layout"
              >
                Split V
              </button>
            </div>
            <button
              className="drawer-section-action"
              onClick={() =>
                activePane && sendControl({ type: "zoom_pane", paneId: activePane.id })
              }
              disabled={!activePane || !activeWindow || activeWindow.paneCount <= 1}
              title="Toggle zoom — expand active pane to fill the entire window"
            >
              Zoom Pane
            </button>
            <button
              className={`drawer-section-action${stickyZoom ? " active" : ""}`}
              onClick={() => setStickyZoom((v) => !v)}
              data-testid="sticky-zoom-toggle"
              title="Sticky zoom — automatically zoom the pane when switching windows or panes"
            >
              Sticky Zoom: {stickyZoom ? "On" : "Off"}
            </button>

            <button
              className="drawer-section-action"
              onClick={() => {
                if (!activePane) return;
                setSelectedPaneId(null);
                sendControl({ type: "kill_pane", paneId: activePane.id });
              }}
              disabled={!activePane}
              title="Close the active pane"
            >
              Close Pane
            </button>
            <button
              className="drawer-section-action"
              onClick={() => {
                if (!activeSession || !activeWindow) return;
                setSelectedWindowIndex(null);
                setSelectedPaneId(null);
                sendControl({
                  type: "kill_window",
                  session: activeSession.name,
                  windowIndex: activeWindow.index
                });
              }}
              disabled={!activeSession || !activeWindow}
              title="Kill the active window and all its panes"
            >
              Kill Window
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

            {serverConfig?.version && (
              <p className="drawer-version">v{serverConfig.version}</p>
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
              sendTerminal(quoted, false);
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

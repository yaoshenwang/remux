import { useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { themes } from "./themes";
import { ansiToHtml } from "./ansi-to-html";
import type {
  ControlServerMessage,
  TmuxPaneState,
  TmuxSessionState,
  TmuxSessionSummary,
  TmuxStateSnapshot,
  TmuxWindowState
} from "../shared/protocol";

interface ServerConfig {
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
  const [composeEnabled, setComposeEnabled] = useState(true);
  const [composeText, setComposeText] = useState("");

  const [scrollbackVisible, setScrollbackVisible] = useState(false);
  const [scrollbackText, setScrollbackText] = useState("");
  const [scrollbackLines, setScrollbackLines] = useState(1000);
  const scrollbackContentRef = useRef<HTMLDivElement | null>(null);
  const scrollbackRefreshRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Start in terminal mode so xterm.js can initialize with correct dimensions,
  // then auto-switch to scroll mode after first tmux_state arrives.
  const [viewMode, setViewMode] = useState<"scroll" | "terminal">("terminal");
  const hasAutoSwitchedRef = useRef(false);

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

  const requestScrollback = (lines: number): void => {
    if (!activePane) {
      return;
    }
    setScrollbackLines(lines);
    sendControl({ type: "capture_scrollback", paneId: activePane.id, lines });
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
      // Delay fit to ensure CSS layout is settled, then send resize + auto-switch
      setTimeout(() => {
        if (fitAddonRef.current && terminalRef.current) {
          fitAddonRef.current.fit();
          // Fallback: if cols is unreasonably small, force a minimum
          if (terminalRef.current.cols < 20) {
            terminalRef.current.resize(80, 24);
          }
        }
        sendTerminalResize();
        if (!hasAutoSwitchedRef.current) {
          hasAutoSwitchedRef.current = true;
          setTimeout(() => setViewMode("scroll"), 200);
        }
      }, 300);
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
          openTerminalSocket(passwordValue, message.clientId);
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
          debugLog("control_socket.scrollback", {
            paneId: message.paneId,
            lines: message.lines,
            bytes: message.text.length
          });
          setScrollbackText(message.text);
          setScrollbackVisible(true);
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
      fontFamily: "'MesloLGS NF', 'MesloLGM NF', 'Hack Nerd Font', 'FiraCode Nerd Font', 'JetBrainsMono Nerd Font', 'DejaVu Sans Mono Nerd Font', 'Symbols Nerd Font Mono', Menlo, Monaco, 'Courier New', monospace",
      fontSize: initialFontSize,
      theme: themeConfig?.xterm ?? {
        background: "#0d1117",
        foreground: "#d1e4ff",
        cursor: "#93c5fd"
      }
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
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

    const fitAndNotifyResize = () => {
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
    };
  }, []);

  useEffect(() => {
    return () => {
      controlSocketRef.current?.close();
      terminalSocketRef.current?.close();
    };
  }, []);

  const scrollViewActive = scrollbackVisible || viewMode === "scroll";

  // Scrollback auto-refresh and scroll-to-bottom
  useEffect(() => {
    if (!scrollViewActive || !authReady) {
      if (scrollbackRefreshRef.current) {
        clearInterval(scrollbackRefreshRef.current);
        scrollbackRefreshRef.current = null;
      }
      return;
    }

    // Initial fetch + scroll to bottom
    requestScrollback(scrollbackLines);
    requestAnimationFrame(() => {
      const el = scrollbackContentRef.current;
      if (el) {
        el.scrollTop = el.scrollHeight;
      }
    });

    // Auto-refresh every 3s
    scrollbackRefreshRef.current = setInterval(() => {
      requestScrollback(scrollbackLines);
    }, 3000);

    return () => {
      if (scrollbackRefreshRef.current) {
        clearInterval(scrollbackRefreshRef.current);
        scrollbackRefreshRef.current = null;
      }
    };
  }, [scrollViewActive, authReady, activePane?.id]);

  // Scroll to bottom when new scrollback text arrives (only if already at bottom)
  useEffect(() => {
    const el = scrollbackContentRef.current;
    if (!el || !scrollViewActive || !scrollbackText) {
      return;
    }
    const isAtBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 30;
    // Update HTML content
    el.innerHTML = ansiToHtml(scrollbackText);
    if (isAtBottom) {
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
      });
    }
  }, [scrollbackText]);

  // Re-fit terminal when switching to terminal mode
  useEffect(() => {
    if (viewMode === "terminal" && fitAddonRef.current) {
      requestAnimationFrame(() => {
        fitAddonRef.current?.fit();
        sendTerminalResize();
      });
    }
  }, [viewMode]);

  // On desktop, fit font-size so terminal columns fill the container width
  useEffect(() => {
    if (viewMode !== "scroll" || window.innerWidth < 768) return;
    const el = scrollbackContentRef.current;
    if (!el || !scrollbackText) return;

    const fitFont = (): void => {
      const stripped = scrollbackText.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
      const lines = stripped.split("\n");
      let maxCols = 0;
      for (const line of lines) {
        if (line.length > maxCols) maxCols = line.length;
      }
      if (maxCols < 10) return;

      const probe = document.createElement("span");
      probe.style.cssText = `font-family:${getComputedStyle(el).fontFamily};font-size:100px;position:absolute;visibility:hidden;white-space:pre`;
      probe.textContent = "M";
      document.body.appendChild(probe);
      const charWidthAt100 = probe.getBoundingClientRect().width;
      document.body.removeChild(probe);
      if (charWidthAt100 <= 0) return;

      const containerWidth = el.clientWidth - 16;
      const targetFontSize = (containerWidth / maxCols) * (100 / charWidthAt100);
      el.style.fontSize = `${Math.max(7, Math.min(16, targetFontSize)).toFixed(1)}px`;
    };

    fitFont();
    const observer = new ResizeObserver(fitFont);
    observer.observe(el);
    return () => observer.disconnect();
  }, [viewMode, scrollbackText]);

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

    document.addEventListener("paste", handlePaste);
    return () => document.removeEventListener("paste", handlePaste);
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
    const selected = window.getSelection()?.toString() || scrollbackText;
    await navigator.clipboard.writeText(selected);
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
      <header className="topbar">
        <button
          onClick={() => setDrawerOpen((value) => !value)}
          className="icon-btn"
          data-testid="drawer-toggle"
        >
          =
        </button>
        <div className="top-title">
          Window: {activeWindow ? `${activeWindow.index}: ${activeWindow.name}` : "-"}
        </div>
        <div className="top-actions">
          <span
            className={`top-status ${topStatus.kind}`}
            title={topStatus.label}
            aria-label={`Status: ${topStatus.label}`}
            data-testid="top-status-indicator"
          />
          <button
            className={`top-zoom-indicator${activePane?.zoomed ? " on" : ""}`}
            title={activePane?.zoomed ? "Active pane is zoomed" : "Active pane is not zoomed"}
            aria-label={`Pane zoom: ${activePane?.zoomed ? "on" : "off"}`}
            data-testid="top-zoom-indicator"
            onClick={() => activePane && sendControl({ type: "zoom_pane", paneId: activePane.id })}
            disabled={!activePane || !activeWindow || activeWindow.paneCount <= 1}
            style={viewMode !== "terminal" ? { display: "none" } : undefined}
          >
            🔍
          </button>
          <button
            className={`top-btn${viewMode === "terminal" ? " active" : ""}`}
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

      {viewMode === "terminal" && <section className="toolbar" onMouseUp={focusTerminal}>
        {/* Row 1: Esc, Ctrl, Alt, Cmd, /, @, Hm, ↑, Ed */}
        <div className="toolbar-main">
          <button onClick={() => sendTerminal("\u001b")}>Esc</button>
          <button className={`modifier ${modifiers.ctrl}`} onClick={() => toggleModifier("ctrl")}>Ctrl</button>
          <button className={`modifier ${modifiers.alt}`} onClick={() => toggleModifier("alt")}>Alt</button>
          <button className={`modifier ${modifiers.meta}`} onClick={() => toggleModifier("meta")}>Cmd</button>
          <button onClick={() => sendTerminal("/")}>/</button>
          <button onClick={() => sendTerminal("@")}>@</button>
          <button onClick={() => sendTerminal("\u001b[H")}>Hm</button>
          <button onClick={() => sendTerminal("\u001b[A")}>↑</button>
          <button onClick={() => sendTerminal("\u001b[F")}>Ed</button>
        </div>

        {/* Row 2: ^C, ^B, ^R, Sft, Tab, Enter, ..., ←, ↓, → */}
        <div className="toolbar-main">
          <button className="danger" onClick={() => sendTerminal("\u0003", false)}>^C</button>
          <button onClick={() => sendTerminal("\u0002", false)}>^B</button>
          <button onClick={() => sendTerminal("\u0012", false)}>^R</button>
          <button className={`modifier ${modifiers.shift}`} onClick={() => toggleModifier("shift")}>Sft</button>
          <button onClick={() => sendTerminal("\t")}>Tab</button>
          <button onClick={() => sendTerminal("\r")}>Enter</button>
          <button
            className="toolbar-expand-btn"
            onClick={() => {
              setToolbarExpanded((v) => !v);
              if (toolbarExpanded) {
                setToolbarDeepExpanded(false);
              }
            }}
          >
            {toolbarExpanded ? "..." : "..."}
          </button>
          <button onClick={() => sendTerminal("\u001b[D")}>←</button>
          <button onClick={() => sendTerminal("\u001b[B")}>↓</button>
          <button onClick={() => sendTerminal("\u001b[C")}>→</button>
        </div>

        {/* Expanded section (collapsible) */}
        <div className={`toolbar-row-secondary ${toolbarExpanded ? "expanded" : ""}`}>
          <button onClick={() => sendTerminal("\u0004", false)}>^D</button>
          <button onClick={() => sendTerminal("\u000c", false)}>^L</button>
          <button
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
            onClick={() => fileInputRef.current?.click()}
          >
            Upload
          </button>
          {/* file input moved outside toolbar for scroll mode access */}
          <button onClick={() => sendTerminal("\u001b[3~")}>Del</button>
          <button onClick={() => sendTerminal("\u001b[2~")}>Insert</button>
          <button onClick={() => sendTerminal("\u001b[5~")}>PgUp</button>
          <button onClick={() => sendTerminal("\u001b[6~")}>PgDn</button>
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
                      onDoubleClick={(e) => {
                        e.preventDefault();
                        setRenamingSession(session.name);
                        setRenameSessionValue(session.name);
                      }}
                      className={session.name === (attachedSession || activeSession?.name) ? "active" : ""}
                    >
                      {session.name} {session.attached ? "*" : ""}
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
                          {windowState.index}: {windowState.name}
                          {windowState.index === activeWindow?.index ? " *" : ""}
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
              >
                Split H
              </button>
              <button
                onClick={() =>
                  activePane &&
                  sendControl({ type: "split_pane", paneId: activePane.id, orientation: "v" })
                }
                disabled={!activePane}
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
            >
              Zoom Pane
            </button>
            <button
              className={`drawer-section-action${stickyZoom ? " active" : ""}`}
              onClick={() => setStickyZoom((v) => !v)}
              data-testid="sticky-zoom-toggle"
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
              sendTerminal(quoted, false);
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

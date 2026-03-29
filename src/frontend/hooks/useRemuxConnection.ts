/**
 * Manages the control WebSocket connection lifecycle:
 * - config fetch, auth flow, reconnect with exponential backoff
 * - password UI state
 * - sendControl helper
 * - delegates all post-auth messages to onControlMessage callback
 *
 * Does NOT manage the terminal WebSocket (that depends on terminal runtime refs).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ControlServerMessage, BackendCapabilities, ServerCapabilities } from "../../shared/protocol";
import type { BandwidthStats, ServerConfig } from "../app-types";
import { MAX_RECONNECT_ATTEMPTS, resolveReconnectDelay, shouldPauseReconnect } from "../reconnect-policy";
import { resolvePreferredWebSocketOrigin } from "../websocket-origin";
import { attachWebSocketKeepAlive } from "../websocket-keepalive";
import {
  debugLog,
  formatPasswordError,
  parseMessage,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  token,
  wsOrigin
} from "../remux-runtime";

export interface ControlAuthPayload {
  session?: string;
  tabIndex?: number;
  paneId?: string;
  cols?: number;
  rows?: number;
}

export interface ConnectionCallbacks {
  /** Called after successful auth. Use to open terminal socket, etc. */
  onAuthOk: (passwordValue: string, clientId: string, serverCapabilities: ServerCapabilities | null) => void;
  /** Called for all control messages except auth_ok/auth_error. */
  onControlMessage: (message: ControlServerMessage) => void;
  /** Called when control socket closes. */
  onControlClose: () => void;
  /** Returns auth payload for initial attach and reconnects. */
  getAuthPayload: () => ControlAuthPayload | null;
}

export interface UseRemuxConnectionResult {
  authReady: boolean;
  errorMessage: string;
  statusMessage: string;
  password: string;
  needsPasswordInput: boolean;
  passwordErrorMessage: string;
  serverConfig: ServerConfig | null;
  capabilities: BackendCapabilities | null;
  serverCapabilities: ServerCapabilities | null;
  bandwidthStats: BandwidthStats | null;
  resolvedSocketOrigin: string;
  retryRequired: boolean;

  retryConnection: () => void;
  sendControl: (payload: Record<string, unknown>) => void;
  setPassword: (value: string) => void;
  submitPassword: () => void;
  setErrorMessage: React.Dispatch<React.SetStateAction<string>>;
  setStatusMessage: React.Dispatch<React.SetStateAction<string>>;
  setBandwidthStats: React.Dispatch<React.SetStateAction<BandwidthStats | null>>;

  controlSocketRef: React.RefObject<WebSocket | null>;
}

export const useRemuxConnection = (callbacks: ConnectionCallbacks): UseRemuxConnectionResult => {
  const cbRef = useRef(callbacks);
  cbRef.current = callbacks;

  const controlSocketRef = useRef<WebSocket | null>(null);
  const socketOriginRef = useRef(wsOrigin);
  const stopControlKeepAliveRef = useRef<(() => void) | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const suppressReconnectRef = useRef(false);

  const [serverConfig, setServerConfig] = useState<ServerConfig | null>(null);
  const serverConfigRef = useRef<ServerConfig | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [statusMessage, setStatusMessage] = useState("");
  const [password, setPassword] = useState(sessionStorage.getItem("remux-password") ?? "");
  const passwordRef = useRef(password);
  const [needsPasswordInput, setNeedsPasswordInput] = useState(false);
  const [passwordErrorMessage, setPasswordErrorMessage] = useState("");
  const [authReady, setAuthReady] = useState(false);
  const [capabilities, setCapabilities] = useState<BackendCapabilities | null>(null);
  const [serverCapabilities, setServerCapabilities] = useState<ServerCapabilities | null>(null);
  const [bandwidthStats, setBandwidthStats] = useState<BandwidthStats | null>(null);
  const [resolvedSocketOrigin, setResolvedSocketOrigin] = useState(wsOrigin);
  const [retryRequired, setRetryRequired] = useState(false);

  useEffect(() => { passwordRef.current = password; }, [password]);
  useEffect(() => { serverConfigRef.current = serverConfig; }, [serverConfig]);

  const sendControl = useCallback((payload: Record<string, unknown>): void => {
    if (controlSocketRef.current?.readyState !== WebSocket.OPEN) {
      debugLog("send_control.blocked", { payload, readyState: controlSocketRef.current?.readyState });
      setErrorMessage("control websocket disconnected");
      return;
    }
    setErrorMessage("");
    debugLog("send_control", payload);
    controlSocketRef.current.send(JSON.stringify(payload));
  }, []);

  const cancelReconnect = (): void => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  };

  const openControlSocketRef = useRef<(pw: string) => void>(() => {});

  const scheduleReconnect = useCallback((passwordValue: string): void => {
    if (suppressReconnectRef.current) return;
    cancelReconnect();
    const attempt = reconnectAttemptRef.current;
    if (shouldPauseReconnect(attempt)) {
      suppressReconnectRef.current = true;
      setRetryRequired(true);
      setErrorMessage(`connection lost after ${MAX_RECONNECT_ATTEMPTS} retries`);
      setStatusMessage("retry required");
      return;
    }

    reconnectAttemptRef.current += 1;
    const delay = resolveReconnectDelay(attempt, RECONNECT_BASE_MS, RECONNECT_MAX_MS);
    debugLog("reconnect.schedule", { attempt, delay });
    setStatusMessage(`reconnecting in ${(delay / 1000).toFixed(0)}s...`);
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      debugLog("reconnect.attempt", { attempt });
      setStatusMessage("reconnecting...");
      openControlSocketRef.current(passwordValue);
    }, delay);
  }, []);

  const openControlSocket = useCallback((passwordValue: string): void => {
    debugLog("control_socket.open.begin", { hasPassword: Boolean(passwordValue) });
    cancelReconnect();
    setRetryRequired(false);
    if (controlSocketRef.current) {
      stopControlKeepAliveRef.current?.();
      stopControlKeepAliveRef.current = null;
      controlSocketRef.current.onclose = null;
      controlSocketRef.current.close();
    }

    const activeSocketOrigin = socketOriginRef.current;
    let authed = false;
    const socket = new WebSocket(`${activeSocketOrigin}/ws/control`);
    socket.onopen = () => {
      debugLog("control_socket.onopen");
      stopControlKeepAliveRef.current?.();
      stopControlKeepAliveRef.current = attachWebSocketKeepAlive(socket, {
        intervalMs: 25_000,
        createPayload: () => JSON.stringify({ type: "ping", timestamp: performance.now() }),
      });
      const sendAuth = (retriesRemaining = 8): void => {
        const authPayload = cbRef.current.getAuthPayload();
        const hasTerminalSize = typeof authPayload?.cols === "number" && typeof authPayload?.rows === "number";
        if (!hasTerminalSize && retriesRemaining > 0) {
          requestAnimationFrame(() => sendAuth(retriesRemaining - 1));
          return;
        }
        socket.send(JSON.stringify({
          type: "auth",
          token,
          password: passwordValue || undefined,
          ...(authPayload ?? {}),
        }));
      };

      sendAuth();
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
          authed = true;
          reconnectAttemptRef.current = 0;
          suppressReconnectRef.current = false;
          setRetryRequired(false);
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
          const nextServerCapabilities = message.serverCapabilities ?? null;
          setServerCapabilities(nextServerCapabilities);
          cbRef.current.onAuthOk(passwordValue, message.clientId, nextServerCapabilities);
          return;
        }
        case "auth_error": {
          suppressReconnectRef.current = true;
          setErrorMessage(message.reason);
          setAuthReady(false);
          const passwordAuthFailed =
            message.reason === "invalid password" || Boolean(serverConfigRef.current?.passwordRequired);
          if (passwordAuthFailed) {
            setNeedsPasswordInput(true);
            setPasswordErrorMessage(formatPasswordError(message.reason));
            sessionStorage.removeItem("remux-password");
          }
          return;
        }
        default:
          cbRef.current.onControlMessage(message);
          return;
      }
    };
    socket.onclose = () => {
      debugLog("control_socket.onclose");
      stopControlKeepAliveRef.current?.();
      stopControlKeepAliveRef.current = null;
      setAuthReady(false);
      setErrorMessage("");
      cbRef.current.onControlClose();
      if (!authed && activeSocketOrigin !== wsOrigin) {
        socketOriginRef.current = wsOrigin;
        setResolvedSocketOrigin(wsOrigin);
        debugLog("control_socket.loopback_fallback", {
          from: activeSocketOrigin,
          to: wsOrigin,
        });
        openControlSocket(passwordValue);
        return;
      }
      scheduleReconnect(passwordValue);
    };
    controlSocketRef.current = socket;
  }, [scheduleReconnect]);

  useEffect(() => {
    openControlSocketRef.current = openControlSocket;
  }, [openControlSocket]);

  // Initial config fetch + connect
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

        if (config.passwordRequired && !passwordRef.current) {
          debugLog("config.fetch.password_required");
          setNeedsPasswordInput(true);
          setPasswordErrorMessage("");
          return;
        }

        const nextSocketOrigin = await resolvePreferredWebSocketOrigin({
          publicOrigin: wsOrigin,
          preferredLoopbackOrigin: config.localWebSocketOrigin,
        });
        socketOriginRef.current = nextSocketOrigin;
        setResolvedSocketOrigin(nextSocketOrigin);
        debugLog("socket_origin.selected", {
          publicOrigin: wsOrigin,
          advertisedLoopbackOrigin: config.localWebSocketOrigin ?? null,
          activeOrigin: nextSocketOrigin,
        });

        openControlSocket(passwordRef.current);
      })
      .catch((error: Error) => {
        debugLog("config.fetch.error", { message: error.message });
        setErrorMessage(error.message);
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cleanup
  useEffect(() => () => {
    stopControlKeepAliveRef.current?.();
    stopControlKeepAliveRef.current = null;
    controlSocketRef.current?.close();
  }, []);

  const submitPassword = useCallback((): void => {
    setPasswordErrorMessage("");
    openControlSocket(passwordRef.current);
  }, [openControlSocket]);

  const retryConnection = useCallback((): void => {
    reconnectAttemptRef.current = 0;
    suppressReconnectRef.current = false;
    setRetryRequired(false);
    setErrorMessage("");
    openControlSocket(passwordRef.current);
  }, [openControlSocket]);

  return {
    authReady,
    errorMessage,
    statusMessage,
    password,
    needsPasswordInput,
    passwordErrorMessage,
    serverConfig,
    capabilities,
    serverCapabilities,
    bandwidthStats,
    resolvedSocketOrigin,
    retryRequired,
    retryConnection,
    sendControl,
    setPassword,
    submitPassword,
    setErrorMessage,
    setStatusMessage,
    setBandwidthStats,
    controlSocketRef,
  };
};

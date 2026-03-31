import { useCallback, useEffect, useRef, useState } from "react";
import { token, wsOrigin, RECONNECT_BASE_MS, RECONNECT_MAX_MS, formatPasswordError } from "../remux-runtime";
import { attachWebSocketKeepAlive } from "../websocket-keepalive";
import { resolveReconnectDelay, shouldPauseReconnect } from "../reconnect-policy";

export type ConnectionStatus =
  | "idle"
  | "connecting"
  | "authenticating"
  | "connected"
  | "disconnected"
  | "error";

export interface UseZellijConnectionResult {
  status: ConnectionStatus;
  errorMessage: string;
  statusMessage: string;

  needsPassword: boolean;
  password: string;
  passwordErrorMessage: string;
  setPassword: (v: string) => void;
  submitPassword: () => void;
  retryConnection: () => void;

  /** Send raw terminal input to the server. */
  sendRaw: (data: string) => void;
  /** Send a resize event to the server. */
  sendResize: (cols: number, rows: number) => void;

  socketRef: React.MutableRefObject<WebSocket | null>;

  serverVersion: string | null;
  serverGitBranch: string | null;
  serverGitCommitSha: string | null;
}

interface ServerConfig {
  passwordRequired: boolean;
  version?: string;
  gitBranch?: string;
  gitCommitSha?: string;
}

export const useZellijConnection = (
  writeToTerminal: (data: string | Uint8Array) => void,
): UseZellijConnectionResult => {
  const socketRef = useRef<WebSocket | null>(null);
  const stopKeepAliveRef = useRef<(() => void) | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const dataCallbackRef = useRef(writeToTerminal);
  dataCallbackRef.current = writeToTerminal;

  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const [statusMessage, setStatusMessage] = useState("");
  const [needsPassword, setNeedsPassword] = useState(false);
  const [password, setPassword] = useState("");
  const [passwordErrorMessage, setPasswordErrorMessage] = useState("");
  const [serverConfig, setServerConfig] = useState<ServerConfig | null>(null);

  const passwordRef = useRef(password);
  passwordRef.current = password;

  const connect = useCallback((passwordOverride?: string) => {
    // Clean up previous connection.
    stopKeepAliveRef.current?.();
    socketRef.current?.close();

    setStatus("connecting");
    setErrorMessage("");
    setStatusMessage("Connecting...");

    const ws = new WebSocket(`${wsOrigin}/ws/terminal`);
    ws.binaryType = "arraybuffer";
    socketRef.current = ws;

    ws.onopen = () => {
      setStatus("authenticating");
      setStatusMessage("Authenticating...");

      stopKeepAliveRef.current = attachWebSocketKeepAlive(ws, {
        intervalMs: 25_000,
        createPayload: () => JSON.stringify({ type: "ping", timestamp: performance.now() }),
      });

      const authMsg: Record<string, unknown> = { type: "auth", token };
      const pw = passwordOverride ?? passwordRef.current;
      if (pw) authMsg.password = pw;

      ws.send(JSON.stringify(authMsg));
    };

    ws.onmessage = (event: MessageEvent) => {
      if (event.data instanceof ArrayBuffer) {
        dataCallbackRef.current(new Uint8Array(event.data));
        return;
      }

      // JSON control message.
      try {
        const msg = JSON.parse(event.data as string);

        if (msg.type === "auth_ok") {
          setStatus("connected");
          setStatusMessage("");
          setNeedsPassword(false);
          setPasswordErrorMessage("");
          reconnectAttemptRef.current = 0;
          return;
        }

        if (msg.type === "auth_error") {
          setPasswordErrorMessage(formatPasswordError(msg.reason ?? "authentication failed"));
          setNeedsPassword(true);
          setStatus("error");
          return;
        }

        // For pong or other messages, just ignore.
      } catch {
        // Not JSON — treat as terminal text output.
        dataCallbackRef.current(event.data as string);
      }
    };

    ws.onclose = () => {
      stopKeepAliveRef.current?.();
      socketRef.current = null;

      if (status === "error") return;
      setStatus("disconnected");
      setStatusMessage("Disconnected");

      // Auto-reconnect.
      const attempt = reconnectAttemptRef.current;
      if (shouldPauseReconnect(attempt)) {
        setErrorMessage("Connection lost. Click to retry.");
        return;
      }
      const delay = resolveReconnectDelay(attempt, RECONNECT_BASE_MS, RECONNECT_MAX_MS);
      reconnectAttemptRef.current = attempt + 1;
      reconnectTimerRef.current = setTimeout(() => connect(), delay);
    };

    ws.onerror = () => {
      // onclose will fire after this.
    };
  }, [status]);

  // Fetch config and initiate connection on mount.
  useEffect(() => {
    const init = async () => {
      try {
        const resp = await fetch("/api/config");
        const config: ServerConfig = await resp.json();
        setServerConfig(config);

        if (config.passwordRequired && !passwordRef.current) {
          setNeedsPassword(true);
          setStatus("idle");
          return;
        }

        connect();
      } catch {
        setErrorMessage("Failed to reach server");
        setStatus("error");
      }
    };
    void init();

    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      stopKeepAliveRef.current?.();
      socketRef.current?.close();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const submitPassword = useCallback(() => {
    setPasswordErrorMessage("");
    connect(passwordRef.current);
  }, [connect]);

  const retryConnection = useCallback(() => {
    reconnectAttemptRef.current = 0;
    connect();
  }, [connect]);

  const sendRaw = useCallback((data: string) => {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(new TextEncoder().encode(data));
  }, []);

  const sendResize = useCallback((cols: number, rows: number) => {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "resize", cols, rows }));
  }, []);

  return {
    status,
    errorMessage,
    statusMessage,
    needsPassword,
    password,
    passwordErrorMessage,
    setPassword,
    submitPassword,
    retryConnection,
    sendRaw,
    sendResize,
    socketRef,
    serverVersion: serverConfig?.version ?? null,
    serverGitBranch: serverConfig?.gitBranch ?? null,
    serverGitCommitSha: serverConfig?.gitCommitSha ?? null,
  };
};

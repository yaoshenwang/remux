import { useCallback, useEffect, useRef, useState } from "react";
import { token, wsOrigin, formatPasswordError } from "../remux-runtime";
import { attachWebSocketKeepAlive } from "../websocket-keepalive";

// --- Workspace state types (matches server output) ---

export interface WorkspacePane {
  id: string;
  focused: boolean;
  title: string;
  command: string | null;
  cwd: string | null;
  rows: number;
  cols: number;
  x: number;
  y: number;
}

export interface WorkspaceTab {
  index: number;
  name: string;
  active: boolean;
  isFullscreen: boolean;
  hasBell: boolean;
  panes: WorkspacePane[];
}

export interface WorkspaceState {
  session: string;
  tabs: WorkspaceTab[];
  activeTabIndex: number;
}

export interface BandwidthStats {
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
}

export interface UseZellijControlResult {
  // Connection state
  connected: boolean;
  needsPassword: boolean;
  password: string;
  passwordErrorMessage: string;
  setPassword: (v: string) => void;
  submitPassword: () => void;

  // Workspace state
  workspace: WorkspaceState | null;

  // Inspect
  inspectContent: string | null;

  // Bandwidth stats
  bandwidthStats: BandwidthStats | null;

  // Actions
  refreshWorkspace: () => void;
  newTab: (name?: string) => void;
  closeTab: (tabIndex: number) => void;
  selectTab: (tabIndex: number) => void;
  renameTab: (tabIndex: number, name: string) => void;
  newPane: (direction: "right" | "down") => void;
  closePane: () => void;
  toggleFullscreen: () => void;
  requestInspect: (full?: boolean) => void;
  renameSession: (name: string) => void;
}

export const useZellijControl = (): UseZellijControlResult => {
  const socketRef = useRef<WebSocket | null>(null);
  const stopKeepAliveRef = useRef<(() => void) | null>(null);

  const [connected, setConnected] = useState(false);
  const [needsPassword, setNeedsPassword] = useState(false);
  const [password, setPassword] = useState("");
  const [passwordErrorMessage, setPasswordErrorMessage] = useState("");
  const [workspace, setWorkspace] = useState<WorkspaceState | null>(null);
  const [inspectContent, setInspectContent] = useState<string | null>(null);
  const [bandwidthStats, setBandwidthStats] = useState<BandwidthStats | null>(null);
  const rttTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const passwordRef = useRef(password);
  passwordRef.current = password;

  const send = useCallback((msg: Record<string, unknown>) => {
    const ws = socketRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }, []);

  const connect = useCallback((passwordOverride?: string) => {
    stopKeepAliveRef.current?.();
    socketRef.current?.close();

    const ws = new WebSocket(`${wsOrigin}/ws/control`);
    socketRef.current = ws;

    ws.onopen = () => {
      stopKeepAliveRef.current = attachWebSocketKeepAlive(ws, {
        intervalMs: 25_000,
        createPayload: () => JSON.stringify({ type: "ping" }),
      });

      const authMsg: Record<string, unknown> = { type: "auth", token };
      const pw = passwordOverride ?? passwordRef.current;
      if (pw) authMsg.password = pw;
      ws.send(JSON.stringify(authMsg));
    };

    ws.onmessage = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data as string);

        // Handle bandwidth_stats and pong (extension messages).
        if (msg.type === "bandwidth_stats" && msg.stats) {
          setBandwidthStats(msg.stats as BandwidthStats);
          return;
        }
        if (msg.type === "pong" && typeof msg.timestamp === "number") {
          const rtt = Math.round(performance.now() - msg.timestamp);
          setBandwidthStats((prev) => prev ? { ...prev, rttMs: rtt } : null);
          return;
        }

        if (msg.type === "auth_ok") {
          setConnected(true);
          setNeedsPassword(false);
          setPasswordErrorMessage("");
          // Request initial workspace state.
          ws.send(JSON.stringify({ type: "subscribe_workspace" }));
          // Start RTT measurement pings.
          if (rttTimerRef.current) clearInterval(rttTimerRef.current);
          rttTimerRef.current = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "ping", timestamp: performance.now() }));
            }
          }, 10_000);
          return;
        }

        if (msg.type === "auth_error") {
          setPasswordErrorMessage(formatPasswordError(msg.reason ?? "authentication failed"));
          setNeedsPassword(true);
          setConnected(false);
          return;
        }

        if (msg.type === "workspace_state") {
          setWorkspace({
            session: msg.session,
            tabs: msg.tabs,
            activeTabIndex: msg.activeTabIndex,
          });
          return;
        }

        if (msg.type === "inspect_content") {
          setInspectContent(msg.content ?? null);
          return;
        }
      } catch {
        // Ignore non-JSON.
      }
    };

    ws.onclose = () => {
      stopKeepAliveRef.current?.();
      if (rttTimerRef.current) {
        clearInterval(rttTimerRef.current);
        rttTimerRef.current = null;
      }
      setConnected(false);
      // Auto-reconnect after 2s.
      setTimeout(() => connect(), 2000);
    };

    ws.onerror = () => {};
  }, []);

  useEffect(() => {
    const init = async () => {
      try {
        const resp = await fetch("/api/config");
        const config = await resp.json();
        if (config.passwordRequired && !passwordRef.current) {
          setNeedsPassword(true);
          return;
        }
        connect();
      } catch {
        // Retry.
        setTimeout(() => void init(), 3000);
      }
    };
    void init();

    return () => {
      stopKeepAliveRef.current?.();
      if (rttTimerRef.current) clearInterval(rttTimerRef.current);
      socketRef.current?.close();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const submitPassword = useCallback(() => {
    setPasswordErrorMessage("");
    connect(passwordRef.current);
  }, [connect]);

  return {
    connected,
    needsPassword,
    password,
    passwordErrorMessage,
    setPassword,
    submitPassword,
    workspace,
    inspectContent,
    bandwidthStats,
    refreshWorkspace: useCallback(() => send({ type: "subscribe_workspace" }), [send]),
    newTab: useCallback((name?: string) => send({ type: "new_tab", name }), [send]),
    closeTab: useCallback((tabIndex: number) => send({ type: "close_tab", tabIndex }), [send]),
    selectTab: useCallback((tabIndex: number) => send({ type: "select_tab", tabIndex }), [send]),
    renameTab: useCallback((tabIndex: number, name: string) => send({ type: "rename_tab", tabIndex, name }), [send]),
    newPane: useCallback((direction: "right" | "down") => send({ type: "new_pane", direction }), [send]),
    closePane: useCallback(() => send({ type: "close_pane" }), [send]),
    toggleFullscreen: useCallback(() => send({ type: "toggle_fullscreen" }), [send]),
    requestInspect: useCallback((full?: boolean) => send({ type: "capture_inspect", full: full ?? true }), [send]),
    renameSession: useCallback((name: string) => send({ type: "rename_session", name }), [send]),
  };
};

import { useCallback, useEffect, useRef, useState } from "react";
import {
  buildInspectCacheBucketKey,
  readInspectCache,
  toLocalCacheSnapshot,
  writeInspectCache,
} from "../inspect/cache.js";
import type { InspectRequest, InspectSnapshot } from "../inspect/types.js";
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
  inspectSnapshot: InspectSnapshot | null;
  inspectLoading: boolean;
  inspectError: string | null;

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
  requestInspect: (
    request?: Partial<InspectRequest>,
    options?: { append?: boolean; preferCache?: boolean },
  ) => void;
  loadMoreInspect: () => void;
  renameSession: (name: string) => void;
}

interface PendingInspectRequest {
  append: boolean;
  baseRequest: InspectRequest;
  cacheKey: string | null;
}

export const useZellijControl = (): UseZellijControlResult => {
  const socketRef = useRef<WebSocket | null>(null);
  const stopKeepAliveRef = useRef<(() => void) | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectRef = useRef<(passwordOverride?: string) => void>(() => undefined);

  const [connected, setConnected] = useState(false);
  const [needsPassword, setNeedsPassword] = useState(false);
  const [password, setPassword] = useState("");
  const [passwordErrorMessage, setPasswordErrorMessage] = useState("");
  const [workspace, setWorkspace] = useState<WorkspaceState | null>(null);
  const [inspectSnapshot, setInspectSnapshot] = useState<InspectSnapshot | null>(null);
  const [inspectLoading, setInspectLoading] = useState(false);
  const [inspectError, setInspectError] = useState<string | null>(null);
  const [bandwidthStats, setBandwidthStats] = useState<BandwidthStats | null>(null);
  const rttTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const inspectSnapshotRef = useRef<InspectSnapshot | null>(null);
  const pendingInspectRequestRef = useRef<PendingInspectRequest | null>(null);
  const lastInspectRequestRef = useRef<InspectRequest | null>(null);
  const workspaceSessionRef = useRef("remux");

  const passwordRef = useRef(password);
  passwordRef.current = password;
  workspaceSessionRef.current = workspace?.session ?? workspaceSessionRef.current;

  const markInspectSnapshot = useCallback((snapshot: InspectSnapshot | null) => {
    inspectSnapshotRef.current = snapshot;
    setInspectSnapshot(snapshot);
  }, []);

  const send = useCallback((msg: Record<string, unknown>) => {
    const ws = socketRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }, []);

  const resolveInspectRequest = useCallback((request: Partial<InspectRequest> = {}): InspectRequest | null => {
    const scope = request.scope ?? lastInspectRequestRef.current?.scope ?? "tab";
    const currentTabIndex = request.tabIndex ?? workspace?.activeTabIndex ?? 0;
    const activeTab = workspace?.tabs.find((tab) => tab.index === currentTabIndex)
      ?? workspace?.tabs.find((tab) => tab.active)
      ?? workspace?.tabs[0];

    if (scope === "tab") {
      return {
        scope,
        tabIndex: request.tabIndex ?? activeTab?.index ?? workspace?.activeTabIndex ?? 0,
        query: request.query,
        limit: request.limit,
        cursor: request.cursor ?? null,
      };
    }

    const defaultPaneId = activeTab?.panes.find((pane) => pane.focused)?.id ?? activeTab?.panes[0]?.id;
    const paneId = request.paneId ?? defaultPaneId;
    if (!paneId) {
      return null;
    }

    return {
      scope,
      paneId,
      tabIndex: activeTab?.index,
      query: request.query,
      limit: request.limit,
      cursor: request.cursor ?? null,
    };
  }, [workspace]);

  const requestInspect = useCallback((
    request: Partial<InspectRequest> = {},
    options: { append?: boolean; preferCache?: boolean } = {},
  ) => {
    const resolved = resolveInspectRequest(request);
    if (!resolved) {
      return;
    }

    const baseRequest: InspectRequest = {
      scope: resolved.scope,
      paneId: resolved.paneId,
      tabIndex: resolved.tabIndex,
      query: resolved.query,
      limit: resolved.limit,
    };
    const sessionName = workspace?.session ?? "remux";
    const cacheKey = !baseRequest.query
      ? buildInspectCacheBucketKey(sessionName, baseRequest)
      : null;

    if (options.preferCache !== false && !resolved.cursor && cacheKey) {
      const cached = readInspectCache(cacheKey);
      if (cached) {
        markInspectSnapshot(toLocalCacheSnapshot(cached));
      }
    }

    if (!resolved.cursor) {
      lastInspectRequestRef.current = baseRequest;
    }

    pendingInspectRequestRef.current = {
      append: options.append ?? Boolean(resolved.cursor),
      baseRequest,
      cacheKey,
    };
    setInspectLoading(true);
    setInspectError(null);
    send({
      type: "request_inspect",
      ...resolved,
    });
  }, [markInspectSnapshot, resolveInspectRequest, send, workspace?.session]);

  const connect = useCallback((passwordOverride?: string) => {
    stopKeepAliveRef.current?.();
    socketRef.current?.close();
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

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
          setInspectError(null);
          // Request initial workspace state.
          ws.send(JSON.stringify({ type: "subscribe_workspace" }));
          if (lastInspectRequestRef.current) {
            pendingInspectRequestRef.current = {
              append: false,
              baseRequest: lastInspectRequestRef.current,
              cacheKey: lastInspectRequestRef.current.query
                ? null
                : buildInspectCacheBucketKey(workspaceSessionRef.current, lastInspectRequestRef.current),
            };
            setInspectLoading(true);
            ws.send(JSON.stringify({ type: "request_inspect", ...lastInspectRequestRef.current }));
          }
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

        if (msg.type === "inspect_snapshot" && msg.descriptor && Array.isArray(msg.items)) {
          const nextSnapshot = {
            descriptor: msg.descriptor,
            items: msg.items,
            cursor: msg.cursor ?? null,
            truncated: Boolean(msg.truncated),
          } satisfies InspectSnapshot;
          const pendingRequest = pendingInspectRequestRef.current;
          const combinedSnapshot = pendingRequest?.append && inspectSnapshotRef.current
            ? {
              ...nextSnapshot,
              items: [...inspectSnapshotRef.current.items, ...nextSnapshot.items],
              descriptor: {
                ...nextSnapshot.descriptor,
                totalItems: nextSnapshot.descriptor.totalItems
                  ?? inspectSnapshotRef.current.descriptor.totalItems
                  ?? nextSnapshot.items.length,
              },
            }
            : nextSnapshot;

          markInspectSnapshot(combinedSnapshot);
          pendingInspectRequestRef.current = null;
          setInspectLoading(false);
          setInspectError(null);

          if (pendingRequest?.cacheKey && !pendingRequest.baseRequest.query) {
            writeInspectCache(pendingRequest.cacheKey, combinedSnapshot);
          }
          return;
        }

        if (msg.type === "inspect_content") {
          markInspectSnapshot(null);
          setInspectLoading(false);
          setInspectError(msg.content ? null : "legacy inspect content unavailable");
          return;
        }

        if (msg.type === "error") {
          if (pendingInspectRequestRef.current) {
            pendingInspectRequestRef.current = null;
            setInspectLoading(false);
            setInspectError(msg.message ?? "inspect request failed");
          }
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
      if (inspectSnapshotRef.current) {
        markInspectSnapshot({
          ...inspectSnapshotRef.current,
          descriptor: {
            ...inspectSnapshotRef.current.descriptor,
            staleness: "stale",
          },
        });
      }
      // Auto-reconnect after 2s.
      reconnectTimerRef.current = setTimeout(() => connectRef.current(), 2000);
    };

    ws.onerror = () => {};
  }, [markInspectSnapshot]);
  connectRef.current = connect;

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
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      socketRef.current?.close();
    };
  }, [connect]);

  const submitPassword = useCallback(() => {
    setPasswordErrorMessage("");
    connect(passwordRef.current);
  }, [connect]);

  const loadMoreInspect = useCallback(() => {
    if (!inspectSnapshotRef.current?.cursor || !lastInspectRequestRef.current) {
      return;
    }

    requestInspect(
      {
        ...lastInspectRequestRef.current,
        cursor: inspectSnapshotRef.current.cursor,
      },
      {
        append: true,
        preferCache: false,
      },
    );
  }, [requestInspect]);

  return {
    connected,
    needsPassword,
    password,
    passwordErrorMessage,
    setPassword,
    submitPassword,
    workspace,
    inspectSnapshot,
    inspectLoading,
    inspectError,
    bandwidthStats,
    refreshWorkspace: useCallback(() => send({ type: "subscribe_workspace" }), [send]),
    newTab: useCallback((name?: string) => send({ type: "new_tab", name }), [send]),
    closeTab: useCallback((tabIndex: number) => send({ type: "close_tab", tabIndex }), [send]),
    selectTab: useCallback((tabIndex: number) => send({ type: "select_tab", tabIndex }), [send]),
    renameTab: useCallback((tabIndex: number, name: string) => send({ type: "rename_tab", tabIndex, name }), [send]),
    newPane: useCallback((direction: "right" | "down") => send({ type: "new_pane", direction }), [send]),
    closePane: useCallback(() => send({ type: "close_pane" }), [send]),
    toggleFullscreen: useCallback(() => send({ type: "toggle_fullscreen" }), [send]),
    requestInspect,
    loadMoreInspect,
    renameSession: useCallback((name: string) => send({ type: "rename_session", name }), [send]),
  };
};

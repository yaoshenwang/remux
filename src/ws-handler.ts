/**
 * WebSocket handler for Remux.
 * All WebSocket message routing: auth gate, control messages, terminal I/O.
 *
 * Protocol envelope (v1): all server-sent JSON messages are wrapped in
 * { v: 1, type: string, payload: T }. Incoming messages accept both
 * enveloped (v:1) and legacy bare formats for backward compatibility.
 *
 * Client connection state: each WebSocket gets a clientId and role
 * (active/observer). First client on a tab is active; subsequent are
 * observers whose terminal input is silently dropped.
 */

import crypto from "crypto";
import type http from "http";
import { WebSocketServer } from "ws";
import type WebSocket from "ws";
import {
  type RemuxWebSocket,
  controlClients,
  sessionMap,
  createSession,
  createTab,
  deleteSession,
  getState,
  findTab,
  attachToTab,
  detachFromTab,
  recalcTabSize,
  broadcastState,
  setBroadcastHooks,
} from "./session.js";
import { validateToken } from "./auth.js";

// ── Protocol Envelope ───────────────────────────────────────────

/**
 * Send an enveloped JSON message: { v: 1, type, payload }.
 */
export function sendEnvelope<T>(
  ws: WebSocket | RemuxWebSocket,
  type: string,
  payload: T,
): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ v: 1, type, payload }));
  }
}

/**
 * Unwrap an incoming message. If it has `v: 1`, extract type + payload.
 * Otherwise treat as legacy bare message (return as-is).
 */
function unwrapMessage(parsed: any): { type: string; [key: string]: any } {
  if (parsed && parsed.v === 1 && typeof parsed.type === "string") {
    return { type: parsed.type, ...(parsed.payload || {}) };
  }
  return parsed;
}

// ── Client Connection State ─────────────────────────────────────

export interface ClientState {
  clientId: string;
  role: "active" | "observer";
  connectedAt: number;
  currentSession: string | null;
  currentTabId: number | null;
}

/** Map from WebSocket to client tracking state. */
export const clientStates = new Map<RemuxWebSocket, ClientState>();

function generateClientId(): string {
  return crypto.randomBytes(4).toString("hex");
}

/**
 * Determine the active client for a given tab.
 * Returns the first client found with role 'active' on that tab.
 */
function getActiveClientForTab(tabId: number): RemuxWebSocket | null {
  for (const [ws, state] of clientStates) {
    if (state.currentTabId === tabId && state.role === "active") return ws;
  }
  return null;
}

/**
 * Assign roles after a client attaches to a tab.
 * If no active client exists on the tab, the client becomes active.
 * Otherwise it becomes an observer.
 */
function assignRole(ws: RemuxWebSocket, tabId: number): void {
  const state = clientStates.get(ws);
  if (!state) return;

  const existingActive = getActiveClientForTab(tabId);
  if (!existingActive || existingActive === ws) {
    state.role = "active";
  } else {
    state.role = "observer";
  }
  state.currentTabId = tabId;
}

/**
 * When a client detaches or disconnects, reassign roles.
 * If the disconnecting client was active, promote the first observer.
 */
function reassignRolesAfterDetach(
  tabId: number,
  wasActive: boolean,
): void {
  if (!wasActive) return;

  // Find first observer on the same tab and promote
  for (const [ws, state] of clientStates) {
    if (
      state.currentTabId === tabId &&
      state.role === "observer" &&
      ws.readyState === ws.OPEN
    ) {
      state.role = "active";
      sendEnvelope(ws, "role_changed", {
        clientId: state.clientId,
        role: "active",
      });
      break;
    }
  }
}

/**
 * Get client list for state broadcasts.
 */
export function getClientList(): Array<{
  clientId: string;
  role: "active" | "observer";
  session: string | null;
  tabId: number | null;
}> {
  const list: Array<{
    clientId: string;
    role: "active" | "observer";
    session: string | null;
    tabId: number | null;
  }> = [];
  for (const [ws, state] of clientStates) {
    if (ws.readyState === ws.OPEN) {
      list.push({
        clientId: state.clientId,
        role: state.role,
        session: state.currentSession,
        tabId: state.currentTabId,
      });
    }
  }
  return list;
}

// ── Setup ────────────────────────────────────────────────────────

/**
 * Create a WebSocketServer, wire up upgrade handling and message routing.
 */
export function setupWebSocket(
  httpServer: http.Server,
  TOKEN: string | null,
  PASSWORD: string | null,
): WebSocketServer {
  // Wire broadcast hooks to break the circular session <-> ws-handler dependency
  setBroadcastHooks(sendEnvelope, getClientList);

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    if (url.pathname === "/ws") {
      wss.handleUpgrade(req, socket, head, (ws) =>
        wss.emit("connection", ws, req),
      );
    } else {
      socket.destroy();
    }
  });

  // ── Heartbeat: ping authenticated clients every 30s ──
  const HEARTBEAT_INTERVAL = 30_000;
  setInterval(() => {
    for (const ws of controlClients) {
      if (ws.readyState === ws.OPEN) ws.ping();
    }
  }, HEARTBEAT_INTERVAL);

  wss.on("connection", (rawWs: WebSocket) => {
    const ws = rawWs as RemuxWebSocket;
    ws._remuxTabId = null;
    ws._remuxCols = 80;
    ws._remuxRows = 24;

    // Auth: no auth needed only if neither token nor password is configured
    const requiresAuth = !!(TOKEN || PASSWORD);
    ws._remuxAuthed = !requiresAuth;

    // Initialize client state
    const clientId = generateClientId();
    const clientState: ClientState = {
      clientId,
      role: "observer",
      connectedAt: Date.now(),
      currentSession: null,
      currentTabId: null,
    };
    clientStates.set(ws, clientState);

    if (!requiresAuth) controlClients.add(ws);

    ws.on("message", (raw) => {
      const msg = raw.toString("utf8");

      // ── Auth gate ──
      if (!ws._remuxAuthed) {
        try {
          const rawParsed = JSON.parse(msg);
          const parsed = unwrapMessage(rawParsed);
          if (parsed.type === "auth") {
            if (validateToken(parsed.token, TOKEN)) {
              ws._remuxAuthed = true;
              controlClients.add(ws);
              sendEnvelope(ws, "auth_ok", {});
              sendEnvelope(ws, "state", {
                sessions: getState(),
                clients: getClientList(),
              });
              return;
            }
          }
        } catch {}
        sendEnvelope(ws, "auth_error", { reason: "invalid token" });
        ws.close(4001, "unauthorized");
        return;
      }

      // ── JSON control messages ──
      if (msg.startsWith("{")) {
        try {
          const rawParsed = JSON.parse(msg);
          const p = unwrapMessage(rawParsed);

          // Attach to first tab of a session (or create one)
          if (p.type === "attach_first") {
            const name = p.session || "main";
            const session = createSession(name);
            let tab = session.tabs.find((t) => !t.ended);
            if (!tab)
              tab = createTab(
                session,
                p.cols || ws._remuxCols,
                p.rows || ws._remuxRows,
              );
            attachToTab(
              tab,
              ws,
              p.cols || ws._remuxCols,
              p.rows || ws._remuxRows,
            );
            clientState.currentSession = name;
            assignRole(ws, tab.id);
            // Send state BEFORE attached so client has session/tab data when processing attached
            broadcastState();
            sendEnvelope(ws, "attached", {
              tabId: tab.id,
              session: name,
              clientId: clientState.clientId,
              role: clientState.role,
            });
            return;
          }

          // Attach to an existing tab by id
          if (p.type === "attach_tab") {
            const found = findTab(p.tabId);
            if (found) {
              attachToTab(
                found.tab,
                ws,
                p.cols || ws._remuxCols,
                p.rows || ws._remuxRows,
              );
              clientState.currentSession = found.session.name;
              assignRole(ws, found.tab.id);
              broadcastState();
              sendEnvelope(ws, "attached", {
                tabId: found.tab.id,
                session: found.session.name,
                clientId: clientState.clientId,
                role: clientState.role,
              });
            }
            return;
          }

          // Create a new tab in a session (creates session if needed)
          if (p.type === "new_tab") {
            const session = createSession(p.session || "main");
            const tab = createTab(
              session,
              p.cols || ws._remuxCols,
              p.rows || ws._remuxRows,
            );
            attachToTab(
              tab,
              ws,
              p.cols || ws._remuxCols,
              p.rows || ws._remuxRows,
            );
            clientState.currentSession = session.name;
            assignRole(ws, tab.id);
            broadcastState();
            sendEnvelope(ws, "attached", {
              tabId: tab.id,
              session: session.name,
              clientId: clientState.clientId,
              role: clientState.role,
            });
            return;
          }

          // Close a tab (kill its PTY)
          if (p.type === "close_tab") {
            const found = findTab(p.tabId);
            if (found) {
              if (!found.tab.ended) found.tab.pty.kill();
              found.session.tabs = found.session.tabs.filter(
                (t) => t.id !== p.tabId,
              );
              // If session has no tabs left, remove it (unless it's "main")
              if (
                found.session.tabs.length === 0 &&
                found.session.name !== "main"
              ) {
                sessionMap.delete(found.session.name);
              }
            }
            broadcastState();
            return;
          }

          // Create a new session (with one default tab)
          if (p.type === "new_session") {
            const name = p.name || "session-" + Date.now();
            const session = createSession(name);
            const tab = createTab(
              session,
              p.cols || ws._remuxCols,
              p.rows || ws._remuxRows,
            );
            attachToTab(
              tab,
              ws,
              p.cols || ws._remuxCols,
              p.rows || ws._remuxRows,
            );
            clientState.currentSession = name;
            assignRole(ws, tab.id);
            broadcastState();
            sendEnvelope(ws, "attached", {
              tabId: tab.id,
              session: name,
              clientId: clientState.clientId,
              role: clientState.role,
            });
            return;
          }

          // Delete entire session
          if (p.type === "delete_session") {
            if (p.name) {
              deleteSession(p.name);
              broadcastState();
            }
            return;
          }

          // Inspect: capture current tab's terminal content as text
          if (p.type === "inspect") {
            const found = findTab(ws._remuxTabId);
            if (found && found.tab.vt && !found.tab.ended) {
              const { text, cols, rows } = found.tab.vt.textSnapshot();
              sendEnvelope(ws, "inspect_result", {
                text,
                meta: {
                  session: found.session.name,
                  tabId: found.tab.id,
                  tabTitle: found.tab.title,
                  cols,
                  rows,
                  timestamp: Date.now(),
                },
              });
            } else {
              // Fallback: raw scrollback as text
              const found2 = findTab(ws._remuxTabId);
              const rawText = found2
                ? found2.tab.scrollback.read().toString("utf8")
                : "";
              // Strip ANSI escape sequences
              const text = rawText
                .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
                .replace(/\x1b\][^\x07]*\x07/g, "");
              sendEnvelope(ws, "inspect_result", {
                text,
                meta: { timestamp: Date.now() },
              });
            }
            return;
          }

          // Rename a tab
          if (p.type === "rename_tab") {
            const found = findTab(p.tabId);
            if (found && typeof p.title === "string" && p.title.trim()) {
              found.tab.title = p.title.trim().slice(0, 32);
              broadcastState();
            }
            return;
          }

          // Resize current tab
          if (p.type === "resize") {
            ws._remuxCols = p.cols;
            ws._remuxRows = p.rows;
            const found = findTab(ws._remuxTabId);
            if (found) recalcTabSize(found.tab);
            return;
          }

          // ── Control handoff ──

          // Request control: observer requests to become active
          if (p.type === "request_control") {
            const tabId = ws._remuxTabId;
            if (tabId == null) return;

            const currentActive = getActiveClientForTab(tabId);
            if (currentActive && currentActive !== ws) {
              // Demote current active to observer
              const activeState = clientStates.get(currentActive);
              if (activeState) {
                activeState.role = "observer";
                sendEnvelope(currentActive, "role_changed", {
                  clientId: activeState.clientId,
                  role: "observer",
                });
              }
            }

            // Promote requester to active
            clientState.role = "active";
            sendEnvelope(ws, "role_changed", {
              clientId: clientState.clientId,
              role: "active",
            });
            broadcastState();
            return;
          }

          // Release control: active voluntarily becomes observer
          if (p.type === "release_control") {
            const tabId = ws._remuxTabId;
            if (tabId == null) return;

            if (clientState.role === "active") {
              clientState.role = "observer";
              sendEnvelope(ws, "role_changed", {
                clientId: clientState.clientId,
                role: "observer",
              });

              // Promote first waiting observer
              for (const [otherWs, otherState] of clientStates) {
                if (
                  otherWs !== ws &&
                  otherState.currentTabId === tabId &&
                  otherState.role === "observer" &&
                  otherWs.readyState === otherWs.OPEN
                ) {
                  otherState.role = "active";
                  sendEnvelope(otherWs, "role_changed", {
                    clientId: otherState.clientId,
                    role: "active",
                  });
                  break;
                }
              }
              broadcastState();
            }
            return;
          }

          return;
        } catch {
          /* not JSON */
        }
      }

      // ── Raw terminal input -> current tab's PTY ──
      // Only active clients can write to PTY; observer input is silently dropped
      if (clientState.role !== "active") return;

      const found = findTab(ws._remuxTabId);
      if (found && !found.tab.ended) {
        found.tab.pty.write(msg);
      }
    });

    ws.on("close", () => {
      const tabId = ws._remuxTabId;
      const wasActive = clientState.role === "active";

      detachFromTab(ws);
      controlClients.delete(ws);
      clientStates.delete(ws);

      // Reassign roles if the disconnecting client was active
      if (tabId != null) {
        reassignRolesAfterDetach(tabId, wasActive);
        broadcastState();
      }
    });

    ws.on("error", () => {});
  });

  return wss;
}

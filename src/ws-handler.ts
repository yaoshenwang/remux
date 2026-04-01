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
import { E2EESession } from "./e2ee.js";
import type WebSocket from "ws";
import {
  type RemuxWebSocket,
  controlClients,
  sessionMap,
  createSession,
  createTab,
  deleteSession,
  getState,
  getFirstSessionName,
  findTab,
  attachToTab,
  detachFromTab,
  recalcTabSize,
  broadcastState,
  setBroadcastHooks,
} from "./session.js";
import { validateToken, registerDevice } from "./auth.js";
import {
  listDevices,
  updateDeviceTrust,
  renameDevice,
  deleteDevice,
  findDeviceById,
  createPairCode,
  consumePairCode,
  touchDevice,
  savePushSubscription,
  removePushSubscription,
  getPushSubscription,
  type Device,
} from "./store.js";
import {
  getVapidPublicKey,
  sendPushNotification,
  broadcastPush,
} from "./push.js";
import {
  createTopic,
  updateTopic,
  listTopics,
  deleteTopic,
  createRun,
  updateRun,
  listRuns,
  listArtifacts,
  createApproval,
  listApprovals,
  resolveApproval,
  searchEntities,
  createNote,
  listNotes,
  updateNote,
  deleteNote,
  togglePinNote,
  listCommands,
  removeStaleTab,
  removeSession as removeSessionFromDb,
} from "./store.js";
import {
  captureSnapshot,
  createCommandCard,
  getTopicSummary,
  generateHandoffBundle,
} from "./workspace.js";
import {
  detectContentType,
  renderDiff,
  renderMarkdown,
  renderAnsi,
} from "./renderers.js";

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
  lastActiveAt: number; // last time this client sent input or took control
  currentSession: string | null;
  currentTabId: number | null;
}

// If active client hasn't sent input for this long, new clients can claim active
const ACTIVE_IDLE_TIMEOUT_MS = 120_000; // 2 minutes

/** Map from WebSocket to client tracking state. */
export const clientStates = new Map<RemuxWebSocket, ClientState>();

/** Map from WebSocket to E2EE session (only present when client initiated E2EE). */
export const e2eeSessions = new Map<RemuxWebSocket, E2EESession>();

/**
 * Send data to a WebSocket, encrypting if E2EE is established.
 * For raw terminal output that bypasses sendEnvelope.
 */
export function e2eeSend(ws: WebSocket | RemuxWebSocket, data: string): void {
  if (ws.readyState !== ws.OPEN) return;
  const session = e2eeSessions.get(ws as RemuxWebSocket);
  if (session && session.isEstablished()) {
    // Wrap encrypted data in e2ee_msg envelope
    const encrypted = session.encryptMessage(data);
    ws.send(JSON.stringify({ v: 1, type: "e2ee_msg", payload: { data: encrypted } }));
  } else {
    ws.send(data);
  }
}

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
 * If the existing active client has been idle beyond ACTIVE_IDLE_TIMEOUT_MS,
 * the new client steals active and the idle client is demoted.
 * Otherwise the new client becomes an observer.
 */
function assignRole(ws: RemuxWebSocket, tabId: number): void {
  const state = clientStates.get(ws);
  if (!state) return;

  const existingActive = getActiveClientForTab(tabId);
  if (!existingActive || existingActive === ws) {
    state.role = "active";
    state.lastActiveAt = Date.now();
  } else {
    // Check if existing active client is idle — if so, steal active
    const activeState = clientStates.get(existingActive);
    const isIdle = activeState && (Date.now() - activeState.lastActiveAt > ACTIVE_IDLE_TIMEOUT_MS);
    if (isIdle) {
      activeState!.role = "observer";
      sendEnvelope(existingActive, "role_changed", {
        clientId: activeState!.clientId,
        role: "observer",
      });
      state.role = "active";
      state.lastActiveAt = Date.now();
    } else {
      state.role = "observer";
    }
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
/** Map deviceId -> Set of connected WebSockets (for force-disconnect on revoke). */
const deviceSockets = new Map<string, Set<RemuxWebSocket>>();

export function setupWebSocket(
  httpServer: http.Server,
  TOKEN: string | null,
  PASSWORD: string | null,
): WebSocketServer {
  // Wire broadcast hooks to break the circular session <-> ws-handler dependency
  setBroadcastHooks(sendEnvelope, getClientList, e2eeSend);

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    // Disable Nagle algorithm to minimize input latency (see #80)
    if ("setNoDelay" in socket) (socket as import("net").Socket).setNoDelay(true);
    const url = new URL(req.url!, `http://${req.headers.host}`);
    if (url.pathname === "/ws") {
      wss.handleUpgrade(req, socket, head, (ws) =>
        wss.emit("connection", ws, req),
      );
    } else {
      socket.destroy();
    }
  });

  // ── Heartbeat: send data-level ping to authenticated clients every 30s ──
  // Browser onmessage does NOT fire for protocol-level ws.ping() frames,
  // so we send a JSON envelope that the client can use to reset its timeout.
  const HEARTBEAT_INTERVAL = 30_000;
  setInterval(() => {
    for (const ws of controlClients) {
      if (ws.readyState === ws.OPEN) sendEnvelope(ws, "ping", {});
    }
  }, HEARTBEAT_INTERVAL);

  wss.on("connection", (rawWs: WebSocket, req: http.IncomingMessage) => {
    const ws = rawWs as RemuxWebSocket;
    ws._remuxTabId = null;
    ws._remuxCols = 80;
    ws._remuxRows = 24;
    ws._remuxDeviceId = null;

    // Auth: no auth needed only if neither token nor password is configured
    const requiresAuth = !!(TOKEN || PASSWORD);
    ws._remuxAuthed = !requiresAuth;

    // Initialize client state
    const clientId = generateClientId();
    const clientState: ClientState = {
      clientId,
      role: "observer",
      connectedAt: Date.now(),
      lastActiveAt: Date.now(),
      currentSession: null,
      currentTabId: null,
    };
    clientStates.set(ws, clientState);

    // Register device from request headers
    let deviceInfo: Device | null = null;
    try {
      const { device } = registerDevice(req);
      deviceInfo = device;
      ws._remuxDeviceId = device.id;

      // Track socket for device disconnect
      if (!deviceSockets.has(device.id)) {
        deviceSockets.set(device.id, new Set());
      }
      deviceSockets.get(device.id)!.add(ws);

      // Block connections from blocked devices
      if (device.trust === "blocked") {
        sendEnvelope(ws, "auth_error", { reason: "device blocked" });
        ws.close(4003, "device blocked");
        return;
      }
    } catch {
      // Device registration failure is non-fatal
    }

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
              // If client provides a persistent device ID, re-register with it
              // (replaces the initial header-fingerprint registration)
              if (parsed.deviceId) {
                try {
                  // Clean up old fingerprint-based device socket tracking
                  if (ws._remuxDeviceId && ws._remuxDeviceId !== parsed.deviceId) {
                    const oldSockets = deviceSockets.get(ws._remuxDeviceId);
                    if (oldSockets) { oldSockets.delete(ws); if (oldSockets.size === 0) deviceSockets.delete(ws._remuxDeviceId); }
                  }
                  const { device } = registerDevice(req, parsed.deviceId);
                  // Re-check trust after re-registration: block if device was blocked
                  if (device.trust === "blocked") {
                    sendEnvelope(ws, "auth_error", { reason: "device blocked" });
                    ws.close(4003, "device blocked");
                    return;
                  }
                  deviceInfo = device;
                  ws._remuxDeviceId = device.id;
                  if (!deviceSockets.has(device.id)) deviceSockets.set(device.id, new Set());
                  deviceSockets.get(device.id)!.add(ws);
                } catch {}
              }
              sendEnvelope(ws, "auth_ok", {
                deviceId: deviceInfo?.id ?? null,
                trust: deviceInfo?.trust ?? null,
              });
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

          // ── E2EE handshake (opt-in, backward compatible) ──

          if (p.type === "e2ee_init") {
            // Client sends its X25519 public key to initiate E2EE
            if (typeof p.publicKey === "string") {
              const session = new E2EESession();
              session.completeHandshake(p.publicKey);
              e2eeSessions.set(ws, session);
              sendEnvelope(ws, "e2ee_init", {
                publicKey: session.getPublicKey(),
              });
              sendEnvelope(ws, "e2ee_ready", { established: true });
            }
            return;
          }

          if (p.type === "e2ee_msg") {
            // Decrypt incoming encrypted message and re-process as control message
            const e2ee = e2eeSessions.get(ws);
            if (!e2ee || !e2ee.isEstablished()) {
              sendEnvelope(ws, "error", { reason: "E2EE not established" });
              return;
            }
            try {
              const decrypted = e2ee.decryptMessage(p.data);
              // Re-parse the decrypted plaintext as a control message
              if (decrypted.startsWith("{")) {
                const innerParsed = JSON.parse(decrypted);
                const inner = unwrapMessage(innerParsed);

                // Terminal input wrapped in E2EE
                if (inner.type === "input") {
                  if (clientState.role === "active") {
                    clientState.lastActiveAt = Date.now();
                    const found = findTab(ws._remuxTabId);
                    if (found && !found.tab.ended) {
                      found.tab.pty.write(inner.data);
                    }
                  }
                  return;
                }

                // For other control messages, re-emit as if received normally.
                // We prepend the decrypted JSON back through the message handler.
                // To avoid infinite recursion, we mark the message as already decrypted.
                ws.emit("message", Buffer.from(decrypted, "utf8"));
              } else {
                // Raw terminal input wrapped in E2EE
                if (clientState.role === "active") {
                  clientState.lastActiveAt = Date.now();
                  const found = findTab(ws._remuxTabId);
                  if (found && !found.tab.ended) {
                    found.tab.pty.write(decrypted);
                  }
                }
              }
            } catch (err) {
              sendEnvelope(ws, "error", {
                reason: "E2EE decrypt failed",
              });
            }
            return;
          }

          // Attach to first tab of a session (or create one).
          // If no session specified, pick the first existing one or create "default".
          if (p.type === "attach_first") {
            const name = p.session || getFirstSessionName() || "default";
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
            const session = createSession(p.session || "default");
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
              removeStaleTab(p.tabId);
              // If session has no tabs left, remove it
              if (found.session.tabs.length === 0) {
                removeSessionFromDb(found.session.name);
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
              // Strip ANSI escape sequences comprehensively:
              // CSI sequences, OSC sequences (BEL or ST terminated), DCS/PM/APC,
              // simple escapes, and remaining control chars except newline/tab
              const text = rawText
                .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")       // CSI sequences
                .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC sequences
                .replace(/\x1b[PX^_][^\x1b]*\x1b\\/g, "")     // DCS/PM/APC sequences
                .replace(/\x1b[()][A-Z0-9]/g, "")              // charset selection
                .replace(/\x1b[A-Z=><78]/gi, "")               // simple escape sequences
                .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "") // remaining ctrl chars
                .replace(/\x7f/g, "");                          // DEL char
              // Include tab metadata so Inspect header shows identity and size
              const session = found2 ? found2.session : null;
              const tab = found2 ? found2.tab : null;
              sendEnvelope(ws, "inspect_result", {
                text,
                meta: {
                  session: session?.name || "",
                  tabId: tab?.id || null,
                  tabTitle: tab?.title || "",
                  cols: ws._remuxCols || 80,
                  rows: ws._remuxRows || 24,
                  timestamp: Date.now(),
                },
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
            clientState.lastActiveAt = Date.now();
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

          // ── Device management messages ──

          if (p.type === "list_devices") {
            const devices = listDevices();
            sendEnvelope(ws, "device_list", { devices });
            return;
          }

          if (p.type === "trust_device") {
            // Only trusted devices can trust others
            const sender = ws._remuxDeviceId
              ? findDeviceById(ws._remuxDeviceId)
              : null;
            if (!sender || sender.trust !== "trusted") {
              sendEnvelope(ws, "error", {
                reason: "only trusted devices can trust others",
              });
              return;
            }
            if (p.deviceId) {
              updateDeviceTrust(p.deviceId, "trusted");
              sendEnvelope(ws, "device_list", { devices: listDevices() });
              broadcastDeviceList();
            }
            return;
          }

          if (p.type === "block_device") {
            // Only trusted devices can block others
            const sender = ws._remuxDeviceId
              ? findDeviceById(ws._remuxDeviceId)
              : null;
            if (!sender || sender.trust !== "trusted") {
              sendEnvelope(ws, "error", {
                reason: "only trusted devices can block others",
              });
              return;
            }
            if (p.deviceId) {
              updateDeviceTrust(p.deviceId, "blocked");
              // Force disconnect blocked device
              forceDisconnectDevice(p.deviceId);
              sendEnvelope(ws, "device_list", { devices: listDevices() });
              broadcastDeviceList();
            }
            return;
          }

          if (p.type === "rename_device") {
            if (p.deviceId && typeof p.name === "string" && p.name.trim()) {
              renameDevice(p.deviceId, p.name.trim().slice(0, 32));
              sendEnvelope(ws, "device_list", { devices: listDevices() });
              broadcastDeviceList();
            }
            return;
          }

          if (p.type === "revoke_device") {
            // Only trusted devices can revoke others
            const sender = ws._remuxDeviceId
              ? findDeviceById(ws._remuxDeviceId)
              : null;
            if (!sender || sender.trust !== "trusted") {
              sendEnvelope(ws, "error", {
                reason: "only trusted devices can revoke others",
              });
              return;
            }
            if (p.deviceId) {
              forceDisconnectDevice(p.deviceId);
              deleteDevice(p.deviceId);
              sendEnvelope(ws, "device_list", { devices: listDevices() });
              broadcastDeviceList();
            }
            return;
          }

          if (p.type === "generate_pair_code") {
            // Only trusted devices can generate pair codes
            const sender = ws._remuxDeviceId
              ? findDeviceById(ws._remuxDeviceId)
              : null;
            if (!sender || sender.trust !== "trusted") {
              sendEnvelope(ws, "error", {
                reason: "only trusted devices can generate pair codes",
              });
              return;
            }
            const pairCode = createPairCode(sender.id);
            sendEnvelope(ws, "pair_code", {
              code: pairCode.code,
              expiresAt: pairCode.expiresAt,
            });
            return;
          }

          if (p.type === "pair") {
            if (typeof p.code === "string") {
              const createdBy = consumePairCode(p.code);
              if (createdBy && ws._remuxDeviceId) {
                updateDeviceTrust(ws._remuxDeviceId, "trusted");
                // Refresh device info
                deviceInfo = findDeviceById(ws._remuxDeviceId);
                sendEnvelope(ws, "pair_result", {
                  success: true,
                  deviceId: ws._remuxDeviceId,
                });
                broadcastDeviceList();
              } else {
                sendEnvelope(ws, "pair_result", {
                  success: false,
                  reason: "invalid or expired code",
                });
              }
            }
            return;
          }

          // ── Push notification messages ──

          if (p.type === "get_vapid_key") {
            const publicKey = getVapidPublicKey();
            sendEnvelope(ws, "vapid_key", { publicKey });
            return;
          }

          if (p.type === "subscribe_push") {
            if (
              ws._remuxDeviceId &&
              p.subscription &&
              typeof p.subscription.endpoint === "string" &&
              p.subscription.keys?.p256dh &&
              p.subscription.keys?.auth
            ) {
              savePushSubscription(
                ws._remuxDeviceId,
                p.subscription.endpoint,
                p.subscription.keys.p256dh,
                p.subscription.keys.auth,
              );
              sendEnvelope(ws, "push_subscribed", { success: true });
            } else {
              sendEnvelope(ws, "push_subscribed", {
                success: false,
                reason: "invalid subscription or no device ID",
              });
            }
            return;
          }

          if (p.type === "unsubscribe_push") {
            if (ws._remuxDeviceId) {
              removePushSubscription(ws._remuxDeviceId);
              sendEnvelope(ws, "push_unsubscribed", { success: true });
            }
            return;
          }

          if (p.type === "test_push") {
            if (ws._remuxDeviceId) {
              sendPushNotification(
                ws._remuxDeviceId,
                "Remux Test",
                "Push notifications are working!",
              ).then((sent) => {
                sendEnvelope(ws, "push_test_result", { sent });
              });
            } else {
              sendEnvelope(ws, "push_test_result", { sent: false });
            }
            return;
          }

          if (p.type === "get_push_status") {
            const hasSub = ws._remuxDeviceId
              ? !!getPushSubscription(ws._remuxDeviceId)
              : false;
            sendEnvelope(ws, "push_status", { subscribed: hasSub });
            return;
          }

          // ── Workspace: Topics ──

          if (p.type === "create_topic") {
            if (typeof p.title === "string" && p.title.trim()) {
              const topic = createTopic(
                p.sessionName || clientState.currentSession || "default",
                p.title.trim(),
              );
              sendEnvelope(ws, "topic_created", topic);
            }
            return;
          }

          if (p.type === "list_topics") {
            const topics = listTopics(p.sessionName || undefined);
            sendEnvelope(ws, "topic_list", { topics });
            return;
          }

          if (p.type === "delete_topic") {
            if (p.topicId) {
              const ok = deleteTopic(p.topicId);
              sendEnvelope(ws, "topic_deleted", {
                topicId: p.topicId,
                success: ok,
              });
            }
            return;
          }

          // ── Workspace: Runs ──

          if (p.type === "create_run") {
            const run = createRun({
              topicId: p.topicId || undefined,
              sessionName: p.sessionName || clientState.currentSession || "default",
              tabId: p.tabId,
              command: p.command,
            });
            sendEnvelope(ws, "run_created", run);
            return;
          }

          if (p.type === "update_run") {
            if (p.runId) {
              const ok = updateRun(p.runId, {
                exitCode: p.exitCode,
                status: p.status,
              });
              sendEnvelope(ws, "run_updated", {
                runId: p.runId,
                success: ok,
              });
            }
            return;
          }

          if (p.type === "list_runs") {
            const runs = listRuns(p.topicId || undefined);
            sendEnvelope(ws, "run_list", { runs });
            return;
          }

          // ── Workspace: Artifacts ──

          if (p.type === "capture_snapshot") {
            const tabId = ws._remuxTabId;
            if (tabId != null) {
              const result = captureSnapshot(
                clientState.currentSession || "default",
                tabId,
                p.topicId || undefined,
              );
              if (result) {
                const a = result.artifact;
                const contentType = a.content ? detectContentType(a.content) : "plain";
                let renderedHtml: string | undefined;
                if (a.content) {
                  if (contentType === "diff") renderedHtml = renderDiff(a.content);
                  else if (contentType === "markdown") renderedHtml = renderMarkdown(a.content);
                  else if (contentType === "ansi") renderedHtml = '<pre style="margin:0;font-size:11px;line-height:1.5">' + renderAnsi(a.content) + "</pre>";
                }
                sendEnvelope(ws, "snapshot_captured", { ...a, contentType, renderedHtml });
              } else {
                sendEnvelope(ws, "error", {
                  reason: "no tab attached for snapshot",
                });
              }
            }
            return;
          }

          if (p.type === "list_artifacts") {
            const artifacts = listArtifacts({
              topicId: p.topicId || undefined,
              runId: p.runId || undefined,
              sessionName: p.sessionName || clientState.currentSession || undefined,
            });
            // Enrich artifacts with server-side rendered HTML
            const enriched = artifacts.map((a) => {
              if (!a.content) return a;
              const contentType = detectContentType(a.content);
              let renderedHtml: string | undefined;
              if (contentType === "diff") renderedHtml = renderDiff(a.content);
              else if (contentType === "markdown") renderedHtml = renderMarkdown(a.content);
              else if (contentType === "ansi") renderedHtml = '<pre style="margin:0;font-size:11px;line-height:1.5">' + renderAnsi(a.content) + "</pre>";
              return { ...a, contentType, renderedHtml };
            });
            sendEnvelope(ws, "artifact_list", { artifacts: enriched });
            return;
          }

          // ── Workspace: Approvals ──

          if (p.type === "create_approval") {
            if (typeof p.title === "string" && p.title.trim()) {
              const approval = createApproval({
                runId: p.runId || undefined,
                topicId: p.topicId || undefined,
                title: p.title.trim(),
                description: p.description,
              });
              sendEnvelope(ws, "approval_created", approval);
              // Broadcast to all control clients so they see the new approval
              for (const client of controlClients) {
                if (client !== ws && client.readyState === client.OPEN) {
                  sendEnvelope(client, "approval_created", approval);
                }
              }
            }
            return;
          }

          if (p.type === "list_approvals") {
            const approvals = listApprovals(p.status || undefined);
            sendEnvelope(ws, "approval_list", { approvals });
            return;
          }

          if (p.type === "resolve_approval") {
            if (
              p.approvalId &&
              (p.status === "approved" || p.status === "rejected")
            ) {
              const ok = resolveApproval(p.approvalId, p.status);
              sendEnvelope(ws, "approval_resolved", {
                approvalId: p.approvalId,
                status: p.status,
                success: ok,
              });
              // Broadcast resolution to all control clients
              for (const client of controlClients) {
                if (client !== ws && client.readyState === client.OPEN) {
                  sendEnvelope(client, "approval_resolved", {
                    approvalId: p.approvalId,
                    status: p.status,
                    success: ok,
                  });
                }
              }
            }
            return;
          }

          // ── Search ──

          if (p.type === "search") {
            if (typeof p.query === "string") {
              const results = searchEntities(p.query, p.limit || 20);
              sendEnvelope(ws, "search_results", { query: p.query, results });
            }
            return;
          }

          // ── Handoff Bundle ──

          if (p.type === "get_handoff") {
            const bundle = generateHandoffBundle();
            sendEnvelope(ws, "handoff_bundle", bundle);
            return;
          }

          // ── Memory Notes ──

          if (p.type === "create_note") {
            if (typeof p.content === "string" && p.content.trim()) {
              const note = createNote(p.content.trim());
              sendEnvelope(ws, "note_created", note);
            }
            return;
          }

          if (p.type === "list_notes") {
            const notes = listNotes();
            sendEnvelope(ws, "note_list", { notes });
            return;
          }

          if (p.type === "update_note") {
            if (p.noteId && typeof p.content === "string" && p.content.trim()) {
              const ok = updateNote(p.noteId, p.content.trim());
              sendEnvelope(ws, "note_updated", { noteId: p.noteId, success: ok });
            }
            return;
          }

          if (p.type === "delete_note") {
            if (p.noteId) {
              const ok = deleteNote(p.noteId);
              sendEnvelope(ws, "note_deleted", { noteId: p.noteId, success: ok });
            }
            return;
          }

          if (p.type === "pin_note") {
            if (p.noteId) {
              const ok = togglePinNote(p.noteId);
              sendEnvelope(ws, "note_pinned", { noteId: p.noteId, success: ok });
            }
            return;
          }

          // ── Shell Integration: Commands ──

          if (p.type === "list_commands") {
            const tabId = p.tabId ?? ws._remuxTabId;
            if (tabId != null) {
              const commands = listCommands(tabId, p.limit || 50);
              sendEnvelope(ws, "command_list", { tabId, commands });
            }
            return;
          }

          // ── E11: Git / Review ──

          if (p.type === "git_status") {
            const { getGitStatus } = require("./git-service.js");
            getGitStatus().then((status: any) => sendEnvelope(ws, "git_status_result", status)).catch(() => {});
            return;
          }

          if (p.type === "git_diff") {
            const { getGitDiff } = require("./git-service.js");
            getGitDiff(p.base).then((diff: any) => sendEnvelope(ws, "git_diff_result", diff)).catch(() => {});
            return;
          }

          if (p.type === "git_worktrees") {
            const { getWorktrees } = require("./git-service.js");
            getWorktrees().then((worktrees: any) => sendEnvelope(ws, "git_worktrees_result", { worktrees })).catch(() => {});
            return;
          }

          if (p.type === "git_compare") {
            const { compareBranches } = require("./git-service.js");
            compareBranches(p.base || "main", p.head || "HEAD").then((result: any) => sendEnvelope(ws, "git_compare_result", result)).catch(() => {});
            return;
          }

          // ── E10: Adapter Platform ──

          if (p.type === "request_adapter_state") {
            // E10-007: return all adapter states
            // Lazy import to avoid circular dependency with server.ts
            const { adapterRegistry } = require("./server.js");
            const states = adapterRegistry?.getAllStates() ?? [];
            sendEnvelope(ws, "adapter_state", { adapters: states });
            return;
          }

          return;
        } catch (err) {
          // Log JSON parse errors for debugging (e.g. createNote DB failures)
          if (msg.startsWith("{")) {
            console.error("[remux] JSON handler error:", err);
            return; // Don't fall through to PTY for malformed JSON
          }
        }
      }

      // ── Raw terminal input -> current tab's PTY ──
      // Only active clients can write to PTY; observer input is silently dropped
      if (clientState.role !== "active") return;

      // Track activity for idle timeout
      clientState.lastActiveAt = Date.now();

      // Defense-in-depth: never write JSON control messages to PTY
      if (msg.startsWith("{") && msg.includes('"type"')) return;

      const found = findTab(ws._remuxTabId);
      if (found && !found.tab.ended) {
        found.tab.pty.write(msg);
      }
    });

    ws.on("close", () => {
      const tabId = ws._remuxTabId;
      const wasActive = clientState.role === "active";

      // Clean up device socket tracking
      if (ws._remuxDeviceId) {
        const sockets = deviceSockets.get(ws._remuxDeviceId);
        if (sockets) {
          sockets.delete(ws);
          if (sockets.size === 0) deviceSockets.delete(ws._remuxDeviceId);
        }
      }

      detachFromTab(ws);
      controlClients.delete(ws);
      clientStates.delete(ws);
      e2eeSessions.delete(ws);

      // Reassign roles if the disconnecting client was active
      if (tabId != null) {
        reassignRolesAfterDetach(tabId, wasActive);
        broadcastState();
      }
    });

    ws.on("error", (err) => {
      console.error("[ws] error:", err.message);
    });
  });

  /**
   * Force disconnect all sockets belonging to a device.
   */
  function forceDisconnectDevice(deviceId: string): void {
    const sockets = deviceSockets.get(deviceId);
    if (!sockets) return;
    for (const sock of sockets) {
      sendEnvelope(sock, "auth_error", { reason: "device revoked" });
      sock.close(4003, "device revoked");
    }
    deviceSockets.delete(deviceId);
  }

  /**
   * Broadcast device list to all authenticated control clients.
   */
  function broadcastDeviceList(): void {
    const devices = listDevices();
    for (const client of controlClients) {
      if (client.readyState === client.OPEN) {
        sendEnvelope(client, "device_list", { devices });
      }
    }
  }

  return wss;
}

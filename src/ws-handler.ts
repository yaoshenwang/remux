/**
 * WebSocket handler for Remux.
 * All WebSocket message routing: auth gate, control messages, terminal I/O.
 */

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
} from "./session.js";
import { validateToken } from "./auth.js";

// ── Setup ────────────────────────────────────────────────────────

/**
 * Create a WebSocketServer, wire up upgrade handling and message routing.
 */
export function setupWebSocket(
  httpServer: http.Server,
  TOKEN: string | null,
  PASSWORD: string | null,
): WebSocketServer {
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
    if (!requiresAuth) controlClients.add(ws);

    ws.on("message", (raw) => {
      const msg = raw.toString("utf8");

      // ── Auth gate ──
      if (!ws._remuxAuthed) {
        try {
          const parsed = JSON.parse(msg);
          if (parsed.type === "auth") {
            if (validateToken(parsed.token, TOKEN)) {
              ws._remuxAuthed = true;
              controlClients.add(ws);
              ws.send(JSON.stringify({ type: "auth_ok" }));
              ws.send(JSON.stringify({ type: "state", sessions: getState() }));
              return;
            }
          }
        } catch {}
        ws.send(
          JSON.stringify({ type: "auth_error", reason: "invalid token" }),
        );
        ws.close(4001, "unauthorized");
        return;
      }

      // ── JSON control messages ──
      if (msg.startsWith("{")) {
        try {
          const p = JSON.parse(msg);

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
            // Send state BEFORE attached so client has session/tab data when processing attached
            broadcastState();
            ws.send(
              JSON.stringify({ type: "attached", tabId: tab.id, session: name }),
            );
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
              broadcastState();
              ws.send(
                JSON.stringify({
                  type: "attached",
                  tabId: found.tab.id,
                  session: found.session.name,
                }),
              );
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
            broadcastState();
            ws.send(
              JSON.stringify({
                type: "attached",
                tabId: tab.id,
                session: session.name,
              }),
            );
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
            broadcastState();
            ws.send(
              JSON.stringify({ type: "attached", tabId: tab.id, session: name }),
            );
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
              ws.send(
                JSON.stringify({
                  type: "inspect_result",
                  text,
                  meta: {
                    session: found.session.name,
                    tabId: found.tab.id,
                    tabTitle: found.tab.title,
                    cols,
                    rows,
                    timestamp: Date.now(),
                  },
                }),
              );
            } else {
              // Fallback: raw scrollback as text
              const found2 = findTab(ws._remuxTabId);
              const raw = found2
                ? found2.tab.scrollback.read().toString("utf8")
                : "";
              // Strip ANSI escape sequences
              const text = raw
                .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
                .replace(/\x1b\][^\x07]*\x07/g, "");
              ws.send(
                JSON.stringify({
                  type: "inspect_result",
                  text,
                  meta: { timestamp: Date.now() },
                }),
              );
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

          return;
        } catch {
          /* not JSON */
        }
      }

      // ── Raw terminal input -> current tab's PTY ──
      const found = findTab(ws._remuxTabId);
      if (found && !found.tab.ended) {
        found.tab.pty.write(msg);
      }
    });

    ws.on("close", () => {
      detachFromTab(ws);
      controlClients.delete(ws);
    });

    ws.on("error", () => {});
  });

  return wss;
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import type { AuthService } from "./auth/auth-service.js";
import { createZellijPty, type ZellijPty } from "./pty/zellij-pty.js";
import { ZellijController } from "./zellij-controller.js";
import type { Extensions } from "./extensions.js";

export interface ZellijServerConfig {
  port: number;
  host: string;
  frontendDir: string;
  zellijSession: string;
  zellijBin?: string;
}

export interface ZellijServerDeps {
  authService: AuthService;
  logger: Pick<Console, "log" | "error">;
  extensions?: Extensions;
}

export interface RunningServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  server: http.Server;
}

interface TerminalClient {
  ws: WebSocket;
  authenticated: boolean;
  /** Per-client PTY — each browser gets its own zellij attach process. */
  pty: ZellijPty | null;
}

interface ControlClient {
  ws: WebSocket;
  authenticated: boolean;
}

export const createZellijServer = (
  config: ZellijServerConfig,
  deps: ZellijServerDeps,
): RunningServer => {
  const { authService, logger, extensions } = deps;

  const app = express();
  app.use(express.json());

  // --- HTTP routes ---

  // --- File upload (clipboard image paste / toolbar upload) ---
  const UPLOAD_DIR = path.join(os.tmpdir(), "remux-uploads");
  const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB
  const MIME_TO_EXT: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/bmp": "bmp",
    "image/svg+xml": "svg",
  };

  app.post(
    "/api/upload",
    express.raw({ limit: "50mb", type: "image/*" }),
    (req, res) => {
      const authHeader = req.headers.authorization ?? "";
      const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
      const authResult = authService.verify({ token: bearerToken });
      if (!authResult.ok) {
        res.status(401).json({ error: authResult.reason ?? "unauthorized" });
        return;
      }

      const contentType = req.headers["content-type"] ?? "";
      if (!MIME_TO_EXT[contentType]) {
        res.status(400).json({ error: `unsupported content type: ${contentType}` });
        return;
      }

      const body = req.body as Buffer;
      if (!body || body.length === 0) {
        res.status(400).json({ error: "empty body" });
        return;
      }
      if (body.length > MAX_UPLOAD_BYTES) {
        res.status(413).json({ error: "file too large (>50MB)" });
        return;
      }

      const ext = MIME_TO_EXT[contentType];
      const timestamp = Date.now();
      const rand = crypto.randomBytes(4).toString("hex");
      const filename = `paste-${timestamp}-${rand}.${ext}`;

      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
      const filePath = path.join(UPLOAD_DIR, filename);
      fs.writeFileSync(filePath, body);

      logger.log(`Upload saved: ${filePath} (${body.length} bytes)`);
      res.json({ path: filePath, size: body.length });
    },
  );

  app.get("/api/config", (_req, res) => {
    res.json({
      passwordRequired: authService.requiresPassword(),
      version: process.env.npm_package_version ?? "0.0.0",
    });
  });

  // Extension routes: push notifications + state API.
  if (extensions) {
    app.use(extensions.notificationRoutes);

    app.get("/api/state/:session", (req, res) => {
      const snapshot = extensions.getSnapshot(req.params.session);
      if (snapshot) {
        res.json(snapshot);
      } else {
        res.status(404).json({ error: "session not found or no state tracked" });
      }
    });

    app.get("/api/scrollback/:session", (req, res) => {
      const from = parseInt(req.query.from as string) || 0;
      const count = parseInt(req.query.count as string) || 100;
      const lines = extensions.getScrollback(req.params.session, from, count);
      res.json({ from, count: lines.length, lines });
    });

    app.get("/api/gastown/:session", (req, res) => {
      const info = extensions.getGastownInfo(req.params.session);
      res.json(info);
    });

    app.get("/api/stats/bandwidth", (_req, res) => {
      res.json(extensions.getBandwidthStats());
    });

    // File browser API: list and read files in the working directory.
    app.get("/api/files", (_req, res) => {
      try {
        const cwd = process.cwd();
        const entries = fs.readdirSync(cwd, { withFileTypes: true })
          .filter((e) => !e.name.startsWith("."))
          .map((e) => ({
            name: e.name,
            type: e.isDirectory() ? "directory" : "file",
          }));
        res.json({ path: cwd, entries });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.get("/api/files/*filePath", (req, res) => {
      const rawPath = Array.isArray(req.params.filePath)
        ? req.params.filePath.join("/")
        : String(req.params.filePath ?? "");
      const filePath = path.resolve(process.cwd(), rawPath);
      // Security: ensure the resolved path is within cwd.
      if (!filePath.startsWith(process.cwd())) {
        res.status(403).json({ error: "path traversal not allowed" });
        return;
      }
      try {
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
          const entries = fs.readdirSync(filePath, { withFileTypes: true })
            .filter((e) => !e.name.startsWith("."))
            .map((e) => ({
              name: e.name,
              type: e.isDirectory() ? "directory" : "file",
            }));
          res.json({ path: filePath, entries });
        } else {
          // Limit file reads to 1MB.
          if (stat.size > 1_048_576) {
            res.status(413).json({ error: "file too large (>1MB)" });
            return;
          }
          const content = fs.readFileSync(filePath, "utf8");
          res.json({ path: filePath, content, size: stat.size });
        }
      } catch {
        res.status(404).json({ error: `not found: ${rawPath}` });
      }
    });
  }

  app.use(express.static(config.frontendDir));
  app.get("/{*path}", (_req, res) => {
    res.sendFile("index.html", { root: config.frontendDir });
  });

  // --- Server & WebSocket ---

  const server = http.createServer(app);
  const terminalWss = new WebSocketServer({ noServer: true, perMessageDeflate: true });
  const controlWss = new WebSocketServer({ noServer: true, perMessageDeflate: true });
  const terminalClients = new Set<TerminalClient>();
  const controlClients = new Set<ControlClient>();
  let controller: ZellijController | null = null;
  /** Whether the Zellij session has been bootstrapped (first client created it). */
  let sessionBootstrapped = false;

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/ws/terminal") {
      terminalWss.handleUpgrade(request, socket, head, (ws) => {
        terminalWss.emit("connection", ws);
      });
    } else if (url.pathname === "/ws/control") {
      controlWss.handleUpgrade(request, socket, head, (ws) => {
        controlWss.emit("connection", ws);
      });
    } else {
      socket.destroy();
    }
  });

  // Enable TCP_NODELAY for low-latency terminal I/O.
  server.on("connection", (socket) => {
    socket.setNoDelay(true);
  });

  /** Ensure the ZellijController is initialized. */
  const ensureController = (): void => {
    if (controller) return;
    controller = new ZellijController({
      session: config.zellijSession,
      zellijBin: config.zellijBin,
      logger,
    });
  };

  /**
   * Create a per-client PTY that attaches to the shared Zellij session.
   * The first client creates the session (--create); subsequent clients
   * attach to the existing session.  Each PTY is sized to that client's
   * terminal dimensions, and Zellij handles multi-client size negotiation.
   */
  const createClientPty = (client: TerminalClient, cols: number, rows: number): ZellijPty => {
    const pty = createZellijPty({
      session: config.zellijSession,
      zellijBin: config.zellijBin,
      cols,
      rows,
    });

    pty.onData((data: string) => {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(data);
      }
      // Feed into extensions (state tracker + notifications).
      extensions?.onTerminalData(config.zellijSession, data);
    });

    pty.onExit(({ exitCode }) => {
      logger.log(`Client PTY exited (pid=${pty.pid}, code=${exitCode})`);
      extensions?.onSessionExit(config.zellijSession, exitCode);
      client.pty = null;
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.close(1001, "zellij exited");
      }
    });

    sessionBootstrapped = true;
    ensureController();
    extensions?.onSessionCreated(config.zellijSession, cols, rows);
    logger.log(`Client PTY started (pid=${pty.pid}, session=${config.zellijSession}, ${cols}x${rows})`);
    return pty;
  };

  /** Broadcast workspace state to all authenticated control clients. */
  const broadcastWorkspaceState = async (): Promise<void> => {
    if (!controller) return;
    try {
      const state = await controller.queryWorkspaceState();
      const msg = JSON.stringify({ type: "workspace_state", ...state });
      for (const client of controlClients) {
        if (client.authenticated && client.ws.readyState === WebSocket.OPEN) {
          client.ws.send(msg);
        }
      }
    } catch (err) {
      logger.error("Failed to query workspace state:", err);
    }
  };

  terminalWss.on("connection", (ws: WebSocket) => {
    const client: TerminalClient = { ws, authenticated: false, pty: null };
    terminalClients.add(client);

    ws.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
      // After auth, treat all messages as either JSON control or raw terminal input.
      if (client.authenticated && client.pty) {
        const data = toNodeBuffer(raw);

        // Try to parse as JSON control message (resize, ping).
        if (data[0] === 0x7b) {
          try {
            const msg = JSON.parse(data.toString("utf8"));
            if (msg.type === "resize" && typeof msg.cols === "number" && typeof msg.rows === "number") {
              // Resize THIS client's PTY only — Zellij handles multi-client negotiation.
              client.pty.resize(msg.cols, msg.rows);
              extensions?.onSessionResize(config.zellijSession, msg.cols, msg.rows);
              return;
            }
            if (msg.type === "ping") {
              ws.send(JSON.stringify({ type: "pong", timestamp: msg.timestamp }));
              return;
            }
          } catch {
            // Not JSON, fall through to write as terminal input.
          }
        }

        client.pty.write(data.toString("utf8"));
        return;
      }

      // --- Auth handshake (first message must be JSON auth) ---
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(toNodeBuffer(raw).toString("utf8"));
      } catch {
        ws.send(JSON.stringify({ type: "auth_error", reason: "invalid message" }));
        ws.close(4001, "invalid");
        return;
      }

      if (msg.type !== "auth") {
        ws.send(JSON.stringify({ type: "auth_error", reason: "expected auth message" }));
        ws.close(4001, "expected auth");
        return;
      }

      const result = authService.verify({
        token: msg.token as string | undefined,
        password: msg.password as string | undefined,
      });
      if (!result.ok) {
        ws.send(JSON.stringify({ type: "auth_error", reason: result.reason }));
        ws.close(4001, "unauthorized");
        return;
      }

      client.authenticated = true;

      const cols = typeof msg.cols === "number" ? msg.cols : 120;
      const rows = typeof msg.rows === "number" ? msg.rows : 30;

      try {
        client.pty = createClientPty(client, cols, rows);
      } catch (err) {
        logger.error("Failed to start client PTY:", err);
        ws.send(JSON.stringify({ type: "auth_error", reason: "failed to start terminal" }));
        ws.close(1011, "pty error");
        return;
      }

      ws.send(JSON.stringify({ type: "auth_ok" }));
    });

    ws.on("close", () => {
      // Kill this client's PTY — Zellij auto-adjusts to remaining clients.
      if (client.pty) {
        logger.log(`Client disconnected, killing PTY (pid=${client.pty.pid})`);
        client.pty.kill();
        client.pty = null;
      }
      terminalClients.delete(client);
    });

    ws.on("error", (err: Error) => {
      logger.error("WebSocket error:", err.message);
      if (client.pty) {
        client.pty.kill();
        client.pty = null;
      }
      terminalClients.delete(client);
    });
  });

  // --- Control WebSocket (/ws/control) ---

  controlWss.on("connection", (ws: WebSocket) => {
    const client: ControlClient = { ws, authenticated: false };
    controlClients.add(client);

    ws.on("message", async (raw: Buffer | ArrayBuffer | Buffer[]) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(toNodeBuffer(raw).toString("utf8"));
      } catch {
        return;
      }

      // Handle ping/pong for RTT measurement (bypass auth check).
      if (msg.type === "ping" && typeof msg.timestamp === "number") {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "pong", timestamp: msg.timestamp }));
        }
        return;
      }

      // Auth handshake.
      if (!client.authenticated) {
        if (msg.type !== "auth") {
          ws.send(JSON.stringify({ type: "auth_error", reason: "expected auth" }));
          ws.close(4001, "expected auth");
          return;
        }
        const result = authService.verify({
          token: msg.token as string | undefined,
          password: msg.password as string | undefined,
        });
        if (!result.ok) {
          ws.send(JSON.stringify({ type: "auth_error", reason: result.reason }));
          ws.close(4001, "unauthorized");
          return;
        }
        client.authenticated = true;
        ws.send(JSON.stringify({ type: "auth_ok" }));
        return;
      }

      // Authenticated commands.
      if (!controller) {
        ws.send(JSON.stringify({ type: "error", message: "zellij not started" }));
        return;
      }

      try {
        switch (msg.type) {
          case "subscribe_workspace":
            await broadcastWorkspaceState();
            break;
          case "new_tab":
            await controller.newTab(msg.name as string | undefined);
            await broadcastWorkspaceState();
            break;
          case "close_tab":
            await controller.closeTab(msg.tabIndex as number);
            await broadcastWorkspaceState();
            break;
          case "select_tab":
            await controller.goToTab(msg.tabIndex as number);
            await broadcastWorkspaceState();
            break;
          case "rename_tab":
            await controller.renameTab(msg.tabIndex as number, msg.name as string);
            await broadcastWorkspaceState();
            break;
          case "new_pane":
            await controller.newPane(msg.direction as "right" | "down");
            await broadcastWorkspaceState();
            break;
          case "close_pane":
            await controller.closePane();
            await broadcastWorkspaceState();
            break;
          case "toggle_fullscreen":
            await controller.toggleFullscreen();
            await broadcastWorkspaceState();
            break;
          case "capture_inspect": {
            const content = await controller.dumpScreen(msg.full as boolean ?? true);
            ws.send(JSON.stringify({ type: "inspect_content", content }));
            break;
          }
          case "rename_session":
            await controller.renameSession(msg.name as string);
            await broadcastWorkspaceState();
            break;
          default:
            ws.send(JSON.stringify({ type: "error", message: `unknown command: ${msg.type}` }));
        }
      } catch (err) {
        ws.send(JSON.stringify({ type: "error", message: String(err) }));
      }
    });

    ws.on("close", () => {
      controlClients.delete(client);
    });

    ws.on("error", (err: Error) => {
      logger.error("Control WebSocket error:", err.message);
      controlClients.delete(client);
    });
  });

  return {
    server,
    async start() {
      return new Promise<void>((resolve, reject) => {
        server.listen(config.port, config.host, () => {
          logger.log(`Zellij server listening on ${config.host}:${config.port}`);
          resolve();
        });
        server.once("error", reject);
      }).then(() => {
        // Broadcast bandwidth stats every 5 seconds to all authed control clients.
        if (extensions) {
          setInterval(() => {
            const stats = extensions.getBandwidthStats();
            const msg = JSON.stringify({ type: "bandwidth_stats", stats });
            for (const client of controlClients) {
              if (client.authenticated && client.ws.readyState === WebSocket.OPEN) {
                client.ws.send(msg);
              }
            }
          }, 5000);
        }
      });
    },
    async stop() {
      // Kill all per-client PTYs.
      for (const client of terminalClients) {
        if (client.pty) {
          client.pty.kill();
          client.pty = null;
        }
        client.ws.close(1001, "server shutting down");
      }
      for (const client of controlClients) {
        client.ws.close(1001, "server shutting down");
      }
      terminalClients.clear();
      controlClients.clear();
      terminalWss.close();
      controlWss.close();
      extensions?.dispose();
      return new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
};

/** Normalize ws message payloads to a single Node Buffer. */
const toNodeBuffer = (data: Buffer | ArrayBuffer | Buffer[]): Buffer => {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.concat(data);
};

import http from "node:http";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import type { AuthService } from "./auth/auth-service.js";
import { createZellijPty, type ZellijPty } from "./pty/zellij-pty.js";

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
}

export interface RunningServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  server: http.Server;
}

interface AuthenticatedClient {
  ws: WebSocket;
  authenticated: boolean;
}

export const createZellijServer = (
  config: ZellijServerConfig,
  deps: ZellijServerDeps,
): RunningServer => {
  const { authService, logger } = deps;

  const app = express();

  // --- HTTP routes ---

  app.get("/api/config", (_req, res) => {
    res.json({
      passwordRequired: authService.requiresPassword(),
      version: process.env.npm_package_version ?? "0.0.0",
    });
  });

  app.use(express.static(config.frontendDir));
  app.get("/{*path}", (_req, res) => {
    res.sendFile("index.html", { root: config.frontendDir });
  });

  // --- Server & WebSocket ---

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<AuthenticatedClient>();
  let pty: ZellijPty | null = null;

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws/terminal") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws);
    });
  });

  // Enable TCP_NODELAY for low-latency terminal I/O.
  server.on("connection", (socket) => {
    socket.setNoDelay(true);
  });

  const ensurePty = (cols: number, rows: number): ZellijPty => {
    if (pty) return pty;

    pty = createZellijPty({
      session: config.zellijSession,
      zellijBin: config.zellijBin,
      cols,
      rows,
    });

    pty.onData((data: string) => {
      for (const client of clients) {
        if (client.authenticated && client.ws.readyState === WebSocket.OPEN) {
          client.ws.send(data);
        }
      }
    });

    pty.onExit(({ exitCode }) => {
      logger.log(`Zellij exited with code ${exitCode}`);
      pty = null;
      // Close all clients when Zellij exits.
      for (const client of clients) {
        client.ws.close(1001, "zellij exited");
      }
    });

    logger.log(`Zellij PTY started (pid=${pty.pid}, session=${config.zellijSession})`);
    return pty;
  };

  wss.on("connection", (ws: WebSocket) => {
    const client: AuthenticatedClient = { ws, authenticated: false };
    clients.add(client);

    ws.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
      // After auth, treat all messages as either JSON control or raw terminal input.
      if (client.authenticated) {
        const data = toNodeBuffer(raw);

        // Try to parse as JSON control message (resize, ping).
        if (data[0] === 0x7b) {
          // '{' — likely JSON
          try {
            const msg = JSON.parse(data.toString("utf8"));
            if (msg.type === "resize" && typeof msg.cols === "number" && typeof msg.rows === "number") {
              pty?.resize(msg.cols, msg.rows);
              return;
            }
            if (msg.type === "ping") {
              // Respond with pong and drop — don't write to PTY.
              ws.send(JSON.stringify({ type: "pong", timestamp: msg.timestamp }));
              return;
            }
          } catch {
            // Not JSON, fall through to write as terminal input.
          }
        }

        pty?.write(data.toString("utf8"));
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
        ensurePty(cols, rows);
      } catch (err) {
        logger.error("Failed to start Zellij PTY:", err);
        ws.send(JSON.stringify({ type: "auth_error", reason: "failed to start terminal" }));
        ws.close(1011, "pty error");
        return;
      }

      ws.send(JSON.stringify({ type: "auth_ok" }));
    });

    ws.on("close", () => {
      clients.delete(client);
    });

    ws.on("error", (err: Error) => {
      logger.error("WebSocket error:", err.message);
      clients.delete(client);
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
      });
    },
    async stop() {
      // Kill PTY first.
      if (pty) {
        pty.kill();
        pty = null;
      }
      // Close all WebSocket connections.
      for (const client of clients) {
        client.ws.close(1001, "server shutting down");
      }
      clients.clear();
      wss.close();
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

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { AuthService, DeviceTrustError } from "./auth/auth-service.js";
import { createZellijPty, type ZellijPty } from "./pty/zellij-pty.js";
import { InspectBadRequestError, InspectService } from "./inspect/index.js";
import { ZellijController, type ZellijControllerApi } from "./zellij-controller.js";
import type { Extensions } from "./extensions.js";
import {
  createEnvelope,
  EMPTY_PROTOCOL_CAPABILITIES,
  normalizeProtocolCapabilities,
  parseEnvelope,
  SERVER_PROTOCOL_CAPABILITIES,
  type ProtocolCapabilities,
  type RemuxDomain,
} from "./protocol/envelope.js";
import {
  normalizeClientMode,
  normalizeClientPlatform,
  normalizeDeviceName,
  type ConnectedClientInfo,
} from "./protocol/client-state.js";

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
  createController?: () => ZellijControllerApi;
}

export interface RunningServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  server: http.Server;
  getConnectedClients?(): ConnectedClientInfo[];
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
  capabilities: ProtocolCapabilities;
  clientId: string;
  connectTime: string;
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
  let cachedServerVersion: string | null = null;

  const resolveBearerToken = (req: express.Request): string => {
    const authHeader = req.headers.authorization ?? "";
    return authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  };

  const verifyApiRequest = (req: express.Request): { ok: boolean; reason?: string } => {
    return authService.verifyTokenOnly(resolveBearerToken(req));
  };

  const resolveServerVersion = (): string => {
    if (cachedServerVersion) {
      return cachedServerVersion;
    }

    if (process.env.npm_package_version) {
      cachedServerVersion = process.env.npm_package_version;
      return cachedServerVersion;
    }

    try {
      const packageJsonPath = path.resolve(process.cwd(), "package.json");
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { version?: string };
      cachedServerVersion = packageJson.version ?? "0.0.0";
    } catch {
      cachedServerVersion = "0.0.0";
    }

    return cachedServerVersion;
  };

  app.post(
    "/api/upload",
    express.raw({ limit: "50mb", type: "image/*" }),
    (req, res) => {
      const authResult = verifyApiRequest(req);
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
      version: resolveServerVersion(),
    });
  });

  app.post("/api/pairing/create", (req, res) => {
    const authResult = verifyApiRequest(req);
    if (!authResult.ok) {
      res.status(401).json({ error: authResult.reason ?? "unauthorized" });
      return;
    }

    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const pairing = authService.createPairingSession({
      baseUrl,
      serverVersion: resolveServerVersion(),
    });
    res.json({
      payload: pairing.payload,
    });
  });

  app.post("/api/pairing/redeem", (req, res) => {
    try {
      const redeemed = authService.redeemPairingSession({
        pairingSessionId: req.body?.pairingSessionId as string,
        token: req.body?.token as string,
        publicKey: req.body?.publicKey as string,
        displayName: req.body?.displayName as string | undefined,
        platform: req.body?.platform as string | undefined,
      });
      res.json(redeemed);
    } catch (error) {
      if (error instanceof DeviceTrustError) {
        res.status(error.statusCode).json({
          error: error.message,
          code: error.code,
        });
        return;
      }
      res.status(500).json({ error: String(error) });
    }
  });

  app.get("/api/devices", (req, res) => {
    const authResult = verifyApiRequest(req);
    if (!authResult.ok) {
      res.status(401).json({ error: authResult.reason ?? "unauthorized" });
      return;
    }

    res.json({
      devices: authService.listDevices(),
    });
  });

  app.post("/api/devices/:deviceId/revoke", (req, res) => {
    const authResult = verifyApiRequest(req);
    if (!authResult.ok) {
      res.status(401).json({ error: authResult.reason ?? "unauthorized" });
      return;
    }

    try {
      const device = authService.revokeDevice(
        req.params.deviceId,
        typeof req.body?.reason === "string" && req.body.reason.trim()
          ? req.body.reason.trim()
          : "revoked by user",
      );
      res.json({ device });
    } catch (error) {
      if (error instanceof DeviceTrustError) {
        res.status(error.statusCode).json({
          error: error.message,
          code: error.code,
        });
        return;
      }
      res.status(500).json({ error: String(error) });
    }
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

    app.get("/api/inspect/:session", (req, res) => {
      const from = parseInt(req.query.from as string) || 0;
      const count = parseInt(req.query.count as string) || 100;
      const lines = extensions.getInspectLines(req.params.session, from, count);
      res.json({ from, count: lines.length, lines });
    });

    app.get("/api/scrollback/:session", (req, res) => {
      const redirectTarget = `/api/inspect/${encodeURIComponent(req.params.session)}${req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : ""}`;
      res.redirect(301, redirectTarget);
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
  const connectedClients = new Map<string, ConnectedClientInfo>();
  let clientsChangedTimer: ReturnType<typeof setTimeout> | null = null;
  let pairingCleanupTimer: ReturnType<typeof setInterval> | null = null;
  let controller: ZellijControllerApi | null = null;
  let inspectService: InspectService | null = null;
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
    controller = deps.createController?.() ?? new ZellijController({
      session: config.zellijSession,
      zellijBin: config.zellijBin,
      logger,
    });
  };

  const ensureInspectService = (): InspectService => {
    if (inspectService) {
      return inspectService;
    }
    ensureController();
    inspectService = new InspectService({
      controller: controller ?? undefined,
      tracker: null,
    });
    return inspectService;
  };

  const resolveFocusedPaneId = async (): Promise<string | null> => {
    ensureController();
    if (!controller) {
      return null;
    }
    const workspace = await controller.queryWorkspaceState();
    const activeTab = workspace.tabs.find((tab) => tab.index === workspace.activeTabIndex);
    return activeTab?.panes.find((pane) => pane.focused)?.id ?? activeTab?.panes[0]?.id ?? null;
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
      const legacyMessage = JSON.stringify({ type: "workspace_state", ...state });
      const envelopeMessage = JSON.stringify(createEnvelope("runtime", "workspace_state", state));
      for (const client of controlClients) {
        if (client.authenticated && client.ws.readyState === WebSocket.OPEN) {
          client.ws.send(client.capabilities.envelope ? envelopeMessage : legacyMessage);
        }
      }
    } catch (err) {
      logger.error("Failed to query workspace state:", err);
    }
  };

  const sendLegacyControlMessage = (
    ws: WebSocket,
    type: string,
    payload: Record<string, unknown> = {},
  ): void => {
    ws.send(JSON.stringify({ type, ...payload }));
  };

  const sendWireProtocolMessage = <TPayload extends object>(
    ws: WebSocket,
    useEnvelope: boolean,
    domain: RemuxDomain,
    type: string,
    payload: TPayload,
    options: { requestId?: string } = {},
  ): void => {
    if (useEnvelope) {
      ws.send(JSON.stringify(createEnvelope(domain, type, payload, {
        requestId: options.requestId,
      })));
      return;
    }

    sendLegacyControlMessage(ws, type, payload as Record<string, unknown>);
  };

  const sendProtocolMessage = <TPayload extends object>(
    client: ControlClient,
    domain: RemuxDomain,
    type: string,
    payload: TPayload,
    options: { requestId?: string } = {},
  ): void => {
    sendWireProtocolMessage(client.ws, client.capabilities.envelope, domain, type, payload, options);
  };

  const getConnectedClientsSnapshot = (): ConnectedClientInfo[] => {
    return [...connectedClients.values()].sort((left, right) => {
      return left.connectTime.localeCompare(right.connectTime);
    });
  };

  const markControlClientActive = (
    client: ControlClient,
    overrides: Partial<Pick<ConnectedClientInfo, "deviceName" | "platform" | "mode">> = {},
  ): ConnectedClientInfo | null => {
    if (!client.authenticated) {
      return null;
    }

    const current = connectedClients.get(client.clientId);
    if (!current) {
      return null;
    }

    const nextInfo: ConnectedClientInfo = {
      ...current,
      ...overrides,
      lastActivityAt: new Date().toISOString(),
    };
    connectedClients.set(client.clientId, nextInfo);
    return nextInfo;
  };

  const broadcastClientsChanged = (): void => {
    const clients = getConnectedClientsSnapshot();
    for (const client of controlClients) {
      if (!client.authenticated || client.ws.readyState !== WebSocket.OPEN) {
        continue;
      }

      sendProtocolMessage(client, "runtime", "clients_changed", {
        selfClientId: client.clientId,
        clients,
      });
    }
  };

  const scheduleClientsChangedBroadcast = (): void => {
    if (clientsChangedTimer) {
      clearTimeout(clientsChangedTimer);
    }

    clientsChangedTimer = setTimeout(() => {
      clientsChangedTimer = null;
      broadcastClientsChanged();
    }, 0);
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
        resumeToken: msg.resumeToken as string | undefined,
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
    const client: ControlClient = {
      ws,
      authenticated: false,
      capabilities: { ...EMPTY_PROTOCOL_CAPABILITIES },
      clientId: crypto.randomUUID(),
      connectTime: new Date().toISOString(),
    };
    controlClients.add(client);

    ws.on("message", async (raw: Buffer | ArrayBuffer | Buffer[]) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(toNodeBuffer(raw).toString("utf8"));
      } catch {
        return;
      }

      const preAuthEnvelope = parseEnvelope<Record<string, unknown>>(msg, { source: "client" });
      const preAuthPayload = preAuthEnvelope?.payload && typeof preAuthEnvelope.payload === "object"
        ? preAuthEnvelope.payload
        : msg;
      const preAuthType = preAuthEnvelope?.type ?? msg.type;

      // Handle ping/pong for RTT measurement (bypass auth check).
      if (msg.type === "ping" && typeof msg.timestamp === "number") {
        markControlClientActive(client);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "pong", timestamp: msg.timestamp }));
        }
        return;
      }

      // Auth handshake.
      if (!client.authenticated) {
        if (preAuthType !== "auth") {
          ws.send(JSON.stringify({ type: "auth_error", reason: "expected auth" }));
          ws.close(4001, "expected auth");
          return;
        }
        const requestedCapabilities = normalizeProtocolCapabilities(preAuthPayload.capabilities);
        const result = authService.verify({
          token: preAuthPayload.token as string | undefined,
          password: preAuthPayload.password as string | undefined,
          resumeToken: preAuthPayload.resumeToken as string | undefined,
        });
        if (!result.ok) {
          sendWireProtocolMessage(ws, requestedCapabilities.envelope, "core", "auth_error", {
            reason: result.reason ?? "unauthorized",
          });
          ws.close(4001, "unauthorized");
          return;
        }
        client.authenticated = true;
        client.capabilities = requestedCapabilities;
        const platform = normalizeClientPlatform(preAuthPayload.platform ?? result.device?.platform);
        const deviceName = normalizeDeviceName(preAuthPayload.deviceName ?? result.device?.displayName, platform);
        connectedClients.set(client.clientId, {
          clientId: client.clientId,
          connectTime: client.connectTime,
          deviceName,
          platform,
          lastActivityAt: new Date().toISOString(),
          mode: "active",
        });
        ensureController();
        setTimeout(() => {
          if (ws.readyState !== WebSocket.OPEN) {
            return;
          }
          sendWireProtocolMessage(ws, client.capabilities.envelope, "core", "auth_ok", {
            clientId: client.clientId,
            capabilities: SERVER_PROTOCOL_CAPABILITIES,
          });
          scheduleClientsChangedBroadcast();
        }, 0);
        return;
      }

      // Authenticated commands.
      if (!controller) {
        ws.send(JSON.stringify({ type: "error", message: "zellij not started" }));
        return;
      }

      try {
        markControlClientActive(client);
        const envelope = parseEnvelope(msg, { allowLegacyFallback: false, source: "client" });
        if (envelope?.domain === "inspect" && envelope.type === "request_inspect") {
          const inspectRequest = envelope.payload as Record<string, unknown>;
          const scope = inspectRequest.scope;
          const cursor = typeof inspectRequest.cursor === "string" ? inspectRequest.cursor : null;
          const query = typeof inspectRequest.query === "string" ? inspectRequest.query : undefined;
          const limit = typeof inspectRequest.limit === "number" ? inspectRequest.limit : undefined;
          const service = ensureInspectService();

          if (scope === "tab") {
            const tabIndex = typeof inspectRequest.tabIndex === "number"
              ? inspectRequest.tabIndex
              : (await controller.queryWorkspaceState()).activeTabIndex;
            const snapshot = await service.queryTabHistory(tabIndex, { cursor, query, limit });
            sendProtocolMessage(client, "inspect", "inspect_snapshot", snapshot, {
              requestId: envelope.requestId,
            });
            return;
          }

          if (scope === "pane") {
            const paneId = typeof inspectRequest.paneId === "string"
              ? inspectRequest.paneId
              : await resolveFocusedPaneId();
            if (!paneId) {
              throw new InspectBadRequestError("missing paneId for inspect request");
            }
            const snapshot = await service.queryPaneHistory(paneId, { cursor, query, limit });
            sendProtocolMessage(client, "inspect", "inspect_snapshot", snapshot, {
              requestId: envelope.requestId,
            });
            return;
          }

          throw new InspectBadRequestError("invalid inspect scope");
        }

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
            sendProtocolMessage(client, "core", "inspect_content", { content });
            break;
          }
          case "set_client_mode": {
            const mode = normalizeClientMode(msg.mode);
            markControlClientActive(client, { mode });
            scheduleClientsChangedBroadcast();
            break;
          }
          case "request_inspect": {
            const service = ensureInspectService();
            const scope = msg.scope;
            const cursor = typeof msg.cursor === "string" ? msg.cursor : null;
            const query = typeof msg.query === "string" ? msg.query : undefined;
            const limit = typeof msg.limit === "number" ? msg.limit : undefined;

            if (scope === "tab") {
              const tabIndex = typeof msg.tabIndex === "number"
                ? msg.tabIndex
                : (await controller.queryWorkspaceState()).activeTabIndex;
              const snapshot = await service.queryTabHistory(tabIndex, { cursor, query, limit });
              sendProtocolMessage(client, "inspect", "inspect_snapshot", snapshot);
              break;
            }

            if (scope === "pane") {
              const paneId = typeof msg.paneId === "string" ? msg.paneId : await resolveFocusedPaneId();
              if (!paneId) {
                throw new InspectBadRequestError("missing paneId for inspect request");
              }
              const snapshot = await service.queryPaneHistory(paneId, { cursor, query, limit });
              sendProtocolMessage(client, "inspect", "inspect_snapshot", snapshot);
              break;
            }

            throw new InspectBadRequestError("invalid inspect scope");
          }
          case "rename_session":
            await controller.renameSession(msg.name as string);
            await broadcastWorkspaceState();
            break;
          default:
            ws.send(JSON.stringify({ type: "error", message: `unknown command: ${msg.type}` }));
        }
      } catch (err) {
        if (err instanceof InspectBadRequestError) {
          ws.send(JSON.stringify({ type: "error", code: err.statusCode, message: err.message }));
          return;
        }
        ws.send(JSON.stringify({ type: "error", message: String(err) }));
      }
    });

    ws.on("close", () => {
      controlClients.delete(client);
      if (client.authenticated) {
        connectedClients.delete(client.clientId);
        scheduleClientsChangedBroadcast();
      }
    });

    ws.on("error", (err: Error) => {
      logger.error("Control WebSocket error:", err.message);
      controlClients.delete(client);
      if (client.authenticated) {
        connectedClients.delete(client.clientId);
        scheduleClientsChangedBroadcast();
      }
    });
  });

  return {
    server,
    getConnectedClients() {
      return getConnectedClientsSnapshot();
    },
    async start() {
      return new Promise<void>((resolve, reject) => {
        server.listen(config.port, config.host, () => {
          logger.log(`Zellij server listening on ${config.host}:${config.port}`);
          resolve();
        });
        server.once("error", reject);
      }).then(() => {
        authService.cleanupExpiredPairingSessions();
        pairingCleanupTimer = setInterval(() => {
          authService.cleanupExpiredPairingSessions();
        }, 60 * 60 * 1000);

        // Broadcast bandwidth stats every 5 seconds to all authed control clients.
        if (extensions) {
          setInterval(() => {
            const stats = extensions.getBandwidthStats();
            const legacyMessage = JSON.stringify({ type: "bandwidth_stats", stats });
            const envelopeMessage = JSON.stringify(createEnvelope("admin", "bandwidth_stats", { stats }));
            for (const client of controlClients) {
              if (client.authenticated && client.ws.readyState === WebSocket.OPEN) {
                client.ws.send(client.capabilities.envelope ? envelopeMessage : legacyMessage);
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
      connectedClients.clear();
      if (clientsChangedTimer) {
        clearTimeout(clientsChangedTimer);
        clientsChangedTimer = null;
      }
      if (pairingCleanupTimer) {
        clearInterval(pairingCleanupTimer);
        pairingCleanupTimer = null;
      }
      terminalWss.close();
      controlWss.close();
      extensions?.dispose();
      authService.dispose();
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

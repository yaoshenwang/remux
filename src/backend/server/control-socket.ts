import type { WebSocketServer } from "ws";
import type { AuthService } from "../auth/auth-service.js";
import type { BackendCapabilities, ControlClientMessage } from "../../shared/protocol.js";
import type { ServerCapabilities } from "../../shared/contracts/core.js";
import { randomToken } from "../util/random.js";
import { parseClientMessage, sendJson, summarizeClientMessage } from "./socket-protocol.js";
import type { SessionAttachService } from "./session-attach-service.js";
import type { ControlContext } from "./types.js";

interface RegisterControlSocketHandlersOptions {
  authService: AuthService;
  controlClients: Set<ControlContext>;
  controlWss: WebSocketServer;
  logger: Pick<Console, "log" | "error">;
  resolveServerCapabilities: () => ServerCapabilities;
  runControlMutation: (message: ControlClientMessage, context: ControlContext) => Promise<void>;
  sessionAttachService: Pick<SessionAttachService, "applyInitialViewHint" | "ensureAttachedSession">;
  shutdownControlContext: (context: ControlContext) => Promise<void>;
  verboseLog: (...args: unknown[]) => void;
  getBackendCapabilities: () => BackendCapabilities;
  getBackendKind: () => string;
  getMonitor: () => { forcePublish(): Promise<void> } | undefined;
}

export const registerControlSocketHandlers = ({
  authService,
  controlClients,
  controlWss,
  logger,
  resolveServerCapabilities,
  runControlMutation,
  sessionAttachService,
  shutdownControlContext,
  verboseLog,
  getBackendCapabilities,
  getBackendKind,
  getMonitor,
}: RegisterControlSocketHandlersOptions): void => {
  controlWss.on("connection", (socket) => {
    const context: ControlContext = {
      socket,
      authed: false,
      clientId: randomToken(12),
      messageQueue: Promise.resolve(),
      terminalClients: new Set()
    };
    controlClients.add(context);
    logger.log("control ws connected", context.clientId);

    socket.on("message", async (rawData) => {
      const raw = rawData.toString("utf8");

      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (parsed.type === "ping" && typeof parsed.timestamp === "number") {
          if (socket.readyState === socket.OPEN) {
            socket.send(JSON.stringify({ type: "pong", timestamp: parsed.timestamp }));
          }
          return;
        }
      } catch {
        // Continue to normal parsing.
      }

      const message = parseClientMessage(raw);
      if (!message) {
        sendJson(socket, { type: "error", message: "invalid message format" });
        return;
      }

      context.messageQueue = context.messageQueue.then(async () => {
        logger.log("control ws message", context.clientId, message.type);
        verboseLog("control ws payload", context.clientId, summarizeClientMessage(message));

        try {
          if (!context.authed) {
            if (message.type !== "auth") {
              sendJson(socket, { type: "auth_error", reason: "auth required" });
              return;
            }

            const authResult = authService.verify({
              token: message.token,
              password: message.password
            });
            if (!authResult.ok) {
              logger.log("control ws auth failed", context.clientId, authResult.reason ?? "unknown");
              sendJson(socket, {
                type: "auth_error",
                reason: authResult.reason ?? "unauthorized"
              });
              return;
            }

            context.authed = true;
            logger.log("control ws auth ok", context.clientId);
            sendJson(socket, {
              type: "auth_ok",
              clientId: context.clientId,
              requiresPassword: authService.requiresPassword(),
              capabilities: getBackendCapabilities(),
              serverCapabilities: resolveServerCapabilities(),
              backendKind: getBackendKind()
            });
            try {
              await sessionAttachService.ensureAttachedSession(context, message.session);
              await sessionAttachService.applyInitialViewHint(context, {
                tabIndex: message.tabIndex,
                paneId: message.paneId
              });
            } catch (error) {
              logger.error("initial attach failed", error);
              sendJson(socket, {
                type: "error",
                message: error instanceof Error ? error.message : String(error)
              });
            }
            await getMonitor()?.forcePublish();
            return;
          }

          try {
            verboseLog("control mutation start", context.clientId, message.type);
            await runControlMutation(message, context);
            verboseLog("control mutation done", context.clientId, message.type);
          } finally {
            verboseLog("force publish start", context.clientId, message.type);
            await getMonitor()?.forcePublish();
            verboseLog("force publish done", context.clientId, message.type);
          }
        } catch (error) {
          logger.error("control ws error", context.clientId, error);
          sendJson(socket, {
            type: "error",
            message: error instanceof Error ? error.message : String(error)
          });
        }
      }).catch((error) => {
        logger.error("control ws error", context.clientId, error);
        sendJson(socket, {
          type: "error",
          message: error instanceof Error ? error.message : String(error)
        });
      });
    });

    socket.on("close", () => {
      controlClients.delete(context);
      void shutdownControlContext(context);
      logger.log("control ws closed", context.clientId);
    });
  });
};

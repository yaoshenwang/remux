import type { WebSocketServer } from "ws";
import type { AuthService } from "../auth/auth-service.js";
import { extractTerminalDimensions, parseClientMessage, isObject } from "./socket-protocol.js";
import type { ControlContext, DataContext } from "./types.js";

interface RegisterTerminalSocketHandlersOptions {
  authService: AuthService;
  getControlContext: (clientId: string) => ControlContext | undefined;
  logger: Pick<Console, "log" | "error">;
  terminalClients: Set<DataContext>;
  terminalWss: WebSocketServer;
  verboseLog: (...args: unknown[]) => void;
}

export const registerTerminalSocketHandlers = ({
  authService,
  getControlContext,
  logger,
  terminalClients,
  terminalWss,
  verboseLog,
}: RegisterTerminalSocketHandlersOptions): void => {
  terminalWss.on("connection", (socket) => {
    const ctx: DataContext = { socket, authed: false };
    terminalClients.add(ctx);
    logger.log("terminal ws connected");

    socket.on("message", (rawData, isBinary) => {
      if (!ctx.authed) {
        if (isBinary) {
          socket.close(4001, "auth required");
          return;
        }

        const authMessage = parseClientMessage(rawData.toString("utf8"));
        if (!authMessage || authMessage.type !== "auth") {
          socket.close(4001, "auth required");
          return;
        }
        const clientId = authMessage.clientId;
        if (!clientId) {
          socket.close(4001, "unauthorized");
          return;
        }

        const authResult = authService.verify({
          token: authMessage.token,
          password: authMessage.password
        });
        if (!authResult.ok) {
          logger.log("terminal ws auth failed", authResult.reason ?? "unknown");
          socket.close(4001, "unauthorized");
          return;
        }
        const controlContext = getControlContext(clientId);
        if (!controlContext || !controlContext.authed) {
          socket.close(4001, "unauthorized");
          return;
        }

        ctx.authed = true;
        ctx.controlClientId = clientId;
        ctx.controlContext = controlContext;
        controlContext.terminalClients.add(ctx);
        const initialTerminalSize = extractTerminalDimensions(authMessage);
        if (initialTerminalSize) {
          controlContext.pendingResize = initialTerminalSize;
          controlContext.runtime?.resize(initialTerminalSize.cols, initialTerminalSize.rows);
        }
        logger.log("terminal ws auth ok");

        controlContext.runtime?.replayLast((data) => {
          if (socket.readyState === socket.OPEN) {
            socket.send(data);
          }
        });
        return;
      }

      if (isBinary) {
        let buf: Buffer;
        if (Buffer.isBuffer(rawData)) {
          buf = rawData;
        } else if (rawData instanceof ArrayBuffer) {
          buf = Buffer.from(rawData);
        } else if (Array.isArray(rawData)) {
          buf = Buffer.concat(rawData);
        } else {
          buf = Buffer.from(rawData);
        }
        verboseLog("terminal ws binary input", `bytes=${buf.length}`);
        ctx.controlContext?.runtime?.write(buf.toString("utf8"));
        return;
      }

      const text = rawData.toString("utf8");
      if (text.startsWith("{")) {
        try {
          const payload = JSON.parse(text) as unknown;
          if (
            isObject(payload) &&
            payload.type === "resize" &&
            typeof payload.cols === "number" &&
            typeof payload.rows === "number"
          ) {
            if (ctx.controlContext?.runtime) {
              ctx.controlContext.runtime.resize(payload.cols, payload.rows);
            }
            if (ctx.controlContext) {
              ctx.controlContext.pendingResize = { cols: payload.cols, rows: payload.rows };
            }
            verboseLog("terminal ws resize", `${payload.cols}x${payload.rows}`);
            return;
          }
        } catch {
          // fall through and treat as terminal input
        }
      }

      ctx.controlContext?.runtime?.write(text);
      verboseLog("terminal ws text input", `bytes=${Buffer.byteLength(text, "utf8")}`);
    });

    socket.on("close", () => {
      terminalClients.delete(ctx);
      ctx.controlContext?.terminalClients.delete(ctx);
      logger.log("terminal ws closed");
    });
  });
};

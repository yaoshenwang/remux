import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createZellijServer, type RunningServer } from "../../src/backend/server-zellij.js";
import { AuthService } from "../../src/backend/auth/auth-service.js";

const TOKEN = "client-state-token";
type BufferedWebSocket = WebSocket & {
  __messageQueue: string[];
};

describe("control client connection state", () => {
  let server: RunningServer;
  let baseWsUrl = "";

  beforeAll(async () => {
    const controller = {
      async queryWorkspaceState() {
        return {
          session: "client-state",
          activeTabIndex: 0,
          tabs: [
            {
              index: 0,
              name: "main",
              active: true,
              isFullscreen: false,
              hasBell: false,
              panes: [
                {
                  id: "terminal_1",
                  focused: true,
                  title: "api",
                  command: "npm run dev",
                  cwd: "/tmp/api",
                  rows: 24,
                  cols: 80,
                  x: 0,
                  y: 0,
                },
              ],
            },
          ],
        };
      },
      async dumpScreen() {
        return "legacy inspect payload";
      },
      async dumpPaneScreen() {
        return ["first line", "second line", "third line"].join("\n");
      },
      async newTab() {},
      async closeTab() {},
      async goToTab() {},
      async renameTab() {},
      async newPane() {},
      async closePane() {},
      async toggleFullscreen() {},
      async renameSession() {},
    };

    server = createZellijServer(
      {
        port: 0,
        host: "127.0.0.1",
        frontendDir: path.resolve("dist"),
        zellijSession: "client-state",
      },
      {
        authService: new AuthService({ token: TOKEN }),
        logger: { log: () => {}, error: () => {} },
        createController: () => controller,
      },
    );

    await server.start();
    const address = server.server.address() as AddressInfo;
    baseWsUrl = `ws://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await server.stop();
  });

  it("tracks clients, broadcasts clients_changed, and applies mode updates", async () => {
    const alpha = await connectControlClient(baseWsUrl, {
      type: "auth",
      token: TOKEN,
      deviceName: "MacBook Pro",
      platform: "web",
      capabilities: {
        envelope: true,
        inspectV2: true,
        deviceTrust: true,
      },
    });
    const alphaAuth = await expectMessage(
      alpha,
      (payload) => payload.domain === "core" && payload.type === "auth_ok",
    );
    expect(typeof alphaAuth.payload.clientId).toBe("string");

    const alphaInitial = await expectMessage(
      alpha,
      (payload) => payload.domain === "runtime" && payload.type === "clients_changed",
    );
    expect(alphaInitial.payload.clients).toHaveLength(1);
    expect(alphaInitial.payload.selfClientId).toBe(alphaAuth.payload.clientId);
    expect(alphaInitial.payload.clients[0]).toMatchObject({
      deviceName: "MacBook Pro",
      platform: "web",
      mode: "active",
    });

    const beta = await connectControlClient(baseWsUrl, {
      type: "auth",
      token: TOKEN,
      deviceName: "iPhone",
      platform: "ios",
    });
    const betaAuth = await expectMessage(beta, (payload) => payload.type === "auth_ok");
    expect(typeof betaAuth.clientId).toBe("string");

    const alphaChanged = await expectMessage(
      alpha,
      (payload) => payload.domain === "runtime" && payload.type === "clients_changed" && payload.payload.clients.length === 2,
    );
    const betaChanged = await expectMessage(
      beta,
      (payload) => payload.type === "clients_changed" && Array.isArray(payload.clients) && payload.clients.length === 2,
    );

    expect(alphaChanged.payload.clients).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ clientId: alphaAuth.payload.clientId, mode: "active" }),
        expect.objectContaining({ clientId: betaAuth.clientId, mode: "active" }),
      ]),
    );
    expect(betaChanged.clients).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ clientId: betaAuth.clientId, deviceName: "iPhone" }),
      ]),
    );

    beta.send(JSON.stringify({ type: "set_client_mode", mode: "observer" }));

    const alphaModeUpdate = await expectMessage(
      alpha,
      (payload) =>
        payload.domain === "runtime"
        && payload.type === "clients_changed"
        && payload.payload.clients.some((client: Record<string, unknown>) =>
          client.clientId === betaAuth.clientId && client.mode === "observer"
        ),
    );

    expect(alphaModeUpdate.payload.clients).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ clientId: betaAuth.clientId, mode: "observer" }),
      ]),
    );

    expect(server.getConnectedClients?.()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ clientId: alphaAuth.payload.clientId, deviceName: "MacBook Pro", mode: "active" }),
        expect.objectContaining({ clientId: betaAuth.clientId, deviceName: "iPhone", mode: "observer" }),
      ]),
    );

    beta.close();
    alpha.close();
  });
});

const connectControlClient = async (
  baseWsUrl: string,
  authMessage: Record<string, unknown>,
): Promise<BufferedWebSocket> => {
  const ws = new WebSocket(`${baseWsUrl}/ws/control`) as BufferedWebSocket;
  ws.__messageQueue = [];
  ws.on("message", (raw) => {
    ws.__messageQueue.push(String(raw));
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  ws.send(JSON.stringify(authMessage));
  return ws;
};

const expectMessage = async (
  ws: BufferedWebSocket,
  matcher: (payload: Record<string, any>) => boolean,
): Promise<Record<string, any>> => {
  const queuedIndex = ws.__messageQueue.findIndex((raw) => {
    try {
      return matcher(JSON.parse(raw) as Record<string, any>);
    } catch {
      return false;
    }
  });
  if (queuedIndex >= 0) {
    const [queued] = ws.__messageQueue.splice(queuedIndex, 1);
    return JSON.parse(queued) as Record<string, any>;
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for matching message"));
    }, 5_000);

    const cleanup = () => {
      clearTimeout(timeout);
      ws.off("message", onMessage);
      ws.off("error", onError);
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const onMessage = (raw: WebSocket.RawData) => {
      try {
        const normalized = String(raw);
        const payload = JSON.parse(normalized) as Record<string, any>;
        if (!matcher(payload)) {
          return;
        }
        const queuedMessageIndex = ws.__messageQueue.indexOf(normalized);
        if (queuedMessageIndex >= 0) {
          ws.__messageQueue.splice(queuedMessageIndex, 1);
        }
        cleanup();
        resolve(payload);
      } catch (error) {
        cleanup();
        reject(error);
      }
    };

    ws.on("message", onMessage);
    ws.on("error", onError);
  });
};

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createZellijServer, type RunningServer } from "../../src/backend/server-zellij.js";
import { AuthService } from "../../src/backend/auth/auth-service.js";
import { createEnvelope } from "../../src/backend/protocol/envelope.js";

const TOKEN = "protocol-compat-token";

describe("control protocol compatibility", () => {
  let server: RunningServer;
  let baseWsUrl = "";

  beforeAll(async () => {
    const controller = {
      async queryWorkspaceState() {
        return {
          session: "protocol-compat",
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
        zellijSession: "protocol-compat",
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

  it("serves legacy and envelope clients concurrently without breaking capture_inspect", async () => {
    const legacyClient = await connectControlClient(baseWsUrl, { type: "auth", token: TOKEN });
    const envelopeClient = await connectControlClient(baseWsUrl, {
      type: "auth",
      token: TOKEN,
      capabilities: {
        envelope: true,
        inspectV2: true,
        deviceTrust: false,
      },
    });

    const legacyAuthOk = await expectMessage(legacyClient, (payload) => payload.type === "auth_ok");
    const envelopeAuthOk = await expectMessage(
      envelopeClient,
      (payload) => payload.domain === "core" && payload.type === "auth_ok",
    );

    expect(legacyAuthOk.capabilities).toEqual({
      envelope: true,
      inspectV2: true,
      deviceTrust: false,
    });
    expect(envelopeAuthOk).toMatchObject({
      domain: "core",
      type: "auth_ok",
      version: 1,
      source: "server",
      payload: {
        capabilities: {
          envelope: true,
          inspectV2: true,
          deviceTrust: false,
        },
      },
    });

    legacyClient.send(JSON.stringify({ type: "subscribe_workspace" }));

    const legacyWorkspace = await expectMessage(legacyClient, (payload) => payload.type === "workspace_state");
    expect(legacyWorkspace).toMatchObject({
      type: "workspace_state",
      session: "protocol-compat",
      activeTabIndex: 0,
    });

    const envelopeWorkspace = await expectMessage(
      envelopeClient,
      (payload) => payload.domain === "runtime" && payload.type === "workspace_state",
    );
    expect(envelopeWorkspace).toMatchObject({
      domain: "runtime",
      type: "workspace_state",
      version: 1,
      source: "server",
      payload: {
        session: "protocol-compat",
        activeTabIndex: 0,
      },
    });

    legacyClient.send(
      JSON.stringify({
        type: "request_inspect",
        scope: "pane",
        paneId: "terminal_1",
        limit: 2,
      }),
    );
    const legacyInspect = await expectMessage(legacyClient, (payload) => payload.type === "inspect_snapshot");
    expect(legacyInspect.descriptor.scope).toBe("pane");
    expect(legacyInspect.items).toHaveLength(2);

    envelopeClient.send(JSON.stringify(
      createEnvelope(
        "inspect",
        "request_inspect",
        {
          scope: "pane",
          paneId: "terminal_1",
          limit: 2,
        },
        {
          source: "client",
        },
      ),
    ));
    const envelopeInspect = await expectMessage(
      envelopeClient,
      (payload) => payload.domain === "inspect" && payload.type === "inspect_snapshot",
    );
    expect(envelopeInspect).toMatchObject({
      domain: "inspect",
      type: "inspect_snapshot",
      version: 1,
      source: "server",
    });
    expect(envelopeInspect.payload.descriptor.scope).toBe("pane");
    expect(envelopeInspect.payload.items).toHaveLength(2);

    envelopeClient.send(JSON.stringify({ type: "capture_inspect", full: true }));
    const legacyCapture = await expectMessage(
      envelopeClient,
      (payload) => payload.domain === "core" && payload.type === "inspect_content",
    );
    expect(legacyCapture).toMatchObject({
      domain: "core",
      type: "inspect_content",
      payload: {
        content: "legacy inspect payload",
      },
    });

    legacyClient.close();
    envelopeClient.close();
  });
});

const connectControlClient = async (
  baseWsUrl: string,
  authMessage: Record<string, unknown>,
): Promise<WebSocket> => {
  const ws = new WebSocket(`${baseWsUrl}/ws/control`);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  ws.send(JSON.stringify(authMessage));
  return ws;
};

const expectMessage = async (
  ws: WebSocket,
  matcher: (payload: Record<string, any>) => boolean,
): Promise<Record<string, any>> => {
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
        const payload = JSON.parse(String(raw)) as Record<string, any>;
        if (!matcher(payload)) {
          return;
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

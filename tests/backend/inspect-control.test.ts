import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createZellijServer, type RunningServer } from "../../src/backend/server-zellij.js";
import { AuthService } from "../../src/backend/auth/auth-service.js";

const TOKEN = "inspect-control-token";

describe("inspect control channel", () => {
  let server: RunningServer;
  let baseWsUrl = "";

  beforeAll(async () => {
    const controller = {
      async queryWorkspaceState() {
        return {
          session: "inspect-control",
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
        zellijSession: "inspect-control",
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

  it("serves request_inspect snapshots and keeps capture_inspect backward compatible", async () => {
    const ws = new WebSocket(`${baseWsUrl}/ws/control`);

    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });

    ws.send(JSON.stringify({ type: "auth", token: TOKEN }));
    await expectMessage(ws, "auth_ok");

    ws.send(
      JSON.stringify({
        type: "request_inspect",
        scope: "pane",
        paneId: "terminal_1",
        limit: 2,
      }),
    );

    const inspectSnapshot = await expectMessage(ws, "inspect_snapshot");
    expect(inspectSnapshot.descriptor.scope).toBe("pane");
    expect(inspectSnapshot.items).toHaveLength(2);
    expect(inspectSnapshot.cursor).not.toBeNull();

    ws.send(JSON.stringify({ type: "capture_inspect", full: true }));
    const legacyPayload = await expectMessage(ws, "inspect_content");
    expect(legacyPayload.content).toBe("legacy inspect payload");

    ws.close();
  });
});

const expectMessage = async (
  ws: WebSocket,
  type: string,
): Promise<Record<string, any>> => {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for ${type}`));
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
        if (payload.type !== type) {
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

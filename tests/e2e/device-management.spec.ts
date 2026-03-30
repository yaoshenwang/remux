import { expect, test } from "@playwright/test";
import { startZellijE2EServer, type StartedZellijE2EServer } from "./harness/zellij-e2e-server.js";

let server: StartedZellijE2EServer | undefined;

test.beforeEach(async () => {
  server = await startZellijE2EServer();
  await createTrustedDevice(server.baseUrl, server.token);
});

test.afterEach(async () => {
  if (server) {
    await server.stop();
    server = undefined;
  }
});

test("renders trusted devices, creates pairing QR, and revokes devices from the sidebar", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installMockSockets(page);
  await page.goto(`${server!.baseUrl}/?token=${server!.token}`);

  await expect(page.getByTestId("device-list")).toContainText("Alice iPhone");
  await expect(page.getByTestId("device-list")).toContainText("trusted");

  await page.getByRole("button", { name: "Pair New Device" }).click();
  await expect(page.getByTestId("pairing-qr")).toBeVisible();

  await page.getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByTestId("device-list")).toContainText("revoked");
  await expect(page.getByRole("button", { name: "Revoked" })).toBeVisible();
});

const createTrustedDevice = async (baseUrl: string, token: string): Promise<void> => {
  const pairingCreate = await fetch(`${baseUrl}/api/pairing/create`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  const pairingPayload = await pairingCreate.json() as {
    payload: {
      pairingSessionId: string;
      token: string;
    };
  };

  await fetch(`${baseUrl}/api/pairing/redeem`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      pairingSessionId: pairingPayload.payload.pairingSessionId,
      token: pairingPayload.payload.token,
      publicKey: "device-management-public-key",
      displayName: "Alice iPhone",
      platform: "ios",
    }),
  });
};

const installMockSockets = async (page: import("@playwright/test").Page) => {
  await page.addInitScript(() => {
    const workspaceState = {
      session: "device-management",
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

    class MockSocket extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;

      readonly CONNECTING = MockSocket.CONNECTING;
      readonly OPEN = MockSocket.OPEN;
      readonly CLOSING = MockSocket.CLOSING;
      readonly CLOSED = MockSocket.CLOSED;

      readyState = MockSocket.CONNECTING;
      url: string;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent<string>) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      binaryType: BinaryType = "blob";
      protocol = "";
      extensions = "";

      constructor(url: string | URL) {
        super();
        this.url = String(url);
        queueMicrotask(() => {
          this.readyState = MockSocket.OPEN;
          this.onopen?.(new Event("open"));
        });
      }

      send(payload: string) {
        const message = JSON.parse(payload) as Record<string, any>;

        if (this.url.includes("/ws/terminal")) {
          if (message.type === "auth") {
            this.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ type: "auth_ok" }) }));
          }
          return;
        }

        if (message.type === "auth") {
          this.onmessage?.(new MessageEvent("message", {
            data: JSON.stringify({
              type: "auth_ok",
              clientId: "client-web-1",
              capabilities: {
                envelope: true,
                inspectV2: true,
                deviceTrust: true,
              },
            }),
          }));
          return;
        }

        if (message.type === "subscribe_workspace") {
          this.onmessage?.(new MessageEvent("message", {
            data: JSON.stringify({
              domain: "runtime",
              type: "workspace_state",
              version: 1,
              emittedAt: "2026-03-31T10:00:00.000Z",
              source: "server",
              payload: workspaceState,
            }),
          }));
        }
      }

      close(code = 1000, reason = "") {
        if (this.readyState === MockSocket.CLOSED) {
          return;
        }
        this.readyState = MockSocket.CLOSED;
        this.onclose?.(new CloseEvent("close", { code, reason, wasClean: code === 1000 }));
      }
    }

    Object.defineProperty(window, "WebSocket", {
      configurable: true,
      writable: true,
      value: MockSocket,
    });

    window.confirm = () => true;
  });
};

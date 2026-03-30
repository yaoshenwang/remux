import { expect, test } from "@playwright/test";
import { startZellijE2EServer, type StartedZellijE2EServer } from "./harness/zellij-e2e-server.js";

let server: StartedZellijE2EServer | undefined;

test.beforeEach(async () => {
  server = await startZellijE2EServer();
});

test.afterEach(async () => {
  if (server) {
    await server.stop();
    server = undefined;
  }
});

test("requests notification permission and syncs bell / exit preferences", async ({ page }) => {
  await installMockSockets(page);
  await installNotificationMocks(page);
  await page.goto(`${server!.baseUrl}/?token=${server!.token}`);

  await page.getByLabel("Bell alerts").check();
  await page.getByLabel("Session exit").check();
  await expect(page.getByLabel("Session exit")).toBeChecked();

  const debugState = await page.evaluate(() => window.__remuxNotificationTest);
  expect(debugState?.requestedPermissions).toBe(1);
  expect(debugState?.subscribeBodies).toEqual([
    expect.objectContaining({
      preferences: {
        bell: true,
        exit: false,
      },
    }),
  ]);
});

const installNotificationMocks = async (page: import("@playwright/test").Page) => {
  await page.addInitScript(() => {
    const sharedState = {
      requestedPermissions: 0,
      subscribeBodies: [] as Array<Record<string, unknown>>,
    };

    const subscription = {
      endpoint: "https://push.example/subscription",
      keys: {
        p256dh: "p256dh-key",
        auth: "auth-key",
      },
      unsubscribe: async () => true,
      toJSON() {
        return {
          endpoint: this.endpoint,
          keys: this.keys,
        };
      },
    };

    const registration = {
      pushManager: {
        getSubscription: async () => null,
        subscribe: async () => subscription,
      },
    };

    Object.defineProperty(window, "Notification", {
      configurable: true,
      writable: true,
      value: class MockNotification {
        static permission: NotificationPermission = "default";

        static async requestPermission(): Promise<NotificationPermission> {
          sharedState.requestedPermissions += 1;
          MockNotification.permission = "granted";
          return "granted";
        }
      },
    });

    Object.defineProperty(window, "PushManager", {
      configurable: true,
      writable: true,
      value: class {},
    });

    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      writable: true,
      value: {
        register: async () => registration,
        getRegistration: async () => registration,
      },
    });

    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/api/push/subscribe")) {
        sharedState.subscribeBodies.push(JSON.parse(String(init?.body ?? "{}")));
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        });
      }
      return nativeFetch(input, init);
    };

    Object.defineProperty(window, "__remuxNotificationTest", {
      configurable: true,
      writable: true,
      value: sharedState,
    });
  });
};

const installMockSockets = async (page: import("@playwright/test").Page) => {
  await page.addInitScript(() => {
    const workspaceState = {
      session: "notifications",
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
  });
};

declare global {
  interface Window {
    __remuxNotificationTest?: {
      requestedPermissions: number;
      subscribeBodies: Array<Record<string, unknown>>;
    };
  }
}

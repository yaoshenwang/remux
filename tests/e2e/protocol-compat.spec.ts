import { expect, test } from "@playwright/test";
import { startZellijE2EServer, type StartedZellijE2EServer } from "./harness/zellij-e2e-server.js";

let server: StartedZellijE2EServer | undefined;

test.use({ timezoneId: "Asia/Shanghai" });

test.beforeEach(async () => {
  server = await startZellijE2EServer();
});

test.afterEach(async () => {
  if (server) {
    await server.stop();
    server = undefined;
  }
});

test("frontend negotiates capabilities and renders envelope protocol payloads", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installEnvelopeMockSockets(page);
  await page.goto(`${server!.baseUrl}/?token=${server!.token}`);

  await expect(page.getByTestId("inspect-view")).toBeVisible();
  await expect(page.getByText("env boot ok")).toBeVisible();

  const authMessages = await page.evaluate(() => window.__remuxProtocolCompatTest?.authMessages ?? []);
  expect(authMessages).toHaveLength(1);
  expect(authMessages[0]).toMatchObject({
    type: "auth",
    capabilities: {
      envelope: true,
      inspectV2: true,
      deviceTrust: true,
    },
  });

  const inspectRequests = await page.evaluate(() => window.__remuxProtocolCompatTest?.inspectRequests ?? []);
  expect(inspectRequests).toEqual(expect.arrayContaining([
    expect.objectContaining({
      domain: "inspect",
      type: "request_inspect",
      payload: expect.objectContaining({ scope: "tab" }),
    }),
  ]));
});

const installEnvelopeMockSockets = async (page: import("@playwright/test").Page) => {
  await page.addInitScript(() => {
    type ListenerMap = Map<string, Set<(event: any) => void>>;

    const workspaceState = {
      session: "protocol-envelope-e2e",
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

    const sharedState = {
      authMessages: [] as Array<Record<string, unknown>>,
      inspectRequests: [] as Array<Record<string, unknown>>,
    };

    const createEnvelope = (domain: string, type: string, payload: Record<string, unknown>) => ({
      domain,
      type,
      version: 1,
      requestId: null,
      emittedAt: "2026-03-31T10:00:00.000Z",
      source: "server",
      payload,
    });

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

      private listeners: ListenerMap = new Map();

      constructor(url: string | URL) {
        super();
        this.url = String(url);

        queueMicrotask(() => {
          this.readyState = MockSocket.OPEN;
          this.emit("open", new Event("open"));
        });
      }

      send(payload: string) {
        const message = JSON.parse(payload) as Record<string, any>;

        if (this.url.includes("/ws/terminal")) {
          if (message.type === "auth") {
            this.emit("message", new MessageEvent("message", { data: JSON.stringify({ type: "auth_ok" }) }));
          }
          return;
        }

        if (message.type === "auth") {
          sharedState.authMessages.push(message);
          this.emit("message", new MessageEvent("message", {
            data: JSON.stringify(createEnvelope("core", "auth_ok", {
              capabilities: {
                envelope: true,
                inspectV2: true,
                deviceTrust: true,
              },
            })),
          }));
          return;
        }

        if (message.type === "subscribe_workspace") {
          this.emit("message", new MessageEvent("message", {
            data: JSON.stringify(createEnvelope("runtime", "workspace_state", workspaceState)),
          }));
          return;
        }

        if (message.domain === "inspect" && message.type === "request_inspect") {
          sharedState.inspectRequests.push(message);
          this.emit("message", new MessageEvent("message", {
            data: JSON.stringify(createEnvelope("inspect", "inspect_snapshot", {
              descriptor: {
                scope: "tab",
                source: "runtime_capture",
                precision: "partial",
                staleness: "fresh",
                capturedAt: "2026-03-31T10:00:00.000Z",
                totalItems: 1,
                tabIndex: 0,
              },
              items: [
                {
                  type: "output",
                  content: "env boot ok",
                  lineNumber: 1,
                  timestamp: "2026-03-31T10:00:00.000Z",
                  paneId: "terminal_1",
                },
              ],
              cursor: null,
              truncated: false,
            })),
          }));
        }
      }

      close(code = 1000, reason = "") {
        if (this.readyState === MockSocket.CLOSED) {
          return;
        }
        this.readyState = MockSocket.CLOSED;
        this.emit("close", new CloseEvent("close", { code, reason, wasClean: code === 1000 }));
      }

      addEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
        if (!listener) {
          return;
        }
        const listeners = this.listeners.get(type) ?? new Set();
        const normalized = typeof listener === "function"
          ? listener
          : (event: Event) => listener.handleEvent(event);
        listeners.add(normalized);
        this.listeners.set(type, listeners);
      }

      removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
        if (!listener) {
          return;
        }
        const listeners = this.listeners.get(type);
        if (!listeners) {
          return;
        }
        const normalized = typeof listener === "function"
          ? listener
          : (event: Event) => listener.handleEvent(event);
        listeners.delete(normalized);
      }

      dispatchEvent(event: Event): boolean {
        this.emit(event.type, event);
        return true;
      }

      private emit(type: string, event: Event) {
        if (type === "open") {
          this.onopen?.(event);
        }
        if (type === "message") {
          this.onmessage?.(event as MessageEvent<string>);
        }
        if (type === "close") {
          this.onclose?.(event as CloseEvent);
        }
        if (type === "error") {
          this.onerror?.(event);
        }
        for (const listener of this.listeners.get(type) ?? []) {
          listener(event);
        }
      }
    }

    Object.defineProperty(window, "WebSocket", {
      configurable: true,
      writable: true,
      value: MockSocket,
    });

    Object.defineProperty(window, "__remuxProtocolCompatTest", {
      configurable: true,
      writable: true,
      value: sharedState,
    });
  });
};

declare global {
  interface Window {
    __remuxProtocolCompatTest?: {
      authMessages: Array<Record<string, unknown>>;
      inspectRequests: Array<Record<string, unknown>>;
    };
  }
}

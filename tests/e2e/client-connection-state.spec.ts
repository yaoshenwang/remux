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

test("shows connected clients and toggles the current client mode", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installMockSockets(page);
  await page.goto(`${server!.baseUrl}/?token=${server!.token}`);

  await expect(page.getByTestId("connected-client-summary")).toContainText("2 devices");
  await expect(page.getByTestId("connected-client-list")).toContainText("This Browser");
  await expect(page.getByTestId("connected-client-list")).toContainText("iPhone");

  const badge = page.getByRole("button", { name: "Mode: Active" });
  await expect(badge).toBeVisible();
  await badge.click();
  await expect(page.getByRole("button", { name: "Mode: Observer" })).toBeVisible();

  const sentModes = await page.evaluate(() => window.__remuxClientStateTest?.modeRequests ?? []);
  expect(sentModes).toEqual(["observer"]);
});

const installMockSockets = async (page: import("@playwright/test").Page) => {
  await page.addInitScript(() => {
    type ListenerMap = Map<string, Set<(event: any) => void>>;

    const workspaceState = {
      session: "client-state-e2e",
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
      modeRequests: [] as string[],
      currentMode: "active" as "active" | "observer",
      controlSocket: null as MockSocket | null,
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

    const broadcastClientsChanged = (socket: MockSocket) => {
      const payload = {
        selfClientId: "client-web-1",
        clients: [
          {
            clientId: "client-web-1",
            connectTime: "2026-03-31T10:00:00.000Z",
            deviceName: "This Browser",
            platform: "web",
            lastActivityAt: "2026-03-31T10:00:00.000Z",
            mode: sharedState.currentMode,
          },
          {
            clientId: "client-ios-1",
            connectTime: "2026-03-31T10:00:00.000Z",
            deviceName: "iPhone",
            platform: "ios",
            lastActivityAt: "2026-03-31T10:00:01.000Z",
            mode: "active",
          },
        ],
      };
      socket.emit("message", new MessageEvent("message", {
        data: JSON.stringify(createEnvelope("runtime", "clients_changed", payload)),
      }));
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

      private listeners: ListenerMap = new Map();

      constructor(url: string | URL) {
        super();
        this.url = String(url);

        if (this.url.includes("/ws/control")) {
          sharedState.controlSocket = this;
        }

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
          this.emit("message", new MessageEvent("message", {
            data: JSON.stringify({
              type: "auth_ok",
              clientId: "client-web-1",
              capabilities: {
                envelope: true,
                inspectV2: true,
                deviceTrust: false,
              },
            }),
          }));
          return;
        }

        if (message.type === "subscribe_workspace") {
          this.emit("message", new MessageEvent("message", {
            data: JSON.stringify(createEnvelope("runtime", "workspace_state", workspaceState)),
          }));
          broadcastClientsChanged(this);
          return;
        }

        if (message.domain === "inspect" && message.type === "request_inspect") {
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
                  content: "client-state ready",
                  lineNumber: 1,
                  timestamp: "2026-03-31T10:00:00.000Z",
                  paneId: "terminal_1",
                },
              ],
              cursor: null,
              truncated: false,
            })),
          }));
          return;
        }

        if (message.type === "set_client_mode") {
          sharedState.currentMode = message.mode;
          sharedState.modeRequests.push(message.mode);
          broadcastClientsChanged(this);
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

      emit(type: string, event: Event) {
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

    Object.defineProperty(window, "__remuxClientStateTest", {
      configurable: true,
      writable: true,
      value: sharedState,
    });

    window.confirm = () => true;
  });
};

declare global {
  interface Window {
    __remuxClientStateTest?: {
      modeRequests: string[];
      currentMode: "active" | "observer";
      controlSocket: unknown;
    };
  }
}

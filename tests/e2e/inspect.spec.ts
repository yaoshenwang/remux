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

test("inspect view supports mobile default, badges, scope switching, search, and pagination", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installMockSockets(page);
  await page.goto(`${server!.baseUrl}/?token=${server!.token}`);

  await expect(page.getByTestId("inspect-view")).toBeVisible();
  await expect(page.getByText("Source: runtime_capture")).toBeVisible();
  await expect(page.getByText("Precision: partial")).toBeVisible();
  await expect(page.getByText("Staleness: fresh")).toBeVisible();

  await page.getByRole("button", { name: "Load More" }).click();
  await expect(page.getByText("continued tail line")).toBeVisible();

  await page.getByRole("button", { name: "Pane Scope" }).click();
  await expect(page.locator(".inspect-pane-header strong").filter({ hasText: "Pane terminal_1" })).toBeVisible();

  const search = page.getByPlaceholder("Search inspect history");
  await search.fill("error");
  await expect(page.locator("mark")).toContainText("error");

  const requestLog = await page.evaluate(() => window.__remuxInspectTest?.requestLog ?? []);
  expect(requestLog).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ scope: "tab" }),
      expect.objectContaining({ scope: "pane" }),
      expect.objectContaining({ query: "error" }),
    ]),
  );
});

test("inspect marks cached or disconnected data stale and refetches on reconnect", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installMockSockets(page);
  await page.goto(`${server!.baseUrl}/?token=${server!.token}`);

  await expect(page.getByText("Staleness: fresh")).toBeVisible();

  await page.evaluate(() => window.__remuxInspectTest?.dropControlSocket());
  await expect(page.getByText("Staleness: stale")).toBeVisible();

  await expect(page.getByText("Staleness: fresh")).toBeVisible({ timeout: 8_000 });
  await expect(page.getByText("Captured: 2026-03-31 18:05:00")).toBeVisible();
});

test("protocol compatibility keeps legacy clients working while the app negotiates envelope", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installMockSockets(page);
  await page.goto(`${server!.baseUrl}/?token=${server!.token}`);

  await expect(page.getByTestId("inspect-view")).toBeVisible();
  await expect(page.getByText("Source: runtime_capture")).toBeVisible();

  const legacyResult = await page.evaluate(async (token) => {
    const waitForMessage = async (ws: WebSocket, matcher: (payload: Record<string, unknown>) => boolean) => {
      return await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error("timed out waiting for protocol message"));
        }, 2_000);

        const cleanup = () => {
          clearTimeout(timeout);
          ws.removeEventListener("message", onMessage);
          ws.removeEventListener("error", onError);
        };

        const onError = () => {
          cleanup();
          reject(new Error("socket error"));
        };

        const onMessage = (event: MessageEvent<string>) => {
          const payload = JSON.parse(event.data) as Record<string, unknown>;
          if (!matcher(payload)) {
            return;
          }
          cleanup();
          resolve(payload);
        };

        ws.addEventListener("message", onMessage);
        ws.addEventListener("error", onError);
      });
    };

    const ws = new WebSocket(`${window.location.origin.replace(/^http/, "ws")}/ws/control`);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("timed out waiting for open")), 2_000);
      ws.addEventListener("open", () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
    });

    const authOkPromise = waitForMessage(ws, (payload) => payload.type === "auth_ok");
    ws.send(JSON.stringify({ type: "auth", token }));
    const authOk = await authOkPromise;

    const workspacePromise = waitForMessage(ws, (payload) => payload.type === "workspace_state");
    ws.send(JSON.stringify({ type: "subscribe_workspace" }));
    const workspace = await workspacePromise;

    const inspectPromise = waitForMessage(ws, (payload) => payload.type === "inspect_snapshot");
    ws.send(JSON.stringify({
      type: "request_inspect",
      scope: "pane",
      paneId: "terminal_1",
      limit: 2,
    }));
    const inspect = await inspectPromise;
    ws.close();

    return {
      authOk,
      workspace,
      inspect,
      authLog: window.__remuxInspectTest?.authLog ?? [],
      requestLog: window.__remuxInspectTest?.requestLog ?? [],
    };
  }, server!.token);

  expect(legacyResult.authOk).toMatchObject({
    type: "auth_ok",
    capabilities: {
      envelope: true,
      inspectV2: true,
      deviceTrust: true,
    },
  });
  expect(legacyResult.workspace).toMatchObject({
    type: "workspace_state",
    session: "inspect-e2e",
  });
  expect(legacyResult.workspace).not.toHaveProperty("domain");
  expect(legacyResult.inspect).toMatchObject({
    type: "inspect_snapshot",
  });
  expect(legacyResult.inspect).not.toHaveProperty("domain");
  expect(legacyResult.authLog).toEqual(expect.arrayContaining([
    expect.objectContaining({ transport: "legacy", supportsEnvelope: false }),
    expect.objectContaining({ transport: "legacy", supportsEnvelope: true }),
  ]));
  expect(legacyResult.requestLog).toEqual(expect.arrayContaining([
    expect.objectContaining({ transport: "envelope", scope: "tab" }),
    expect.objectContaining({ transport: "legacy", scope: "pane" }),
  ]));
});

const installMockSockets = async (page: import("@playwright/test").Page) => {
  await page.addInitScript(() => {
    type InspectRequest = {
      scope?: "pane" | "tab";
      paneId?: string;
      tabIndex?: number;
      cursor?: string | null;
      query?: string;
      limit?: number;
    };

    type ProtocolCapabilities = {
      envelope: boolean;
      inspectV2: boolean;
      deviceTrust: boolean;
    };

    type WireMessage = {
      type: string;
      domain?: string;
      payload?: Record<string, unknown>;
      requestId?: string;
      capabilities?: ProtocolCapabilities;
      [key: string]: unknown;
    };

    type ListenerMap = Map<string, Set<(event: any) => void>>;

    const workspaceState = {
      session: "inspect-e2e",
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
            {
              id: "terminal_2",
              focused: false,
              title: "logs",
              command: "tail -f",
              cwd: "/tmp/logs",
              rows: 24,
              cols: 80,
              x: 81,
              y: 0,
            },
          ],
        },
      ],
    };

    const sharedState = {
      requestLog: [] as Array<Record<string, unknown>>,
      authLog: [] as Array<Record<string, unknown>>,
      controlSocket: null as MockSocket | null,
      reconnectVersion: 0,
      dropControlSocket() {
        sharedState.controlSocket?.close(1006, "test disconnect");
      },
    };

    const buildSnapshot = (request: InspectRequest) => {
      const capturedAt = sharedState.reconnectVersion > 0
        ? "2026-03-31T10:05:00.000Z"
        : "2026-03-31T10:00:00.000Z";

      if (request.scope === "pane" && request.query?.toLowerCase() === "error") {
        return {
          type: "inspect_snapshot",
          descriptor: {
            scope: "pane",
            source: "runtime_capture",
            precision: "precise",
            staleness: "fresh",
            capturedAt,
            totalItems: 3,
            paneId: "terminal_1",
          },
          items: [
            { type: "output", content: "boot ok", lineNumber: 1, timestamp: capturedAt, paneId: "terminal_1" },
            {
              type: "output",
              content: "fatal error connecting upstream",
              lineNumber: 2,
              timestamp: capturedAt,
              paneId: "terminal_1",
              highlights: [{ start: 6, end: 11 }],
            },
            { type: "output", content: "retry scheduled", lineNumber: 3, timestamp: capturedAt, paneId: "terminal_1" },
          ],
          cursor: null,
          truncated: false,
        };
      }

      if (request.scope === "pane") {
        return {
          type: "inspect_snapshot",
          descriptor: {
            scope: "pane",
            source: "runtime_capture",
            precision: "precise",
            staleness: "fresh",
            capturedAt,
            totalItems: 2,
            paneId: "terminal_1",
          },
          items: [
            { type: "output", content: "Pane terminal_1", lineNumber: 1, timestamp: capturedAt, paneId: "terminal_1" },
            { type: "output", content: "serving :3000", lineNumber: 2, timestamp: capturedAt, paneId: "terminal_1" },
          ],
          cursor: null,
          truncated: false,
        };
      }

      if (request.cursor === "tab-page-2") {
        return {
          type: "inspect_snapshot",
          descriptor: {
            scope: "tab",
            source: "runtime_capture",
            precision: "partial",
            staleness: "fresh",
            capturedAt,
            totalItems: 5,
            tabIndex: 0,
          },
          items: [
            {
              type: "output",
              content: "continued tail line",
              lineNumber: 2,
              timestamp: capturedAt,
              paneId: "terminal_2",
            },
          ],
          cursor: null,
          truncated: false,
        };
      }

      return {
        type: "inspect_snapshot",
        descriptor: {
          scope: "tab",
          source: "runtime_capture",
          precision: "partial",
          staleness: "fresh",
          capturedAt,
          totalItems: 5,
          tabIndex: 0,
        },
        items: [
          { type: "marker", content: "Pane terminal_1", lineNumber: null, timestamp: capturedAt, paneId: "terminal_1" },
          { type: "output", content: "boot ok", lineNumber: 1, timestamp: capturedAt, paneId: "terminal_1" },
          { type: "marker", content: "Pane terminal_2", lineNumber: null, timestamp: capturedAt, paneId: "terminal_2" },
          { type: "output", content: "tail line 1", lineNumber: 1, timestamp: capturedAt, paneId: "terminal_2" },
        ],
        cursor: "tab-page-2",
        truncated: true,
      };
    };

    const serverCapabilities: ProtocolCapabilities = {
      envelope: true,
      inspectV2: true,
      deviceTrust: true,
    };

    const createEnvelope = (domain: string, type: string, payload: Record<string, unknown>, requestId?: string) => ({
      domain,
      type,
      version: 1,
      ...(requestId ? { requestId } : {}),
      emittedAt: "2026-03-31T10:00:00.000Z",
      source: "server",
      payload,
    });

    const parseMessage = (wire: WireMessage) => {
      if (wire.domain && wire.payload && typeof wire.payload === "object") {
        return {
          transport: "envelope" as const,
          type: wire.type,
          payload: wire.payload,
          requestId: typeof wire.requestId === "string" ? wire.requestId : undefined,
        };
      }

      const { type, ...payload } = wire;
      return {
        transport: "legacy" as const,
        type,
        payload,
      };
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
      supportsEnvelope = false;

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
        const message = JSON.parse(payload) as WireMessage;
        const parsed = parseMessage(message);

        if (this.url.includes("/ws/terminal")) {
          if (parsed.type === "auth") {
            this.emit("message", new MessageEvent("message", { data: JSON.stringify({ type: "auth_ok" }) }));
          }
          return;
        }

        if (parsed.type === "auth") {
          const authPayload = parsed.payload as Record<string, unknown>;
          this.supportsEnvelope = authPayload.capabilities !== undefined
            && typeof authPayload.capabilities === "object"
            && (authPayload.capabilities as Record<string, unknown>).envelope === true;
          sharedState.authLog.push({
            transport: parsed.transport,
            supportsEnvelope: this.supportsEnvelope,
          });
          if (sharedState.reconnectVersion > 0) {
            sharedState.reconnectVersion += 1;
          }
          this.emit("message", new MessageEvent("message", {
            data: JSON.stringify(
              this.supportsEnvelope
                ? createEnvelope("core", "auth_ok", { capabilities: serverCapabilities })
                : { type: "auth_ok", capabilities: serverCapabilities },
            ),
          }));
          return;
        }

        if (parsed.type === "subscribe_workspace") {
          const workspacePayload = { ...workspaceState };
          this.emit(
            "message",
            new MessageEvent("message", {
              data: JSON.stringify(
                this.supportsEnvelope
                  ? createEnvelope("runtime", "workspace_state", workspacePayload)
                  : { type: "workspace_state", ...workspacePayload },
              ),
            }),
          );
          return;
        }

        if (parsed.type === "request_inspect") {
          const request = parsed.payload as InspectRequest;
          sharedState.requestLog.push({
            transport: parsed.transport,
            ...request,
          });
          const snapshot = buildSnapshot(request);
          const { type, ...snapshotPayload } = snapshot;
          this.emit("message", new MessageEvent("message", {
            data: JSON.stringify(
              this.supportsEnvelope
                ? createEnvelope("inspect", type, snapshotPayload)
                : snapshot,
            ),
          }));
        }
      }

      close(code = 1000, reason = "") {
        if (this.readyState === MockSocket.CLOSED) {
          return;
        }
        this.readyState = MockSocket.CLOSED;
        if (this.url.includes("/ws/control")) {
          sharedState.reconnectVersion = 1;
        }
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

    Object.defineProperty(window, "__remuxInspectTest", {
      configurable: true,
      writable: true,
      value: sharedState,
    });
  });
};

declare global {
  interface Window {
    __remuxInspectTest?: {
      authLog: Array<Record<string, unknown>>;
      requestLog: Array<Record<string, unknown>>;
      dropControlSocket: () => void;
    };
  }
}

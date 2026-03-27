import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { AuthService } from "../../src/backend/auth/auth-service.js";
import type { RuntimeConfig } from "../../src/backend/config.js";
import {
  createRemuxV2GatewayServer,
  type RunningServer,
} from "../../src/backend/server-v2.js";
import type {
  RuntimeV2InspectSnapshot,
  RuntimeV2WorkspaceSummary,
} from "../../src/backend/v2/types.js";
import { openSocket, waitForMessage, waitForOpen } from "../harness/ws.js";

const silentLogger = { log: () => undefined, error: () => undefined };

const buildConfig = (token: string): RuntimeConfig => ({
  port: 0,
  host: "127.0.0.1",
  password: undefined,
  tunnel: false,
  defaultSession: "main",
  scrollbackLines: 1000,
  pollIntervalMs: 100,
  token,
  frontendDir: process.cwd(),
});

const encodeBase64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");

type FakeRuntimeV2ControlClientMessage =
  | { type: "subscribe_workspace" }
  | { type: "split_pane"; pane_id: string; direction: "vertical" | "horizontal" }
  | {
      type: "request_inspect";
      scope:
        | { type: "pane"; pane_id: string }
        | { type: "tab"; tab_id: string }
        | { type: "session"; session_id: string };
    };

type FakeRuntimeV2TerminalClientMessage =
  | {
      type: "attach";
      pane_id: string;
      mode: "interactive" | "read_only";
      size: { cols: number; rows: number };
    }
  | {
      type: "input";
      data_base64: string;
    }
  | {
      type: "resize";
      size: { cols: number; rows: number };
    }
  | {
      type: "request_snapshot";
    };

const waitForRawMessage = (socket: WebSocket, timeoutMs = 3_000): Promise<string> =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for raw ws message")), timeoutMs);
    const handler = (raw: RawData) => {
      clearTimeout(timeout);
      socket.off("message", handler);
      resolve(raw.toString("utf8"));
    };
    socket.on("message", handler);
  });

class FakeRuntimeV2Server {
  private readonly server = http.createServer(this.handleHttpRequest.bind(this));
  private readonly wss = new WebSocketServer({ noServer: true });
  private workspace: RuntimeV2WorkspaceSummary = {
    sessionId: "session-1",
    tabId: "tab-1",
    paneId: "pane-1",
    sessionName: "main",
    tabTitle: "Shell",
    sessionState: "live",
    sessionCount: 1,
    tabCount: 1,
    paneCount: 1,
    activeSessionId: "session-1",
    activeTabId: "tab-1",
    activePaneId: "pane-1",
    zoomedPaneId: null,
    layout: { type: "leaf", paneId: "pane-1" },
    leaseHolderClientId: "terminal-client-1",
    sessions: [
      {
        sessionId: "session-1",
        sessionName: "main",
        sessionState: "live",
        isActive: true,
        activeTabId: "tab-1",
        tabCount: 1,
        tabs: [
          {
            tabId: "tab-1",
            tabTitle: "Shell",
            isActive: true,
            activePaneId: "pane-1",
            zoomedPaneId: null,
            paneCount: 1,
            layout: { type: "leaf", paneId: "pane-1" },
            panes: [
              {
                paneId: "pane-1",
                isActive: true,
                isZoomed: false,
                leaseHolderClientId: "terminal-client-1",
              },
            ],
          },
        ],
      },
    ],
  };
  private readonly paneContent = new Map<string, string>([
    ["pane-1", "PANE_ONE_READY\r\n"],
    ["pane-2", "PANE_TWO_READY\r\n"],
  ]);

  constructor() {
    this.server.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname !== "/v2/control" && url.pathname !== "/v2/terminal") {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(request, socket, head, (ws) => {
        this.wss.emit("connection", ws, request);
      });
    });

    this.wss.on("connection", (socket, request) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname === "/v2/control") {
        this.handleControlSocket(socket);
        return;
      }
      this.handleTerminalSocket(socket);
    });
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve) => {
      this.server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    this.wss.close();
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private handleHttpRequest(request: http.IncomingMessage, response: http.ServerResponse): void {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/healthz") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ok");
      return;
    }

    if (request.method === "GET" && url.pathname === "/v2/meta") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        service: "remuxd",
        protocolVersion: "2",
        controlWebsocketPath: "/v2/control",
        terminalWebsocketPath: "/v2/terminal",
        publicBaseUrl: null,
      }));
      return;
    }

    response.writeHead(404);
    response.end();
  }

  private handleControlSocket(socket: WebSocket): void {
    socket.send(JSON.stringify({
      type: "hello",
      protocol_version: "2",
      write_lease_model: "single-active-writer",
    }));
    socket.send(JSON.stringify({
      type: "workspace_snapshot",
      summary: this.workspace,
    }));

    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString("utf8")) as FakeRuntimeV2ControlClientMessage;
      switch (message.type) {
        case "subscribe_workspace":
          socket.send(JSON.stringify({ type: "workspace_snapshot", summary: this.workspace }));
          return;
        case "split_pane": {
          if (message.pane_id !== "pane-1" || message.direction !== "vertical") {
            socket.send(JSON.stringify({ type: "command_rejected", reason: "unexpected split payload" }));
            return;
          }
          const activeSession = this.workspace.sessions[0]!;
          const activeTab = activeSession.tabs[0]!;
          const newPaneId = "pane-2";
          activeTab.activePaneId = newPaneId;
          activeTab.paneCount = 2;
          activeTab.layout = {
            type: "split",
            direction: "right",
            ratio: 50,
            children: [
              { type: "leaf", paneId: "pane-1" },
              { type: "leaf", paneId: newPaneId },
            ],
          };
          activeTab.panes = [
            { paneId: "pane-1", isActive: false, isZoomed: false, leaseHolderClientId: null },
            { paneId: newPaneId, isActive: true, isZoomed: false, leaseHolderClientId: "terminal-client-2" },
          ];
          this.workspace = {
            ...this.workspace,
            paneId: newPaneId,
            activePaneId: newPaneId,
            paneCount: 2,
            layout: activeTab.layout,
            leaseHolderClientId: "terminal-client-2",
            sessions: [
              {
                ...activeSession,
                tabs: [activeTab],
              },
            ],
          };
          socket.send(JSON.stringify({ type: "workspace_snapshot", summary: this.workspace }));
          return;
        }
        case "request_inspect": {
          const paneId = message.scope.type === "pane"
            ? message.scope.pane_id
            : this.workspace.activePaneId ?? this.workspace.paneId;
          const snapshot: RuntimeV2InspectSnapshot = {
            scope: { type: "pane", paneId },
            precision: paneId === "pane-2" ? "approximate" : "precise",
            summary: paneId,
            previewText: (this.paneContent.get(paneId) ?? "").trim(),
            visibleRows: [(this.paneContent.get(paneId) ?? "").trim()],
            byteCount: (this.paneContent.get(paneId) ?? "").length,
            size: { cols: 120, rows: 40 },
          };
          socket.send(JSON.stringify({ type: "inspect_snapshot", snapshot }));
          return;
        }
        default:
          socket.send(JSON.stringify({ type: "workspace_snapshot", summary: this.workspace }));
      }
    });
  }

  private handleTerminalSocket(socket: WebSocket): void {
    let attachedPaneId = "pane-1";
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString("utf8")) as FakeRuntimeV2TerminalClientMessage;
      switch (message.type) {
        case "attach":
          attachedPaneId = message.pane_id;
          socket.send(JSON.stringify({
            type: "hello",
            protocol_version: "2",
            pane_id: attachedPaneId,
          }));
          socket.send(JSON.stringify({
            type: "snapshot",
            size: message.size,
            sequence: 1,
            content_base64: encodeBase64(this.paneContent.get(attachedPaneId) ?? ""),
          }));
          socket.send(JSON.stringify({
            type: "lease_state",
            client_id: "terminal-client-1",
          }));
          return;
        case "input": {
          const chunk = Buffer.from(message.data_base64, "base64").toString("utf8");
          const next = `${this.paneContent.get(attachedPaneId) ?? ""}${chunk}`;
          this.paneContent.set(attachedPaneId, next);
          socket.send(JSON.stringify({
            type: "stream",
            sequence: 2,
            chunk_base64: encodeBase64(chunk),
          }));
          return;
        }
        case "resize":
          socket.send(JSON.stringify({ type: "resize_confirmed", size: message.size }));
          return;
        case "request_snapshot":
          socket.send(JSON.stringify({
            type: "snapshot",
            size: { cols: 120, rows: 40 },
            sequence: 3,
            contentBase64: encodeBase64(this.paneContent.get(attachedPaneId) ?? ""),
          }));
      }
    });
  }
}

describe("runtime v2 gateway server", () => {
  let upstream: FakeRuntimeV2Server;
  let server: RunningServer;
  let baseUrl: string;
  let baseWsUrl: string;

  beforeEach(async () => {
    upstream = new FakeRuntimeV2Server();
    const upstreamBaseUrl = await upstream.start();
    server = createRemuxV2GatewayServer(buildConfig("test-token"), {
      authService: new AuthService({ token: "test-token" }),
      logger: silentLogger,
      upstreamBaseUrl,
    });
    await server.start();
    const address = server.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    baseWsUrl = `ws://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await server.stop();
    await upstream.stop();
  });

  test("bridges auth, workspace snapshots, inspect, and terminal retargeting", async () => {
    const control = await openSocket(`${baseWsUrl}/ws/control`);
    const authOkPromise = waitForMessage<{ type: "auth_ok"; clientId: string }>(
      control,
      (message) => message.type === "auth_ok",
    );
    const attachedPromise = waitForMessage<{ type: "attached"; session: string }>(
      control,
      (message) => message.type === "attached",
    );
    const workspaceStatePromise = waitForMessage<{
      type: "workspace_state";
      workspace: { sessions: Array<{ name: string; tabs: Array<{ panes: Array<{ id: string }> }> }> };
    }>(control, (message) => message.type === "workspace_state");

    control.send(JSON.stringify({ type: "auth", token: "test-token" }));

    const authOk = await authOkPromise;
    const attached = await attachedPromise;
    const workspaceState = await workspaceStatePromise;

    expect(attached.session).toBe("main");
    expect(workspaceState.workspace.sessions[0]?.name).toBe("main");
    expect(workspaceState.workspace.sessions[0]?.tabs[0]?.panes[0]?.id).toBe("pane-1");

    const terminal = new WebSocket(`${baseWsUrl}/ws/terminal`);
    await waitForOpen(terminal);
    terminal.send(JSON.stringify({
      type: "auth",
      token: "test-token",
      clientId: authOk.clientId,
      cols: 120,
      rows: 40,
    }));

    expect(await waitForRawMessage(terminal)).toContain("PANE_ONE_READY");

    control.send(JSON.stringify({
      type: "capture_tab_history",
      session: "main",
      tabIndex: 0,
      lines: 128,
    }));

    const tabHistory = await waitForMessage<{
      type: "tab_history";
      panes: Array<{ paneId: string; text: string }>;
    }>(control, (message) => message.type === "tab_history");
    expect(tabHistory.panes[0]).toMatchObject({
      paneId: "pane-1",
      text: "PANE_ONE_READY",
    });

    control.send(JSON.stringify({
      type: "split_pane",
      paneId: "pane-1",
      direction: "right",
    }));

    const updatedWorkspace = await waitForMessage<{
      type: "workspace_state";
      workspace: { sessions: Array<{ tabs: Array<{ panes: Array<{ id: string; active: boolean }> }> }> };
    }>(control, (message) => message.type === "workspace_state" && message.workspace.sessions[0]?.tabs[0]?.panes.length === 2);
    expect(updatedWorkspace.workspace.sessions[0]?.tabs[0]?.panes[1]).toMatchObject({
      id: "pane-2",
      active: true,
    });

    const switchedTerminalSnapshot = await waitForRawMessage(terminal);
    expect(switchedTerminalSnapshot).toContain("PANE_TWO_READY");

    terminal.send("echo hi\r");
    expect(await waitForRawMessage(terminal)).toContain("echo hi\r");

    terminal.close();
    control.close();
  });

  test("serves runtime-v2 config metadata without backend switching", async () => {
    const response = await fetch(`${baseUrl}/api/config`);
    expect(response.status).toBe(200);
    const config = await response.json() as {
      passwordRequired: boolean;
      scrollbackLines: number;
      runtimeMode: string;
      backendKind?: string;
    };

    expect(config.passwordRequired).toBe(false);
    expect(config.scrollbackLines).toBe(1000);
    expect(config.runtimeMode).toBe("runtime-v2");
    expect(config.backendKind).toBe("runtime-v2");
  });
});

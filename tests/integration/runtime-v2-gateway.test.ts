import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { WebSocket, type RawData } from "ws";
import { AuthService } from "../../src/backend/auth/auth-service.js";
import type { RuntimeConfig } from "../../src/backend/config.js";
import {
  createRemuxV2GatewayServer,
  type RunningServer,
} from "../../src/backend/server-v2.js";
import { FakeRuntimeV2Server } from "../harness/fakeRuntimeV2Server.js";
import { openSocket, waitForMessage } from "../harness/ws.js";

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
    let terminal: WebSocket | null = null;
    try {
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

      terminal = await openSocket(`${baseWsUrl}/ws/terminal`);
      const initialSnapshotPromise = waitForRawMessage(terminal);
      terminal.send(JSON.stringify({
        type: "auth",
        token: "test-token",
        clientId: authOk.clientId,
        cols: 120,
        rows: 40,
      }));

      expect(await initialSnapshotPromise).toContain("PANE_ONE_READY");

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

      const switchedTerminalSnapshotPromise = waitForRawMessage(terminal);
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

      const switchedTerminalSnapshot = await switchedTerminalSnapshotPromise;
      expect(switchedTerminalSnapshot).toContain("PANE_TWO_READY");

      const echoedInputPromise = waitForRawMessage(terminal);
      terminal.send("echo hi\r");
      expect(await echoedInputPromise).toContain("echo hi\r");
    } finally {
      terminal?.close();
      control.close();
    }
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

  test("rejects invalid control auth and keeps backend switching disabled", async () => {
    const control = await openSocket(`${baseWsUrl}/ws/control`);
    try {
      control.send(JSON.stringify({ type: "auth", token: "bad-token" }));
      const authError = await waitForMessage<{ type: "auth_error"; reason?: string }>(
        control,
        (message) => message.type === "auth_error",
      );
      expect(authError.reason).toContain("invalid token");
    } finally {
      control.close();
    }

    const unauthorized = await fetch(`${baseUrl}/api/switch-backend`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ backend: "tmux" }),
    });
    expect(unauthorized.status).toBe(401);

    const disabled = await fetch(`${baseUrl}/api/switch-backend`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ backend: "tmux" }),
    });
    expect(disabled.status).toBe(501);
    await expect(disabled.json()).resolves.toEqual({
      ok: false,
      error: "runtime-v2 backend switching is not supported",
    });
  });
});

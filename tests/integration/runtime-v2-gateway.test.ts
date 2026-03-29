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

const waitForTerminalFrame = (
  socket: WebSocket,
  timeoutMs = 3_000
): Promise<{ isBinary: boolean; text: string }> =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for terminal frame")), timeoutMs);
    const handler = (raw: RawData, isBinary: boolean) => {
      clearTimeout(timeout);
      socket.off("message", handler);
      resolve({
        isBinary,
        text: raw.toString("utf8"),
      });
    };
    socket.on("message", handler);
  });

const waitForRawMessage = async (socket: WebSocket, timeoutMs = 3_000): Promise<string> =>
  (await waitForTerminalFrame(socket, timeoutMs)).text;

const authControlClient = async (
  baseWsUrl: string,
): Promise<{ control: WebSocket; clientId: string }> => {
  const control = await openSocket(`${baseWsUrl}/ws/control`);
  const authOkPromise = waitForMessage<{ type: "auth_ok"; clientId: string }>(
    control,
    (message) => message.type === "auth_ok",
  );
  control.send(JSON.stringify({ type: "auth", token: "test-token" }));
  const authOk = await authOkPromise;
  await waitForMessage(control, (message: { type: string }) => message.type === "attached");
  await waitForMessage(control, (message: { type: string }) => message.type === "workspace_state");
  return { control, clientId: authOk.clientId };
};

const authTerminalClient = async (
  baseWsUrl: string,
  clientId: string,
  size: { cols: number; rows: number },
): Promise<{ terminal: WebSocket; initialSnapshot: string }> => {
  const terminal = await openSocket(`${baseWsUrl}/ws/terminal`);
  const initialSnapshotPromise = waitForRawMessage(terminal);
  terminal.send(JSON.stringify({
    type: "auth",
    token: "test-token",
    clientId,
    cols: size.cols,
    rows: size.rows,
  }));
  const initialSnapshot = await initialSnapshotPromise;
  return { terminal, initialSnapshot };
};

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

  test("shares one upstream pane bridge across multiple browser viewers without shrinking to the latest narrow viewport", async () => {
    const first = await authControlClient(baseWsUrl);
    const second = await authControlClient(baseWsUrl);
    let terminalA: WebSocket | null = null;
    let terminalB: WebSocket | null = null;

    try {
      ({ terminal: terminalA } = await authTerminalClient(baseWsUrl, first.clientId, { cols: 120, rows: 40 }));
      ({ terminal: terminalB } = await authTerminalClient(baseWsUrl, second.clientId, { cols: 48, rows: 18 }));

      await expect.poll(() => upstream.latestTerminal("pane-1")?.attachCount ?? 0).toBe(1);
      await expect.poll(() => upstream.latestTerminal("pane-1")?.sizes.at(-1)).toEqual({ cols: 120, rows: 40 });

      const firstViewerEcho = waitForRawMessage(terminalA);
      const secondViewerEcho = waitForRawMessage(terminalB);
      terminalB.send("echo shared-view\r");

      expect(await firstViewerEcho).toContain("echo shared-view\r");
      expect(await secondViewerEcho).toContain("echo shared-view\r");
      expect(upstream.latestTerminal("pane-1")?.writes.at(-1)).toBe("echo shared-view\r");
    } finally {
      terminalA?.close();
      terminalB?.close();
      first.control.close();
      second.control.close();
    }
  });

  test("bridges terminal live data as binary frames and writes raw binary upstream", async () => {
    upstream.setTerminalStreamTransport("binary");

    const { control, clientId } = await authControlClient(baseWsUrl);
    let terminal: WebSocket | null = null;

    try {
      ({ terminal } = await authTerminalClient(baseWsUrl, clientId, { cols: 120, rows: 40 }));

      const echoedFramePromise = waitForTerminalFrame(terminal);
      terminal.send(Buffer.from("echo binary\r", "utf8"));

      const echoedFrame = await echoedFramePromise;
      expect(echoedFrame.isBinary).toBe(true);
      expect(echoedFrame.text).toContain("echo binary\r");
      await expect.poll(() => upstream.latestTerminal("pane-1")?.inputFrameTypes.at(-1)).toBe("binary");
      expect(upstream.latestTerminal("pane-1")?.writes.at(-1)).toBe("echo binary\r");
    } finally {
      terminal?.close();
      control.close();
    }
  });

  test("debounces repeated resize bursts down to one upstream snapshot request", async () => {
    const { control, clientId } = await authControlClient(baseWsUrl);
    let terminal: WebSocket | null = null;

    try {
      ({ terminal } = await authTerminalClient(baseWsUrl, clientId, { cols: 120, rows: 40 }));

      terminal.send(JSON.stringify({ type: "resize", cols: 100, rows: 30 }));
      terminal.send(JSON.stringify({ type: "resize", cols: 110, rows: 30 }));
      terminal.send(JSON.stringify({ type: "resize", cols: 132, rows: 30 }));

      await expect.poll(() => upstream.latestTerminal("pane-1")?.sizes.at(-1)).toEqual({ cols: 132, rows: 30 });
      await expect.poll(() => upstream.latestTerminal("pane-1")?.requestSnapshotCount ?? 0).toBe(1);
    } finally {
      terminal?.close();
      control.close();
    }
  });

  test("serves runtime-v2 config metadata", async () => {
    const response = await fetch(`${baseUrl}/api/config`);
    expect(response.status).toBe(200);
    const config = await response.json() as {
      passwordRequired: boolean;
      scrollbackLines: number;
      runtimeMode: string;
      backendKind?: string;
      localWebSocketOrigin?: string;
    };

    expect(config.passwordRequired).toBe(false);
    expect(config.scrollbackLines).toBe(1000);
    expect(config.runtimeMode).toBe("runtime-v2");
    expect(config.backendKind).toBe("runtime-v2");
    expect(config.localWebSocketOrigin).toBeUndefined();
  });

  test("answers control ping messages and ignores terminal keepalive frames", async () => {
    const control = await openSocket(`${baseWsUrl}/ws/control`);
    let terminal: WebSocket | null = null;
    try {
      const authOkPromise = waitForMessage<{ type: "auth_ok"; clientId: string }>(
        control,
        (message) => message.type === "auth_ok",
      );
      control.send(JSON.stringify({ type: "auth", token: "test-token" }));
      const authOk = await authOkPromise;

      control.send(JSON.stringify({ type: "ping", timestamp: 123 }));
      const pong = await waitForMessage<{ type: "pong"; timestamp: number }>(
        control,
        (message) => message.type === "pong",
      );
      expect(pong).toEqual({ type: "pong", timestamp: 123 });

      terminal = await openSocket(`${baseWsUrl}/ws/terminal`);
      terminal.send(JSON.stringify({
        type: "auth",
        token: "test-token",
        clientId: authOk.clientId,
        cols: 120,
        rows: 40,
      }));
      await waitForRawMessage(terminal);

      terminal.send(JSON.stringify({ type: "ping" }));
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(upstream.latestTerminal("pane-1")?.writes).toEqual([]);
    } finally {
      terminal?.close();
      control.close();
    }
  });

  test("send_compose uses safe delayed submit mode through the runtime terminal bridge", async () => {
    const control = await openSocket(`${baseWsUrl}/ws/control`);
    let terminal: WebSocket | null = null;
    try {
      const authOkPromise = waitForMessage<{ type: "auth_ok"; clientId: string }>(
        control,
        (message) => message.type === "auth_ok",
      );
      control.send(JSON.stringify({ type: "auth", token: "test-token" }));
      const authOk = await authOkPromise;

      terminal = await openSocket(`${baseWsUrl}/ws/terminal`);
      terminal.send(JSON.stringify({
        type: "auth",
        token: "test-token",
        clientId: authOk.clientId,
        cols: 120,
        rows: 40,
      }));
      await waitForRawMessage(terminal);

      control.send(JSON.stringify({ type: "send_compose", text: "echo hi" }));

      await expect.poll(() => upstream.latestTerminal("pane-1")?.writes).toEqual(["echo hi", "\r"]);
    } finally {
      terminal?.close();
      control.close();
    }
  });

  test("send_compose serializes repeated submissions so commands stay separated", async () => {
    const control = await openSocket(`${baseWsUrl}/ws/control`);
    let terminal: WebSocket | null = null;
    try {
      const authOkPromise = waitForMessage<{ type: "auth_ok"; clientId: string }>(
        control,
        (message) => message.type === "auth_ok",
      );
      control.send(JSON.stringify({ type: "auth", token: "test-token" }));
      const authOk = await authOkPromise;

      terminal = await openSocket(`${baseWsUrl}/ws/terminal`);
      terminal.send(JSON.stringify({
        type: "auth",
        token: "test-token",
        clientId: authOk.clientId,
        cols: 120,
        rows: 40,
      }));
      await waitForRawMessage(terminal);

      control.send(JSON.stringify({ type: "send_compose", text: "echo first" }));
      control.send(JSON.stringify({ type: "send_compose", text: "echo second" }));

      await expect.poll(() => upstream.latestTerminal("pane-1")?.writes).toEqual([
        "echo first",
        "\r",
        "echo second",
        "\r",
      ]);
    } finally {
      terminal?.close();
      control.close();
    }
  });

  test("rejects invalid control auth", async () => {
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
  });

  test("replays persisted scrollback on attach and exposes it through inspect history", async () => {
    upstream.setPaneScrollback("pane-1", [
      "history line 1",
      "history line 2",
      "history line 3",
    ]);
    upstream.setPaneContent("pane-1", "live line 4\r\n");

    const control = await openSocket(`${baseWsUrl}/ws/control`);
    let terminal: WebSocket | null = null;
    try {
      const authOkPromise = waitForMessage<{ type: "auth_ok"; clientId: string }>(
        control,
        (message) => message.type === "auth_ok",
      );
      control.send(JSON.stringify({ type: "auth", token: "test-token" }));
      const authOk = await authOkPromise;

      terminal = await openSocket(`${baseWsUrl}/ws/terminal`);
      const initialSnapshotPromise = waitForRawMessage(terminal);
      terminal.send(JSON.stringify({
        type: "auth",
        token: "test-token",
        clientId: authOk.clientId,
        cols: 120,
        rows: 40,
      }));

      const initialSnapshot = await initialSnapshotPromise;
      expect(initialSnapshot).toContain("history line 1");
      expect(initialSnapshot).toContain("history line 3");
      expect(initialSnapshot).toContain("live line 4");

      control.send(JSON.stringify({
        type: "capture_tab_history",
        session: "main",
        tabIndex: 0,
        lines: 64,
      }));

      const tabHistory = await waitForMessage<{
        type: "tab_history";
        panes: Array<{ paneId: string; text: string }>;
      }>(control, (message) => message.type === "tab_history");

      expect(tabHistory.panes[0]).toMatchObject({
        paneId: "pane-1",
        text: "history line 1\nhistory line 2\nhistory line 3\nlive line 4",
      });
    } finally {
      terminal?.close();
      control.close();
    }
  });
});

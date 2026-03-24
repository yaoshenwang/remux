import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import { AuthService } from "../../src/backend/auth/auth-service.js";
import type { RuntimeConfig } from "../../src/backend/config.js";
import { createRemuxServer, type RunningServer } from "../../src/backend/server.js";
import { FakePtyFactory } from "../harness/fakePty.js";
import { FakeSessionGateway } from "../harness/fakeTmux.js";
import { openSocket, waitForMessage } from "../harness/ws.js";

const buildConfig = (token: string): RuntimeConfig => ({
  port: 0,
  host: "127.0.0.1",
  password: undefined,
  tunnel: false,
  defaultSession: "main",
  scrollbackLines: 1000,
  pollIntervalMs: 100,
  token,
  frontendDir: process.cwd()
});

describe("zellij backend server", () => {
  let runningServer: RunningServer;
  let gateway: FakeSessionGateway;
  let ptyFactory: FakePtyFactory;
  let baseWsUrl: string;

  const authControl = async (
    control: WebSocket,
    token: string = "test-token"
  ): Promise<{ clientId: string; attachedSession: string }> => {
    const authOkPromise = waitForMessage<{ type: string; clientId: string }>(
      control,
      (msg) => msg.type === "auth_ok"
    );
    const attachedPromise = waitForMessage<{ type: string; session: string }>(
      control,
      (msg) => msg.type === "attached"
    );
    control.send(JSON.stringify({ type: "auth", token }));
    const authOk = await authOkPromise;
    const attached = await attachedPromise;
    return { clientId: authOk.clientId, attachedSession: attached.session };
  };

  beforeEach(async () => {
    gateway = new FakeSessionGateway(["main"], { attachedSession: "main" });
    ptyFactory = new FakePtyFactory();
    const authService = new AuthService({ token: "test-token" });
    const config = buildConfig("test-token");

    runningServer = createRemuxServer(config, {
      tmux: gateway,
      ptyFactory,
      backendKind: "zellij",
      authService,
      logger: { log: () => {}, error: () => {} }
    });
    await runningServer.start();
    const port = (runningServer.server.address() as AddressInfo).port;
    baseWsUrl = `ws://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await runningServer.stop();
  });

  test("does NOT create grouped session on connect", async () => {
    const control = await openSocket(`${baseWsUrl}/ws/control`);
    try {
      await authControl(control);
      const groupCalls = gateway.calls.filter((c) =>
        c.startsWith("createGroupedSession")
      );
      expect(groupCalls).toHaveLength(0);
    } finally {
      control.close();
    }
  });

  test("attaches PTY with session:paneId format", async () => {
    const control = await openSocket(`${baseWsUrl}/ws/control`);
    try {
      await authControl(control);
      expect(ptyFactory.lastSpawnedSession).toMatch(/^main:/);
    } finally {
      control.close();
    }
  });

  test("does NOT kill session on disconnect", async () => {
    const control = await openSocket(`${baseWsUrl}/ws/control`);
    await authControl(control);
    const callsBefore = gateway.calls.length;
    control.close();
    await new Promise((r) => setTimeout(r, 200));
    const killCalls = gateway.calls
      .slice(callsBefore)
      .filter((c) => c.startsWith("killSession"));
    expect(killCalls).toHaveLength(0);
  });

  test("select_window updates virtual view and re-attaches PTY", async () => {
    await gateway.newWindow("main");
    const p0 = await gateway.listPanes("main", 0);

    const control = await openSocket(`${baseWsUrl}/ws/control`);
    try {
      await authControl(control);
      const processCountBefore = ptyFactory.processes.length;

      // Wait for state reflecting window 0 as active (virtual view updated)
      const statePromise = waitForMessage<{
        type: string;
        state: { sessions: Array<{ windowStates: Array<{ index: number; active: boolean }> }> };
      }>(control, (msg) => {
        if (msg.type !== "tmux_state") return false;
        const ws = msg.state?.sessions?.[0]?.windowStates;
        return ws?.some((w: { index: number; active: boolean }) => w.index === 0 && w.active) ?? false;
      });
      control.send(
        JSON.stringify({ type: "select_window", session: "main", windowIndex: 0 })
      );
      await statePromise;

      // A new PTY process should have been spawned for window 0's pane
      expect(ptyFactory.processes.length).toBe(processCountBefore + 1);
      expect(ptyFactory.lastSpawnedSession).toContain(p0[0].id);
    } finally {
      control.close();
    }
  });

  test("select_pane updates virtual view and re-attaches PTY", async () => {
    // Get the first pane ID from the gateway, then split to get a second
    const initialPanes = await gateway.listPanes("main", 0);
    const firstPaneId = initialPanes[0].id;
    await gateway.splitWindow(firstPaneId, "h");
    const panes = await gateway.listPanes("main", 0);
    const secondPane = panes[1];
    expect(secondPane).toBeDefined();

    const control = await openSocket(`${baseWsUrl}/ws/control`);
    try {
      await authControl(control);

      const statePromise = waitForMessage<{ type: string }>(
        control,
        (msg) => msg.type === "tmux_state"
      );
      control.send(
        JSON.stringify({ type: "select_pane", paneId: secondPane.id })
      );
      await statePromise;

      expect(ptyFactory.lastSpawnedSession).toContain(secondPane.id);
    } finally {
      control.close();
    }
  });

  test("tmux_state reflects virtual view active flags", async () => {
    // newWindow makes window 1 active (initial attach picks window 1)
    // Select window 0 to change the virtual view
    await gateway.newWindow("main");
    const control = await openSocket(`${baseWsUrl}/ws/control`);
    try {
      await authControl(control);

      control.send(
        JSON.stringify({ type: "select_window", session: "main", windowIndex: 0 })
      );

      const state = await waitForMessage<{
        type: string;
        state: { sessions: Array<{ windowStates: Array<{ index: number; active: boolean }> }> };
      }>(control, (msg) => {
        if (msg.type !== "tmux_state") return false;
        const ws = msg.state?.sessions?.[0]?.windowStates;
        return ws?.some((w: { index: number; active: boolean }) => w.index === 0 && w.active) ?? false;
      });

      const windows = state.state.sessions[0].windowStates;
      const w0 = windows.find((w) => w.index === 0);
      const w1 = windows.find((w) => w.index === 1);
      expect(w0?.active).toBe(true);
      expect(w1?.active).toBe(false);
    } finally {
      control.close();
    }
  });
});

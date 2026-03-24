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

/**
 * A zellij-style fake: no createGroupedSession, no switchClient.
 * We create a wrapper that delegates to FakeSessionGateway but omits optional methods.
 */
function createFakeZellijGateway(
  sessions: string[],
  options?: { attachedSession?: string }
): FakeSessionGateway & { readonly kind: "zellij" } {
  const base = new FakeSessionGateway(sessions, options);
  // Create a proxy that hides createGroupedSession and switchClient
  return Object.create(base, {
    kind: { value: "zellij" as const, writable: false },
    capabilities: {
      value: {
        supportsPaneFocusById: true,
        supportsTabRename: true,
        supportsSessionRename: true,
        supportsPreciseScrollback: false,
        supportsFloatingPanes: true,
        supportsFullscreenPane: true,
      },
      writable: false
    },
    createGroupedSession: { value: undefined, writable: false },
    switchClient: { value: undefined, writable: false },
  }) as FakeSessionGateway & { readonly kind: "zellij" };
}

describe("zellij backend server", () => {
  let runningServer: RunningServer;
  let gateway: FakeSessionGateway & { readonly kind: "zellij" };
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
    gateway = createFakeZellijGateway(["main"], { attachedSession: "main" });
    ptyFactory = new FakePtyFactory();
    const authService = new AuthService({ token: "test-token" });
    const config = buildConfig("test-token");

    runningServer = createRemuxServer(config, {
      backend: gateway,
      ptyFactory,
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

  test("select_tab updates view and re-attaches PTY", async () => {
    await gateway.newTab("main");
    const p0 = await gateway.listPanes("main", 0);

    const control = await openSocket(`${baseWsUrl}/ws/control`);
    try {
      await authControl(control);
      const processCountBefore = ptyFactory.processes.length;

      // Wait for state reflecting tab 0 as active (view updated)
      const statePromise = waitForMessage<{
        type: string;
        workspace: { sessions: Array<{ tabs: Array<{ index: number; active: boolean }> }> };
      }>(control, (msg) => {
        if (msg.type !== "workspace_state") return false;
        const ts = msg.workspace?.sessions?.[0]?.tabs;
        return ts?.some((t: { index: number; active: boolean }) => t.index === 0 && t.active) ?? false;
      });
      control.send(
        JSON.stringify({ type: "select_tab", session: "main", tabIndex: 0 })
      );
      await statePromise;

      // A new PTY process should have been spawned for tab 0's pane
      expect(ptyFactory.processes.length).toBe(processCountBefore + 1);
      expect(ptyFactory.lastSpawnedSession).toContain(p0[0].id);
    } finally {
      control.close();
    }
  });

  test("select_pane updates view and re-attaches PTY", async () => {
    // Get the first pane ID from the gateway, then split to get a second
    const initialPanes = await gateway.listPanes("main", 0);
    const firstPaneId = initialPanes[0].id;
    await gateway.splitPane(firstPaneId, "right");
    const panes = await gateway.listPanes("main", 0);
    const secondPane = panes[1];
    expect(secondPane).toBeDefined();

    const control = await openSocket(`${baseWsUrl}/ws/control`);
    try {
      await authControl(control);

      const statePromise = waitForMessage<{ type: string }>(
        control,
        (msg) => msg.type === "workspace_state"
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

  test("workspace_state reflects view active flags", async () => {
    // newTab makes tab 1 active (initial attach picks tab 1)
    // Select tab 0 to change the view
    await gateway.newTab("main");
    const control = await openSocket(`${baseWsUrl}/ws/control`);
    try {
      await authControl(control);

      control.send(
        JSON.stringify({ type: "select_tab", session: "main", tabIndex: 0 })
      );

      const state = await waitForMessage<{
        type: string;
        workspace: { sessions: Array<{ tabs: Array<{ index: number; active: boolean }> }> };
      }>(control, (msg) => {
        if (msg.type !== "workspace_state") return false;
        const ts = msg.workspace?.sessions?.[0]?.tabs;
        return ts?.some((t: { index: number; active: boolean }) => t.index === 0 && t.active) ?? false;
      });

      const tabs = state.workspace.sessions[0].tabs;
      const t0 = tabs.find((t) => t.index === 0);
      const t1 = tabs.find((t) => t.index === 1);
      expect(t0?.active).toBe(true);
      expect(t1?.active).toBe(false);
    } finally {
      control.close();
    }
  });
});

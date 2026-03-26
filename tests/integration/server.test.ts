import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { WebSocket, type RawData } from "ws";
import { AdapterRegistry } from "../../src/backend/adapters/registry.js";
import { createGenericShellAdapter } from "../../src/backend/adapters/generic-shell-adapter.js";
import { AuthService } from "../../src/backend/auth/auth-service.js";
import type { RuntimeConfig } from "../../src/backend/config.js";
import { DeviceIdentityStore } from "../../src/backend/device/identity-store.js";
import { PairingService } from "../../src/backend/device/pairing-service.js";
import { createRemuxServer, type RunningServer } from "../../src/backend/server.js";
import { SemanticEventBroadcaster } from "../../src/backend/server/semantic-event-transport.js";
import { buildSnapshot } from "../../src/backend/multiplexer/types.js";
import { FakePtyFactory } from "../harness/fakePty.js";
import { FakeSessionGateway } from "../harness/fakeTmux.js";
import { connectNativeControlClient } from "../harness/nativeClient.js";
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

describe("tmux mobile server", () => {
  let runningServer: RunningServer;
  let tmux: FakeSessionGateway;
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

  const waitForTmuxCall = async (
    predicate: (call: string) => boolean,
    timeoutMs = 1_000
  ): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (tmux.calls.some(predicate)) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("timed out waiting for expected tmux call");
  };

  const startWithSessions = async (
    sessions: string[],
    options: { password?: string; attachedSession?: string; failSwitchClient?: boolean } = {}
  ): Promise<void> => {
    tmux = new FakeSessionGateway(sessions, {
      attachedSession: options.attachedSession,
      failSwitchClient: options.failSwitchClient
    });
    ptyFactory = new FakePtyFactory();
    const auth = new AuthService({ password: options.password, token: "test-token" });

    runningServer = createRemuxServer(buildConfig("test-token"), {
      backend: tmux,
      ptyFactory,
      authService: auth,
      logger: { log: () => undefined, error: () => undefined }
    });

    await runningServer.start();
    const address = runningServer.server.address() as AddressInfo;
    baseWsUrl = `ws://127.0.0.1:${address.port}`;
  };

  beforeEach(async () => {
    await startWithSessions([]);
  });

  afterEach(async () => {
    await runningServer.stop();
  });

  test("rejects invalid token", async () => {
    const control = await openSocket(`${baseWsUrl}/ws/control`);
    control.send(JSON.stringify({ type: "auth", token: "bad-token" }));

    const response = await waitForMessage<{ type: string; reason?: string }>(
      control,
      (msg) => msg.type === "auth_error"
    );
    expect(response.reason).toContain("invalid token");

    control.close();
  });

  test("auth_ok reports wired native and semantic capabilities", async () => {
    await runningServer.stop();

    tmux = new FakeSessionGateway(["main"]);
    ptyFactory = new FakePtyFactory();
    const auth = new AuthService({ token: "test-token" });
    const registry = new AdapterRegistry();
    registry.register(createGenericShellAdapter());

    runningServer = createRemuxServer(buildConfig("test-token"), {
      backend: tmux,
      ptyFactory,
      authService: auth,
      logger: { log: () => undefined, error: () => undefined },
      notificationTransport: {
        supportsPushNotifications: () => true,
      },
      device: {
        identityStore: new DeviceIdentityStore(),
        pairingService: new PairingService(),
      },
      adapterRegistry: registry,
      semanticTransport: new SemanticEventBroadcaster(),
    });

    await runningServer.start();
    const address = runningServer.server.address() as AddressInfo;
    baseWsUrl = `ws://127.0.0.1:${address.port}`;

    const { control, authOk } = await connectNativeControlClient({
      baseWsUrl,
      token: "test-token",
    });
    const authMessage = authOk as {
      serverCapabilities: {
        notifications: { supportsPushNotifications: boolean };
        transport: {
          supportsTrustedReconnect: boolean;
          supportsPairingBootstrap: boolean;
          supportsDeviceIdentity: boolean;
        };
        semantic: {
          adaptersAvailable: string[];
          supportsEventStream: boolean;
        };
      };
    };

    expect(authMessage.serverCapabilities.notifications.supportsPushNotifications).toBe(true);
    expect(authMessage.serverCapabilities.transport.supportsTrustedReconnect).toBe(false);
    expect(authMessage.serverCapabilities.transport.supportsPairingBootstrap).toBe(true);
    expect(authMessage.serverCapabilities.transport.supportsDeviceIdentity).toBe(true);
    expect(authMessage.serverCapabilities.semantic.adaptersAvailable).toEqual(["generic-shell"]);
    expect(authMessage.serverCapabilities.semantic.supportsEventStream).toBe(true);

    control.close();
  });

  test("native harness receives workspace_state after auth", async () => {
    await runningServer.stop();
    await startWithSessions(["main"]);

    const { control } = await connectNativeControlClient({
      baseWsUrl,
      token: "test-token",
    });

    const workspaceState = await waitForMessage<{
      type: "workspace_state";
      workspace: { sessions: Array<{ name: string }> };
      clientView: { sessionName: string };
    }>(control, (message) => message.type === "workspace_state");

    expect(workspaceState.workspace.sessions[0]?.name).toBe("main");
    expect(workspaceState.clientView.sessionName).toBe("main");

    control.close();
  });

  test("creates default session and attaches when no sessions exist", async () => {
    const control = await openSocket(`${baseWsUrl}/ws/control`);
    const { attachedSession } = await authControl(control);

    expect(attachedSession).toBe("main");
    expect(tmux.calls).toContain("createSession:main");
    expect(tmux.calls.some((c) => c.startsWith("createGroupedSession:") && c.endsWith(":main"))).toBe(true);
    expect(ptyFactory.lastSpawnedSession).toMatch(/^remux-client-/);

    control.close();
  });

  test("shows session picker when multiple sessions exist", async () => {
    await runningServer.stop();
    await startWithSessions(["work", "dev"]);

    const control = await openSocket(`${baseWsUrl}/ws/control`);
    control.send(JSON.stringify({ type: "auth", token: "test-token" }));

    const picker = await waitForMessage<{ type: string; sessions: Array<{ name: string }> }>(
      control,
      (msg) => msg.type === "session_picker"
    );

    expect(picker.sessions).toHaveLength(2);
    control.close();
  });

  test("shows session picker even when one session is currently attached", async () => {
    await runningServer.stop();
    await startWithSessions(["main", "work"], { attachedSession: "work" });

    const control = await openSocket(`${baseWsUrl}/ws/control`);
    control.send(JSON.stringify({ type: "auth", token: "test-token" }));

    const picker = await waitForMessage<{ type: string; sessions: Array<{ name: string }> }>(
      control,
      (msg) => msg.type === "session_picker"
    );

    expect(picker.sessions).toHaveLength(2);
    expect(ptyFactory.lastSpawnedSession).toBeUndefined();
    control.close();
  });

  test("select_session attaches without using switch-client", async () => {
    await runningServer.stop();
    await startWithSessions(["work", "dev"], { failSwitchClient: true });

    const control = await openSocket(`${baseWsUrl}/ws/control`);
    control.send(JSON.stringify({ type: "auth", token: "test-token" }));
    await waitForMessage(control, (msg: { type: string }) => msg.type === "session_picker");

    control.send(JSON.stringify({ type: "select_session", session: "dev" }));
    const attached = await waitForMessage<{ type: string; session: string }>(
      control,
      (msg) => msg.type === "attached"
    );

    expect(attached.session).toBe("dev");
    expect(tmux.calls.some((c) => c.startsWith("createGroupedSession:") && c.endsWith(":dev"))).toBe(true);
    expect(ptyFactory.lastSpawnedSession).toMatch(/^remux-client-/);
    expect(tmux.calls.some((call) => call.startsWith("switchClient:"))).toBe(false);
    control.close();
  });

  test("initial auth applies launch session, tab, and pane hints", async () => {
    await runningServer.stop();
    await startWithSessions(["main", "work"]);

    await tmux.newTab("work");
    const workSnapshot = await buildSnapshot(tmux);
    const workTab = workSnapshot.sessions.find((session) => session.name === "work")?.tabs.find((tab) => tab.index === 1);
    const workPaneId = workTab?.panes[0]?.id ?? "";
    await tmux.splitPane(workPaneId, "right");
    const updatedSnapshot = await buildSnapshot(tmux);
    const targetPaneId = updatedSnapshot.sessions
      .find((session) => session.name === "work")
      ?.tabs.find((tab) => tab.index === 1)
      ?.panes[1]?.id ?? "";

    const control = await openSocket(`${baseWsUrl}/ws/control`);
    const authOkPromise = waitForMessage<{ type: string; clientId: string }>(
      control,
      (msg) => msg.type === "auth_ok"
    );
    const attachedPromise = waitForMessage<{ type: string; session: string }>(
      control,
      (msg) => msg.type === "attached"
    );
    const workspacePromise = waitForMessage<{
      type: string;
      clientView?: { sessionName: string; tabIndex: number; paneId: string };
    }>(
      control,
      (msg) => msg.type === "workspace_state"
        && msg.clientView?.sessionName === "work"
        && msg.clientView?.tabIndex === 1
        && msg.clientView?.paneId === targetPaneId
    );

    control.send(JSON.stringify({
      type: "auth",
      token: "test-token",
      session: "work",
      tabIndex: 1,
      paneId: targetPaneId
    }));

    await authOkPromise;
    await expect(attachedPromise).resolves.toMatchObject({ session: "work" });
    await expect(workspacePromise).resolves.toMatchObject({
      clientView: {
        sessionName: "work",
        tabIndex: 1,
        paneId: targetPaneId
      }
    });

    control.close();
  });

  test("requires terminal auth to bind to an authenticated control client", async () => {
    const control = await openSocket(`${baseWsUrl}/ws/control`);
    await authControl(control);

    const terminal = await openSocket(`${baseWsUrl}/ws/terminal`);
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      terminal.once("close", (code, reason) => resolve({ code, reason: reason.toString("utf8") }));
    });
    terminal.send(JSON.stringify({ type: "auth", token: "test-token" }));

    await expect(closed).resolves.toMatchObject({ code: 4001, reason: "unauthorized" });
    control.close();
  });

  test("isolates terminal runtime per authenticated control client", async () => {
    await runningServer.stop();
    await startWithSessions(["main"]);

    const controlA = await openSocket(`${baseWsUrl}/ws/control`);
    const authA = await authControl(controlA);
    const controlB = await openSocket(`${baseWsUrl}/ws/control`);
    const authB = await authControl(controlB);

    expect(ptyFactory.processes).toHaveLength(2);

    const terminalA = await openSocket(`${baseWsUrl}/ws/terminal`);
    terminalA.send(JSON.stringify({ type: "auth", token: "test-token", clientId: authA.clientId }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const terminalB = await openSocket(`${baseWsUrl}/ws/terminal`);
    terminalB.send(JSON.stringify({ type: "auth", token: "test-token", clientId: authB.clientId }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const fromA = new Promise<string>((resolve) => {
      terminalA.once("message", (raw: RawData) => resolve(raw.toString("utf8")));
    });
    ptyFactory.processes[0].emitData("from-a");
    await expect(fromA).resolves.toBe("from-a");

    const fromB = new Promise<string>((resolve) => {
      terminalB.once("message", (raw: RawData) => resolve(raw.toString("utf8")));
    });
    ptyFactory.processes[1].emitData("from-b");
    await expect(fromB).resolves.toBe("from-b");

    terminalA.send("input-a");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ptyFactory.processes[0].writes).toContain("input-a");
    expect(ptyFactory.processes[1].writes).not.toContain("input-a");

    terminalA.close();
    terminalB.close();
    controlA.close();
    controlB.close();
  });

  test("executes control commands and forwards terminal io", async () => {
    await runningServer.stop();
    await startWithSessions(["main"]);

    const control = await openSocket(`${baseWsUrl}/ws/control`);
    const { clientId, attachedSession } = await authControl(control);
    const snapshot = await buildSnapshot(tmux);
    const attachedState = snapshot.sessions.find((session) => session.name === attachedSession);
    expect(attachedState).toBeDefined();
    const paneId = attachedState?.tabs[0].panes[0].id ?? "";

    control.send(JSON.stringify({ type: "split_pane", paneId, direction: "right" }));
    control.send(JSON.stringify({ type: "send_compose", text: "echo hi" }));
    const capturePromise = waitForMessage<{ type: string; text: string }>(
      control,
      (msg) => msg.type === "scrollback"
    );
    control.send(JSON.stringify({ type: "capture_scrollback", paneId, lines: 222 }));

    const capture = await capturePromise;
    expect(capture.text).toContain("captured 222 lines");
    expect(tmux.calls).toContain(`splitPane:${paneId}:right`);
    expect(ptyFactory.latestProcess().writes).toContain("echo hi\r");

    const terminal = await openSocket(`${baseWsUrl}/ws/terminal`);
    terminal.send(JSON.stringify({ type: "auth", token: "test-token", clientId }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const terminalDataPromise = new Promise<string>((resolve) => {
      terminal.once("message", (raw: RawData) => resolve(raw.toString("utf8")));
    });
    ptyFactory.latestProcess().emitData("tmux-output");
    const terminalData = await terminalDataPromise;
    expect(terminalData).toBe("tmux-output");

    terminal.send("input-data");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ptyFactory.latestProcess().writes).toContain("input-data");

    terminal.close();
    control.close();
  });

  test("new_tab uses the active pane cwd in tmux mode", async () => {
    await runningServer.stop();
    await startWithSessions(["main"]);

    const control = await openSocket(`${baseWsUrl}/ws/control`);
    await authControl(control);
    const snapshot = await buildSnapshot(tmux);
    const paneId = snapshot.sessions.find((session) => session.name === "main")?.tabs[0]?.panes[0]?.id ?? "";
    tmux.setPanePath(paneId, "/Users/test/project-alpha");

    control.send(JSON.stringify({ type: "new_tab", session: "main" }));
    await waitForTmuxCall((call) => call === "newTab:main:/Users/test/project-alpha");

    control.close();
  });

  test("new_session uses the active pane cwd in tmux mode", async () => {
    await runningServer.stop();
    await startWithSessions(["main"]);

    const control = await openSocket(`${baseWsUrl}/ws/control`);
    await authControl(control);
    const snapshot = await buildSnapshot(tmux);
    const paneId = snapshot.sessions.find((session) => session.name === "main")?.tabs[0]?.panes[0]?.id ?? "";
    tmux.setPanePath(paneId, "/Users/test/project-beta");

    control.send(JSON.stringify({ type: "new_session", name: "feature-branch" }));
    await waitForTmuxCall((call) => call === "createSession:feature-branch:/Users/test/project-beta");

    control.close();
  });

  test("capture_tab_history returns pane history and timeline events", async () => {
    await runningServer.stop();
    await startWithSessions(["main"]);

    const control = await openSocket(`${baseWsUrl}/ws/control`);
    await authControl(control);
    const snapshot = await buildSnapshot(tmux);
    const mainTab = snapshot.sessions.find((session) => session.name === "main")?.tabs[0];
    const paneId = mainTab?.panes[0]?.id ?? "";

    control.send(JSON.stringify({ type: "split_pane", paneId, direction: "right" }));
    await waitForTmuxCall((call) => call === `splitPane:${paneId}:right`);

    const updatedSnapshot = await buildSnapshot(tmux);
    const updatedTab = updatedSnapshot.sessions.find((session) => session.name === "main")?.tabs[0];
    const panes = updatedTab?.panes ?? [];
    tmux.setPaneCapture(panes[0]!.id, "left history");
    tmux.setPaneCapture(panes[1]!.id, "right history");

    const historyPromise = waitForMessage<{
      type: string;
      sessionName: string;
      tabIndex: number;
      panes: Array<{ paneId: string; text: string }>;
      events: Array<{ text: string }>;
    }>(control, (msg) => msg.type === "tab_history");

    control.send(JSON.stringify({ type: "capture_tab_history", session: "main", tabIndex: 0, lines: 333 }));
    const history = await historyPromise;

    expect(history.sessionName).toBe("main");
    expect(history.tabIndex).toBe(0);
    expect(history.panes).toHaveLength(2);
    expect(history.panes.map((pane) => pane.text)).toContain("left history");
    expect(history.events.some((event) => event.text.startsWith("Pane added:"))).toBe(true);

    control.close();
  });

  test("capture_tab_history keeps archived pane content after close_pane", async () => {
    await runningServer.stop();
    await startWithSessions(["main"]);

    const control = await openSocket(`${baseWsUrl}/ws/control`);
    await authControl(control);
    const initialSnapshot = await buildSnapshot(tmux);
    const paneId = initialSnapshot.sessions.find((session) => session.name === "main")?.tabs[0]?.panes[0]?.id ?? "";

    control.send(JSON.stringify({ type: "split_pane", paneId, direction: "right" }));
    await waitForTmuxCall((call) => call === `splitPane:${paneId}:right`);

    const updatedSnapshot = await buildSnapshot(tmux);
    const panes = updatedSnapshot.sessions.find((session) => session.name === "main")?.tabs[0]?.panes ?? [];
    tmux.setPaneCapture(panes[0]!.id, "archived left pane");
    tmux.setPaneCapture(panes[1]!.id, "live right pane");

    control.send(JSON.stringify({ type: "close_pane", paneId: panes[0]!.id }));
    await waitForTmuxCall((call) => call === `closePane:${panes[0]!.id}`);

    const historyPromise = waitForMessage<{
      type: string;
      panes: Array<{ paneId: string; text: string; archived: boolean }>;
    }>(control, (msg) => msg.type === "tab_history");

    control.send(JSON.stringify({ type: "capture_tab_history", session: "main", tabIndex: 0, lines: 444 }));
    const history = await historyPromise;

    expect(history.panes.some((pane) => pane.paneId === panes[0]!.id && pane.archived && pane.text.includes("archived left pane"))).toBe(true);
    expect(history.panes.some((pane) => pane.paneId === panes[1]!.id && !pane.archived && pane.text.includes("live right pane"))).toBe(true);

    control.close();
  });

  test("select_tab reflects per-client active tab from mobile session", async () => {
    await runningServer.stop();
    await startWithSessions(["main"]);

    const control = await openSocket(`${baseWsUrl}/ws/control`);
    const { attachedSession } = await authControl(control);

    // Create a second tab — new_tab now goes to the base session "main" via view store
    control.send(JSON.stringify({ type: "new_tab", session: attachedSession }));
    await waitForTmuxCall((call) => call.startsWith("newTab:main"));

    // Drain any pending workspace_state messages from new_tab
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Set up listener BEFORE sending select_tab to catch the response
    const statePromise = waitForMessage<{
      type: string;
      workspace: { sessions: Array<{ name: string; tabs: Array<{ index: number; active: boolean }> }> };
    }>(control, (msg) => {
      if (msg.type !== "workspace_state") return false;
      // Only match state where tab 0 is active (our desired state)
      const main = msg.workspace.sessions.find((s) => s.name === "main");
      const t0 = main?.tabs.find((t) => t.index === 0);
      return t0?.active === true;
    });

    // Now select tab 0 on the mobile session (tab 1 is currently active after new_tab)
    control.send(
      JSON.stringify({ type: "select_tab", session: attachedSession, tabIndex: 0 })
    );

    const stateMsg = await statePromise;
    const mainSession = stateMsg.workspace.sessions.find((s) => s.name === "main");
    expect(mainSession).toBeDefined();

    // The broadcast should show tab 0 as active (matching the mobile session's state)
    const tab0 = mainSession!.tabs.find((t) => t.index === 0);
    const tab1 = mainSession!.tabs.find((t) => t.index === 1);
    expect(tab0?.active).toBe(true);
    expect(tab1?.active).toBe(false);

    control.close();
  });

  test("new_tab switches the current client to the newly created tab", async () => {
    await runningServer.stop();
    await startWithSessions(["main"]);

    const control = await openSocket(`${baseWsUrl}/ws/control`);
    const { attachedSession } = await authControl(control);

    const statePromise = waitForMessage<{
      type: string;
      workspace: { sessions: Array<{ name: string; tabs: Array<{ index: number; active: boolean }> }> };
    }>(control, (msg) => {
      if (msg.type !== "workspace_state") return false;
      const main = msg.workspace.sessions.find((session) => session.name === "main");
      const newTab = main?.tabs.find((tab) => tab.index === 1);
      return newTab?.active === true;
    });

    control.send(JSON.stringify({ type: "new_tab", session: attachedSession }));

    await waitForTmuxCall((call) => call.startsWith("newTab:main"));
    await waitForTmuxCall(
      (call) => call.startsWith("selectTab:remux-client-") && call.endsWith(":1")
    );

    const stateMsg = await statePromise;
    const mainSession = stateMsg.workspace.sessions.find((session) => session.name === "main");
    const tab0 = mainSession?.tabs.find((tab) => tab.index === 0);
    const tab1 = mainSession?.tabs.find((tab) => tab.index === 1);

    expect(tab0?.active).toBe(false);
    expect(tab1?.active).toBe(true);

    control.close();
  });

  test("close_tab targets the correct tab after switching", async () => {
    await runningServer.stop();
    await startWithSessions(["main"]);

    const control = await openSocket(`${baseWsUrl}/ws/control`);
    const { attachedSession } = await authControl(control);

    // Create tab 1 — new_tab goes to base session "main" via view store
    control.send(JSON.stringify({ type: "new_tab", session: attachedSession }));
    await waitForTmuxCall((call) => call.startsWith("newTab:main"));

    // Select tab 1 on mobile session
    control.send(
      JSON.stringify({ type: "select_tab", session: attachedSession, tabIndex: 1 })
    );
    await waitForTmuxCall(
      (call) => call.startsWith("selectTab:remux-client-") && call.endsWith(":1")
    );

    // Kill tab 1 (the active tab on mobile)
    tmux.calls.length = 0;
    control.send(
      JSON.stringify({ type: "close_tab", session: attachedSession, tabIndex: 1 })
    );
    await waitForTmuxCall((call) => call.includes("closeTab:") && call.endsWith(":1"));

    // Verify the correct tab (1) was killed on the base session, not tab 0
    expect(
      tmux.calls.some((c) => c === "closeTab:main:1")
    ).toBe(true);

    control.close();
  });

  test("close_tab refuses to kill the last tab", async () => {
    await runningServer.stop();
    await startWithSessions(["main"]);

    const control = await openSocket(`${baseWsUrl}/ws/control`);
    const { attachedSession } = await authControl(control);

    // Session has only one tab — kill should be rejected
    tmux.calls.length = 0;
    control.send(
      JSON.stringify({ type: "close_tab", session: attachedSession, tabIndex: 0 })
    );

    // Should receive an info message instead of killing
    const infoMsg = await waitForMessage<{ type: string; message: string }>(
      control,
      (msg) => msg.type === "info" && msg.message.includes("last window")
    );
    expect(infoMsg.message).toContain("last window");

    // closeTab should NOT have been called
    expect(tmux.calls.some((c) => c.includes("closeTab:"))).toBe(false);

    control.close();
  });

  test("close_session refuses to kill the last session", async () => {
    await runningServer.stop();
    await startWithSessions(["main"]);

    const control = await openSocket(`${baseWsUrl}/ws/control`);
    const { attachedSession } = await authControl(control);

    tmux.calls.length = 0;
    control.send(
      JSON.stringify({ type: "close_session", session: attachedSession })
    );

    const infoMsg = await waitForMessage<{ type: string; message: string }>(
      control,
      (msg) => msg.type === "info" && msg.message.includes("last session")
    );
    expect(infoMsg.message).toContain("last session");
    expect(tmux.calls.some((call) => call.startsWith("killSession:main"))).toBe(false);

    control.close();
  });

  test("close_session reattaches the client to the remaining session", async () => {
    await runningServer.stop();
    await startWithSessions(["main", "work"]);

    const control = await openSocket(`${baseWsUrl}/ws/control`);
    control.send(JSON.stringify({ type: "auth", token: "test-token" }));
    await waitForMessage(control, (msg: { type: string }) => msg.type === "session_picker");
    const initialAttachPromise = waitForMessage<{ type: string; session: string }>(
      control,
      (msg) => msg.type === "attached" && msg.session === "main"
    );
    control.send(JSON.stringify({ type: "select_session", session: "main" }));
    await initialAttachPromise;

    const spawnedBeforeClose = ptyFactory.processes.length;
    tmux.calls.length = 0;
    const attachedPromise = waitForMessage<{ type: string; session: string }>(
      control,
      (msg) => msg.type === "attached" && msg.session === "work"
    );
    control.send(JSON.stringify({ type: "close_session", session: "main" }));

    const attached = await attachedPromise;
    expect(attached.session).toBe("work");
    expect(tmux.calls).toContain("killSession:main");
    expect(
      tmux.calls.some((call) => call.startsWith("killSession:remux-client-"))
    ).toBe(true);
    expect(
      tmux.calls.some((call) => call.startsWith("createGroupedSession:") && call.endsWith(":work"))
    ).toBe(true);
    expect(ptyFactory.processes.length).toBeGreaterThan(spawnedBeforeClose);

    control.close();
  });

  test("rename_session renames via backend", async () => {
    await runningServer.stop();
    await startWithSessions(["alpha"]);

    const control = await openSocket(`${baseWsUrl}/ws/control`);
    const { attachedSession } = await authControl(control);
    expect(attachedSession).toBe("alpha");

    control.send(
      JSON.stringify({ type: "rename_session", session: "alpha", newName: "beta" })
    );
    await waitForTmuxCall((call) => call === "renameSession:alpha:beta");

    expect(tmux.calls).toContain("renameSession:alpha:beta");

    control.close();
  });

  test("rename_tab renames via backend", async () => {
    await runningServer.stop();
    await startWithSessions(["work"]);

    const control = await openSocket(`${baseWsUrl}/ws/control`);
    await authControl(control);

    control.send(
      JSON.stringify({ type: "rename_tab", session: "work", tabIndex: 0, newName: "editor" })
    );
    await waitForTmuxCall((call) => call.includes("renameTab:") && call.endsWith(":0:editor"));

    expect(
      tmux.calls.some((c) => c === "renameTab:work:0:editor")
    ).toBe(true);

    control.close();
  });

  test("stop is idempotent when called repeatedly", async () => {
    await runningServer.stop();
    await runningServer.stop();
  });
});

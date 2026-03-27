import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import { AuthService } from "../../src/backend/auth/auth-service.js";
import type { RuntimeConfig } from "../../src/backend/config.js";
import type { MultiplexerBackend } from "../../src/backend/multiplexer/types.js";
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

type ScenarioPane = {
  id: string;
  active: boolean;
};

type ScenarioTab = {
  index: number;
  name: string;
  active: boolean;
  panes: ScenarioPane[];
};

type ScenarioSession = {
  name: string;
  attached: boolean;
  tabs: ScenarioTab[];
};

class ScenarioZellijGateway implements MultiplexerBackend {
  public readonly kind = "zellij" as const;
  public readonly capabilities = {
    supportsPaneFocusById: true,
    supportsTabRename: true,
    supportsSessionRename: true,
    supportsPreciseScrollback: false,
    supportsFloatingPanes: true,
    supportsFullscreenPane: true,
  };

  private sessions: ScenarioSession[];
  private nextPaneId = 2;
  private readonly delayNewTabPanes: boolean;
  private readonly delayRenameSession: boolean;
  private readonly keepCurrentTabActiveOnNewTab: boolean;
  private readonly keepTabsInactiveOnSelect: boolean;

  public constructor(options?: {
    delayNewTabPanes?: boolean;
    delayRenameSession?: boolean;
    keepCurrentTabActiveOnNewTab?: boolean;
    keepTabsInactiveOnSelect?: boolean;
  }) {
    this.delayNewTabPanes = options?.delayNewTabPanes ?? false;
    this.delayRenameSession = options?.delayRenameSession ?? false;
    this.keepCurrentTabActiveOnNewTab = options?.keepCurrentTabActiveOnNewTab ?? false;
    this.keepTabsInactiveOnSelect = options?.keepTabsInactiveOnSelect ?? false;
    this.sessions = [
      {
        name: "main",
        attached: true,
        tabs: [
          {
            index: 0,
            name: "shell",
            active: true,
            panes: [{ id: "terminal_1", active: true }]
          }
        ]
      }
    ];
  }

  public async listSessions() {
    return this.sessions.map((session) => ({
      name: session.name,
      attached: session.attached,
      tabCount: session.tabs.length
    }));
  }

  public async createSession(name: string): Promise<void> {
    if (this.sessions.some((session) => session.name === name)) return;
    this.sessions.push({
      name,
      attached: false,
      tabs: [{ index: 0, name: "shell", active: true, panes: [{ id: `terminal_${this.nextPaneId++}`, active: true }] }]
    });
  }

  public async killSession(name: string): Promise<void> {
    this.sessions = this.sessions.filter((session) => session.name !== name);
  }

  public async renameSession(name: string, newName: string): Promise<void> {
    const session = this.mustFindSession(name);
    const replacement: ScenarioSession = {
      ...session,
      name: newName
    };
    if (!this.delayRenameSession) {
      session.name = newName;
      return;
    }
    this.sessions = this.sessions.filter((candidate) => candidate.name !== name);
    setTimeout(() => {
      this.sessions = [...this.sessions, replacement];
    }, 150);
  }

  public async listTabs(session: string) {
    return this.mustFindSession(session).tabs.map((tab) => ({
      index: tab.index,
      name: tab.name,
      active: tab.active,
      paneCount: tab.panes.length
    }));
  }

  public async newTab(session: string): Promise<void> {
    const sessionState = this.mustFindSession(session);
    if (!this.keepCurrentTabActiveOnNewTab) {
      sessionState.tabs.forEach((tab) => {
        tab.active = false;
        tab.panes.forEach((pane) => {
          pane.active = false;
        });
      });
    }
    const newTab: ScenarioTab = {
      index: sessionState.tabs.length,
      name: `tab-${sessionState.tabs.length}`,
      active: !this.keepCurrentTabActiveOnNewTab,
      panes: this.delayNewTabPanes ? [] : [{ id: `terminal_${this.nextPaneId++}`, active: true }]
    };
    if (this.keepCurrentTabActiveOnNewTab && newTab.panes[0]) {
      newTab.panes[0].active = false;
    }
    sessionState.tabs.push(newTab);
    if (this.delayNewTabPanes) {
      setTimeout(() => {
        if (newTab.panes.length === 0) {
          newTab.panes = [{
            id: `terminal_${this.nextPaneId++}`,
            active: !this.keepCurrentTabActiveOnNewTab
          }];
        }
      }, 150);
    }
  }

  public async closeTab(session: string, tabIndex: number): Promise<void> {
    const sessionState = this.mustFindSession(session);
    sessionState.tabs = sessionState.tabs.filter((tab) => tab.index !== tabIndex);
    if (!sessionState.tabs.some((tab) => tab.active) && sessionState.tabs[0]) {
      sessionState.tabs[0].active = true;
      if (sessionState.tabs[0].panes[0]) {
        sessionState.tabs[0].panes[0].active = true;
      }
    }
  }

  public async selectTab(session: string, tabIndex: number): Promise<void> {
    const sessionState = this.mustFindSession(session);
    sessionState.tabs.forEach((tab) => {
      tab.active = this.keepTabsInactiveOnSelect ? false : tab.index === tabIndex;
      tab.panes.forEach((pane, paneIndex) => {
        pane.active = tab.index === tabIndex && paneIndex === 0;
      });
    });
  }

  public async renameTab(session: string, tabIndex: number, newName: string): Promise<void> {
    const tab = this.mustFindSession(session).tabs.find((candidate) => candidate.index === tabIndex);
    if (tab) {
      tab.name = newName;
    }
  }

  public async listPanes(session: string, tabIndex: number) {
    const tab = this.mustFindSession(session).tabs.find((candidate) => candidate.index === tabIndex);
    return (tab?.panes ?? []).map((pane, index) => ({
      index,
      id: pane.id,
      currentCommand: "bash",
      active: pane.active,
      width: 120,
      height: 40,
      zoomed: false,
      currentPath: "/tmp"
    }));
  }

  public async splitPane(paneId: string): Promise<void> {
    const { tab } = this.mustFindPane(paneId);
    tab.panes.forEach((pane) => {
      pane.active = false;
    });
    tab.panes.push({ id: `terminal_${this.nextPaneId++}`, active: true });
  }

  public async closePane(paneId: string): Promise<void> {
    const { tab } = this.mustFindPane(paneId);
    tab.panes = tab.panes.filter((pane) => pane.id !== paneId);
    if (tab.panes[0]) {
      tab.panes[0].active = true;
    }
  }

  public async focusPane(paneId: string): Promise<void> {
    const { tab } = this.mustFindPane(paneId);
    tab.panes.forEach((pane) => {
      pane.active = pane.id === paneId;
    });
  }

  public async toggleFullscreen(): Promise<void> {}
  public async isPaneFullscreen(): Promise<boolean> {
    return false;
  }

  public async capturePane(): Promise<{ text: string; paneWidth: number; isApproximate: boolean }> {
    return { text: "", paneWidth: 80, isApproximate: true };
  }

  public getActiveTabIndex(sessionName: string): number | undefined {
    return this.mustFindSession(sessionName).tabs.find((tab) => tab.active)?.index;
  }

  private mustFindSession(name: string): ScenarioSession {
    const session = this.sessions.find((candidate) => candidate.name === name);
    if (!session) {
      throw new Error(`missing session: ${name}`);
    }
    return session;
  }

  private mustFindPane(paneId: string): { session: ScenarioSession; tab: ScenarioTab } {
    for (const session of this.sessions) {
      for (const tab of session.tabs) {
        if (tab.panes.some((pane) => pane.id === paneId)) {
          return { session, tab };
        }
      }
    }
    throw new Error(`missing pane: ${paneId}`);
  }
}

class NoFocusChangeZellijGateway extends ScenarioZellijGateway {
  public override async selectTab(): Promise<void> {
    // Intentionally preserve backend focus to verify that workspace_state
    // stays honest and clientView carries the local selection.
  }
}

class LifecycleZellijGateway implements MultiplexerBackend {
  public readonly kind = "zellij" as const;
  public readonly capabilities = {
    supportsPaneFocusById: true,
    supportsTabRename: true,
    supportsSessionRename: true,
    supportsPreciseScrollback: false,
    supportsFloatingPanes: true,
    supportsFullscreenPane: true,
  };

  public readonly reviveCalls: string[] = [];

  private readonly sessions = [
    {
      name: "main",
      attached: true,
      lifecycle: "live" as const,
      tabs: [{ index: 0, name: "shell", active: true, panes: [{ id: "terminal_1", active: true }] }]
    },
    {
      name: "other",
      attached: false,
      lifecycle: "live" as const,
      tabs: [{ index: 0, name: "shell", active: true, panes: [{ id: "terminal_2", active: true }] }]
    },
    {
      name: "saved",
      attached: false,
      lifecycle: "exited" as const,
      tabs: [{ index: 0, name: "shell", active: true, panes: [{ id: "terminal_3", active: true }] }]
    }
  ];

  public async listSessions() {
    return this.sessions.map((session) => ({
      name: session.name,
      attached: session.attached,
      lifecycle: session.lifecycle,
      tabCount: session.lifecycle === "live" ? session.tabs.length : 0
    }));
  }

  public async reviveSession(name: string): Promise<void> {
    const session = this.mustFindSession(name);
    this.reviveCalls.push(name);
    session.lifecycle = "live";
  }

  public async createSession(): Promise<void> {}
  public async killSession(): Promise<void> {}
  public async renameSession(): Promise<void> {}
  public async newTab(): Promise<void> {}
  public async closeTab(): Promise<void> {}
  public async selectTab(): Promise<void> {}
  public async renameTab(): Promise<void> {}
  public async splitPane(): Promise<void> {}
  public async closePane(): Promise<void> {}

  public async listTabs(session: string) {
    const sessionState = this.mustFindSession(session);
    if (sessionState.lifecycle !== "live") {
      return [];
    }
    return sessionState.tabs.map((tab) => ({
      index: tab.index,
      name: tab.name,
      active: tab.active,
      paneCount: tab.panes.length
    }));
  }

  public async listPanes(session: string, tabIndex: number) {
    const sessionState = this.mustFindSession(session);
    if (sessionState.lifecycle !== "live") {
      return [];
    }
    const tab = sessionState.tabs.find((candidate) => candidate.index === tabIndex);
    return (tab?.panes ?? []).map((pane, index) => ({
      index,
      id: pane.id,
      currentCommand: "bash",
      active: pane.active,
      width: 120,
      height: 40,
      zoomed: false,
      currentPath: "/tmp"
    }));
  }

  public async focusPane(paneId: string): Promise<void> {
    for (const session of this.sessions) {
      if (session.lifecycle !== "live") continue;
      for (const tab of session.tabs) {
        for (const pane of tab.panes) {
          pane.active = pane.id === paneId;
          if (pane.active) {
            tab.active = true;
          }
        }
      }
    }
  }

  public async toggleFullscreen(): Promise<void> {}
  public async isPaneFullscreen(): Promise<boolean> {
    return false;
  }

  public async capturePane(): Promise<{ text: string; paneWidth: number; isApproximate: boolean }> {
    return { text: "", paneWidth: 80, isApproximate: true };
  }

  public setSessionLifecycle(name: string, lifecycle: "live" | "exited"): void {
    this.mustFindSession(name).lifecycle = lifecycle;
  }

  private mustFindSession(name: string) {
    const session = this.sessions.find((candidate) => candidate.name === name);
    if (!session) {
      throw new Error(`missing session: ${name}`);
    }
    return session;
  }
}

class DuplicatePaneIdZellijGateway implements MultiplexerBackend {
  public readonly kind = "zellij" as const;
  public readonly capabilities = {
    supportsPaneFocusById: true,
    supportsTabRename: true,
    supportsSessionRename: true,
    supportsPreciseScrollback: false,
    supportsFloatingPanes: true,
    supportsFullscreenPane: true,
  };

  public readonly splitCalls: string[] = [];
  private readonly paneSessionMap = new Map<string, string>();

  private sessions = [
    {
      name: "alpha",
      attached: false,
      tabs: [{ index: 0, name: "shell", active: true, panes: [{ id: "terminal_0", active: true }] }]
    },
    {
      name: "beta",
      attached: false,
      tabs: [{ index: 0, name: "shell", active: true, panes: [{ id: "terminal_0", active: true }] }]
    }
  ];

  public async listSessions() {
    return this.sessions.map((session) => ({
      name: session.name,
      attached: session.attached,
      tabCount: session.tabs.length
    }));
  }

  public async createSession(): Promise<void> {}
  public async killSession(): Promise<void> {}
  public async renameSession(): Promise<void> {}

  public async listTabs(session: string) {
    return this.mustFindSession(session).tabs.map((tab) => ({
      index: tab.index,
      name: tab.name,
      active: tab.active,
      paneCount: tab.panes.length
    }));
  }

  public async newTab(): Promise<void> {}
  public async closeTab(): Promise<void> {}
  public async selectTab(): Promise<void> {}
  public async renameTab(): Promise<void> {}

  public async listPanes(session: string, tabIndex: number) {
    const tab = this.mustFindSession(session).tabs.find((candidate) => candidate.index === tabIndex);
    return (tab?.panes ?? []).map((pane, index) => {
      this.paneSessionMap.set(pane.id, session);
      return {
      index,
      id: pane.id,
      currentCommand: "bash",
      active: pane.active,
      width: 120,
      height: 40,
      zoomed: false,
      currentPath: "/tmp"
      };
    });
  }

  public async splitPane(paneId: string): Promise<void> {
    const sessionName = this.paneSessionMap.get(paneId);
    const session = sessionName
      ? this.sessions.find((candidate) => candidate.name === sessionName)
      : undefined;
    if (!session) {
      throw new Error(`missing mapped pane: ${paneId}`);
    }
    this.splitCalls.push(session.name);
    const tab = session.tabs[0];
    tab?.panes.push({ id: `terminal_${tab.panes.length}`, active: true });
  }

  public async closePane(): Promise<void> {}
  public async focusPane(paneId: string): Promise<void> {
    for (const session of this.sessions) {
      for (const tab of session.tabs) {
        const hasPane = tab.panes.some((pane) => pane.id === paneId);
        if (!hasPane) continue;
        for (const pane of tab.panes) {
          pane.active = pane.id === paneId;
        }
      }
    }
  }
  public async toggleFullscreen(): Promise<void> {}
  public async isPaneFullscreen(): Promise<boolean> { return false; }
  public async capturePane(): Promise<{ text: string; paneWidth: number; isApproximate: boolean }> {
    return { text: "", paneWidth: 80, isApproximate: true };
  }

  private mustFindSession(name: string) {
    const session = this.sessions.find((candidate) => candidate.name === name);
    if (!session) {
      throw new Error(`missing session: ${name}`);
    }
    return session;
  }
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

  test("attaches PTY with session+tab runtime target", async () => {
    const control = await openSocket(`${baseWsUrl}/ws/control`);
    try {
      await authControl(control);
      expect(ptyFactory.lastSpawnedSession).toBe("zellij-tab://main#0");
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

      // A new PTY process should have been spawned for tab 0
      expect(ptyFactory.processes.length).toBe(processCountBefore + 1);
      expect(ptyFactory.lastSpawnedSession).toBe("zellij-tab://main#0");
    } finally {
      control.close();
    }
  });

  test("select_pane is disabled in zellij tab-only live mode", async () => {
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
      const processCountBefore = ptyFactory.processes.length;

      const infoPromise = waitForMessage<{ type: string; message: string }>(
        control,
        (msg) => msg.type === "info" && msg.message.includes("pane selection is disabled")
      );
      control.send(
        JSON.stringify({ type: "select_pane", paneId: secondPane.id })
      );
      await infoPromise;

      expect(ptyFactory.processes.length).toBe(processCountBefore);
      expect(ptyFactory.lastSpawnedSession).toBe("zellij-tab://main#0");
    } finally {
      control.close();
    }
  });

  test("workspace_state preserves backend active flags and sends clientView separately", async () => {
    const scenarioGateway = new NoFocusChangeZellijGateway();
    const authService = new AuthService({ token: "test-token" });
    const config = buildConfig("test-token");
    await runningServer.stop();
    runningServer = createRemuxServer(config, {
      backend: scenarioGateway,
      ptyFactory,
      authService,
      logger: { log: () => {}, error: () => {} }
    });
    await runningServer.start();
    const port = (runningServer.server.address() as AddressInfo).port;
    baseWsUrl = `ws://127.0.0.1:${port}`;

    await scenarioGateway.newTab("main");
    const control = await openSocket(`${baseWsUrl}/ws/control`);
    try {
      await authControl(control);

      control.send(
        JSON.stringify({ type: "select_tab", session: "main", tabIndex: 0 })
      );

      const state = await waitForMessage<{
        type: string;
        clientView: { tabIndex: number };
        workspace: { sessions: Array<{ tabs: Array<{ index: number; active: boolean }> }> };
      }>(control, (msg) => {
        if (msg.type !== "workspace_state") return false;
        const ts = msg.workspace?.sessions?.[0]?.tabs;
        const tabZero = ts?.find((t: { index: number; active: boolean }) => t.index === 0);
        const tabOne = ts?.find((t: { index: number; active: boolean }) => t.index === 1);
        return msg.clientView?.tabIndex === 0
          && tabZero?.active === false
          && tabOne?.active === true;
      });

      const tabs = state.workspace.sessions[0].tabs;
      const t0 = tabs.find((t) => t.index === 0);
      const t1 = tabs.find((t) => t.index === 1);
      expect(state.clientView.tabIndex).toBe(0);
      expect(t0?.active).toBe(false);
      expect(t1?.active).toBe(true);
    } finally {
      control.close();
    }
  });

  test("workspace_state includes runtime state emitted by the attached PTY", async () => {
    const control = await openSocket(`${baseWsUrl}/ws/control`);
    try {
      await authControl(control);

      ptyFactory.latestProcess().emitRuntimeState({
        streamMode: "native-bridge",
        scrollbackPrecision: "precise"
      });

      const state = await waitForMessage<{
        type: "workspace_state";
        runtimeState: { streamMode: string; scrollbackPrecision: string };
      }>(
        control,
        (message) => message.type === "workspace_state" && message.runtimeState?.streamMode === "native-bridge"
      );

      expect(state.runtimeState).toEqual({
        streamMode: "native-bridge",
        scrollbackPrecision: "precise"
      });
    } finally {
      control.close();
    }
  });

  test("runtime geometry is sent on a dedicated control message", async () => {
    const control = await openSocket(`${baseWsUrl}/ws/control`);
    try {
      await authControl(control);

      ptyFactory.latestProcess().emitRuntimeGeometry({
        requested: { cols: 140, rows: 40 },
        confirmed: { cols: 136, rows: 38 },
        status: "syncing"
      });

      const geometry = await waitForMessage<{
        type: "runtime_geometry";
        geometry: {
          requested: { cols: number; rows: number };
          confirmed: { cols: number; rows: number };
          status: string;
        };
      }>(
        control,
        (message) => message.type === "runtime_geometry" && message.geometry.confirmed.cols === 136
      );

      expect(geometry.geometry).toEqual({
        requested: { cols: 140, rows: 40 },
        confirmed: { cols: 136, rows: 38 },
        status: "syncing"
      });
    } finally {
      control.close();
    }
  });

  test("workspace change events trigger an immediate workspace refresh for follow-focus clients", async () => {
    await gateway.newTab("main");
    const control = await openSocket(`${baseWsUrl}/ws/control`);
    try {
      await authControl(control);
      control.send(JSON.stringify({ type: "set_follow_focus", follow: true }));
      await waitForMessage<{ type: "workspace_state"; clientView: { followBackendFocus: boolean } }>(
        control,
        (message) => message.type === "workspace_state" && message.clientView.followBackendFocus === true
      );

      await gateway.selectTab("main", 1);
      ptyFactory.latestProcess().emitWorkspaceChange("session_switch");

      const state = await waitForMessage<{
        type: "workspace_state";
        clientView: { tabIndex: number };
      }>(
        control,
        (message) => message.type === "workspace_state" && message.clientView.tabIndex === 1
      );

      expect(state.clientView.tabIndex).toBe(1);
    } finally {
      control.close();
    }
  });

  test("enabling follow-focus immediately rebuilds the workspace and re-arms fast polling", async () => {
    const slowGateway = createFakeZellijGateway(["main"]);
    await slowGateway.newTab("main");
    await slowGateway.selectTab("main", 0);
    const authService = new AuthService({ token: "test-token" });
    const config = { ...buildConfig("test-token"), pollIntervalMs: 10_000 };
    await runningServer.stop();
    runningServer = createRemuxServer(config, {
      backend: slowGateway,
      ptyFactory,
      authService,
      logger: { log: () => {}, error: () => {} }
    });
    await runningServer.start();
    const address = runningServer.server.address() as AddressInfo;
    baseWsUrl = `ws://127.0.0.1:${address.port}`;

    const control = await openSocket(`${baseWsUrl}/ws/control`);
    try {
      await authControl(control);
      const snapshotCallsBefore = slowGateway.calls.filter((call) => call.startsWith("listTabs:main")).length;
      control.send(JSON.stringify({ type: "set_follow_focus", follow: true }));
      await waitForMessage<{ type: "workspace_state"; clientView: { followBackendFocus: boolean } }>(
        control,
        (message) => message.type === "workspace_state" && message.clientView.followBackendFocus === true
      );
      await new Promise((resolve) => setTimeout(resolve, 200));

      const snapshotCallsAfter = slowGateway.calls.filter((call) => call.startsWith("listTabs:main")).length;
      expect(snapshotCallsAfter).toBeGreaterThan(snapshotCallsBefore);
    } finally {
      control.close();
    }
  });

  test("auth auto-attaches the only live session even when exited sessions exist", async () => {
    const scenarioGateway = new LifecycleZellijGateway();
    scenarioGateway.setSessionLifecycle("other", "exited");
    const authService = new AuthService({ token: "test-token" });
    const config = { ...buildConfig("test-token"), defaultSession: "ghost" };
    await runningServer.stop();
    runningServer = createRemuxServer(config, {
      backend: scenarioGateway,
      ptyFactory,
      authService,
      logger: { log: () => {}, error: () => {} }
    });
    await runningServer.start();
    const port = (runningServer.server.address() as AddressInfo).port;
    baseWsUrl = `ws://127.0.0.1:${port}`;

    const control = await openSocket(`${baseWsUrl}/ws/control`);
    try {
      const { attachedSession } = await authControl(control);
      expect(attachedSession).toBe("main");
      expect(ptyFactory.lastSpawnedSession).toBe("zellij-tab://main#0");
    } finally {
      control.close();
    }
  });

  test("select_session revives exited zellij sessions before attaching", async () => {
    const scenarioGateway = new LifecycleZellijGateway();
    const authService = new AuthService({ token: "test-token" });
    const config = { ...buildConfig("test-token"), defaultSession: "ghost" };
    await runningServer.stop();
    runningServer = createRemuxServer(config, {
      backend: scenarioGateway,
      ptyFactory,
      authService,
      logger: { log: () => {}, error: () => {} }
    });
    await runningServer.start();
    const port = (runningServer.server.address() as AddressInfo).port;
    baseWsUrl = `ws://127.0.0.1:${port}`;

    const control = await openSocket(`${baseWsUrl}/ws/control`);
    try {
      const authOkPromise = waitForMessage<{ type: string }>(
        control,
        (msg) => msg.type === "auth_ok"
      );
      const pickerPromise = waitForMessage<{ type: string; sessions: Array<{ name: string }> }>(
        control,
        (msg) => msg.type === "session_picker"
      );
      control.send(JSON.stringify({ type: "auth", token: "test-token" }));
      await authOkPromise;
      await pickerPromise;

      const attachedPromise = waitForMessage<{ type: string; session: string }>(
        control,
        (msg) => msg.type === "attached" && msg.session === "saved",
        5_000
      );
      control.send(JSON.stringify({ type: "select_session", session: "saved" }));
      const attached = await attachedPromise;

      expect(attached.session).toBe("saved");
      expect(scenarioGateway.reviveCalls).toEqual(["saved"]);
      expect(ptyFactory.lastSpawnedSession).toBe("zellij-tab://saved#0");
    } finally {
      control.close();
    }
  });

  test("new_tab waits for a real pane before reattaching PTY", async () => {
    const scenarioGateway = new ScenarioZellijGateway({ delayNewTabPanes: true });
    const authService = new AuthService({ token: "test-token" });
    const config = buildConfig("test-token");
    await runningServer.stop();
    runningServer = createRemuxServer(config, {
      backend: scenarioGateway,
      ptyFactory,
      authService,
      logger: { log: () => {}, error: () => {} }
    });
    await runningServer.start();
    const port = (runningServer.server.address() as AddressInfo).port;
    baseWsUrl = `ws://127.0.0.1:${port}`;

    const control = await openSocket(`${baseWsUrl}/ws/control`);
    try {
      await authControl(control);
      control.send(JSON.stringify({ type: "new_tab", session: "main" }));

      const state = await waitForMessage<{
        type: string;
        workspace: { sessions: Array<{ tabs: Array<{ index: number; active: boolean; panes: Array<{ id: string }> }> }> };
        clientView: { paneId?: string; tabIndex: number };
      }>(control, (msg) => {
        if (msg.type !== "workspace_state") return false;
        const activeTab = msg.workspace.sessions[0]?.tabs.find((tab) => tab.active);
        return Boolean(
          activeTab
          && activeTab.index === 1
          && activeTab.panes.length > 0
          && msg.clientView.tabIndex === activeTab.index
        );
      }, 5_000);

      const activeTab = state.workspace.sessions[0].tabs.find((tab) => tab.active);
      expect(activeTab?.panes.length).toBeGreaterThan(0);
      expect(state.clientView.tabIndex).toBe(activeTab?.index);
      expect(state.clientView.paneId).toBeUndefined();
      expect(ptyFactory.lastSpawnedSession).toBe("zellij-tab://main#1");
    } finally {
      control.close();
    }
  });

  test("new_tab reattaches promptly even when zellij never marks the selected tab active", async () => {
    const scenarioGateway = new ScenarioZellijGateway({
      keepCurrentTabActiveOnNewTab: true,
      keepTabsInactiveOnSelect: true
    });
    const authService = new AuthService({ token: "test-token" });
    const config = { ...buildConfig("test-token"), pollIntervalMs: 2_500 };
    await runningServer.stop();
    runningServer = createRemuxServer(config, {
      backend: scenarioGateway,
      ptyFactory,
      authService,
      logger: { log: () => {}, error: () => {} }
    });
    await runningServer.start();
    const port = (runningServer.server.address() as AddressInfo).port;
    baseWsUrl = `ws://127.0.0.1:${port}`;

    const control = await openSocket(`${baseWsUrl}/ws/control`);
    try {
      await authControl(control);
      control.send(JSON.stringify({ type: "new_tab", session: "main" }));

      const state = await waitForMessage<{
        type: string;
        workspace: {
          sessions: Array<{
            tabs: Array<{ index: number; active: boolean; panes: Array<{ id: string; active: boolean }> }>;
          }>;
        };
        clientView: { paneId?: string; tabIndex: number };
      }>(control, (msg) => {
        if (msg.type !== "workspace_state") return false;
        const newTab = msg.workspace.sessions[0]?.tabs.find((tab) => tab.index === 1);
        return Boolean(
          newTab
          && newTab.panes.length > 0
          && msg.clientView.tabIndex === 1
          && newTab.panes.some((pane) => pane.active)
        );
      }, 5_000);

      expect(state.clientView.tabIndex).toBe(1);
      expect(state.workspace.sessions[0]?.tabs.find((tab) => tab.index === 1)?.active).toBe(false);
      expect(state.clientView.paneId).toBeUndefined();
      expect(ptyFactory.lastSpawnedSession).toBe("zellij-tab://main#1");
    } finally {
      control.close();
    }
  });

  test("rename_session keeps the client attached to the renamed session", async () => {
    const scenarioGateway = new ScenarioZellijGateway({ delayRenameSession: true });
    const authService = new AuthService({ token: "test-token" });
    const config = buildConfig("test-token");
    await runningServer.stop();
    runningServer = createRemuxServer(config, {
      backend: scenarioGateway,
      ptyFactory,
      authService,
      logger: { log: () => {}, error: () => {} }
    });
    await runningServer.start();
    const port = (runningServer.server.address() as AddressInfo).port;
    baseWsUrl = `ws://127.0.0.1:${port}`;

    const control = await openSocket(`${baseWsUrl}/ws/control`);
    try {
      await authControl(control);
      control.send(JSON.stringify({ type: "rename_session", session: "main", newName: "renamed" }));

      const attached = await waitForMessage<{ type: string; session: string }>(
        control,
        (msg) => msg.type === "attached" && msg.session === "renamed",
        5_000
      );
      expect(attached.session).toBe("renamed");

      const state = await waitForMessage<{
        type: string;
        clientView: { sessionName: string };
        workspace: { sessions: Array<{ name: string }> };
      }>(control, (msg) => {
        if (msg.type !== "workspace_state") return false;
        return msg.clientView.sessionName === "renamed"
          && msg.workspace.sessions.some((session) => session.name === "renamed");
      }, 5_000);

      expect(state.clientView.sessionName).toBe("renamed");
      expect(state.workspace.sessions.some((session) => session.name === "renamed")).toBe(true);
    } finally {
      control.close();
    }
  });

  test("external session rename preserves the attached client view", async () => {
    const scenarioGateway = new ScenarioZellijGateway({ delayRenameSession: true });
    await scenarioGateway.createSession("other");
    const authService = new AuthService({ token: "test-token" });
    const config = buildConfig("test-token");
    await runningServer.stop();
    runningServer = createRemuxServer(config, {
      backend: scenarioGateway,
      ptyFactory,
      authService,
      logger: { log: () => {}, error: () => {} }
    });
    await runningServer.start();
    const port = (runningServer.server.address() as AddressInfo).port;
    baseWsUrl = `ws://127.0.0.1:${port}`;

    const control = await openSocket(`${baseWsUrl}/ws/control`);
    try {
      const authOkPromise = waitForMessage<{ type: string }>(
        control,
        (msg) => msg.type === "auth_ok"
      );
      const pickerPromise = waitForMessage<{ type: string; sessions: Array<{ name: string }> }>(
        control,
        (msg) => msg.type === "session_picker"
      );
      control.send(JSON.stringify({ type: "auth", token: "test-token" }));
      await authOkPromise;
      await pickerPromise;

      const attachedPromise = waitForMessage<{ type: string; session: string }>(
        control,
        (msg) => msg.type === "attached" && msg.session === "main"
      );
      control.send(JSON.stringify({ type: "select_session", session: "main" }));
      await attachedPromise;

      await scenarioGateway.renameSession("main", "renamed");

      const state = await waitForMessage<{
        type: string;
        clientView: { sessionName: string };
        workspace: { sessions: Array<{ name: string }> };
      }>(control, (msg) => {
        if (msg.type !== "workspace_state") return false;
        return msg.clientView.sessionName === "renamed"
          && msg.workspace.sessions.some((session) => session.name === "renamed")
          && msg.workspace.sessions.some((session) => session.name === "other");
      }, 5_000);

      expect(state.clientView.sessionName).toBe("renamed");
      expect(state.workspace.sessions.map((session) => session.name)).toEqual(
        expect.arrayContaining(["renamed", "other"])
      );
      expect(ptyFactory.lastSpawnedSession).toBe("zellij-tab://renamed#0");
    } finally {
      control.close();
    }
  });

  test("new_tab selects the created tab even when zellij leaves focus on the current tab", async () => {
    const scenarioGateway = new ScenarioZellijGateway({
      keepCurrentTabActiveOnNewTab: true
    });
    const authService = new AuthService({ token: "test-token" });
    const config = buildConfig("test-token");
    await runningServer.stop();
    runningServer = createRemuxServer(config, {
      backend: scenarioGateway,
      ptyFactory,
      authService,
      logger: { log: () => {}, error: () => {} }
    });
    await runningServer.start();
    const port = (runningServer.server.address() as AddressInfo).port;
    baseWsUrl = `ws://127.0.0.1:${port}`;

    const control = await openSocket(`${baseWsUrl}/ws/control`);
    try {
      await authControl(control);
      control.send(JSON.stringify({ type: "new_tab", session: "main" }));

      const state = await waitForMessage<{
        type: string;
        clientView: { sessionName: string; tabIndex: number; paneId?: string };
        workspace: {
          sessions: Array<{
            name: string;
            tabs: Array<{ index: number; active: boolean; panes: Array<{ id: string; active: boolean }> }>;
          }>;
        };
      }>(control, (msg) => {
        if (msg.type !== "workspace_state") return false;
        const mainSession = msg.workspace.sessions.find((session) => session.name === "main");
        const newTab = mainSession?.tabs.find((tab) => tab.index === 1);
        return msg.clientView.sessionName === "main"
          && msg.clientView.tabIndex === 1
          && newTab?.active === true
          && newTab.panes.some((pane) => pane.active);
      }, 5_000);

      expect(state.clientView.tabIndex).toBe(1);
      expect(scenarioGateway.getActiveTabIndex("main")).toBe(1);
      expect(state.clientView.paneId).toBeUndefined();
      expect(ptyFactory.lastSpawnedSession).toBe("zellij-tab://main#1");
    } finally {
      control.close();
    }
  });

  test("split_pane is blocked in zellij tab-only live mode even when pane ids collide across sessions", async () => {
    const gateway = new DuplicatePaneIdZellijGateway();
    const ptyFactory = new FakePtyFactory();
    const authService = new AuthService({ token: "test-token" });
    const config = buildConfig("test-token");
    const server = createRemuxServer(config, {
      backend: gateway,
      ptyFactory,
      authService,
      logger: { log: () => {}, error: () => {} }
    });
    await server.start();

    try {
      const port = (server.server.address() as AddressInfo).port;
      const control = await openSocket(`ws://127.0.0.1:${port}/ws/control`);
      try {
        const authOkPromise = waitForMessage<{ type: string; clientId: string }>(
          control,
          (msg) => msg.type === "auth_ok"
        );
        const attachedPromise = waitForMessage<{ type: string; session: string }>(
          control,
          (msg) => msg.type === "attached" && msg.session === "beta"
        );
        control.send(JSON.stringify({ type: "auth", token: "test-token", session: "beta" }));
        await authOkPromise;
        await attachedPromise;

        const infoPromise = waitForMessage<{ type: string; message: string }>(
          control,
          (msg) => msg.type === "info" && msg.message.includes("pane splitting")
        );
        control.send(JSON.stringify({ type: "split_pane", paneId: "terminal_0", direction: "right" }));
        await infoPromise;

        expect(gateway.splitCalls).toEqual([]);
      } finally {
        control.close();
      }
    } finally {
      await server.stop();
    }
  });
});

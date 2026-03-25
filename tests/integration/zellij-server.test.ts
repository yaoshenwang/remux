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

  public constructor(options?: { delayNewTabPanes?: boolean; delayRenameSession?: boolean }) {
    this.delayNewTabPanes = options?.delayNewTabPanes ?? false;
    this.delayRenameSession = options?.delayRenameSession ?? false;
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
    sessionState.tabs.forEach((tab) => {
      tab.active = false;
      tab.panes.forEach((pane) => {
        pane.active = false;
      });
    });
    const newTab: ScenarioTab = {
      index: sessionState.tabs.length,
      name: `tab-${sessionState.tabs.length}`,
      active: true,
      panes: this.delayNewTabPanes ? [] : [{ id: `terminal_${this.nextPaneId++}`, active: true }]
    };
    sessionState.tabs.push(newTab);
    if (this.delayNewTabPanes) {
      setTimeout(() => {
        if (newTab.panes.length === 0) {
          newTab.panes = [{ id: `terminal_${this.nextPaneId++}`, active: true }];
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
      tab.active = tab.index === tabIndex;
      tab.panes.forEach((pane, paneIndex) => {
        pane.active = tab.active && paneIndex === 0;
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
        clientView: { paneId: string; tabIndex: number };
      }>(control, (msg) => {
        if (msg.type !== "workspace_state") return false;
        const activeTab = msg.workspace.sessions[0]?.tabs.find((tab) => tab.active);
        return Boolean(activeTab && activeTab.panes.length > 0 && msg.clientView.paneId === activeTab.panes[0]?.id);
      }, 5_000);

      const activeTab = state.workspace.sessions[0].tabs.find((tab) => tab.active);
      expect(activeTab?.panes.length).toBeGreaterThan(0);
      expect(state.clientView.tabIndex).toBe(activeTab?.index);
      expect(ptyFactory.lastSpawnedSession).toContain(state.clientView.paneId);
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

  test("split_pane uses the attached session when pane ids collide across sessions", async () => {
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

        control.send(JSON.stringify({ type: "split_pane", paneId: "terminal_0", direction: "right" }));
        await new Promise((resolve) => setTimeout(resolve, 150));

        expect(gateway.splitCalls.at(-1)).toBe("beta");
      } finally {
        control.close();
      }
    } finally {
      await server.stop();
    }
  });
});

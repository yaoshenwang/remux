import http from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type {
  RuntimeV2InspectSnapshot,
  RuntimeV2Metadata,
  RuntimeV2SplitDirection,
  RuntimeV2TerminalSize,
  RuntimeV2WorkspaceSummary,
} from "../../src/backend/v2/types.js";

const encodeBase64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");

type FakeRuntimeV2ControlClientMessage =
  | { type: "subscribe_workspace" }
  | { type: "create_session"; session_name: string }
  | { type: "select_session"; session_id: string }
  | { type: "create_tab"; session_id: string; tab_title: string }
  | { type: "select_tab"; tab_id: string }
  | { type: "close_tab"; tab_id: string }
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

export interface TerminalObservation {
  attachCount: number;
  inputFrameTypes: Array<"text" | "binary">;
  paneId: string;
  requestSnapshotCount: number;
  sizes: RuntimeV2TerminalSize[];
  writes: string[];
}

export interface FakeRuntimeV2ServerOptions {
  initialPaneContent?: Record<string, string>;
  metadata?: Partial<RuntimeV2Metadata>;
  sessionName?: string;
  tabTitle?: string;
}

export class FakeRuntimeV2Server {
  private readonly server = http.createServer(this.handleHttpRequest.bind(this));
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly initialPaneContent: Record<string, string>;
  private readonly initialSessionName: string;
  private readonly initialTabTitle: string;
  private readonly controlSockets = new Set<WebSocket>();
  private readonly sockets = new Set<WebSocket>();
  private readonly terminalSocketsByPane = new Map<string, Set<WebSocket>>();
  private readonly terminalPaneBySocket = new Map<WebSocket, string>();
  private readonly terminalObservations = new Map<string, TerminalObservation>();
  private readonly paneContent = new Map<string, string>();
  private readonly paneScrollback = new Map<string, string[]>();
  private readonly paneStreamSequence = new Map<string, number>();
  private readonly metadata: RuntimeV2Metadata;
  private sessionSequence = 1;
  private tabSequence = 1;
  private terminalClientSequence = 0;
  private terminalStreamTransport: "text" | "binary" = "text";
  private paneSequence = 1;
  private nextTerminalSnapshotDelayMs = 0;
  private terminateTerminalSocketAfterSnapshot = false;
  private workspace: RuntimeV2WorkspaceSummary;

  constructor(options: FakeRuntimeV2ServerOptions = {}) {
    this.initialSessionName = options.sessionName ?? "main";
    this.initialTabTitle = options.tabTitle ?? "Shell";
    this.initialPaneContent = {
      "pane-1": "PANE_ONE_READY\r\n",
      ...(options.initialPaneContent ?? {}),
    };
    this.metadata = {
      service: "remuxd",
      version: "test",
      protocolVersion: "2026-03-27-draft",
      controlWebsocketPath: "/v2/control",
      terminalWebsocketPath: "/v2/terminal",
      publicBaseUrl: null,
      gitBranch: "dev",
      gitCommitSha: "fake-runtime-sha",
      gitDirty: false,
      ...options.metadata,
    };
    this.initializeState();

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
      this.sockets.add(socket);
      socket.on("close", () => {
        this.sockets.delete(socket);
      });
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
    for (const socket of this.controlSockets) {
      socket.close();
    }
    this.controlSockets.clear();
    for (const socket of this.sockets) {
      socket.close();
    }
    this.sockets.clear();
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

  reset(): void {
    for (const socket of Array.from(this.sockets)) {
      socket.close();
    }
    this.controlSockets.clear();
    this.sockets.clear();
    this.terminalSocketsByPane.clear();
    this.terminalPaneBySocket.clear();
    this.initializeState();
  }

  setPaneContent(paneId: string, text: string): void {
    this.paneContent.set(paneId, text);
  }

  setPaneScrollback(paneId: string, rows: string[]): void {
    this.paneScrollback.set(paneId, [...rows]);
  }

  getPaneContent(paneId: string): string {
    return this.paneContent.get(paneId) ?? "";
  }

  getPaneScrollback(paneId: string): string[] {
    return [...(this.paneScrollback.get(paneId) ?? [])];
  }

  activePaneId(): string {
    return this.workspace.activePaneId ?? this.workspace.paneId;
  }

  latestTerminal(paneId = this.activePaneId()): TerminalObservation | null {
    return this.terminalObservations.get(paneId) ?? null;
  }

  allTerminalWrites(): string[] {
    return Array.from(this.terminalObservations.values()).flatMap((observation) => observation.writes);
  }

  setTerminalStreamTransport(mode: "text" | "binary"): void {
    this.terminalStreamTransport = mode;
  }

  delayNextTerminalSnapshot(delayMs: number): void {
    this.nextTerminalSnapshotDelayMs = Math.max(0, delayMs);
  }

  terminateNextTerminalSocketAfterSnapshot(): void {
    this.terminateTerminalSocketAfterSnapshot = true;
  }

  pushTerminalOutput(paneId: string, chunk: string): void {
    const next = `${this.getPaneContent(paneId)}${chunk}`;
    this.setPaneContent(paneId, next);

    const sockets = this.terminalSocketsByPane.get(paneId);
    if (!sockets || sockets.size === 0) {
      return;
    }

    const sequence = this.nextStreamSequence(paneId);
    for (const socket of sockets) {
      if (socket.readyState === socket.OPEN) {
        this.sendTerminalStream(socket, chunk, sequence);
      }
    }
  }

  disconnectClients(): void {
    for (const socket of this.sockets) {
      socket.close(1012, "test reconnect");
    }
  }

  private createPaneSummary(paneId: string, options?: {
    active?: boolean;
    leaseHolderClientId?: string | null;
  }) {
    return {
      paneId,
      isActive: options?.active ?? true,
      isZoomed: false,
      command: "bash",
      currentPath: paneId === "pane-1" ? "/workspace/main" : `/workspace/${paneId}`,
      width: 120,
      height: 40,
      leaseHolderClientId: options?.leaseHolderClientId ?? `terminal-client-${this.terminalClientSequence + 1}`,
    };
  }

  splitActivePane(direction: RuntimeV2SplitDirection = "right"): string {
    const activeSession = this.workspace.sessions[0]!;
    const activeTab = activeSession.tabs[0]!;
    const sourcePaneId = activeTab.activePaneId ?? activeTab.panes[0]?.paneId ?? "pane-1";
    const newPaneId = `pane-${++this.paneSequence}`;
    const layoutDirection = direction === "down" ? "down" : "right";
    const sourcePane = activeTab.panes.find((pane) => pane.paneId === sourcePaneId);

    activeTab.activePaneId = newPaneId;
    activeTab.paneCount = activeTab.panes.length + 1;
    activeTab.layout = {
      type: "split",
      direction: layoutDirection,
      ratio: 50,
      children: [
        { type: "leaf", paneId: sourcePaneId },
        { type: "leaf", paneId: newPaneId },
      ],
    };
    activeTab.panes = activeTab.panes.map((pane) => ({
      ...pane,
      isActive: false,
      leaseHolderClientId: pane.paneId === sourcePaneId ? sourcePane?.leaseHolderClientId ?? null : pane.leaseHolderClientId,
    }));
    activeTab.panes.push({
      ...this.createPaneSummary(newPaneId),
    });

    this.workspace = {
      ...this.workspace,
      paneId: newPaneId,
      activePaneId: newPaneId,
      paneCount: activeTab.paneCount,
      layout: activeTab.layout,
      leaseHolderClientId: `terminal-client-${this.terminalClientSequence + 1}`,
      sessions: [
        {
          ...activeSession,
          tabs: [activeTab],
        },
      ],
    };

    this.paneContent.set(newPaneId, newPaneId === "pane-2" ? "PANE_TWO_READY\r\n" : `READY_${newPaneId}\r\n`);
    this.paneScrollback.set(newPaneId, []);
    this.broadcastWorkspace();
    return newPaneId;
  }

  createSession(sessionName: string): string {
    const sessionId = `session-${++this.sessionSequence}`;
    const tabId = `tab-${++this.tabSequence}`;
    const paneId = `pane-${++this.paneSequence}`;
    const nextSessions = this.workspace.sessions.map((session) => ({
      ...session,
      isActive: false,
      tabs: session.tabs.map((tab) => ({
        ...tab,
        isActive: false,
        panes: tab.panes.map((pane) => ({
          ...pane,
          isActive: false,
        })),
      })),
    }));

    nextSessions.push({
      sessionId,
      sessionName,
      sessionState: "live",
      isActive: true,
      activeTabId: tabId,
      tabCount: 1,
      tabs: [
        {
          tabId,
          tabTitle: "Shell",
          isActive: true,
          activePaneId: paneId,
          zoomedPaneId: null,
          paneCount: 1,
          layout: { type: "leaf", paneId },
          panes: [
            this.createPaneSummary(paneId),
          ],
        },
      ],
    });

    this.workspace = {
      ...this.workspace,
      sessionId,
      tabId,
      paneId,
      sessionName,
      tabTitle: "Shell",
      sessionCount: nextSessions.length,
      tabCount: 1,
      paneCount: 1,
      activeSessionId: sessionId,
      activeTabId: tabId,
      activePaneId: paneId,
      zoomedPaneId: null,
      layout: { type: "leaf", paneId },
      leaseHolderClientId: `terminal-client-${this.terminalClientSequence + 1}`,
      sessions: nextSessions,
    };

    this.paneContent.set(paneId, `READY_${paneId}\r\n`);
    this.paneScrollback.set(paneId, []);
    this.broadcastWorkspace();
    return sessionId;
  }

  createTab(sessionId: string, tabTitle = "Shell"): string {
    const nextSessions = this.workspace.sessions.map((session) => ({
      ...session,
      isActive: session.sessionId === sessionId,
      tabs: session.tabs.map((tab) => ({
        ...tab,
        isActive: false,
        panes: tab.panes.map((pane) => ({
          ...pane,
          isActive: false,
        })),
      })),
    }));
    const targetSession = nextSessions.find((session) => session.sessionId === sessionId);
    if (!targetSession) {
      return "";
    }

    const tabId = `tab-${++this.tabSequence}`;
    const paneId = `pane-${++this.paneSequence}`;
    targetSession.activeTabId = tabId;
    targetSession.tabCount = targetSession.tabs.length + 1;
    targetSession.tabs.push({
      tabId,
      tabTitle,
      isActive: true,
      activePaneId: paneId,
      zoomedPaneId: null,
      paneCount: 1,
      layout: { type: "leaf", paneId },
      panes: [
        this.createPaneSummary(paneId),
      ],
    });

    this.workspace = {
      ...this.workspace,
      sessionId,
      tabId,
      paneId,
      sessionName: targetSession.sessionName,
      tabTitle,
      sessionState: targetSession.sessionState,
      sessionCount: nextSessions.length,
      tabCount: targetSession.tabCount,
      paneCount: 1,
      activeSessionId: sessionId,
      activeTabId: tabId,
      activePaneId: paneId,
      zoomedPaneId: null,
      layout: { type: "leaf", paneId },
      leaseHolderClientId: `terminal-client-${this.terminalClientSequence + 1}`,
      sessions: nextSessions,
    };

    this.paneContent.set(paneId, `READY_${paneId}\r\n`);
    this.paneScrollback.set(paneId, []);
    this.broadcastWorkspace();
    return tabId;
  }

  selectSession(sessionId: string): void {
    const targetSession = this.workspace.sessions.find((session) => session.sessionId === sessionId);
    if (!targetSession) {
      return;
    }

    const activeTab = targetSession.tabs.find((tab) => tab.isActive)
      ?? targetSession.tabs.find((tab) => tab.tabId === targetSession.activeTabId)
      ?? targetSession.tabs[0];
    const activePane = activeTab?.panes.find((pane) => pane.isActive)
      ?? activeTab?.panes.find((pane) => pane.paneId === activeTab.activePaneId)
      ?? activeTab?.panes[0];
    if (!activeTab || !activePane) {
      return;
    }

    this.workspace = {
      ...this.workspace,
      sessionId,
      tabId: activeTab.tabId,
      paneId: activePane.paneId,
      sessionName: targetSession.sessionName,
      tabTitle: activeTab.tabTitle,
      activeSessionId: sessionId,
      activeTabId: activeTab.tabId,
      activePaneId: activePane.paneId,
      zoomedPaneId: activeTab.zoomedPaneId ?? null,
      layout: activeTab.layout,
      tabCount: targetSession.tabCount,
      paneCount: activeTab.paneCount,
      sessions: this.workspace.sessions.map((session) => ({
        ...session,
        isActive: session.sessionId === sessionId,
        tabs: session.tabs.map((tab) => ({
          ...tab,
          isActive: session.sessionId === sessionId && tab.tabId === activeTab.tabId,
          panes: tab.panes.map((pane) => ({
            ...pane,
            isActive: session.sessionId === sessionId && tab.tabId === activeTab.tabId && pane.paneId === activePane.paneId,
          })),
        })),
      })),
    };

    this.broadcastWorkspace();
  }

  selectTab(tabId: string): void {
    const nextSessions = this.workspace.sessions.map((session) => ({
      ...session,
      tabs: session.tabs.map((tab) => ({
        ...tab,
        panes: tab.panes.map((pane) => ({
          ...pane,
        })),
      })),
    }));
    let targetSession = nextSessions.find((session) => session.tabs.some((tab) => tab.tabId === tabId));
    if (!targetSession) {
      return;
    }
    const targetTab = targetSession.tabs.find((tab) => tab.tabId === tabId);
    if (!targetTab) {
      return;
    }
    const activePane = targetTab.panes.find((pane) => pane.isActive)
      ?? targetTab.panes.find((pane) => pane.paneId === targetTab.activePaneId)
      ?? targetTab.panes[0];
    if (!activePane) {
      return;
    }

    for (const session of nextSessions) {
      session.isActive = session.sessionId === targetSession.sessionId;
      for (const tab of session.tabs) {
        tab.isActive = session.sessionId === targetSession.sessionId && tab.tabId === tabId;
        for (const pane of tab.panes) {
          pane.isActive = session.sessionId === targetSession.sessionId && tab.tabId === tabId && pane.paneId === activePane.paneId;
        }
      }
    }
    targetSession = nextSessions.find((session) => session.sessionId === targetSession.sessionId)!;
    targetSession.activeTabId = tabId;
    targetTab.activePaneId = activePane.paneId;

    this.workspace = {
      ...this.workspace,
      sessionId: targetSession.sessionId,
      tabId,
      paneId: activePane.paneId,
      sessionName: targetSession.sessionName,
      tabTitle: targetTab.tabTitle,
      sessionState: targetSession.sessionState,
      sessionCount: nextSessions.length,
      tabCount: targetSession.tabCount,
      paneCount: targetTab.paneCount,
      activeSessionId: targetSession.sessionId,
      activeTabId: tabId,
      activePaneId: activePane.paneId,
      zoomedPaneId: targetTab.zoomedPaneId ?? null,
      layout: targetTab.layout,
      leaseHolderClientId: activePane.leaseHolderClientId ?? null,
      sessions: nextSessions,
    };

    this.broadcastWorkspace();
  }

  closeTab(tabId: string): void {
    const nextSessions = this.workspace.sessions.map((session) => ({
      ...session,
      tabs: session.tabs.map((tab) => ({
        ...tab,
        panes: tab.panes.map((pane) => ({
          ...pane,
        })),
      })),
    }));
    const targetSession = nextSessions.find((session) => session.tabs.some((tab) => tab.tabId === tabId));
    if (!targetSession || targetSession.tabs.length <= 1) {
      return;
    }

    const targetIndex = targetSession.tabs.findIndex((tab) => tab.tabId === tabId);
    if (targetIndex < 0) {
      return;
    }
    const [removedTab] = targetSession.tabs.splice(targetIndex, 1);
    targetSession.tabCount = targetSession.tabs.length;

    const fallbackTab = targetSession.tabs[Math.min(targetIndex, targetSession.tabs.length - 1)]!;
    const fallbackPane = fallbackTab.panes.find((pane) => pane.isActive)
      ?? fallbackTab.panes.find((pane) => pane.paneId === fallbackTab.activePaneId)
      ?? fallbackTab.panes[0]!;
    targetSession.activeTabId = fallbackTab.tabId;

    for (const session of nextSessions) {
      session.isActive = session.sessionId === targetSession.sessionId;
      for (const tab of session.tabs) {
        tab.isActive = session.sessionId === targetSession.sessionId && tab.tabId === fallbackTab.tabId;
        for (const pane of tab.panes) {
          pane.isActive = session.sessionId === targetSession.sessionId
            && tab.tabId === fallbackTab.tabId
            && pane.paneId === fallbackPane.paneId;
        }
      }
    }

    for (const pane of removedTab.panes) {
      this.paneContent.delete(pane.paneId);
      this.paneScrollback.delete(pane.paneId);
      this.terminalObservations.delete(pane.paneId);
      this.terminalSocketsByPane.delete(pane.paneId);
      this.paneStreamSequence.delete(pane.paneId);
    }

    this.workspace = {
      ...this.workspace,
      sessionId: targetSession.sessionId,
      tabId: fallbackTab.tabId,
      paneId: fallbackPane.paneId,
      sessionName: targetSession.sessionName,
      tabTitle: fallbackTab.tabTitle,
      sessionState: targetSession.sessionState,
      sessionCount: nextSessions.length,
      tabCount: targetSession.tabCount,
      paneCount: fallbackTab.paneCount,
      activeSessionId: targetSession.sessionId,
      activeTabId: fallbackTab.tabId,
      activePaneId: fallbackPane.paneId,
      zoomedPaneId: fallbackTab.zoomedPaneId ?? null,
      layout: fallbackTab.layout,
      leaseHolderClientId: fallbackPane.leaseHolderClientId ?? null,
      sessions: nextSessions,
    };

    this.broadcastWorkspace();
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
      response.end(JSON.stringify(this.metadata));
      return;
    }

    response.writeHead(404);
    response.end();
  }

  private handleControlSocket(socket: WebSocket): void {
    this.controlSockets.add(socket);
    socket.send(JSON.stringify({
      type: "hello",
      protocol_version: "2",
      write_lease_model: "single-active-writer",
    }));
    socket.send(JSON.stringify({
      type: "workspace_snapshot",
      summary: this.workspace,
    }));

    socket.on("close", () => {
      this.controlSockets.delete(socket);
    });

    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString("utf8")) as FakeRuntimeV2ControlClientMessage;
      switch (message.type) {
        case "subscribe_workspace":
          socket.send(JSON.stringify({ type: "workspace_snapshot", summary: this.workspace }));
          return;
        case "create_session":
          this.createSession(message.session_name);
          return;
        case "select_session":
          this.selectSession(message.session_id);
          return;
        case "create_tab":
          this.createTab(message.session_id, message.tab_title);
          return;
        case "select_tab":
          this.selectTab(message.tab_id);
          return;
        case "close_tab":
          this.closeTab(message.tab_id);
          return;
        case "split_pane": {
          if (message.pane_id !== this.activePaneId() && message.pane_id !== "pane-1") {
            socket.send(JSON.stringify({ type: "command_rejected", reason: "unexpected split target" }));
            return;
          }
          this.splitActivePane(message.direction === "horizontal" ? "down" : "right");
          return;
        }
        case "request_inspect": {
          const paneId = message.scope.type === "pane"
            ? message.scope.pane_id
            : this.activePaneId();
          const snapshot: RuntimeV2InspectSnapshot = {
            scope: { type: "pane", paneId },
            precision: paneId === this.activePaneId() ? "precise" : "approximate",
            summary: paneId,
            previewText: this.getPaneContent(paneId).trim(),
            scrollbackRows: this.getPaneScrollback(paneId),
            visibleRows: this.getPaneContent(paneId).trim().split("\n").filter(Boolean),
            byteCount: this.getPaneContent(paneId).length,
            size: this.latestTerminal(paneId)?.sizes.at(-1) ?? { cols: 120, rows: 40 },
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
    let terminalClientId = "terminal-client-1";

    socket.on("close", () => {
      this.detachTerminalSocket(socket);
    });

    socket.on("message", (raw, isBinary) => {
      if (isBinary) {
        const chunk = this.readRawData(raw).toString("utf8");
        const observation = this.observeTerminal(attachedPaneId);
        observation.inputFrameTypes.push("binary");
        observation.writes.push(chunk);
        const next = `${this.getPaneContent(attachedPaneId)}${chunk}`;
        this.setPaneContent(attachedPaneId, next);
        this.sendTerminalStream(socket, chunk, observation.writes.length + observation.attachCount);
        return;
      }

      const message = JSON.parse(raw.toString("utf8")) as FakeRuntimeV2TerminalClientMessage;
      switch (message.type) {
        case "attach": {
          this.detachTerminalSocket(socket);
          attachedPaneId = message.pane_id;
          this.attachTerminalSocket(socket, attachedPaneId);
          terminalClientId = `terminal-client-${++this.terminalClientSequence}`;
          const observation = this.observeTerminal(attachedPaneId);
          observation.attachCount += 1;
          observation.sizes.push(message.size);
          const snapshotDelayMs = this.takeTerminalSnapshotDelay();

          socket.send(JSON.stringify({
            type: "hello",
            protocol_version: "2",
            pane_id: attachedPaneId,
          }));
          this.sendTerminalSnapshot(socket, attachedPaneId, message.size, observation.attachCount, snapshotDelayMs);
          this.sendTerminalLeaseState(socket, terminalClientId, snapshotDelayMs);
          return;
        }
        case "input": {
          const chunk = Buffer.from(message.data_base64, "base64").toString("utf8");
          const observation = this.observeTerminal(attachedPaneId);
          observation.inputFrameTypes.push("text");
          observation.writes.push(chunk);
          const next = `${this.getPaneContent(attachedPaneId)}${chunk}`;
          this.setPaneContent(attachedPaneId, next);
          this.sendTerminalStream(socket, chunk, observation.writes.length + observation.attachCount);
          return;
        }
        case "resize": {
          const observation = this.observeTerminal(attachedPaneId);
          observation.sizes.push(message.size);
          socket.send(JSON.stringify({ type: "resize_confirmed", size: message.size }));
          return;
        }
        case "request_snapshot": {
          this.observeTerminal(attachedPaneId).requestSnapshotCount += 1;
          this.sendTerminalSnapshot(
            socket,
            attachedPaneId,
            this.latestTerminal(attachedPaneId)?.sizes.at(-1) ?? { cols: 120, rows: 40 },
            (this.latestTerminal(attachedPaneId)?.attachCount ?? 0) + 10,
            this.takeTerminalSnapshotDelay(),
          );
          return;
        }
      }
    });
  }

  private broadcastWorkspace(): void {
    const payload = JSON.stringify({ type: "workspace_snapshot", summary: this.workspace });
    for (const socket of this.controlSockets) {
      if (socket.readyState === socket.OPEN) {
        socket.send(payload);
      }
    }
  }

  private observeTerminal(paneId: string): TerminalObservation {
    let observation = this.terminalObservations.get(paneId);
    if (!observation) {
      observation = {
        attachCount: 0,
        inputFrameTypes: [],
        paneId,
        requestSnapshotCount: 0,
        sizes: [],
        writes: [],
      };
      this.terminalObservations.set(paneId, observation);
    }
    return observation;
  }

  private readRawData(raw: RawData): Buffer {
    if (Buffer.isBuffer(raw)) {
      return raw;
    }
    if (raw instanceof ArrayBuffer) {
      return Buffer.from(raw);
    }
    if (Array.isArray(raw)) {
      return Buffer.concat(raw);
    }
    return Buffer.from(raw);
  }

  private buildPaneReplay(paneId: string): string {
    const scrollback = this.getPaneScrollback(paneId);
    const live = this.getPaneContent(paneId);
    if (scrollback.length === 0) {
      return live;
    }
    return `${scrollback.join("\r\n")}\r\n${live}`;
  }

  private initializeState(): void {
    this.sessionSequence = 1;
    this.tabSequence = 1;
    this.terminalClientSequence = 0;
    this.terminalStreamTransport = "text";
    this.paneSequence = 1;
    this.nextTerminalSnapshotDelayMs = 0;
    this.terminateTerminalSocketAfterSnapshot = false;
    this.workspace = this.buildInitialWorkspace();
    this.paneContent.clear();
    this.paneScrollback.clear();
    this.terminalObservations.clear();
    this.paneStreamSequence.clear();
    for (const [paneId, text] of Object.entries(this.initialPaneContent)) {
      this.paneContent.set(paneId, text);
    }
  }

  private buildInitialWorkspace(): RuntimeV2WorkspaceSummary {
    return {
      sessionId: "session-1",
      tabId: "tab-1",
      paneId: "pane-1",
      sessionName: this.initialSessionName,
      tabTitle: this.initialTabTitle,
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
          sessionName: this.initialSessionName,
          sessionState: "live",
          isActive: true,
          activeTabId: "tab-1",
          tabCount: 1,
          tabs: [
            {
              tabId: "tab-1",
              tabTitle: this.initialTabTitle,
              isActive: true,
              activePaneId: "pane-1",
              zoomedPaneId: null,
              paneCount: 1,
              layout: { type: "leaf", paneId: "pane-1" },
              panes: [
                this.createPaneSummary("pane-1", {
                  active: true,
                  leaseHolderClientId: "terminal-client-1",
                }),
              ],
            },
          ],
        },
      ],
    };
  }

  private takeTerminalSnapshotDelay(): number {
    const delayMs = this.nextTerminalSnapshotDelayMs;
    this.nextTerminalSnapshotDelayMs = 0;
    return delayMs;
  }

  private sendTerminalLeaseState(socket: WebSocket, clientId: string, delayMs: number): void {
    const send = () => {
      if (socket.readyState !== socket.OPEN) {
        return;
      }
      socket.send(JSON.stringify({
        type: "lease_state",
        client_id: clientId,
      }));
    };
    if (delayMs > 0) {
      setTimeout(send, delayMs);
      return;
    }
    send();
  }

  private sendTerminalSnapshot(
    socket: WebSocket,
    paneId: string,
    size: RuntimeV2TerminalSize,
    sequence: number,
    delayMs: number,
  ): void {
    const send = () => {
      if (socket.readyState !== socket.OPEN) {
        return;
      }
      socket.send(JSON.stringify({
        type: "snapshot",
        size,
        sequence,
        content_base64: encodeBase64(this.getPaneContent(paneId)),
        replay_base64: encodeBase64(this.buildPaneReplay(paneId)),
      }));
      if (this.terminateTerminalSocketAfterSnapshot) {
        this.terminateTerminalSocketAfterSnapshot = false;
        setTimeout(() => {
          const rawSocket = (socket as WebSocket & { _socket?: { destroy: () => void } })._socket;
          rawSocket?.destroy();
        }, 0);
      }
    };
    if (delayMs > 0) {
      setTimeout(send, delayMs);
      return;
    }
    send();
  }

  private sendTerminalStream(socket: WebSocket, chunk: string, sequence: number): void {
    if (this.terminalStreamTransport === "binary") {
      socket.send(Buffer.from(chunk, "utf8"));
      return;
    }

    socket.send(JSON.stringify({
      type: "stream",
      sequence,
      chunk_base64: encodeBase64(chunk),
    }));
  }

  private attachTerminalSocket(socket: WebSocket, paneId: string): void {
    this.terminalPaneBySocket.set(socket, paneId);
    let sockets = this.terminalSocketsByPane.get(paneId);
    if (!sockets) {
      sockets = new Set<WebSocket>();
      this.terminalSocketsByPane.set(paneId, sockets);
    }
    sockets.add(socket);
  }

  private detachTerminalSocket(socket: WebSocket): void {
    const paneId = this.terminalPaneBySocket.get(socket);
    if (!paneId) {
      return;
    }
    this.terminalPaneBySocket.delete(socket);
    const sockets = this.terminalSocketsByPane.get(paneId);
    if (!sockets) {
      return;
    }
    sockets.delete(socket);
    if (sockets.size === 0) {
      this.terminalSocketsByPane.delete(paneId);
    }
  }

  private nextStreamSequence(paneId: string): number {
    const next = (this.paneStreamSequence.get(paneId) ?? 0) + 1;
    this.paneStreamSequence.set(paneId, next);
    return next;
  }
}

import type {
  PaneState,
  SessionSummary,
  TabState,
  BackendCapabilities
} from "../../src/shared/protocol.js";
import type { MultiplexerBackend } from "../../src/backend/multiplexer/types.js";

interface SessionNode {
  name: string;
  attached: boolean;
  windows: WindowNode[];
  /** For grouped sessions, points to the target session's windows array */
  groupTarget?: string;
}

interface WindowNode {
  index: number;
  name: string;
  active: boolean;
  zoomed: boolean;
  panes: PaneNode[];
}

interface PaneNode {
  index: number;
  id: string;
  command: string;
  active: boolean;
  width: number;
  height: number;
  currentPath: string;
}

let paneCounter = 20;

interface FakeTmuxOptions {
  attachedSession?: string;
  failSwitchClient?: boolean;
}

interface PaneCapture {
  text: string;
  paneWidth?: number;
  isApproximate?: boolean;
}

const buildDefaultSession = (name: string): SessionNode => ({
  name,
  attached: false,
  windows: [
    {
      index: 0,
      name: "shell",
      active: true,
      zoomed: false,
      panes: [
        {
          index: 0,
          id: `%${paneCounter++}`,
          command: "bash",
          active: true,
          width: 120,
          height: 40,
          currentPath: "/tmp"
        }
      ]
    }
  ]
});

export class FakeSessionGateway implements MultiplexerBackend {
  public readonly kind = "tmux" as const;
  public readonly capabilities: BackendCapabilities = {
    supportsPaneFocusById: false,
    supportsTabRename: true,
    supportsSessionRename: true,
    supportsPreciseScrollback: true,
    supportsFloatingPanes: false,
    supportsFullscreenPane: true,
  };

  private sessions: SessionNode[] = [];
  private failSwitchClient = false;
  private paneCaptures = new Map<string, PaneCapture>();
  public readonly calls: string[] = [];

  public constructor(seedSessions: string[] = [], options: FakeTmuxOptions = {}) {
    this.sessions = seedSessions.map((name) => buildDefaultSession(name));
    this.failSwitchClient = options.failSwitchClient ?? false;
    if (options.attachedSession) {
      this.markAttached(options.attachedSession);
    }
  }

  public listSessions(): Promise<SessionSummary[]> {
    this.calls.push("listSessions");
    return Promise.resolve(
      this.sessions.map((session) => ({
        name: session.name,
        attached: session.attached,
        tabCount: session.windows.length
      }))
    );
  }

  public listTabs(sessionName: string): Promise<Omit<TabState, "panes">[]> {
    this.calls.push(`listTabs:${sessionName}`);
    const session = this.findSession(sessionName);
    return Promise.resolve(
      session.windows.map((window) => ({
        index: window.index,
        name: window.name,
        active: window.active,
        paneCount: window.panes.length
      }))
    );
  }

  public listPanes(sessionName: string, tabIndex: number): Promise<PaneState[]> {
    this.calls.push(`listPanes:${sessionName}:${tabIndex}`);
    const window = this.findWindow(sessionName, tabIndex);
    return Promise.resolve(
      window.panes.map((pane) => ({
        index: pane.index,
        id: pane.id,
        currentCommand: pane.command,
        active: pane.active,
        width: pane.width,
        height: pane.height,
        zoomed: window.zoomed && pane.active,
        currentPath: pane.currentPath
      }))
    );
  }

  public async createSession(name: string, options?: { cwd?: string }): Promise<void> {
    this.calls.push(`createSession:${name}${options?.cwd ? `:${options.cwd}` : ""}`);
    if (this.sessions.some((session) => session.name === name)) {
      return;
    }
    const session = buildDefaultSession(name);
    if (options?.cwd) {
      session.windows[0]?.panes[0] && (session.windows[0].panes[0].currentPath = options.cwd);
    }
    this.sessions.push(session);
  }

  public async createGroupedSession(name: string, target: string): Promise<void> {
    this.calls.push(`createGroupedSession:${name}:${target}`);
    if (this.sessions.some((session) => session.name === name)) {
      return;
    }
    const targetSession = this.findSession(target);
    // Grouped sessions share the same underlying windows/panes but each session
    // has its own active window pointer (like real tmux).
    // We deep-copy the window metadata but share pane arrays.
    this.sessions.push({
      name,
      attached: false,
      groupTarget: target,
      windows: targetSession.windows.map((w) => ({ ...w, panes: [...w.panes] }))
    });
  }

  public async killSession(name: string): Promise<void> {
    this.calls.push(`killSession:${name}`);
    this.sessions = this.sessions.filter((session) => session.name !== name);
  }

  public async switchClient(sessionName: string): Promise<void> {
    this.calls.push(`switchClient:${sessionName}`);
    if (this.failSwitchClient) {
      throw new Error("no current client");
    }
    this.markAttached(sessionName);
  }

  public async newTab(sessionName: string, options?: { cwd?: string }): Promise<void> {
    this.calls.push(`newTab:${sessionName}${options?.cwd ? `:${options.cwd}` : ""}`);
    const session = this.findSession(sessionName);
    for (const window of session.windows) {
      window.active = false;
    }
    const nextIndex = session.windows.at(-1)?.index ?? -1;
    const newWindow: WindowNode = {
      index: nextIndex + 1,
      name: `win-${nextIndex + 1}`,
      active: true,
      zoomed: false,
      panes: [
        {
          index: 0,
          id: `%${paneCounter++}`,
          command: "bash",
          active: true,
          width: 120,
          height: 40,
          currentPath: options?.cwd ?? "/tmp"
        }
      ]
    };
    session.windows.push(newWindow);
    // Sync to grouped sessions (add window but keep their active state)
    this.syncWindowToGroup(session, newWindow);
  }

  public async closeTab(sessionName: string, tabIndex: number): Promise<void> {
    this.calls.push(`closeTab:${sessionName}:${tabIndex}`);
    const session = this.findSession(sessionName);
    session.windows = session.windows.filter((window) => window.index !== tabIndex);
    if (session.windows.length > 0 && !session.windows.some((w) => w.active)) {
      session.windows[0].active = true;
    }
    this.syncWindowRemovalToGroup(session, tabIndex);
  }

  public async selectTab(sessionName: string, tabIndex: number): Promise<void> {
    this.calls.push(`selectTab:${sessionName}:${tabIndex}`);
    const session = this.findSession(sessionName);
    for (const window of session.windows) {
      window.active = window.index === tabIndex;
    }
  }

  public async splitPane(paneId: string, direction: "right" | "down"): Promise<void> {
    this.calls.push(`splitPane:${paneId}:${direction}`);
    const { session, window } = this.findByPane(paneId);
    for (const pane of window.panes) {
      pane.active = false;
    }
    window.zoomed = false;
    const newPane: PaneNode = {
      index: window.panes.length,
      id: `%${paneCounter++}`,
      command: "bash",
      active: true,
      width: direction === "right" ? 60 : 120,
      height: direction === "down" ? 20 : 40,
      currentPath: window.panes.find((pane) => pane.id === paneId)?.currentPath ?? "/tmp"
    };
    window.panes.push(newPane);
    // Sync new pane to grouped session copies of this window
    for (const member of this.getGroupMembers(session)) {
      const memberWindow = member.windows.find((w) => w.index === window.index);
      if (memberWindow && !memberWindow.panes.some((p) => p.id === newPane.id)) {
        memberWindow.zoomed = false;
        memberWindow.panes.push(newPane);
      }
    }
    for (const s of this.sessions) {
      s.attached = s.name === session.name;
    }
  }

  public async closePane(paneId: string): Promise<void> {
    this.calls.push(`closePane:${paneId}`);
    const { window } = this.findByPane(paneId);
    window.panes = window.panes.filter((pane) => pane.id !== paneId);
    if (window.panes.length > 0) {
      window.panes[0].active = true;
    }
  }

  public async focusPane(paneId: string): Promise<void> {
    this.calls.push(`focusPane:${paneId}`);
    // Pane objects are shared by reference across grouped sessions,
    // so setting pane.active here affects all sessions.
    const { window } = this.findByPane(paneId);
    for (const pane of window.panes) {
      pane.active = pane.id === paneId;
    }
  }

  public async toggleFullscreen(paneId: string): Promise<void> {
    this.calls.push(`toggleFullscreen:${paneId}`);
    const { session, window } = this.findByPane(paneId);
    for (const pane of window.panes) {
      pane.active = pane.id === paneId;
    }
    window.zoomed = !window.zoomed;
    // Sync zoom state to all grouped session copies of this window
    for (const member of this.getGroupMembers(session)) {
      const memberWindow = member.windows.find((w) => w.index === window.index);
      if (memberWindow) {
        memberWindow.zoomed = window.zoomed;
      }
    }
  }

  public async isPaneFullscreen(paneId: string): Promise<boolean> {
    this.calls.push(`isPaneFullscreen:${paneId}`);
    const { window, pane } = this.findByPane(paneId);
    return window.zoomed && pane.active;
  }

  public async capturePane(paneId: string, options?: { lines?: number }): Promise<{ text: string; paneWidth: number; isApproximate: boolean }> {
    const lines = options?.lines ?? 1000;
    this.calls.push(`capturePane:${paneId}:${lines}`);
    const configured = this.paneCaptures.get(paneId);
    return {
      text: configured?.text ?? `captured ${lines} lines for ${paneId}`,
      paneWidth: configured?.paneWidth ?? 80,
      isApproximate: configured?.isApproximate ?? false
    };
  }

  public async renameSession(name: string, newName: string): Promise<void> {
    this.calls.push(`renameSession:${name}:${newName}`);
    const session = this.findSession(name);
    session.name = newName;
    // Update groupTarget references
    for (const s of this.sessions) {
      if (s.groupTarget === name) {
        s.groupTarget = newName;
      }
    }
  }

  public async renameTab(sessionName: string, tabIndex: number, newName: string): Promise<void> {
    this.calls.push(`renameTab:${sessionName}:${tabIndex}:${newName}`);
    const window = this.findWindow(sessionName, tabIndex);
    window.name = newName;
  }

  public setFailSwitchClient(value: boolean): void {
    this.failSwitchClient = value;
  }

  public setPaneCapture(
    paneId: string,
    text: string,
    options?: { paneWidth?: number; isApproximate?: boolean }
  ): void {
    this.paneCaptures.set(paneId, {
      text,
      paneWidth: options?.paneWidth,
      isApproximate: options?.isApproximate
    });
  }

  public setPanePath(paneId: string, currentPath: string): void {
    const { pane } = this.findByPane(paneId);
    pane.currentPath = currentPath;
  }

  public setPaneCommand(paneId: string, command: string): void {
    const { pane } = this.findByPane(paneId);
    pane.command = command;
  }

  /** Get all sessions in the same group as the given session */
  private getGroupMembers(session: SessionNode): SessionNode[] {
    const groupName = session.groupTarget ?? session.name;
    return this.sessions.filter(
      (s) => s !== session && (s.groupTarget === groupName || (s.name === groupName && session.groupTarget))
    );
  }

  /** Sync a newly added window to all grouped sessions */
  private syncWindowToGroup(session: SessionNode, newWindow: WindowNode): void {
    for (const member of this.getGroupMembers(session)) {
      if (!member.windows.some((w) => w.index === newWindow.index)) {
        member.windows.push({ ...newWindow, active: false, panes: [...newWindow.panes] });
      }
    }
  }

  /** Sync a window removal to all grouped sessions */
  private syncWindowRemovalToGroup(session: SessionNode, windowIndex: number): void {
    for (const member of this.getGroupMembers(session)) {
      member.windows = member.windows.filter((w) => w.index !== windowIndex);
      if (member.windows.length > 0 && !member.windows.some((w) => w.active)) {
        member.windows[0].active = true;
      }
    }
  }

  private markAttached(sessionName: string): void {
    for (const session of this.sessions) {
      session.attached = session.name === sessionName;
    }
  }

  private findSession(name: string): SessionNode {
    const session = this.sessions.find((candidate) => candidate.name === name);
    if (!session) {
      throw new Error(`session not found: ${name}`);
    }
    return session;
  }

  private findWindow(sessionName: string, windowIndex: number): WindowNode {
    const session = this.findSession(sessionName);
    const window = session.windows.find((candidate) => candidate.index === windowIndex);
    if (!window) {
      throw new Error(`window not found: ${sessionName}:${windowIndex}`);
    }
    return window;
  }

  private findByPane(paneId: string): { session: SessionNode; window: WindowNode; pane: PaneNode } {
    for (const session of this.sessions) {
      for (const window of session.windows) {
        for (const pane of window.panes) {
          if (pane.id === paneId) {
            return { session, window, pane };
          }
        }
      }
    }

    throw new Error(`pane not found: ${paneId}`);
  }
}

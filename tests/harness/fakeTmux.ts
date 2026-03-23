import type {
  TmuxPaneState,
  TmuxSessionSummary,
  TmuxWindowState
} from "../../src/shared/protocol.js";
import type { TmuxGateway } from "../../src/backend/tmux/types.js";

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
}

let paneCounter = 20;

interface FakeTmuxOptions {
  attachedSession?: string;
  failSwitchClient?: boolean;
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
          height: 40
        }
      ]
    }
  ]
});

export class FakeTmuxGateway implements TmuxGateway {
  private sessions: SessionNode[] = [];
  private failSwitchClient = false;
  public readonly calls: string[] = [];

  public constructor(seedSessions: string[] = [], options: FakeTmuxOptions = {}) {
    this.sessions = seedSessions.map((name) => buildDefaultSession(name));
    this.failSwitchClient = options.failSwitchClient ?? false;
    if (options.attachedSession) {
      this.markAttached(options.attachedSession);
    }
  }

  public listSessions(): Promise<TmuxSessionSummary[]> {
    this.calls.push("listSessions");
    return Promise.resolve(
      this.sessions.map((session) => ({
        name: session.name,
        attached: session.attached,
        windows: session.windows.length
      }))
    );
  }

  public listWindows(sessionName: string): Promise<Omit<TmuxWindowState, "panes">[]> {
    this.calls.push(`listWindows:${sessionName}`);
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

  public listPanes(sessionName: string, windowIndex: number): Promise<TmuxPaneState[]> {
    this.calls.push(`listPanes:${sessionName}:${windowIndex}`);
    const window = this.findWindow(sessionName, windowIndex);
    return Promise.resolve(
      window.panes.map((pane) => ({
        index: pane.index,
        id: pane.id,
        currentCommand: pane.command,
        active: pane.active,
        width: pane.width,
        height: pane.height,
        zoomed: window.zoomed && pane.active,
        currentPath: "/tmp"
      }))
    );
  }

  public async createSession(name: string): Promise<void> {
    this.calls.push(`createSession:${name}`);
    if (this.sessions.some((session) => session.name === name)) {
      return;
    }
    this.sessions.push(buildDefaultSession(name));
  }

  public async createGroupedSession(name: string, targetSession: string): Promise<void> {
    this.calls.push(`createGroupedSession:${name}:${targetSession}`);
    if (this.sessions.some((session) => session.name === name)) {
      return;
    }
    const target = this.findSession(targetSession);
    // Grouped sessions share the same underlying windows/panes but each session
    // has its own active window pointer (like real tmux).
    // We deep-copy the window metadata but share pane arrays.
    this.sessions.push({
      name,
      attached: false,
      groupTarget: targetSession,
      windows: target.windows.map((w) => ({ ...w, panes: [...w.panes] }))
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

  public async newWindow(sessionName: string): Promise<void> {
    this.calls.push(`newWindow:${sessionName}`);
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
          height: 40
        }
      ]
    };
    session.windows.push(newWindow);
    // Sync to grouped sessions (add window but keep their active state)
    this.syncWindowToGroup(session, newWindow);
  }

  public async killWindow(sessionName: string, windowIndex: number): Promise<void> {
    this.calls.push(`killWindow:${sessionName}:${windowIndex}`);
    const session = this.findSession(sessionName);
    session.windows = session.windows.filter((window) => window.index !== windowIndex);
    if (session.windows.length > 0 && !session.windows.some((w) => w.active)) {
      session.windows[0].active = true;
    }
    this.syncWindowRemovalToGroup(session, windowIndex);
  }

  public async selectWindow(sessionName: string, windowIndex: number): Promise<void> {
    this.calls.push(`selectWindow:${sessionName}:${windowIndex}`);
    const session = this.findSession(sessionName);
    for (const window of session.windows) {
      window.active = window.index === windowIndex;
    }
  }

  public async splitWindow(paneId: string, orientation: "h" | "v"): Promise<void> {
    this.calls.push(`splitWindow:${paneId}:${orientation}`);
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
      width: orientation === "h" ? 60 : 120,
      height: orientation === "v" ? 20 : 40
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

  public async killPane(paneId: string): Promise<void> {
    this.calls.push(`killPane:${paneId}`);
    const { window } = this.findByPane(paneId);
    window.panes = window.panes.filter((pane) => pane.id !== paneId);
    if (window.panes.length > 0) {
      window.panes[0].active = true;
    }
  }

  public async selectPane(paneId: string): Promise<void> {
    this.calls.push(`selectPane:${paneId}`);
    // Pane objects are shared by reference across grouped sessions,
    // so setting pane.active here affects all sessions.
    const { window } = this.findByPane(paneId);
    for (const pane of window.panes) {
      pane.active = pane.id === paneId;
    }
  }

  public async zoomPane(paneId: string): Promise<void> {
    this.calls.push(`zoomPane:${paneId}`);
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

  public async isPaneZoomed(paneId: string): Promise<boolean> {
    this.calls.push(`isPaneZoomed:${paneId}`);
    const { window, pane } = this.findByPane(paneId);
    return window.zoomed && pane.active;
  }

  public async capturePane(paneId: string, lines: number): Promise<string> {
    this.calls.push(`capturePane:${paneId}:${lines}`);
    return `captured ${lines} lines for ${paneId}`;
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

  public async renameWindow(sessionName: string, windowIndex: number, newName: string): Promise<void> {
    this.calls.push(`renameWindow:${sessionName}:${windowIndex}:${newName}`);
    const window = this.findWindow(sessionName, windowIndex);
    window.name = newName;
  }

  public setFailSwitchClient(value: boolean): void {
    this.failSwitchClient = value;
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

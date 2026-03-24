import type {
  PaneState,
  SessionState,
  SessionSummary,
  StateSnapshot,
  WindowState
} from "../../shared/protocol.js";

export interface SessionGateway {
  listSessions(): Promise<SessionSummary[]>;
  listWindows(session: string): Promise<Omit<WindowState, "panes">[]>;
  listPanes(session: string, windowIndex: number): Promise<PaneState[]>;
  createSession(name: string): Promise<void>;
  createGroupedSession(name: string, targetSession: string): Promise<void>;
  killSession(name: string): Promise<void>;
  switchClient(session: string): Promise<void>;
  newWindow(session: string): Promise<void>;
  killWindow(session: string, windowIndex: number): Promise<void>;
  selectWindow(session: string, windowIndex: number): Promise<void>;
  splitWindow(paneId: string, orientation: "h" | "v"): Promise<void>;
  killPane(paneId: string): Promise<void>;
  selectPane(paneId: string): Promise<void>;
  zoomPane(paneId: string): Promise<void>;
  isPaneZoomed(paneId: string): Promise<boolean>;
  capturePane(paneId: string, lines: number): Promise<{ text: string; paneWidth: number }>;
  renameSession(name: string, newName: string): Promise<void>;
  renameWindow(session: string, windowIndex: number, newName: string): Promise<void>;
}

export const buildSnapshot = async (
  tmux: SessionGateway
): Promise<StateSnapshot> => {
  const sessions = await tmux.listSessions();

  const sessionStates: SessionState[] = await Promise.all(
    sessions.map(async (session) => {
      const windows = await tmux.listWindows(session.name);
      const withPanes: WindowState[] = await Promise.all(
        windows.map(async (window) => {
          const panes = await tmux.listPanes(session.name, window.index);
          return { ...window, panes };
        })
      );
      return { ...session, windowStates: withPanes };
    })
  );

  return {
    sessions: sessionStates,
    capturedAt: new Date().toISOString()
  };
};

/** @deprecated Use SessionGateway */
export type TmuxGateway = SessionGateway;

import type {
  PaneState,
  SessionState,
  SessionSummary,
  TabState,
  WorkspaceSnapshot,
  BackendCapabilities
} from "../../shared/protocol.js";

export interface MultiplexerBackend {
  readonly kind: "tmux" | "zellij" | "conpty";
  readonly capabilities: BackendCapabilities;

  listSessions(): Promise<SessionSummary[]>;
  createSession(name: string): Promise<void>;
  killSession(name: string): Promise<void>;
  renameSession(name: string, newName: string): Promise<void>;

  listTabs(session: string): Promise<Omit<TabState, "panes">[]>;
  newTab(session: string): Promise<void>;
  closeTab(session: string, tabIndex: number): Promise<void>;
  selectTab(session: string, tabIndex: number): Promise<void>;
  renameTab(session: string, tabIndex: number, newName: string): Promise<void>;

  listPanes(session: string, tabIndex: number): Promise<PaneState[]>;
  splitPane(paneId: string, direction: "right" | "down"): Promise<void>;
  closePane(paneId: string): Promise<void>;
  focusPane(paneId: string): Promise<void>;
  toggleFullscreen(paneId: string): Promise<void>;
  isPaneFullscreen(paneId: string): Promise<boolean>;

  capturePane(paneId: string, options?: { lines?: number }): Promise<{
    text: string;
    paneWidth: number;
    isApproximate: boolean;
  }>;

  // tmux-specific (optional)
  createGroupedSession?(name: string, target: string): Promise<void>;
  switchClient?(session: string): Promise<void>;
}

export const buildSnapshot = async (
  backend: MultiplexerBackend
): Promise<WorkspaceSnapshot> => {
  const sessions = await backend.listSessions();

  const sessionStates: SessionState[] = await Promise.all(
    sessions.map(async (session) => {
      const tabs = await backend.listTabs(session.name);
      const withPanes: TabState[] = await Promise.all(
        tabs.map(async (tab) => {
          const panes = await backend.listPanes(session.name, tab.index);
          return { ...tab, panes };
        })
      );
      return { ...session, tabs: withPanes, tabCount: withPanes.length };
    })
  );

  return {
    sessions: sessionStates,
    capturedAt: new Date().toISOString()
  };
};

/** @deprecated Use MultiplexerBackend */
export type SessionGateway = MultiplexerBackend;
/** @deprecated Use MultiplexerBackend */
export type TmuxGateway = MultiplexerBackend;

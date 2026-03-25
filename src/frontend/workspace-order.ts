import type { SessionState, TabState } from "../shared/protocol.js";

export interface WorkspaceOrderState {
  sessions: string[];
  tabsBySession: Record<string, string[]>;
}

export const WORKSPACE_ORDER_STORAGE_KEY = "remux-workspace-order";

const readStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
};

export const normalizeWorkspaceOrder = (value: unknown): WorkspaceOrderState => {
  if (!value || typeof value !== "object") {
    return { sessions: [], tabsBySession: {} };
  }

  const record = value as Record<string, unknown>;
  const tabsSource = record.tabsBySession;
  const tabsBySession = tabsSource && typeof tabsSource === "object"
    ? Object.fromEntries(
        Object.entries(tabsSource as Record<string, unknown>).map(([sessionName, entries]) => [
          sessionName,
          readStringArray(entries)
        ])
      )
    : {};

  return {
    sessions: readStringArray(record.sessions),
    tabsBySession
  };
};

export const getTabOrderKey = (tab: Pick<TabState, "index" | "name" | "id">): string =>
  tab.id ?? `${tab.index}:${tab.name}`;

const orderIds = <T>(items: T[], ids: string[], getId: (item: T) => string): T[] => {
  if (items.length <= 1) {
    return [...items];
  }

  const rank = new Map(ids.map((id, index) => [id, index]));
  return [...items].sort((left, right) => {
    const leftRank = rank.get(getId(left));
    const rightRank = rank.get(getId(right));
    if (leftRank === undefined && rightRank === undefined) {
      return 0;
    }
    if (leftRank === undefined) {
      return 1;
    }
    if (rightRank === undefined) {
      return -1;
    }
    return leftRank - rightRank;
  });
};

export const orderSessions = (
  sessions: SessionState[],
  state: WorkspaceOrderState
): SessionState[] => {
  return orderIds(sessions, state.sessions, (session) => session.name);
};

export const orderTabs = (
  sessionName: string,
  tabs: TabState[],
  state: WorkspaceOrderState
): TabState[] => {
  return orderIds(tabs, state.tabsBySession[sessionName] ?? [], getTabOrderKey);
};

export const reorderSessionState = (
  state: WorkspaceOrderState,
  draggedName: string,
  targetName: string
): WorkspaceOrderState => {
  const sessions = reorderIds(
    Array.from(new Set([...state.sessions, draggedName, targetName])),
    draggedName,
    targetName
  );
  return { ...state, sessions };
};

export const moveSessionOrder = (
  state: WorkspaceOrderState,
  sessionName: string,
  direction: -1 | 1
): WorkspaceOrderState => {
  const sessions = Array.from(new Set([...state.sessions, sessionName]));
  return {
    ...state,
    sessions: moveId(sessions, sessionName, direction)
  };
};

export const reorderSessionTabs = (
  state: WorkspaceOrderState,
  sessionName: string,
  draggedKey: string,
  targetKey: string
): WorkspaceOrderState => {
  const current = Array.from(
    new Set([...(state.tabsBySession[sessionName] ?? []), draggedKey, targetKey])
  );
  const next = reorderIds(current, draggedKey, targetKey);
  return {
    ...state,
    tabsBySession: {
      ...state.tabsBySession,
      [sessionName]: next
    }
  };
};

export const moveSessionTabOrder = (
  state: WorkspaceOrderState,
  sessionName: string,
  tabKey: string,
  direction: -1 | 1
): WorkspaceOrderState => {
  const current = Array.from(new Set([...(state.tabsBySession[sessionName] ?? []), tabKey]));
  return {
    ...state,
    tabsBySession: {
      ...state.tabsBySession,
      [sessionName]: moveId(current, tabKey, direction)
    }
  };
};

const reorderIds = <T extends string>(items: T[], draggedId: string, targetId: string): T[] => {
  if (draggedId === targetId) {
    return items;
  }

  const next = [...items];
  const draggedIndex = next.findIndex((item) => item === draggedId);
  const targetIndex = next.findIndex((item) => item === targetId);
  if (draggedIndex === -1 || targetIndex === -1) {
    return items;
  }

  const [dragged] = next.splice(draggedIndex, 1);
  next.splice(targetIndex, 0, dragged);
  return next;
};

const moveId = <T extends string>(items: T[], id: string, direction: -1 | 1): T[] => {
  const next = [...items];
  const index = next.findIndex((item) => item === id);
  if (index === -1) {
    return items;
  }
  const targetIndex = index + direction;
  if (targetIndex < 0 || targetIndex >= next.length) {
    return items;
  }
  [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
  return next;
};

import { useDeferredValue, useMemo, useReducer } from "react";
import type {
  ClientView,
  PaneState,
  SessionState,
  SessionSummary,
  TabState,
  WorkspaceSnapshot,
} from "../../shared/protocol.js";
import {
  inferAttachedSessionFromWorkspace,
  isAwaitingSessionAttachment,
  isAwaitingSessionSelection,
  resolveActiveSession,
} from "../ui-state.js";
import {
  orderSessions,
  orderTabs,
  type WorkspaceOrderState,
} from "../workspace-order.js";

export interface WorkspaceState {
  snapshot: WorkspaceSnapshot;
  clientView: ClientView | null;
  attachedSession: string;
  pendingSessionAttachment: string | null;
  sessionChoices: SessionSummary[] | null;
  selectedWindowIndex: number | null;
  selectedPaneId: string | null;
}

export type WorkspaceStateAction =
  | { type: "attached"; sessionName: string }
  | { type: "session_picker"; sessions: SessionSummary[] }
  | { type: "workspace_state"; workspace: WorkspaceSnapshot; clientView: ClientView | null }
  | { type: "begin_session_attachment"; sessionName: string }
  | { type: "clear_local_selection" }
  | { type: "local_selection"; tabIndex: number | null; paneId: string | null };

export interface DerivedWorkspaceState {
  awaitingSessionSelection: boolean;
  awaitingSessionAttachment: boolean;
  activeSession: SessionState | undefined;
  activeTab: TabState | undefined;
  activePane: PaneState | undefined;
  orderedSessions: SessionState[];
  orderedActiveTabs: TabState[];
}

export const createInitialWorkspaceState = (): WorkspaceState => ({
  snapshot: { sessions: [], capturedAt: "" },
  clientView: null,
  attachedSession: "",
  pendingSessionAttachment: null,
  sessionChoices: null,
  selectedWindowIndex: null,
  selectedPaneId: null,
});

export const reduceWorkspaceState = (
  state: WorkspaceState,
  action: WorkspaceStateAction,
): WorkspaceState => {
  switch (action.type) {
    case "attached":
      return {
        ...state,
        attachedSession: action.sessionName,
        pendingSessionAttachment: null,
        sessionChoices: null,
        selectedWindowIndex: null,
        selectedPaneId: null,
      };
    case "session_picker":
      return {
        ...state,
        attachedSession: "",
        pendingSessionAttachment: null,
        sessionChoices: action.sessions,
        selectedWindowIndex: null,
        selectedPaneId: null,
      };
    case "workspace_state": {
      const inferredAttachedSession = inferAttachedSessionFromWorkspace(
        action.workspace.sessions,
        action.clientView,
      );

      return {
        ...state,
        snapshot: action.workspace,
        clientView: action.clientView,
        attachedSession: inferredAttachedSession || state.attachedSession,
        pendingSessionAttachment: inferredAttachedSession ? null : state.pendingSessionAttachment,
        sessionChoices: inferredAttachedSession ? null : state.sessionChoices,
        selectedWindowIndex: null,
        selectedPaneId: null,
      };
    }
    case "begin_session_attachment":
      return {
        ...state,
        pendingSessionAttachment: action.sessionName,
        sessionChoices: null,
      };
    case "clear_local_selection":
      return {
        ...state,
        selectedWindowIndex: null,
        selectedPaneId: null,
      };
    case "local_selection":
      return {
        ...state,
        selectedWindowIndex: action.tabIndex,
        selectedPaneId: action.paneId,
      };
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
};

export const deriveWorkspaceStateView = (
  state: WorkspaceState,
  workspaceOrder: WorkspaceOrderState,
): DerivedWorkspaceState => {
  const awaitingSessionSelection = isAwaitingSessionSelection(
    state.sessionChoices,
    state.attachedSession,
  );
  const awaitingSessionAttachment = isAwaitingSessionAttachment(
    state.pendingSessionAttachment,
    state.attachedSession,
  );
  const activeSession = resolveActiveSession(
    state.snapshot.sessions,
    state.attachedSession,
    awaitingSessionSelection,
    awaitingSessionAttachment,
  );
  const activeTab = (() => {
    if (!activeSession) {
      return undefined;
    }
    if (state.selectedWindowIndex !== null) {
      const selected = activeSession.tabs.find((tab) => tab.index === state.selectedWindowIndex);
      if (selected) {
        return selected;
      }
    }
    return activeSession.tabs.find((tab) => tab.active) ?? activeSession.tabs[0];
  })();
  const activePane = (() => {
    if (!activeTab) {
      return undefined;
    }
    if (state.selectedPaneId !== null) {
      const selected = activeTab.panes.find((pane) => pane.id === state.selectedPaneId);
      if (selected) {
        return selected;
      }
    }
    return activeTab.panes.find((pane) => pane.active) ?? activeTab.panes[0];
  })();
  const orderedSessions = orderSessions(state.snapshot.sessions, workspaceOrder);
  const orderedActiveTabs = activeSession
    ? orderTabs(activeSession.name, activeSession.tabs, workspaceOrder)
    : [];

  return {
    awaitingSessionSelection,
    awaitingSessionAttachment,
    activeSession,
    activeTab,
    activePane,
    orderedSessions,
    orderedActiveTabs,
  };
};

export interface UseWorkspaceStateResult extends WorkspaceState, DerivedWorkspaceState {
  deferredSnapshot: WorkspaceSnapshot;
  onAttached: (sessionName: string) => void;
  onSessionPicker: (sessions: SessionSummary[]) => void;
  onWorkspaceState: (workspace: WorkspaceSnapshot, clientView: ClientView | null) => void;
  beginSessionAttachment: (sessionName: string) => void;
  clearLocalSelection: () => void;
  selectWindowIndex: (tabIndex: number | null) => void;
  selectPaneId: (paneId: string | null) => void;
}

export const useWorkspaceState = (
  workspaceOrder: WorkspaceOrderState,
): UseWorkspaceStateResult => {
  const [state, dispatch] = useReducer(reduceWorkspaceState, undefined, createInitialWorkspaceState);
  const deferredSnapshot = useDeferredValue(state.snapshot);
  const derived = useMemo(
    () => deriveWorkspaceStateView({ ...state, snapshot: deferredSnapshot }, workspaceOrder),
    [deferredSnapshot, state, workspaceOrder],
  );

  return {
    ...state,
    ...derived,
    deferredSnapshot,
    onAttached: (sessionName) => {
      dispatch({ type: "attached", sessionName });
    },
    onSessionPicker: (sessions) => {
      dispatch({ type: "session_picker", sessions });
    },
    onWorkspaceState: (workspace, clientView) => {
      dispatch({ type: "workspace_state", workspace, clientView });
    },
    beginSessionAttachment: (sessionName) => {
      dispatch({ type: "begin_session_attachment", sessionName });
    },
    clearLocalSelection: () => {
      dispatch({ type: "clear_local_selection" });
    },
    selectWindowIndex: (tabIndex) => {
      dispatch({ type: "local_selection", tabIndex, paneId: null });
    },
    selectPaneId: (paneId) => {
      dispatch({ type: "local_selection", tabIndex: state.selectedWindowIndex, paneId });
    },
  };
};

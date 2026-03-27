import type { ClientView, SessionState } from "../shared/protocol";

export const isAwaitingSessionSelection = (
  sessionChoices: Array<unknown> | null,
  attachedSession: string
): boolean => sessionChoices !== null && !attachedSession;

export const isAwaitingSessionAttachment = (
  pendingSessionName: string | null,
  attachedSession: string
): boolean => Boolean(pendingSessionName && pendingSessionName !== attachedSession);

export const resolveActiveSession = (
  sessions: SessionState[],
  attachedSession: string,
  awaitingSessionSelection: boolean,
  awaitingSessionAttachment = false,
  clientView: ClientView | null = null
): SessionState | undefined => {
  if (awaitingSessionSelection || awaitingSessionAttachment) {
    return undefined;
  }

  const preferredSessionName = clientView?.sessionName || attachedSession;
  const selected = sessions.find((session) => session.name === preferredSessionName);
  if (selected) {
    return selected;
  }

  return sessions.find((session) => session.attached) ?? sessions[0];
};

export const inferAttachedSessionFromWorkspace = (
  sessions: SessionState[],
  clientView: ClientView | null
): string => {
  const sessionName = clientView?.sessionName ?? "";
  if (!sessionName) {
    return "";
  }

  return sessions.some((session) => session.name === sessionName) ? sessionName : "";
};

export const shouldUsePaneViewportCols = (
  backendKind?: "tmux" | "zellij" | "conpty"
): boolean => backendKind === "zellij";

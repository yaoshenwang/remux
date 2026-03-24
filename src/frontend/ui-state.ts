import type { SessionState } from "../shared/protocol";

export const isAwaitingSessionSelection = (
  sessionChoices: Array<unknown> | null,
  attachedSession: string
): boolean => sessionChoices !== null && !attachedSession;

export const resolveActiveSession = (
  sessions: SessionState[],
  attachedSession: string,
  awaitingSessionSelection: boolean
): SessionState | undefined => {
  if (awaitingSessionSelection) {
    return undefined;
  }

  const selected = sessions.find((session) => session.name === attachedSession);
  if (selected) {
    return selected;
  }

  return sessions.find((session) => session.attached) ?? sessions[0];
};

export const shouldUsePaneViewportCols = (
  backendKind?: "tmux" | "zellij" | "conpty"
): boolean => backendKind === "zellij";

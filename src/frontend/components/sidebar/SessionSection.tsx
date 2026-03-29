import { useState } from "react";
import { deriveContext, formatContext } from "../../context-label";
import type { RuntimeSnapshot, SessionState } from "../../../shared/protocol";
import type { DragEvent, MutableRefObject } from "react";

interface SessionSectionProps {
  attachedSession: string;
  bellSessions: Set<string>;
  createSession: () => void;
  mobileLayout: boolean;
  renameHandledByKeyRef: MutableRefObject<boolean>;
  renameSessionValue: string;
  renamingSession: string | null;
  selectedSessionName: string | undefined;
  sessionDropTarget: string | null;
  sessions: SessionState[];
  setDraggedSessionName: (value: string | null) => void;
  setRenameSessionValue: (value: string) => void;
  setRenamingSession: (value: string | null) => void;
  setSelectedPaneId: (value: string | null) => void;
  setSelectedWindowIndex: (value: number | null) => void;
  setSessionDropTarget: (value: string | null | ((current: string | null) => string | null)) => void;
  snapshot: RuntimeSnapshot;
  beginDrag: (event: DragEvent<HTMLElement>, type: "session" | "tab" | "snippet", value: string) => void;
  draggedSessionName: string | null;
  onCloseSession: (sessionName: string) => void;
  onRenameSession: (sessionName: string, newName: string) => void;
  onReorderSessions: (draggedSessionName: string, targetSessionName: string) => void;
  onSelectSession: (sessionName: string) => void;
  supportsSessionRename: boolean;
}

export const SessionSection = ({
  attachedSession,
  bellSessions,
  beginDrag,
  createSession,
  draggedSessionName,
  mobileLayout,
  onCloseSession,
  onRenameSession,
  onReorderSessions,
  onSelectSession,
  renameHandledByKeyRef,
  renameSessionValue,
  renamingSession,
  selectedSessionName,
  sessionDropTarget,
  sessions,
  setDraggedSessionName,
  setRenameSessionValue,
  setRenamingSession,
  setSelectedPaneId,
  setSelectedWindowIndex,
  setSessionDropTarget,
  snapshot,
  supportsSessionRename
}: SessionSectionProps) => {
  const [savedExpanded, setSavedExpanded] = useState(false);

  // Preserve existing order (from workspaceOrder/drag reorder) — don't re-sort
  const liveSessions = sessions.filter((session) => session.lifecycle !== "exited");
  const resurrectableSessions = sessions.filter((session) => session.lifecycle === "exited");

  const renderSession = (session: SessionState) => (
        <li
          key={session.name}
          data-testid={`session-item-${session.name}`}
          data-session-name={session.name}
          className={sessionDropTarget === session.name ? "drawer-sort-target" : undefined}
          onDragOver={(event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
          }}
          onDragEnter={(event) => {
            event.preventDefault();
            if (draggedSessionName && draggedSessionName !== session.name) {
              setSessionDropTarget(session.name);
              onReorderSessions(draggedSessionName, session.name);
            }
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              setSessionDropTarget((current) => current === session.name ? null : current);
            }
          }}
          onDrop={(event) => {
            event.preventDefault();
            if (!draggedSessionName || draggedSessionName === session.name) {
              setSessionDropTarget(null);
              return;
            }
            onReorderSessions(draggedSessionName, session.name);
            setDraggedSessionName(null);
            setSessionDropTarget(null);
          }}
        >
          {renamingSession === session.name ? (
            <input
              className="rename-input"
              value={renameSessionValue}
              onChange={(event) => setRenameSessionValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && renameSessionValue.trim()) {
                  renameHandledByKeyRef.current = true;
                  onRenameSession(session.name, renameSessionValue.trim());
                  setRenamingSession(null);
                } else if (event.key === "Escape") {
                  renameHandledByKeyRef.current = true;
                  setRenamingSession(null);
                }
              }}
              onBlur={() => {
                if (renameHandledByKeyRef.current) {
                  renameHandledByKeyRef.current = false;
                  return;
                }
                if (renameSessionValue.trim() && renameSessionValue.trim() !== session.name) {
                  onRenameSession(session.name, renameSessionValue.trim());
                }
                setRenamingSession(null);
              }}
              autoFocus
              data-testid="rename-session-input"
            />
          ) : (
            <div className={`drawer-item-row${mobileLayout && supportsSessionRename ? " mobile-actions" : ""}${session.lifecycle === "exited" ? " resurrectable" : ""}`}>
              <button
                draggable={!mobileLayout}
                onClick={() => onSelectSession(session.name)}
                onDragStart={(event) => {
                  if (mobileLayout) {
                    return;
                  }
                  beginDrag(event, "session", session.name);
                  setDraggedSessionName(session.name);
                }}
                onDragEnd={() => {
                  setDraggedSessionName(null);
                  setSessionDropTarget(null);
                }}
                onDoubleClick={supportsSessionRename ? (event) => {
                  event.preventDefault();
                  setRenamingSession(session.name);
                  setRenameSessionValue(session.name);
                } : undefined}
                className={`drawer-item-main${
                  session.name === (attachedSession || selectedSessionName) ? " active" : ""
                }${session.lifecycle === "exited" ? " resurrectable" : ""}`}
                data-testid={`session-drag-target-${session.name}`}
                >
                <span className="item-name">
                  {session.name} {session.attached ? "*" : ""}
                  {bellSessions.has(session.name) && session.name !== (attachedSession || selectedSessionName) ? " 🔔" : ""}
                </span>
                {(() => {
                  if (session.lifecycle === "exited") {
                    return <span className="item-context">Saved session</span>;
                  }
                  const activeWindow = session.tabs.find((tab) => tab.active) ?? session.tabs[0];
                  const label = activeWindow ? formatContext(deriveContext(activeWindow.panes)) : "";
                  return label ? <span className="item-context">{label}</span> : null;
                })()}
              </button>
              {supportsSessionRename && mobileLayout ? (
                <button
                  type="button"
                  className="drawer-icon-action"
                  onClick={(event) => {
                    event.stopPropagation();
                    setRenamingSession(session.name);
                    setRenameSessionValue(session.name);
                  }}
                  data-testid={`rename-session-${session.name}`}
                  aria-label={`Rename session ${session.name}`}
                  title={`Rename session ${session.name}`}
                >
                  <span aria-hidden="true">✎</span>
                </button>
              ) : null}
              <button
                type="button"
                className="drawer-close-action"
                onClick={(event) => {
                  event.stopPropagation();
                  if (
                    session.name === selectedSessionName ||
                    session.name === attachedSession ||
                    snapshot.sessions.length <= 1
                  ) {
                    setSelectedWindowIndex(null);
                    setSelectedPaneId(null);
                  }
                  onCloseSession(session.name);
                }}
                disabled={snapshot.sessions.length <= 1}
                data-testid={`close-session-${session.name}`}
                aria-label={`${session.lifecycle === "exited" ? "Delete saved session" : "Close session"} ${session.name}`}
                title={`${session.lifecycle === "exited" ? "Delete saved session" : "Close session"} ${session.name}`}
              >
                <span aria-hidden="true">×</span>
              </button>
            </div>
          )}
        </li>
  );

  return (
    <>
      <h3>Live Sessions</h3>
      <ul data-testid="sessions-list">
        {liveSessions.map(renderSession)}
      </ul>
      {resurrectableSessions.length > 0 ? (
        <div className="drawer-session-subgroup">
          <button
            type="button"
            className="drawer-collapsible-header"
            onClick={() => setSavedExpanded(!savedExpanded)}
            data-testid="saved-sessions-toggle"
            aria-expanded={savedExpanded}
          >
            <span className={`collapse-chevron${savedExpanded ? " expanded" : ""}`}>▸</span>
            {" "}Saved Sessions ({resurrectableSessions.length})
          </button>
          {savedExpanded ? (
            <ul data-testid="archived-sessions-list">
              {resurrectableSessions.map(renderSession)}
            </ul>
          ) : null}
        </div>
      ) : null}
      <button
        className="drawer-section-action"
        onClick={createSession}
        data-testid="new-session-button"
        title="Create a new terminal session"
      >
        + New Session
      </button>
    </>
  );
};

import { useCallback, useRef, useState } from "react";
import type { ConnectedClientInfo } from "../../protocol/client-state";

interface SessionSectionProps {
  sessionName: string;
  onRenameSession: (name: string) => void;
  connectionStateLabel: string;
  connectedClients: ConnectedClientInfo[];
  selfClientId: string | null;
}

export const SessionSection = ({
  sessionName,
  onRenameSession,
  connectionStateLabel,
  connectedClients,
  selfClientId,
}: SessionSectionProps) => {
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const commitRename = useCallback(() => {
    const value = inputRef.current?.value.trim();
    if (value && value !== sessionName) {
      onRenameSession(value);
    }
    setEditing(false);
  }, [sessionName, onRenameSession]);

  return (
    <section className="sidebar-section" data-testid="session-section">
      <h3 className="sidebar-section-title">Session</h3>
      <div className="session-item">
        {editing ? (
          <input
            ref={inputRef}
            className="session-rename-input"
            defaultValue={sessionName}
            autoFocus
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") setEditing(false);
            }}
          />
        ) : (
          <span
            className="session-name-label"
            onDoubleClick={() => {
              setEditing(true);
              requestAnimationFrame(() => inputRef.current?.select());
            }}
            title="Double-click to rename"
          >
            {sessionName}
          </span>
        )}
      </div>
      <div className="session-meta-row">
        <span className="session-meta-label">State</span>
        <span className="connection-state-pill">{connectionStateLabel}</span>
      </div>
      <div className="connected-client-summary" data-testid="connected-client-summary">
        {`${connectedClients.length} devices connected`}
      </div>
      <div className="connected-client-list" data-testid="connected-client-list">
        {connectedClients.map((client) => (
          <article
            key={client.clientId}
            className={`connected-client-card${client.clientId === selfClientId ? " is-self" : ""}`}
          >
            <div className="connected-client-primary">
              <span className="connected-client-name">
                {client.deviceName}
              </span>
              {client.clientId === selfClientId && (
                <span className="connected-client-self-badge">You</span>
              )}
            </div>
            <div className="connected-client-meta">
              <span>{client.platform}</span>
              <span>{client.mode}</span>
              <span>{formatTime(client.connectTime)}</span>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
};

const formatTime = (value: string): string => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
};

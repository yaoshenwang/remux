import type { SessionSummary } from "../../shared/protocol";

interface SessionPickerOverlayProps {
  mobileLayout: boolean;
  onSelectSession: (sessionName: string) => void;
  sessions: SessionSummary[] | null;
}

const SessionPickerOverlay = ({ mobileLayout, onSelectSession, sessions }: SessionPickerOverlayProps) => {
  if (!sessions) {
    return null;
  }

  const liveSessions = sessions.filter((session) => session.lifecycle !== "exited");
  const resurrectableSessions = sessions.filter((session) => session.lifecycle === "exited");

  return (
    <div className={`overlay${mobileLayout ? " overlay-sheet" : ""}`} data-testid="session-picker-overlay">
      <div className={`card${mobileLayout ? " card-sheet" : ""}`}>
        <h2>Select Session</h2>
        {liveSessions.length > 0 ? (
          <div className="session-picker-section">
            {liveSessions.map((session) => (
              <button
                key={session.name}
                onClick={() => onSelectSession(session.name)}
              >
                {session.name}
              </button>
            ))}
          </div>
        ) : null}
        {resurrectableSessions.length > 0 ? (
          <div className="session-picker-section session-picker-section-muted">
            <h3>Resurrectable</h3>
            <p className="session-picker-note">Saved sessions that are not currently live.</p>
            {resurrectableSessions.map((session) => (
              <button
                key={session.name}
                className="session-picker-secondary"
                onClick={() => onSelectSession(session.name)}
              >
                {session.name}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
};

export default SessionPickerOverlay;

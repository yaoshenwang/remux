import type { SessionSummary } from "../../shared/protocol";

interface SessionPickerOverlayProps {
  onSelectSession: (sessionName: string) => void;
  sessions: SessionSummary[] | null;
}

const SessionPickerOverlay = ({ onSelectSession, sessions }: SessionPickerOverlayProps) => {
  if (!sessions) {
    return null;
  }

  return (
    <div className="overlay" data-testid="session-picker-overlay">
      <div className="card">
        <h2>Select Session</h2>
        {sessions.map((session) => (
          <button
            key={session.name}
            onClick={() => onSelectSession(session.name)}
          >
            {session.name}
          </button>
        ))}
      </div>
    </div>
  );
};

export default SessionPickerOverlay;

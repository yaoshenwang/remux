import SessionPickerOverlay from "../components/SessionPickerOverlay";
import type { SessionSummary } from "../../shared/protocol.js";

interface SessionPickerScreenProps {
  mobileLayout: boolean;
  onSelectSession: (sessionName: string) => void;
  sessions: SessionSummary[] | null;
}

export const SessionPickerScreen = ({
  mobileLayout,
  onSelectSession,
  sessions,
}: SessionPickerScreenProps) => (
  <SessionPickerOverlay
    mobileLayout={mobileLayout}
    sessions={sessions}
    onSelectSession={onSelectSession}
  />
);

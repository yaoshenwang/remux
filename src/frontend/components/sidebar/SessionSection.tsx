import { useCallback, useRef, useState } from "react";

interface SessionSectionProps {
  sessionName: string;
  onRenameSession: (name: string) => void;
}

export const SessionSection = ({
  sessionName,
  onRenameSession,
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
    </section>
  );
};

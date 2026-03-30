import { useEffect, useRef } from "react";

interface InspectViewProps {
  content: string | null;
  loading: boolean;
  onRefresh: () => void;
  onRequestFull: () => void;
}

export const InspectView = ({
  content,
  loading,
  onRefresh,
  onRequestFull,
}: InspectViewProps) => {
  const preRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (preRef.current && content) {
      // Convert ANSI to simple HTML. For now, strip ANSI codes and show plain text.
      // A full ANSI-to-HTML renderer can be added later.
      preRef.current.textContent = content.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
    }
  }, [content]);

  return (
    <div className="inspect-view" data-testid="inspect-view">
      <div className="inspect-header">
        <span className="inspect-title">Inspect</span>
        <button onClick={onRefresh} disabled={loading}>
          {loading ? "Loading..." : "Refresh"}
        </button>
        <button onClick={onRequestFull} disabled={loading}>
          Full Scrollback
        </button>
      </div>
      <div className="inspect-content">
        {content === null ? (
          <p className="inspect-empty">Click Refresh to capture the current pane content.</p>
        ) : (
          <pre ref={preRef} className="inspect-pre" />
        )}
      </div>
    </div>
  );
};

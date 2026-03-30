import type { RefObject } from "react";

interface TerminalStageProps {
  mobileLayout: boolean;
  onFocusTerminal: () => void;
  terminalStatusMessage?: string;
  terminalContainerRef: RefObject<HTMLDivElement | null>;
}

export const TerminalStage = ({
  onFocusTerminal,
  terminalStatusMessage,
  terminalContainerRef,
}: TerminalStageProps) => (
  <main className="terminal-wrap">
    <div className="terminal-stage live-active">
      <div className="terminal-layer">
        <div
          className="terminal-host"
          ref={terminalContainerRef}
          data-testid="terminal-host"
          onPointerDownCapture={onFocusTerminal}
          onContextMenu={(event) => event.preventDefault()}
        >
          {terminalStatusMessage && (
            <div className="terminal-status-overlay" data-testid="terminal-status-overlay">
              <span>{terminalStatusMessage}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  </main>
);

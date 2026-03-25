import type { CSSProperties, DragEvent, RefObject } from "react";

interface TerminalStageProps {
  dragOver: boolean;
  onDragLeave: () => void;
  onDragOver: (event: DragEvent<HTMLDivElement>) => void;
  onDrop: (event: DragEvent<HTMLDivElement>) => void;
  scrollFontSize: number;
  scrollbackContentRef: RefObject<HTMLDivElement | null>;
  terminalContainerRef: RefObject<HTMLDivElement | null>;
  uploadOverlayText?: string;
  viewMode: "scroll" | "terminal";
}

export const TerminalStage = ({
  dragOver,
  onDragLeave,
  onDragOver,
  onDrop,
  scrollFontSize,
  scrollbackContentRef,
  terminalContainerRef,
  uploadOverlayText = "Drop file to upload",
  viewMode
}: TerminalStageProps) => (
  <main className="terminal-wrap">
    <div
      className="terminal-host"
      ref={terminalContainerRef}
      data-testid="terminal-host"
      style={viewMode !== "terminal" ? { display: "none" } : undefined}
      onContextMenu={(event) => event.preventDefault()}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {dragOver && (
        <div className="upload-overlay">
          <span>{uploadOverlayText}</span>
        </div>
      )}
    </div>
    {viewMode === "scroll" && (
      <div
        className="scrollback-main"
        ref={scrollbackContentRef}
        data-testid="scrollback-main"
        style={scrollFontSize > 0 ? { fontSize: `${scrollFontSize}px` } as CSSProperties : undefined}
      />
    )}
  </main>
);

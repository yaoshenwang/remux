import type { DragEvent, RefObject } from "react";
import { InspectView } from "./InspectView";
import type { TabInspectSnapshot } from "../inspect-state";

interface TerminalStageProps {
  dragOver: boolean;
  inspectErrorMessage: string;
  inspectLineCount: number;
  inspectLoading: boolean;
  inspectPaneFilter: string;
  inspectSearchQuery: string;
  inspectSnapshot: TabInspectSnapshot | null;
  onInspectLoadMore: () => void;
  onInspectPaneFilterChange: (paneId: string) => void;
  onInspectRefresh: () => void;
  onInspectSearchQueryChange: (value: string) => void;
  onFocusTerminal: () => void;
  onDragLeave: () => void;
  onDragOver: (event: DragEvent<HTMLDivElement>) => void;
  onDrop: (event: DragEvent<HTMLDivElement>) => void;
  scrollFontSize: number;
  scrollbackContentRef: RefObject<HTMLDivElement | null>;
  terminalContainerRef: RefObject<HTMLDivElement | null>;
  uploadOverlayText?: string;
  viewMode: "inspect" | "terminal";
}

export const TerminalStage = ({
  dragOver,
  inspectErrorMessage,
  inspectLineCount,
  inspectLoading,
  inspectPaneFilter,
  inspectSearchQuery,
  inspectSnapshot,
  onInspectLoadMore,
  onInspectPaneFilterChange,
  onInspectRefresh,
  onInspectSearchQueryChange,
  onFocusTerminal,
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
      onPointerDown={onFocusTerminal}
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
    {viewMode === "inspect" && (
      <InspectView
        errorMessage={inspectErrorMessage}
        lineCount={inspectLineCount}
        loading={inspectLoading}
        onLoadMore={onInspectLoadMore}
        onPaneFilterChange={onInspectPaneFilterChange}
        onRefresh={onInspectRefresh}
        onSearchQueryChange={onInspectSearchQueryChange}
        paneFilter={inspectPaneFilter}
        searchQuery={inspectSearchQuery}
        scrollFontSize={scrollFontSize}
        scrollbackContentRef={scrollbackContentRef}
        snapshot={inspectSnapshot}
      />
    )}
  </main>
);

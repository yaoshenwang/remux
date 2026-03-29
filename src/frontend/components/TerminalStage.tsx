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
  mobileLayout: boolean;
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
  terminalStatusMessage?: string;
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
  mobileLayout,
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
  terminalStatusMessage,
  terminalContainerRef,
  uploadOverlayText = "Drop file to upload",
  viewMode
}: TerminalStageProps) => (
  <main className="terminal-wrap">
    <div className={`terminal-stage${viewMode === "inspect" ? " inspect-active" : " live-active"}`}>
      <div className={`terminal-layer${viewMode !== "terminal" ? " is-hidden" : ""}`}>
        <div
          className="terminal-host"
          ref={terminalContainerRef}
          data-testid="terminal-host"
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
          {terminalStatusMessage && (
            <div className="terminal-status-overlay" data-testid="terminal-status-overlay">
              <span>{terminalStatusMessage}</span>
            </div>
          )}
        </div>
      </div>
      <div className={`inspect-layer${viewMode === "inspect" ? " is-active" : ""}`}>
        {viewMode === "inspect" && (
          <InspectView
            errorMessage={inspectErrorMessage}
            lineCount={inspectLineCount}
            loading={inspectLoading}
            mobileLayout={mobileLayout}
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
      </div>
    </div>
  </main>
);

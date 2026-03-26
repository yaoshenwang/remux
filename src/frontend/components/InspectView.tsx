import type { CSSProperties, RefObject } from "react";
import { filterInspectSections, type TabInspectSnapshot } from "../inspect-state";

interface InspectViewProps {
  lineCount: number;
  errorMessage: string;
  loading: boolean;
  onLoadMore: () => void;
  onPaneFilterChange: (paneId: string) => void;
  onRefresh: () => void;
  onSearchQueryChange: (value: string) => void;
  paneFilter: string;
  searchQuery: string;
  scrollFontSize: number;
  scrollbackContentRef: RefObject<HTMLDivElement | null>;
  snapshot: TabInspectSnapshot | null;
}

const precisionLabel: Record<TabInspectSnapshot["precision"], string> = {
  precise: "precise",
  approximate: "approximate",
  partial: "partial"
};

const sourceLabel: Record<TabInspectSnapshot["source"], string> = {
  backend_capture: "backend capture",
  server_tab_history: "server timeline"
};

export const InspectView = ({
  lineCount,
  errorMessage,
  loading,
  onLoadMore,
  onPaneFilterChange,
  onRefresh,
  onSearchQueryChange,
  paneFilter,
  searchQuery,
  scrollFontSize,
  scrollbackContentRef,
  snapshot
}: InspectViewProps) => {
  const visibleSections = snapshot
    ? filterInspectSections(snapshot, { paneId: paneFilter, query: searchQuery })
    : [];
  const capturedLabel = snapshot
    ? new Date(snapshot.capturedAt).toLocaleString()
    : "";

  return (
    <div
      className="scrollback-main"
      ref={scrollbackContentRef}
      data-testid="scrollback-main"
      style={scrollFontSize > 0 ? { fontSize: `${scrollFontSize}px` } as CSSProperties : undefined}
    >
      <div className="inspect-header">
        <div className="inspect-title-wrap">
          <h2 className="inspect-title">Inspect</h2>
          {snapshot && (
            <p className="inspect-summary">
              {snapshot.sessionName} / tab {snapshot.tabIndex}: {snapshot.tabName}
            </p>
          )}
        </div>
        <div className="inspect-badges">
          <span className="inspect-badge" data-testid="inspect-scope-badge">Tab History</span>
          <span className="inspect-badge" data-testid="inspect-source-badge">
            {snapshot ? sourceLabel[snapshot.source] : "loading"}
          </span>
          <span className="inspect-badge" data-testid="inspect-precision-badge">
            {snapshot ? precisionLabel[snapshot.precision] : "loading"}
          </span>
          <span className="inspect-badge" data-testid="inspect-line-count-badge">{lineCount} lines</span>
        </div>
      </div>

      <div className="inspect-toolbar">
        <input
          className="inspect-search"
          type="search"
          placeholder="Search current tab history"
          value={searchQuery}
          onChange={(event) => onSearchQueryChange(event.target.value)}
          data-testid="inspect-search-input"
        />
        <button className="inspect-action-btn" onClick={onRefresh} data-testid="inspect-refresh-button">
          Refresh
        </button>
        <button className="inspect-action-btn" onClick={onLoadMore} data-testid="inspect-load-more-button">
          More
        </button>
      </div>

      {snapshot && (
        <div className="inspect-pane-filters">
          <button
            className={`inspect-filter-chip${paneFilter === "all" ? " active" : ""}`}
            onClick={() => onPaneFilterChange("all")}
            data-testid="inspect-pane-filter-all"
          >
            All panes
          </button>
          {snapshot.sections.map((section) => (
            <button
              key={section.paneId}
              className={`inspect-filter-chip${paneFilter === section.paneId ? " active" : ""}`}
              onClick={() => onPaneFilterChange(section.paneId)}
              data-testid={`inspect-pane-filter-${section.paneId}`}
            >
              {section.title.split(" · ")[0]}
            </button>
          ))}
        </div>
      )}

      {snapshot && (
        <div className="inspect-meta-row">
          <span data-testid="inspect-captured-at">Captured {capturedLabel}</span>
          <span>{visibleSections.length}/{snapshot.sections.length} panes shown · {snapshot.events.length} events</span>
        </div>
      )}

      {snapshot?.events.length ? (
        <section className="inspect-events" data-testid="inspect-events">
          <div className="inspect-events-header">Timeline</div>
          {snapshot.events.map((event) => (
            <div key={event.id} className="inspect-event-row" data-testid={`inspect-event-${event.id}`}>
              <span className="inspect-event-time">{new Date(event.at).toLocaleTimeString()}</span>
              <span className="inspect-event-text">{event.text}</span>
            </div>
          ))}
        </section>
      ) : null}

      {loading && !snapshot && (
        <div className="inspect-empty" data-testid="inspect-loading">
          Loading current tab history…
        </div>
      )}

      {loading && snapshot && (
        <div className="inspect-note">
          Refreshing history…
        </div>
      )}

      {errorMessage && (
        <div className="inspect-empty inspect-error" data-testid="inspect-error">
          {errorMessage}
        </div>
      )}

      {snapshot && snapshot.sections.length === 0 && !errorMessage && (
        <div className="inspect-empty">No captured history for this tab yet.</div>
      )}

      {snapshot?.missingPaneIds.length ? (
        <div className="inspect-note">
          Missing panes: {snapshot.missingPaneIds.join(", ")}
        </div>
      ) : null}

      {snapshot && visibleSections.length === 0 && snapshot.sections.length > 0 ? (
        <div className="inspect-empty">No panes match the current filter.</div>
      ) : null}

      {visibleSections.map((section) => (
        <section
          key={section.paneId}
          className="inspect-pane"
          data-testid={`inspect-pane-${section.paneId}`}
        >
          <div className="inspect-pane-header">
            <strong>{section.title}</strong>
            <span className="inspect-pane-meta">
              {section.precision} · width {section.paneWidth}
            </span>
          </div>
          <div
            className="inspect-pane-content"
            dangerouslySetInnerHTML={{ __html: section.html }}
          />
        </section>
      ))}
    </div>
  );
};

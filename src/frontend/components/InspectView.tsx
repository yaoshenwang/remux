import { useEffect, useRef, type ReactNode } from "react";
import type { WorkspacePane } from "../hooks/useZellijControl.js";
import type { InspectHighlight, InspectItem, InspectSnapshot } from "../inspect/types.js";

interface InspectViewProps {
  snapshot: InspectSnapshot | null;
  loading: boolean;
  error: string | null;
  scope: "pane" | "tab";
  selectedPaneId: string | null;
  paneOptions: WorkspacePane[];
  searchQuery: string;
  onRefresh: () => void;
  onLoadMore: () => void;
  onScopeChange: (scope: "pane" | "tab") => void;
  onPaneChange: (paneId: string) => void;
  onSearchChange: (value: string) => void;
}

interface InspectGroup {
  id: string;
  label: string;
  items: InspectItem[];
}

const badgeText = {
  source: (value: string) => `Source: ${value}`,
  precision: (value: string) => `Precision: ${value}`,
  staleness: (value: string) => `Staleness: ${value}`,
};

const badgeHelp = {
  runtime_capture: "Directly captured from the live Zellij pane.",
  state_tracker: "Derived from the backend terminal state tracker.",
  local_cache: "Loaded from browser cache before a fresh fetch completed.",
  precise: "Exact line ordering is trusted for this scope.",
  approximate: "The snapshot is usable but timing or completeness is approximate.",
  partial: "The snapshot is segmented and may omit cross-pane ordering detail.",
  fresh: "Snapshot was fetched from the backend recently.",
  stale: "Snapshot may be out of date and should be refreshed.",
  unknown: "Snapshot freshness could not be determined.",
};

const formatAbsoluteTimestamp = (timestamp: string): string => {
  const value = new Date(timestamp);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
};

const formatRelativeTimestamp = (timestamp: string): string => {
  const diffSeconds = Math.max(0, Math.round((Date.now() - new Date(timestamp).getTime()) / 1000));
  if (diffSeconds < 60) {
    return `${diffSeconds}s ago`;
  }
  if (diffSeconds < 3600) {
    return `${Math.round(diffSeconds / 60)}m ago`;
  }
  return `${Math.round(diffSeconds / 3600)}h ago`;
};

const highlightContent = (
  content: string,
  highlights?: InspectHighlight[],
  fallbackQuery?: string,
): Array<string | ReactNode> => {
  const resolvedHighlights = highlights && highlights.length > 0
    ? highlights
    : fallbackQuery
      ? collectFallbackHighlights(content, fallbackQuery)
      : [];
  if (resolvedHighlights.length === 0) {
    return [content];
  }

  const segments: Array<string | ReactNode> = [];
  let cursor = 0;
  resolvedHighlights.forEach((highlight, index) => {
    if (highlight.start > cursor) {
      segments.push(content.slice(cursor, highlight.start));
    }
    segments.push(
      <mark key={`${highlight.start}-${highlight.end}-${index}`}>
        {content.slice(highlight.start, highlight.end)}
      </mark>,
    );
    cursor = highlight.end;
  });
  if (cursor < content.length) {
    segments.push(content.slice(cursor));
  }
  return segments;
};

const collectFallbackHighlights = (content: string, query: string): InspectHighlight[] => {
  const normalizedContent = content.toLocaleLowerCase();
  const normalizedQuery = query.toLocaleLowerCase();
  const highlights: InspectHighlight[] = [];
  let cursor = normalizedContent.indexOf(normalizedQuery);
  while (cursor !== -1) {
    highlights.push({
      start: cursor,
      end: cursor + normalizedQuery.length,
    });
    cursor = normalizedContent.indexOf(normalizedQuery, cursor + normalizedQuery.length);
  }
  return highlights;
};

export const InspectView = ({
  snapshot,
  loading,
  error,
  scope,
  selectedPaneId,
  paneOptions,
  searchQuery,
  onRefresh,
  onLoadMore,
  onScopeChange,
  onPaneChange,
  onSearchChange,
}: InspectViewProps) => {
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (
      !snapshot?.cursor ||
      loading ||
      !sentinelRef.current ||
      typeof IntersectionObserver === "undefined" ||
      snapshot.items.length < 10
    ) {
      return;
    }

    const sentinel = sentinelRef.current;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        onLoadMore();
      }
    }, { rootMargin: "200px 0px" });

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loading, onLoadMore, snapshot?.cursor]);

  const groups: InspectGroup[] = [];
  if (snapshot) {
    let currentGroup: InspectGroup | null = null;
    snapshot.items.forEach((item) => {
      const groupId = item.paneId ?? "ungrouped";
      if (item.type === "marker") {
        currentGroup = {
          id: groupId,
          label: item.content,
          items: [],
        };
        groups.push(currentGroup);
        return;
      }

      if (!currentGroup || currentGroup.id !== groupId) {
        currentGroup = {
          id: groupId,
          label: `Pane ${groupId}`,
          items: [],
        };
        groups.push(currentGroup);
      }
      currentGroup.items.push(item);
    });
  }

  const descriptor = snapshot?.descriptor;
  const source = descriptor?.source ?? "unknown";
  const precision = descriptor?.precision ?? "unknown";
  const staleness = descriptor?.staleness ?? "unknown";

  return (
    <div className="inspect-view" data-testid="inspect-view">
      <div className="inspect-header">
        <div>
          <h2 className="inspect-title">Inspect</h2>
          <p className="inspect-summary">
            Readable runtime history for the active workspace scope.
          </p>
        </div>
        <div className="inspect-badges">
          <span className={`inspect-badge inspect-badge--source-${source}`} title={badgeHelp[source as keyof typeof badgeHelp]}>
            {badgeText.source(source)}
          </span>
          <span className={`inspect-badge inspect-badge--precision-${precision}`} title={badgeHelp[precision as keyof typeof badgeHelp]}>
            {badgeText.precision(precision)}
          </span>
          <span className={`inspect-badge inspect-badge--staleness-${staleness}`} title={badgeHelp[staleness as keyof typeof badgeHelp]}>
            {badgeText.staleness(staleness)}
          </span>
        </div>
      </div>

      <div className="inspect-toolbar">
        <button
          type="button"
          aria-label="Tab Scope"
          className={`inspect-filter-chip${scope === "tab" ? " active" : ""}`}
          onClick={() => onScopeChange("tab")}
        >
          Tab Scope
        </button>
        <button
          type="button"
          aria-label="Pane Scope"
          className={`inspect-filter-chip${scope === "pane" ? " active" : ""}`}
          onClick={() => onScopeChange("pane")}
        >
          Pane Scope
        </button>
        <input
          className="inspect-search"
          placeholder="Search inspect history"
          value={searchQuery}
          onChange={(event) => onSearchChange(event.target.value)}
        />
        <button type="button" className="inspect-action-btn" onClick={onRefresh} disabled={loading}>
          {loading ? "Loading..." : "Refresh"}
        </button>
      </div>

      {scope === "pane" && paneOptions.length > 0 && (
        <div className="inspect-pane-filters">
          {paneOptions.map((pane) => (
            <button
              key={pane.id}
              type="button"
              className={`inspect-filter-chip${selectedPaneId === pane.id ? " active" : ""}`}
              onClick={() => onPaneChange(pane.id)}
            >
              {pane.title || pane.id}
            </button>
          ))}
        </div>
      )}

      <div className="inspect-meta-row">
        <span>Total: {descriptor?.totalItems ?? snapshot?.items.length ?? 0}</span>
        <span>Captured: {descriptor?.capturedAt ? formatAbsoluteTimestamp(descriptor.capturedAt) : "unknown"}</span>
        <span>{descriptor?.capturedAt ? formatRelativeTimestamp(descriptor.capturedAt) : "no timestamp"}</span>
      </div>

      {error && <p className="inspect-note inspect-error">{error}</p>}

      <div className="inspect-content">
        {!snapshot && !loading ? (
          <p className="inspect-empty">Inspect history will appear here when the backend responds.</p>
        ) : (
          groups.length === 0 ? (
            <p className="inspect-empty">No inspect lines matched the current scope.</p>
          ) : groups.map((group, index) => (
            <section key={`${group.id}-${index}`} className="inspect-pane">
              <div className="inspect-pane-header">
                <strong>{group.label}</strong>
                <span className="inspect-pane-meta">{group.id}</span>
              </div>
              <div className="inspect-pane-content">
                {group.items.length === 0 ? (
                  <p className="inspect-empty">No matching lines in this pane.</p>
                ) : (
                  group.items.map((item) => (
                    <div key={`${group.id}-${item.lineNumber ?? "marker"}-${item.content}`} className="inspect-event-row">
                      <span className="inspect-event-time">
                        {item.lineNumber === null ? "section" : String(item.lineNumber).padStart(4, "0")}
                      </span>
                      <span className="inspect-event-text">
                        {highlightContent(item.content, item.highlights, searchQuery)}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </section>
          ))
        )}

        {snapshot?.cursor && (
          <button type="button" className="inspect-action-btn" onClick={onLoadMore} disabled={loading}>
            Load More
          </button>
        )}
        <div ref={sentinelRef} />
      </div>
    </div>
  );
};

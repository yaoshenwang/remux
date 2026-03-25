import type { BackendCapabilities, PaneState, TabState } from "../../../shared/protocol";

interface PaneSectionProps {
  activePane: PaneState | undefined;
  activeTab: TabState | undefined;
  capabilities: BackendCapabilities | null;
  onClosePane: (paneId: string, isActive: boolean) => void;
  onNewTab: () => void;
  onSelectPane: (pane: PaneState, isActive: boolean) => void;
  onSplitPane: (direction: "right" | "down") => void;
  onToggleFullscreen: () => void;
  onToggleStickyZoom: () => void;
  stickyZoom: boolean;
}

export const PaneSection = ({
  activePane,
  activeTab,
  capabilities,
  onClosePane,
  onNewTab,
  onSelectPane,
  onSplitPane,
  onToggleFullscreen,
  onToggleStickyZoom,
  stickyZoom
}: PaneSectionProps) => (
  <>
    <button
      className="drawer-section-action"
      onClick={onNewTab}
      disabled={!activeTab}
      data-testid="new-tab-button"
    >
      + New Tab
    </button>

    <h3>Panes ({activeTab ? `${activeTab.index}` : "-"})</h3>
    <ul>
      {activeTab
        ? activeTab.panes.map((pane) => {
            const isActive = pane.id === activePane?.id;
            return (
              <li key={pane.id}>
                <div className="drawer-item-row">
                  <button
                    onClick={() => onSelectPane(pane, isActive)}
                    className={`drawer-item-main${isActive ? " active" : ""}`}
                  >
                    <span className="item-name">%{pane.index}: {pane.currentCommand} {isActive ? "*" : ""}</span>
                    {isActive && pane.zoomed ? (
                      <span
                        className="pane-zoom-indicator on"
                        title="Active pane is zoomed"
                        aria-label="Pane zoom: on"
                        data-testid="active-pane-zoom-indicator"
                      >
                        🔍
                      </span>
                    ) : null}
                  </button>
                  <button
                    type="button"
                    className="drawer-close-action"
                    onClick={(event) => {
                      event.stopPropagation();
                      onClosePane(pane.id, isActive);
                    }}
                    disabled={activeTab.panes.length <= 1}
                    data-testid={`close-pane-${pane.id}`}
                    aria-label={`Close pane ${pane.id}`}
                    title={`Close pane ${pane.id}`}
                  >
                    <span aria-hidden="true">×</span>
                  </button>
                </div>
              </li>
            );
          })
        : null}
    </ul>
    <div className="drawer-grid">
      <button
        onClick={() => onSplitPane("right")}
        disabled={!activePane}
        title="Split pane horizontally — create a side-by-side layout"
      >
        Split H
      </button>
      <button
        onClick={() => onSplitPane("down")}
        disabled={!activePane}
        title="Split pane vertically — create a top-bottom layout"
      >
        Split V
      </button>
    </div>
    <button
      className="drawer-section-action"
      onClick={onToggleFullscreen}
      disabled={!activePane || !activeTab || activeTab.paneCount <= 1 || !capabilities?.supportsFullscreenPane}
    >
      Zoom Pane
    </button>
    <button
      className={`drawer-section-action${stickyZoom ? " active" : ""}`}
      onClick={onToggleStickyZoom}
      disabled={!capabilities?.supportsFullscreenPane}
      data-testid="sticky-zoom-toggle"
      title="Sticky zoom — automatically zoom the pane when switching windows or panes"
    >
      Sticky Zoom: {stickyZoom ? "On" : "Off"}
    </button>
  </>
);

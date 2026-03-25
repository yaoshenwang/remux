import type { TopStatus } from "../app-status";
import type { BandwidthStats, ServerConfig } from "../app-types";

interface AppHeaderProps {
  activeTabLabel: string;
  awaitingSessionSelection: boolean;
  bandwidthStats: BandwidthStats | null;
  onToggleDrawer: () => void;
  onSelectTab: (tabIndex: number) => void;
  onToggleSidebarCollapsed: () => void;
  onToggleStats: () => void;
  onToggleViewMode: () => void;
  onCreateTab?: () => void;
  sidebarCollapsed: boolean;
  serverConfig: ServerConfig | null;
  tabs: Array<{
    index: number;
    isActive: boolean;
    label: string;
  }>;
  topStatus: TopStatus;
  viewMode: "scroll" | "terminal";
  supportsPreciseScrollback: boolean;
  formatBytes: (bytes: number) => string;
}

export const AppHeader = ({
  activeTabLabel,
  awaitingSessionSelection,
  bandwidthStats,
  onToggleDrawer,
  onSelectTab,
  onToggleSidebarCollapsed,
  onToggleStats,
  onToggleViewMode,
  onCreateTab,
  sidebarCollapsed,
  serverConfig,
  tabs,
  topStatus,
  viewMode,
  supportsPreciseScrollback,
  formatBytes
}: AppHeaderProps) => (
  <header className="tab-bar">
    <button
      onClick={onToggleDrawer}
      className="tab-bar-burger"
      data-testid="drawer-toggle"
      title="Open sidebar — manage panes, themes, and advanced options"
    >
      ☰
    </button>
    <button
      onClick={onToggleSidebarCollapsed}
      className="tab-bar-sidebar-toggle"
      title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
    >
      {sidebarCollapsed ? "▶" : "◀"}
    </button>
    <div className="top-title">
      {awaitingSessionSelection ? "Select Session" : `Tab: ${activeTabLabel}`}
      {serverConfig?.backendKind === "zellij" && (
        <span className="experimental-badge" title="Zellij support is experimental">(experimental)</span>
      )}
    </div>
    {!awaitingSessionSelection && tabs.length > 0 ? (
      <div className="tab-list" data-testid="tab-list">
        {tabs.map((tab) => (
          <button
            key={tab.index}
            className={`tab${tab.isActive ? " active" : ""}`}
            onClick={() => onSelectTab(tab.index)}
          >
            <span className="tab-label">{tab.label}</span>
          </button>
        ))}
        {onCreateTab ? (
          <button
            className="tab tab-new"
            onClick={onCreateTab}
            title="New tab"
          >
            +
          </button>
        ) : null}
      </div>
    ) : null}
    <div className="tab-bar-actions">
      <span
        className={`top-status ${topStatus.kind}`}
        title={topStatus.label}
        aria-label={`Status: ${topStatus.label}`}
        data-testid="top-status-indicator"
      />
      {bandwidthStats && (
        <button
          className={`bandwidth-indicator ${bandwidthStats.savedPercent > 50 ? "good" : bandwidthStats.savedPercent > 20 ? "ok" : "low"}`}
          onClick={onToggleStats}
          title={`Bandwidth: ${formatBytes(bandwidthStats.compressedBytesPerSec)}/s (${bandwidthStats.savedPercent}% saved). Click for details.`}
        >
          ↓{formatBytes(bandwidthStats.compressedBytesPerSec)}/s
          {bandwidthStats.savedPercent > 0 && <span className="saved-badge">{bandwidthStats.savedPercent}%</span>}
        </button>
      )}
      <button
        className={`top-btn${viewMode === "terminal" ? " active" : ""}`}
        title="Toggle between terminal view and scrollback history"
        onClick={onToggleViewMode}
      >
        {viewMode === "scroll" ? "Term" : "Scroll"}
        {viewMode === "scroll" && !supportsPreciseScrollback && (
          <span className="experimental-badge" title="Scrollback is approximate for this backend"> (approx)</span>
        )}
      </button>
    </div>
  </header>
);

import { useRef } from "react";
import type { DragEvent, MutableRefObject } from "react";
import type { TopStatus } from "../app-status";
import type { BandwidthStats, ServerConfig } from "../app-types";

interface AppHeaderProps {
  activeTabLabel: string;
  awaitingSessionSelection: boolean;
  bandwidthStats: BandwidthStats | null;
  beginDrag: (event: DragEvent<HTMLElement>, type: "session" | "tab" | "snippet", value: string) => void;
  draggedTabKey: string | null;
  mobileLayout: boolean;
  onCloseTab: (tabIndex: number) => void;
  onRenameTab: (tabIndex: number, newName: string) => void;
  onToggleDrawer: () => void;
  onSelectTab: (tabIndex: number) => void;
  onReorderTabs: (draggedTabKey: string, targetKey: string) => void;
  onSetDraggedTabKey: (value: string | null) => void;
  onSetRenameTabValue: (value: string) => void;
  onSetRenamingTab: (value: number | null) => void;
  onSetTabDropTarget: (value: string | null | ((current: string | null) => string | null)) => void;
  onToggleSidebarCollapsed: () => void;
  onToggleStats: () => void;
  onToggleViewMode: () => void;
  onCreateTab?: () => void;
  renameHandledByKeyRef: MutableRefObject<boolean>;
  renameTabValue: string;
  sidebarCollapsed: boolean;
  serverConfig: ServerConfig | null;
  supportsTabRename: boolean;
  tabDropTarget: string | null;
  tabs: Array<{
    canClose: boolean;
    index: number;
    isActive: boolean;
    isRenaming: boolean;
    key: string;
    label: string;
    name: string;
  }>;
  topStatus: TopStatus;
  viewMode: "inspect" | "terminal";
  supportsPreciseScrollback: boolean;
  formatBytes: (bytes: number) => string;
}

export const AppHeader = ({
  activeTabLabel,
  awaitingSessionSelection,
  bandwidthStats,
  beginDrag,
  draggedTabKey,
  mobileLayout,
  onCloseTab,
  onRenameTab,
  onToggleDrawer,
  onReorderTabs,
  onSelectTab,
  onSetDraggedTabKey,
  onSetRenameTabValue,
  onSetRenamingTab,
  onSetTabDropTarget,
  onToggleSidebarCollapsed,
  onToggleStats,
  onToggleViewMode,
  onCreateTab,
  renameHandledByKeyRef,
  renameTabValue,
  sidebarCollapsed,
  serverConfig,
  supportsTabRename,
  tabDropTarget,
  tabs,
  topStatus,
  viewMode,
  supportsPreciseScrollback,
  formatBytes
}: AppHeaderProps) => {
  const showTabs = !awaitingSessionSelection && tabs.length > 0;
  const mobileRenameTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressNextSelectRef = useRef<number | null>(null);
  const mobileStatsTitle = bandwidthStats
    ? `${topStatus.label}. ${formatBytes(bandwidthStats.compressedBytesPerSec)}/s, ${bandwidthStats.savedPercent}% saved.`
    : topStatus.label;

  const clearMobileRenameTimer = (): void => {
    if (mobileRenameTimerRef.current) {
      clearTimeout(mobileRenameTimerRef.current);
      mobileRenameTimerRef.current = null;
    }
  };

  return (
    <header className="tab-bar">
      <button
        onClick={onToggleDrawer}
        className="tab-bar-burger"
        data-testid="drawer-toggle"
        title="Open sidebar — manage sessions, themes, and snippets"
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
      {showTabs ? (
        <div className="tab-list" data-testid="tab-list">
          {tabs.map((tab) => (
            <div
              key={tab.index}
              className={`tab-shell${tab.isActive ? " active" : ""}${tabDropTarget === tab.key ? " drag-target" : ""}`}
              data-testid={`header-tab-${tab.index}`}
              data-tab-key={tab.key}
              onDragOver={(event) => {
                if (mobileLayout) {
                  return;
                }
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
              }}
              onDragEnter={(event) => {
                if (mobileLayout) {
                  return;
                }
                event.preventDefault();
                if (draggedTabKey && draggedTabKey !== tab.key) {
                  onSetTabDropTarget(tab.key);
                  onReorderTabs(draggedTabKey, tab.key);
                }
              }}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                  onSetTabDropTarget((current) => current === tab.key ? null : current);
                }
              }}
              onDrop={(event) => {
                if (mobileLayout) {
                  return;
                }
                event.preventDefault();
                if (!draggedTabKey || draggedTabKey === tab.key) {
                  onSetTabDropTarget(null);
                  return;
                }
                onReorderTabs(draggedTabKey, tab.key);
                onSetDraggedTabKey(null);
                onSetTabDropTarget(null);
              }}
            >
              {tab.isRenaming ? (
                <input
                  className="tab-rename-input"
                  value={renameTabValue}
                  onChange={(event) => onSetRenameTabValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && renameTabValue.trim()) {
                      renameHandledByKeyRef.current = true;
                      onRenameTab(tab.index, renameTabValue.trim());
                      onSetRenamingTab(null);
                    } else if (event.key === "Escape") {
                      renameHandledByKeyRef.current = true;
                      onSetRenamingTab(null);
                    }
                  }}
                  onBlur={() => {
                    if (renameHandledByKeyRef.current) {
                      renameHandledByKeyRef.current = false;
                      return;
                    }
                    if (renameTabValue.trim() && renameTabValue.trim() !== tab.name) {
                      onRenameTab(tab.index, renameTabValue.trim());
                    }
                    onSetRenamingTab(null);
                  }}
                  autoFocus
                  data-testid={`header-tab-rename-${tab.index}`}
                />
              ) : (
                <>
                  <button
                    className={`tab${tab.isActive ? " active" : ""}`}
                    draggable={!mobileLayout}
                    onClick={() => {
                      if (suppressNextSelectRef.current === tab.index) {
                        suppressNextSelectRef.current = null;
                        return;
                      }
                      onSelectTab(tab.index);
                    }}
                    onDoubleClick={supportsTabRename ? () => {
                      onSetRenamingTab(tab.index);
                      onSetRenameTabValue(tab.name);
                    } : undefined}
                    onPointerDown={() => {
                      if (!mobileLayout || !supportsTabRename) {
                        return;
                      }
                      clearMobileRenameTimer();
                      mobileRenameTimerRef.current = setTimeout(() => {
                        suppressNextSelectRef.current = tab.index;
                        onSetRenamingTab(tab.index);
                        onSetRenameTabValue(tab.name);
                      }, 450);
                    }}
                    onPointerLeave={clearMobileRenameTimer}
                    onPointerUp={clearMobileRenameTimer}
                    onPointerCancel={clearMobileRenameTimer}
                    onDragStart={(event) => {
                      if (mobileLayout) {
                        return;
                      }
                      beginDrag(event, "tab", tab.key);
                      onSetDraggedTabKey(tab.key);
                    }}
                    onDragEnd={() => {
                      clearMobileRenameTimer();
                      onSetDraggedTabKey(null);
                      onSetTabDropTarget(null);
                    }}
                    data-testid={`header-tab-button-${tab.index}`}
                  >
                    <span className="tab-label">{tab.label}</span>
                  </button>
                  {tab.canClose ? (
                    <button
                      type="button"
                      className="tab-close"
                      onClick={(event) => {
                        event.stopPropagation();
                        onCloseTab(tab.index);
                      }}
                      title={`Close tab ${tab.index}`}
                      aria-label={`Close tab ${tab.index}`}
                      data-testid={`header-tab-close-${tab.index}`}
                    >
                      ×
                    </button>
                  ) : null}
                </>
              )}
            </div>
          ))}
          {onCreateTab ? (
            <button
              className="tab-new"
              onClick={onCreateTab}
              title="New tab"
              aria-label="New tab"
            >
              +
            </button>
          ) : null}
        </div>
      ) : (
        <div className="top-title">
          {awaitingSessionSelection ? "Select Session" : `Tab: ${activeTabLabel}`}
          {serverConfig?.backendKind === "zellij" && (
            <span className="experimental-badge" title="Zellij support is experimental">(experimental)</span>
          )}
        </div>
      )}
      <div className="tab-bar-actions">
        {mobileLayout ? (
          <button
            type="button"
            className={`top-status-button ${topStatus.kind}`}
            onClick={onToggleStats}
            title={mobileStatsTitle}
            aria-label={`Open connection stats. ${mobileStatsTitle}`}
            data-testid="mobile-stats-toggle"
          >
            <span
              className={`top-status ${topStatus.kind}`}
              title={topStatus.label}
              aria-label={`Status: ${topStatus.label}`}
              data-testid="top-status-indicator"
            />
          </button>
        ) : (
          <span
            className={`top-status ${topStatus.kind}`}
            title={topStatus.label}
            aria-label={`Status: ${topStatus.label}`}
            data-testid="top-status-indicator"
          />
        )}
        {!mobileLayout && bandwidthStats && (
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
          className={`top-btn${viewMode === "inspect" ? " active" : ""}`}
          title="Toggle between live terminal and inspect history"
          onClick={onToggleViewMode}
        >
          {viewMode === "inspect" ? "Live" : "Inspect"}
          {viewMode === "inspect" && !supportsPreciseScrollback && (
            <span className="experimental-badge" title="Inspect history is approximate for this backend"> (approx)</span>
          )}
        </button>
      </div>
    </header>
  );
};

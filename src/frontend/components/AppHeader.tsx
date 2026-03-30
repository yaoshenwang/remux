import { useCallback, useRef, useState } from "react";
import type { WorkspaceTab } from "../hooks/useZellijControl";
import type { ClientMode } from "../protocol/client-state";

interface AppHeaderProps {
  mobileLayout: boolean;
  onToggleDrawer: () => void;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;

  // Tab data
  tabs: WorkspaceTab[];
  activeTabIndex: number;
  sessionName: string;

  // Tab actions
  onSelectTab: (tabIndex: number) => void;
  onCloseTab: (tabIndex: number) => void;
  onNewTab: () => void;
  onRenameTab: (tabIndex: number, name: string) => void;

  // View mode
  viewMode: "terminal" | "inspect";
  onSetViewMode: (mode: "terminal" | "inspect") => void;
  clientMode: ClientMode;
  onToggleClientMode: () => void;
  connectionStateLabel: string;
}

export const AppHeader = ({
  mobileLayout,
  onToggleDrawer,
  sidebarCollapsed,
  onToggleSidebar,
  tabs,
  activeTabIndex,
  sessionName,
  onSelectTab,
  onCloseTab,
  onNewTab,
  onRenameTab,
  viewMode,
  onSetViewMode,
  clientMode,
  onToggleClientMode,
  connectionStateLabel,
}: AppHeaderProps) => {
  const [renamingTab, setRenamingTab] = useState<number | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  const handleDoubleClick = useCallback((tabIndex: number) => {
    setRenamingTab(tabIndex);
    requestAnimationFrame(() => renameInputRef.current?.select());
  }, []);

  const commitRename = useCallback(() => {
    if (renamingTab === null) return;
    const value = renameInputRef.current?.value.trim();
    if (value) onRenameTab(renamingTab, value);
    setRenamingTab(null);
  }, [renamingTab, onRenameTab]);

  return (
    <header className="app-header" data-testid="app-header">
      <div className="app-header-left">
        {mobileLayout && (
          <button className="header-btn hamburger-btn" onClick={onToggleDrawer} title="Menu">
            <span className="material-icon">&#9776;</span>
          </button>
        )}
        {!mobileLayout && (
          <button className="header-btn sidebar-toggle-btn" onClick={onToggleSidebar} title="Toggle sidebar">
            {sidebarCollapsed ? "▸" : "◂"}
          </button>
        )}
        <span className="session-name" title={sessionName}>{sessionName}</span>
      </div>

      {/* Tab bar */}
      <nav className="tab-bar" data-testid="tab-bar">
        {tabs.map((tab) => (
          <button
            key={tab.index}
            className={`tab-item${tab.active ? " active" : ""}${tab.hasBell ? " bell" : ""}`}
            onClick={() => onSelectTab(tab.index)}
            onDoubleClick={() => handleDoubleClick(tab.index)}
            title={tab.name}
          >
            {renamingTab === tab.index ? (
              <input
                ref={renameInputRef}
                className="tab-rename-input"
                defaultValue={tab.name}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename();
                  if (e.key === "Escape") setRenamingTab(null);
                }}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span className="tab-label">{tab.name}</span>
            )}
            {tabs.length > 1 && (
              <span
                className="tab-close"
                onClick={(e) => { e.stopPropagation(); onCloseTab(tab.index); }}
                title="Close tab"
              >
                ×
              </span>
            )}
          </button>
        ))}
        <button className="tab-item tab-new" onClick={onNewTab} title="New tab">+</button>
      </nav>

      <div className="app-header-right">
        {mobileLayout && (
          <span className="connection-state-badge" data-testid="mobile-connection-state">
            {connectionStateLabel}
          </span>
        )}
        <button
          className={`client-mode-toggle ${clientMode === "observer" ? "observer" : "active"}`}
          onClick={onToggleClientMode}
          type="button"
        >
          {`Mode: ${clientMode === "active" ? "Active" : "Observer"}`}
        </button>
        {/* View mode toggle */}
        <div className="view-mode-toggle">
          <button
            className={viewMode === "terminal" ? "active" : ""}
            onClick={() => onSetViewMode("terminal")}
          >
            Live
          </button>
          <button
            className={viewMode === "inspect" ? "active" : ""}
            onClick={() => onSetViewMode("inspect")}
          >
            Inspect
          </button>
        </div>
      </div>
    </header>
  );
};

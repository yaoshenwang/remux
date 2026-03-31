import type { CSSProperties, ReactNode } from "react";

interface AppShellProps {
  drawerOpen: boolean;
  mobileLandscape: boolean;
  mobileLayout: boolean;
  onCloseDrawer: () => void;
  sidebar: ReactNode;
  sidebarCollapsed: boolean;
  viewportHeight: number;
  viewportOffsetLeft: number;
  viewportOffsetTop: number;
  children: ReactNode;
}

export const AppShell = ({
  drawerOpen,
  mobileLandscape,
  mobileLayout,
  onCloseDrawer,
  sidebar,
  sidebarCollapsed,
  viewportHeight,
  viewportOffsetLeft,
  viewportOffsetTop,
  children,
}: AppShellProps) => (
  <div
    className={`app-shell${sidebarCollapsed ? " sidebar-collapsed" : ""}${mobileLayout ? " mobile-layout" : ""}${mobileLandscape ? " mobile-landscape" : ""}`}
    style={{
      "--app-height": `${viewportHeight}px`,
      "--app-offset-left": `${viewportOffsetLeft}px`,
      "--app-offset-top": `${viewportOffsetTop}px`,
    } as CSSProperties}
  >
    <div className="app-shell-content">
      {children}
    </div>
    <div className="app-shell-sidebar" data-testid="app-shell-sidebar">
      {sidebar}
    </div>

    {mobileLayout && drawerOpen && (
      <button
        className="sidebar-close mobile-drawer-close"
        onClick={onCloseDrawer}
        data-testid="drawer-close"
        aria-label="Close sidebar"
      >
        <span className="sidebar-close-icon" aria-hidden="true">×</span>
      </button>
    )}

    {drawerOpen && <div className="sidebar-backdrop" onClick={onCloseDrawer} data-testid="drawer-backdrop" />}
  </div>
);

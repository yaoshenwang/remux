import type { CSSProperties, ReactNode } from "react";

interface AppShellProps {
  drawerOpen: boolean;
  mobileLandscape: boolean;
  mobileLayout: boolean;
  onCloseDrawer: () => void;
  sidebar: ReactNode;
  sidebarCollapsed: boolean;
  viewportHeight: number;
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
  children,
}: AppShellProps) => (
  <div
    className={`app-shell${sidebarCollapsed ? " sidebar-collapsed" : ""}${mobileLayout ? " mobile-layout" : ""}${mobileLandscape ? " mobile-landscape" : ""}`}
    style={{ "--app-height": `${viewportHeight}px` } as CSSProperties}
  >
    {children}
    {sidebar}

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

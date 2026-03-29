/**
 * Client-side preference persistence.
 *
 * Manages theme, sidebar state, sticky zoom, inspect font size,
 * and workspace ordering — all stored in localStorage.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { matchesMobileLayout } from "../mobile-layout";
import {
  normalizeWorkspaceOrder,
  WORKSPACE_ORDER_STORAGE_KEY,
  type WorkspaceOrderState
} from "../workspace-order";

const getInitialStickyZoom = (): boolean => {
  const stored = localStorage.getItem("remux-sticky-zoom");
  if (stored === "true") return true;
  if (stored === "false") return false;
  return matchesMobileLayout();
};

export interface UseClientPreferencesResult {
  theme: "dark" | "light";
  setTheme: (t: "dark" | "light") => void;

  sidebarCollapsed: boolean;
  setSidebarCollapsed: React.Dispatch<React.SetStateAction<boolean>>;

  stickyZoom: boolean;
  setStickyZoom: React.Dispatch<React.SetStateAction<boolean>>;
  markStickyZoomUserSet: () => void;

  inspectFontSize: number;
  setInspectFontSize: (size: number) => void;
  resetInspectFontSize: () => void;

  workspaceOrder: WorkspaceOrderState;
  setWorkspaceOrder: React.Dispatch<React.SetStateAction<WorkspaceOrderState>>;
}

export const useClientPreferences = (): UseClientPreferencesResult => {
  // ── Theme ──
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    const stored = localStorage.getItem("remux-theme");
    if (stored === "light") return "light";
    return "dark";
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("remux-theme", theme);
  }, [theme]);

  // ── Sidebar ──
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() =>
    localStorage.getItem("remux-sidebar-collapsed") === "true"
  );

  useEffect(() => {
    localStorage.setItem("remux-sidebar-collapsed", sidebarCollapsed ? "true" : "false");
  }, [sidebarCollapsed]);

  // ── Sticky zoom ──
  const [stickyZoom, setStickyZoom] = useState(getInitialStickyZoom);
  const stickyZoomUserSetRef = useRef(false);

  const markStickyZoomUserSet = useCallback(() => {
    stickyZoomUserSetRef.current = true;
  }, []);

  useEffect(() => {
    if (!stickyZoomUserSetRef.current) return;
    localStorage.setItem("remux-sticky-zoom", stickyZoom ? "true" : "false");
  }, [stickyZoom]);

  // ── Inspect font size ──
  // One-time migration from legacy localStorage key
  if (typeof window !== "undefined") {
    const legacyKey = "remux-scroll-font-size";
    const legacyValue = localStorage.getItem(legacyKey);
    if (legacyValue !== null) {
      localStorage.setItem("remux-inspect-font-size", legacyValue);
      localStorage.removeItem(legacyKey);
    }
  }

  const [inspectFontSize, setInspectFontSizeRaw] = useState<number>(
    Number(localStorage.getItem("remux-inspect-font-size")) || 0
  );

  const setInspectFontSize = useCallback((size: number) => {
    setInspectFontSizeRaw(size);
    if (size === 0) {
      localStorage.removeItem("remux-inspect-font-size");
    } else {
      localStorage.setItem("remux-inspect-font-size", String(size));
    }
  }, []);

  const resetInspectFontSize = useCallback(() => {
    setInspectFontSizeRaw(0);
    localStorage.removeItem("remux-inspect-font-size");
  }, []);

  // ── Workspace order ──
  const [workspaceOrder, setWorkspaceOrder] = useState<WorkspaceOrderState>(() => {
    try {
      const stored = localStorage.getItem(WORKSPACE_ORDER_STORAGE_KEY);
      if (!stored) return { sessions: [], tabsBySession: {} };
      return normalizeWorkspaceOrder(JSON.parse(stored));
    } catch {
      return { sessions: [], tabsBySession: {} };
    }
  });

  useEffect(() => {
    localStorage.setItem(WORKSPACE_ORDER_STORAGE_KEY, JSON.stringify(workspaceOrder));
  }, [workspaceOrder]);

  return {
    theme,
    setTheme,
    sidebarCollapsed,
    setSidebarCollapsed,
    stickyZoom,
    setStickyZoom,
    markStickyZoomUserSet,
    inspectFontSize,
    setInspectFontSize,
    resetInspectFontSize,
    workspaceOrder,
    setWorkspaceOrder,
  };
};

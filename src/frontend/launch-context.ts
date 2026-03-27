export interface LaunchContextHint {
  session: string;
  tabIndex?: number;
  paneId?: string;
}

export interface TerminalGeometryHint {
  cols: number;
  rows: number;
}

export const buildControlAuthHint = (
  attachedSession: string,
  initialContext: LaunchContextHint | null,
  geometry: TerminalGeometryHint | null = null
): (LaunchContextHint | { session: string } | TerminalGeometryHint) | (LaunchContextHint & TerminalGeometryHint) | ({ session: string } & TerminalGeometryHint) | null => {
  if (initialContext?.session) {
    return geometry ? { ...initialContext, ...geometry } : initialContext;
  }

  const session = attachedSession.trim();
  if (session) {
    return geometry ? { session, ...geometry } : { session };
  }

  return geometry;
};

export const parseLaunchContext = (
  query: URLSearchParams
): LaunchContextHint | null => {
  const session = query.get("session")?.trim() ?? "";
  if (!session) {
    return null;
  }

  const context: LaunchContextHint = { session };
  const tabRaw = query.get("tab");
  if (tabRaw !== null) {
    const tabIndex = Number.parseInt(tabRaw, 10);
    if (Number.isInteger(tabIndex) && tabIndex >= 0) {
      context.tabIndex = tabIndex;
    }
  }

  const paneId = query.get("pane")?.trim();
  if (paneId) {
    context.paneId = paneId;
  }

  return context;
};

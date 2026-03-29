export interface LaunchContext {
  session: string;
  tabIndex?: number;
  paneId?: string;
}

export const buildLaunchUrl = (
  baseUrl: string,
  token: string,
  context?: LaunchContext | null
): string => {
  const url = new URL(baseUrl);
  url.searchParams.set("token", token);
  if (context?.session) {
    url.searchParams.set("session", context.session);
  }
  if (context?.tabIndex !== undefined) {
    url.searchParams.set("tab", String(context.tabIndex));
  }
  if (context?.paneId) {
    url.searchParams.set("pane", context.paneId);
  }
  return url.toString();
};

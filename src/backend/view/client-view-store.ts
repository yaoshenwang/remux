import type { ClientView, WorkspaceSnapshot } from "../../shared/protocol.js";

export class ClientViewStore {
  private views = new Map<string, ClientView>();
  private missingSessionCounts = new Map<string, number>();
  private defaultFollowFocus: boolean;

  constructor(options?: { defaultFollowFocus?: boolean }) {
    this.defaultFollowFocus = options?.defaultFollowFocus ?? false;
  }

  initView(clientId: string, session: string, snapshot: WorkspaceSnapshot): ClientView {
    const sessionState = snapshot.sessions.find((s) => s.name === session);
    const activeTab = sessionState?.tabs.find((t) => t.active) ?? sessionState?.tabs[0];
    const activePane = activeTab?.panes.find((p) => p.active) ?? activeTab?.panes[0];

    const view: ClientView = {
      sessionName: session,
      tabIndex: activeTab?.index ?? 0,
      paneId: activePane?.id ?? "terminal_0",
      followBackendFocus: this.defaultFollowFocus,
    };
    this.views.set(clientId, view);
    this.missingSessionCounts.set(clientId, 0);
    return view;
  }

  selectTab(clientId: string, tabIndex: number, snapshot: WorkspaceSnapshot): void {
    const view = this.views.get(clientId);
    if (!view) return;
    view.tabIndex = tabIndex;
    // Select first active pane in the new tab
    const session = snapshot.sessions.find((s) => s.name === view.sessionName);
    const tab = session?.tabs.find((t) => t.index === tabIndex);
    const activePane = tab?.panes.find((p) => p.active) ?? tab?.panes[0];
    if (activePane) view.paneId = activePane.id;
  }

  selectPane(clientId: string, paneId: string): void {
    const view = this.views.get(clientId);
    if (!view) return;
    view.paneId = paneId;
  }

  selectSession(clientId: string, session: string, snapshot: WorkspaceSnapshot): void {
    const view = this.views.get(clientId);
    if (!view) return;
    view.sessionName = session;
    // Reset to active tab/pane in new session
    const sessionState = snapshot.sessions.find((s) => s.name === session);
    const activeTab = sessionState?.tabs.find((t) => t.active) ?? sessionState?.tabs[0];
    const activePane = activeTab?.panes.find((p) => p.active) ?? activeTab?.panes[0];
    view.tabIndex = activeTab?.index ?? 0;
    view.paneId = activePane?.id ?? "terminal_0";
  }

  setFollowFocus(clientId: string, follow: boolean): void {
    const view = this.views.get(clientId);
    if (!view) return;
    view.followBackendFocus = follow;
  }

  reconcile(snapshot: WorkspaceSnapshot): void {
    for (const [clientId, view] of this.views) {
      const session = snapshot.sessions.find((s) => s.name === view.sessionName);
      if (!session) {
        const misses = (this.missingSessionCounts.get(clientId) ?? 0) + 1;
        this.missingSessionCounts.set(clientId, misses);
        if (misses < 2) {
          continue;
        }
        // Session gone — fall back to first available after a grace poll,
        // so transient zellij rename/create gaps do not detach the client view.
        const fallback = snapshot.sessions[0];
        if (fallback) {
          this.selectSession(clientId, fallback.name, snapshot);
        }
        continue;
      }
      this.missingSessionCounts.set(clientId, 0);

      // Check if current tab still exists
      const tab = session.tabs.find((t) => t.index === view.tabIndex);
      if (!tab) {
        // Tab gone — fall back to active tab
        const activeTab = session.tabs.find((t) => t.active) ?? session.tabs[0];
        if (activeTab) {
          view.tabIndex = activeTab.index;
          const activePane = activeTab.panes.find((p) => p.active) ?? activeTab.panes[0];
          view.paneId = activePane?.id ?? "terminal_0";
        }
        continue;
      }

      // Check if current pane still exists in current tab
      const pane = tab.panes.find((p) => p.id === view.paneId);
      if (!pane) {
        const activePane = tab.panes.find((p) => p.active) ?? tab.panes[0];
        view.paneId = activePane?.id ?? "terminal_0";
      }

      // If followBackendFocus, sync to backend's active state
      if (view.followBackendFocus) {
        const activeTab = session.tabs.find((t) => t.active);
        if (activeTab) {
          view.tabIndex = activeTab.index;
          const activePane = activeTab.panes.find((p) => p.active) ?? activeTab.panes[0];
          if (activePane) view.paneId = activePane.id;
        }
      }
    }
  }

  renameSession(oldName: string, newName: string): void {
    for (const view of this.views.values()) {
      if (view.sessionName === oldName) {
        view.sessionName = newName;
      }
    }
  }

  getView(clientId: string): ClientView | undefined {
    return this.views.get(clientId);
  }

  removeClient(clientId: string): void {
    this.views.delete(clientId);
    this.missingSessionCounts.delete(clientId);
  }
}

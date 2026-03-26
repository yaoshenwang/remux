export interface ZellijNativePaneRenderState {
  viewport: string[];
  scrollback: string[] | null;
}

export interface ZellijNativePaneSnapshot extends ZellijNativePaneRenderState {
  session: string;
  paneId: string;
  updatedAt: number;
}

export class ZellijNativeBridgeStateStore {
  private readonly panes = new Map<string, ZellijNativePaneSnapshot>();

  updatePaneRender(
    session: string,
    paneId: string,
    state: ZellijNativePaneRenderState
  ): void {
    this.panes.set(this.key(session, paneId), {
      session,
      paneId,
      viewport: [...state.viewport],
      scrollback: state.scrollback ? [...state.scrollback] : null,
      updatedAt: Date.now()
    });
  }

  getPaneSnapshot(session: string, paneId: string): ZellijNativePaneSnapshot | null {
    const snapshot = this.panes.get(this.key(session, paneId));
    if (!snapshot) {
      return null;
    }
    return this.cloneSnapshot(snapshot);
  }

  findPaneSnapshot(paneId: string): ZellijNativePaneSnapshot | null {
    let match: ZellijNativePaneSnapshot | null = null;
    for (const snapshot of this.panes.values()) {
      if (snapshot.paneId !== paneId) {
        continue;
      }
      if (match) {
        return null;
      }
      match = snapshot;
    }
    return match ? this.cloneSnapshot(match) : null;
  }

  clearPane(session: string, paneId: string): void {
    this.panes.delete(this.key(session, paneId));
  }

  clearAll(): void {
    this.panes.clear();
  }

  private key(session: string, paneId: string): string {
    return `${session}:${paneId}`;
  }

  private cloneSnapshot(snapshot: ZellijNativePaneSnapshot): ZellijNativePaneSnapshot {
    return {
      session: snapshot.session,
      paneId: snapshot.paneId,
      viewport: [...snapshot.viewport],
      scrollback: snapshot.scrollback ? [...snapshot.scrollback] : null,
      updatedAt: snapshot.updatedAt
    };
  }
}

export function createZellijNativeBridgeStateStore(): ZellijNativeBridgeStateStore {
  return new ZellijNativeBridgeStateStore();
}

const defaultZellijNativeBridgeStateStore = createZellijNativeBridgeStateStore();

export function getDefaultZellijNativeBridgeStateStore(): ZellijNativeBridgeStateStore {
  return defaultZellijNativeBridgeStateStore;
}

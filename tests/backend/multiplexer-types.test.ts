import { describe, expect, test } from "vitest";
import type { MultiplexerBackend } from "../../src/backend/multiplexer/types.js";
import { buildSnapshot } from "../../src/backend/multiplexer/types.js";
import type {
  BackendCapabilities,
  PaneState,
  SessionSummary,
  TabState
} from "../../src/shared/protocol.js";

class SnapshotStubBackend implements MultiplexerBackend {
  public readonly kind = "zellij" as const;
  public readonly capabilities: BackendCapabilities = {
    supportsPaneFocusById: true,
    supportsTabRename: true,
    supportsSessionRename: true,
    supportsPreciseScrollback: false,
    supportsFloatingPanes: true,
    supportsFullscreenPane: true
  };

  public async listSessions(): Promise<SessionSummary[]> {
    return [{ name: "main", attached: false, tabCount: 99 }];
  }

  public async createSession(): Promise<void> {}
  public async killSession(): Promise<void> {}
  public async renameSession(): Promise<void> {}

  public async listTabs(): Promise<Omit<TabState, "panes">[]> {
    return [{ index: 0, name: "shell", active: true, paneCount: 2 }];
  }

  public async newTab(): Promise<void> {}
  public async closeTab(): Promise<void> {}
  public async selectTab(): Promise<void> {}
  public async renameTab(): Promise<void> {}

  public async listPanes(): Promise<PaneState[]> {
    return [
      {
        index: 0,
        id: "terminal_1",
        currentCommand: "bash",
        active: true,
        width: 120,
        height: 40,
        zoomed: false,
        currentPath: "/tmp"
      }
    ];
  }

  public async splitPane(): Promise<void> {}
  public async closePane(): Promise<void> {}
  public async focusPane(): Promise<void> {}
  public async toggleFullscreen(): Promise<void> {}
  public async isPaneFullscreen(): Promise<boolean> {
    return false;
  }

  public async capturePane(): Promise<{ text: string; paneWidth: number; isApproximate: boolean }> {
    return { text: "", paneWidth: 80, isApproximate: true };
  }
}

class PartiallyBrokenBackend extends SnapshotStubBackend {
  public override async listSessions(): Promise<SessionSummary[]> {
    return [
      { name: "main", attached: false, tabCount: 1 },
      { name: "stale", attached: false, tabCount: 1 }
    ];
  }

  public override async listTabs(session: string): Promise<Omit<TabState, "panes">[]> {
    if (session === "stale") {
      throw new Error("There is no active session!");
    }
    return super.listTabs(session);
  }
}

describe("buildSnapshot", () => {
  test("normalizes tab and session counts from actual tab/pane lists", async () => {
    const snapshot = await buildSnapshot(new SnapshotStubBackend());

    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.sessions[0].tabCount).toBe(1);
    expect(snapshot.sessions[0].tabs[0].paneCount).toBe(1);
    expect(snapshot.sessions[0].tabs[0].panes).toHaveLength(1);
  });

  test("skips sessions that fail during snapshot building", async () => {
    const snapshot = await buildSnapshot(new PartiallyBrokenBackend());

    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.sessions[0].name).toBe("main");
  });
});

import { describe, expect, it } from "vitest";
import { InspectService } from "../../src/backend/inspect/index.js";
import type { WorkspaceState } from "../../src/backend/zellij-controller.js";

const buildWorkspaceState = (): WorkspaceState => ({
  session: "test-session",
  activeTabIndex: 0,
  tabs: [
    {
      index: 0,
      name: "main",
      active: true,
      isFullscreen: false,
      hasBell: false,
      panes: [
        {
          id: "terminal_1",
          focused: true,
          title: "api",
          command: "npm run dev",
          cwd: "/tmp/api",
          rows: 24,
          cols: 80,
          x: 0,
          y: 0,
        },
        {
          id: "terminal_2",
          focused: false,
          title: "logs",
          command: "tail -f",
          cwd: "/tmp/logs",
          rows: 24,
          cols: 80,
          x: 81,
          y: 0,
        },
      ],
    },
  ],
});

describe("InspectService", () => {
  it("paginates pane history with opaque cursors", async () => {
    const controller = {
      async queryWorkspaceState() {
        return buildWorkspaceState();
      },
      async dumpPaneScreen() {
        return Array.from({ length: 120 }, (_value, index) => `line ${index + 1}`).join("\n");
      },
    };

    const service = new InspectService({ controller, tracker: null });
    const firstPage = await service.queryPaneHistory("terminal_1", { limit: 50 });

    expect(firstPage.descriptor.scope).toBe("pane");
    expect(firstPage.descriptor.source).toBe("runtime_capture");
    expect(firstPage.descriptor.precision).toBe("precise");
    expect(firstPage.items).toHaveLength(50);
    expect(firstPage.items[0]).toMatchObject({
      type: "output",
      content: "line 1",
      lineNumber: 1,
      paneId: "terminal_1",
    });
    expect(firstPage.cursor).not.toBeNull();
    expect(firstPage.truncated).toBe(true);

    const secondPage = await service.queryPaneHistory("terminal_1", {
      cursor: firstPage.cursor,
      limit: 50,
    });

    expect(secondPage.items[0]?.content).toBe("line 51");
    expect(secondPage.items.at(-1)?.content).toBe("line 100");
    expect(secondPage.cursor).not.toBeNull();

    const lastPage = await service.queryPaneHistory("terminal_1", {
      cursor: secondPage.cursor,
      limit: 50,
    });

    expect(lastPage.items).toHaveLength(20);
    expect(lastPage.items[0]?.content).toBe("line 101");
    expect(lastPage.cursor).toBeNull();
    expect(lastPage.truncated).toBe(false);
  });

  it("returns an empty pane snapshot instead of throwing for blank content", async () => {
    const controller = {
      async queryWorkspaceState() {
        return buildWorkspaceState();
      },
      async dumpPaneScreen() {
        return "";
      },
    };

    const service = new InspectService({ controller, tracker: null });
    const snapshot = await service.queryPaneHistory("terminal_1");

    expect(snapshot.items).toEqual([]);
    expect(snapshot.cursor).toBeNull();
    expect(snapshot.truncated).toBe(false);
    expect(snapshot.descriptor.scope).toBe("pane");
  });

  it("filters pane history with case-insensitive search and context", async () => {
    const controller = {
      async queryWorkspaceState() {
        return buildWorkspaceState();
      },
      async dumpPaneScreen() {
        return [
          "boot",
          "ready",
          "worker connected",
          "fatal error: socket closed",
          "retrying",
          "stabilized",
        ].join("\n");
      },
    };

    const service = new InspectService({ controller, tracker: null });
    const snapshot = await service.queryPaneHistory("terminal_1", {
      query: "ERROR",
      limit: 20,
    });

    expect(snapshot.items.map((item) => item.lineNumber)).toEqual([2, 3, 4, 5, 6]);
    expect(snapshot.items.find((item) => item.lineNumber === 4)?.highlights).toEqual([
      { start: 6, end: 11 },
    ]);
  });

  it("rejects malformed inspect cursors", async () => {
    const controller = {
      async queryWorkspaceState() {
        return buildWorkspaceState();
      },
      async dumpPaneScreen() {
        return "hello";
      },
    };

    const service = new InspectService({ controller, tracker: null });

    await expect(
      service.queryPaneHistory("terminal_1", { cursor: "definitely-not-a-valid-cursor" }),
    ).rejects.toThrow(/invalid inspect cursor/i);
  });

  it("aggregates tab history as pane-scoped segments without faking precise ordering", async () => {
    const paneContent: Record<string, string> = {
      terminal_1: ["api booted", "serving :3000"].join("\n"),
      terminal_2: ["tail line 1", "tail line 2"].join("\n"),
    };

    const controller = {
      async queryWorkspaceState() {
        return buildWorkspaceState();
      },
      async dumpPaneScreen(paneId: string) {
        return paneContent[paneId] ?? "";
      },
    };

    const service = new InspectService({ controller, tracker: null });
    const snapshot = await service.queryTabHistory(0, { limit: 20 });

    expect(snapshot.descriptor.scope).toBe("tab");
    expect(snapshot.descriptor.precision).toBe("partial");
    expect(snapshot.items.filter((item) => item.type === "marker").map((item) => item.paneId)).toEqual([
      "terminal_1",
      "terminal_2",
    ]);
    expect(snapshot.items.filter((item) => item.type === "output" && item.paneId === "terminal_2")).toHaveLength(2);
  });
});

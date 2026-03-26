import { describe, expect, test } from "vitest";
import type { TabState } from "../../src/shared/protocol.js";
import { buildTabInspectSnapshot, filterInspectSections } from "../../src/frontend/inspect-state.js";

const buildTab = (): TabState => ({
  index: 2,
  name: "build",
  active: true,
  paneCount: 2,
  panes: [
    {
      index: 0,
      id: "%1",
      currentCommand: "npm",
      active: true,
      width: 120,
      height: 40,
      zoomed: false,
      currentPath: "/tmp"
    },
    {
      index: 1,
      id: "%2",
      currentCommand: "tail",
      active: false,
      width: 120,
      height: 40,
      zoomed: false,
      currentPath: "/tmp"
    }
  ]
});

describe("buildTabInspectSnapshot", () => {
  test("builds a precise tab snapshot when every pane has backend capture", () => {
    const snapshot = buildTabInspectSnapshot({
      sessionName: "main",
      tab: buildTab(),
      captures: {
        "%1": { paneId: "%1", text: "compile ok", paneWidth: 120, isApproximate: false },
        "%2": { paneId: "%2", text: "\u001b[31mwarn\u001b[0m", paneWidth: 120, isApproximate: false }
      },
      capturedAt: "2026-03-26T10:00:00.000Z"
    });

    expect(snapshot.scope).toBe("tab");
    expect(snapshot.source).toBe("backend_capture");
    expect(snapshot.precision).toBe("precise");
    expect(snapshot.missingPaneIds).toEqual([]);
    expect(snapshot.sections).toHaveLength(2);
    expect(snapshot.sections[0]?.title).toContain("Pane 0");
    expect(snapshot.sections[0]?.html).toContain("compile ok");
    expect(snapshot.sections[1]?.html).toContain("warn");
  });

  test("downgrades to approximate when any pane capture is approximate", () => {
    const snapshot = buildTabInspectSnapshot({
      sessionName: "main",
      tab: buildTab(),
      captures: {
        "%1": { paneId: "%1", text: "exact", paneWidth: 120, isApproximate: false },
        "%2": { paneId: "%2", text: "viewport only", paneWidth: 120, isApproximate: true }
      },
      capturedAt: "2026-03-26T10:00:00.000Z"
    });

    expect(snapshot.precision).toBe("approximate");
    expect(snapshot.sections[1]?.precision).toBe("approximate");
  });

  test("downgrades to partial when one pane is missing from the assembled tab view", () => {
    const snapshot = buildTabInspectSnapshot({
      sessionName: "main",
      tab: buildTab(),
      captures: {
        "%1": { paneId: "%1", text: "only one pane", paneWidth: 120, isApproximate: false }
      },
      capturedAt: "2026-03-26T10:00:00.000Z"
    });

    expect(snapshot.precision).toBe("partial");
    expect(snapshot.missingPaneIds).toEqual(["%2"]);
    expect(snapshot.sections).toHaveLength(1);
  });

  test("filters inspect sections by pane and search query", () => {
    const snapshot = buildTabInspectSnapshot({
      sessionName: "main",
      tab: buildTab(),
      captures: {
        "%1": { paneId: "%1", text: "compile ok", paneWidth: 120, isApproximate: false },
        "%2": { paneId: "%2", text: "fatal error", paneWidth: 120, isApproximate: false }
      },
      capturedAt: "2026-03-26T10:00:00.000Z"
    });

    expect(filterInspectSections(snapshot, { paneId: "all", query: "error" }).map((section) => section.paneId)).toEqual(["%2"]);
    expect(filterInspectSections(snapshot, { paneId: "%1", query: "" }).map((section) => section.paneId)).toEqual(["%1"]);
    expect(filterInspectSections(snapshot, { paneId: "%1", query: "fatal" })).toEqual([]);
  });
});

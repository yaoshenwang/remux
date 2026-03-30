// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import BandwidthStatsModal from "../../src/frontend/components/BandwidthStatsModal.js";

describe("BandwidthStatsModal", () => {
  let container: HTMLDivElement | null = null;
  let root: ReturnType<typeof createRoot> | null = null;

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
      root = null;
    }
    if (container) {
      container.remove();
      container = null;
    }
  });

  test("renders the runtime-v2 bandwidth and queue pressure metrics", () => {
    const onClose = vi.fn();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <BandwidthStatsModal
          onClose={onClose}
          stats={{
            rawBytesPerSec: 1024,
            compressedBytesPerSec: 768,
            savedPercent: 25,
            fullSnapshotsSent: 2,
            diffUpdatesSent: 8,
            avgChangedRowsPerDiff: 128,
            avgDiffBytesPerUpdate: 128,
            rebuiltSnapshotsSent: 1,
            continuationResumes: 2,
            continuationFallbackSnapshots: 3,
            viewerQueueHighWatermarkHits: 3,
            droppedBacklogFrames: 7,
            totalRawBytes: 4096,
            totalCompressedBytes: 3072,
            totalSavedBytes: 1024,
            rttMs: 21,
            protocol: "wss + permessage-deflate",
          }}
        />
      );
    });

    expect(container.textContent ?? "").toContain("Raw");
    expect(container.textContent ?? "").toContain("Wire");
    expect(container.textContent ?? "").toContain("Full snapshots");
    expect(container.textContent ?? "").toContain("Rebuilt snapshots");
    expect(container.textContent ?? "").toContain("Continuation resumes");
    expect(container.textContent ?? "").toContain("Continuation fallbacks");
    expect(container.textContent ?? "").toContain("Queue high watermark hits");
    expect(container.textContent ?? "").toContain("Dropped backlog frames");
  });
});

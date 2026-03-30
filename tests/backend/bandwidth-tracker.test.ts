import { afterEach, describe, expect, test, vi } from "vitest";
import { BandwidthTracker } from "../../src/backend/stats/index.js";

describe("BandwidthTracker", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("accumulates rolling bandwidth and continuation counters", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-30T00:00:00.000Z"));

    const tracker = new BandwidthTracker();
    tracker.recordRawBytes(100);
    tracker.recordCompressedBytes(80);
    tracker.recordDiffUpdate(25);
    tracker.recordRebuiltSnapshot();
    tracker.recordContinuationResume();
    tracker.recordQueueHighWatermarkHit();
    tracker.recordDroppedBacklogFrames(2.9);
    tracker.setRtt(18);

    vi.advanceTimersByTime(1_000);

    tracker.recordRawBytes(50);
    tracker.recordCompressedBytes(25);
    tracker.recordDiffUpdate(75);
    tracker.recordContinuationFallbackSnapshot();

    const stats = tracker.getStats();

    expect(stats.rawBytesPerSec).toBe(150);
    expect(stats.compressedBytesPerSec).toBe(105);
    expect(stats.savedPercent).toBe(30);
    expect(stats.fullSnapshotsSent).toBe(0);
    expect(stats.diffUpdatesSent).toBe(2);
    expect(stats.avgDiffBytesPerUpdate).toBe(50);
    expect(stats.avgChangedRowsPerDiff).toBe(50);
    expect(stats.rebuiltSnapshotsSent).toBe(1);
    expect(stats.continuationResumes).toBe(1);
    expect(stats.continuationFallbackSnapshots).toBe(1);
    expect(stats.viewerQueueHighWatermarkHits).toBe(1);
    expect(stats.droppedBacklogFrames).toBe(2);
    expect(stats.totalRawBytes).toBe(150);
    expect(stats.totalCompressedBytes).toBe(105);
    expect(stats.totalSavedBytes).toBe(45);
    expect(stats.rttMs).toBe(18);
  });

  test("ignores invalid numeric inputs instead of poisoning telemetry", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-30T00:00:00.000Z"));

    const tracker = new BandwidthTracker();
    tracker.recordRawBytes(Number.NaN as number);
    tracker.recordCompressedBytes(Number.POSITIVE_INFINITY as number);
    tracker.recordDiffUpdate(Number.NEGATIVE_INFINITY as number);
    tracker.recordDroppedBacklogFrames(Number.NaN as number);
    tracker.setRtt(Number.NaN as number);

    const stats = tracker.getStats();

    expect(stats.rawBytesPerSec).toBe(0);
    expect(stats.compressedBytesPerSec).toBe(0);
    expect(stats.savedPercent).toBe(0);
    expect(stats.diffUpdatesSent).toBe(1);
    expect(stats.avgDiffBytesPerUpdate).toBe(0);
    expect(stats.avgChangedRowsPerDiff).toBe(0);
    expect(stats.droppedBacklogFrames).toBe(0);
    expect(stats.totalRawBytes).toBe(0);
    expect(stats.totalCompressedBytes).toBe(0);
    expect(stats.totalSavedBytes).toBe(0);
    expect(stats.rttMs).toBeNull();
  });
});

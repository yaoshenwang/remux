// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

describe("snapfeed flush backoff", () => {
  let teardown: (() => void) | null = null;

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    // Provide a minimal DOM so snapfeed init does not throw
    document.body.innerHTML = "<main></main>";
  });

  afterEach(() => {
    teardown?.();
    teardown = null;
    document.body.innerHTML = "";
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("doubles flush interval after a failure, up to 5 min max", async () => {
    // Simulate endpoint always failing
    const fetchSpy = vi.fn().mockResolvedValue({ ok: false });
    vi.stubGlobal("fetch", fetchSpy);

    const { initSnapfeed, push, flush } = await import("@microsoft/snapfeed");
    teardown = initSnapfeed({
      endpoint: "/api/telemetry/events",
      flushIntervalMs: 3000,
      trackApiErrors: false,
      trackClicks: false,
      trackErrors: false,
      trackNavigation: false,
      feedback: { enabled: false },
    });

    // Push an event so flush has something to send
    push("test", "button", "detail");

    // First flush at t=3s
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Push again so next flush has data
    push("test", "button", "detail");

    // Second flush should be at t=3+6=9s (doubled to 6s)
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetchSpy).toHaveBeenCalledTimes(1); // not yet
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetchSpy).toHaveBeenCalledTimes(2); // now at 6s after first

    // Push again
    push("test", "button", "detail");

    // Third flush at 12s after second
    await vi.advanceTimersByTimeAsync(12000);
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    // Push again
    push("test", "button", "detail");

    // Fourth flush at 24s after third
    await vi.advanceTimersByTimeAsync(24000);
    expect(fetchSpy).toHaveBeenCalledTimes(4);

    vi.unstubAllGlobals();
  });

  test("resets interval to base after a successful flush", async () => {
    let callCount = 0;
    const fetchSpy = vi.fn().mockImplementation(async () => {
      callCount++;
      // First call fails, second succeeds, third succeeds
      return { ok: callCount > 1 };
    });
    vi.stubGlobal("fetch", fetchSpy);

    const { initSnapfeed, push } = await import("@microsoft/snapfeed");
    teardown = initSnapfeed({
      endpoint: "/api/telemetry/events",
      flushIntervalMs: 3000,
      trackApiErrors: false,
      trackClicks: false,
      trackErrors: false,
      trackNavigation: false,
      feedback: { enabled: false },
    });

    // First flush fails at t=3s
    push("test", "button", "detail");
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Second flush at t=3+6=9s (backed off), succeeds
    // Events are re-queued from failed flush so queue is non-empty
    await vi.advanceTimersByTimeAsync(6000);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // Third flush should be back to 3s interval
    push("test", "button", "detail");
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    vi.unstubAllGlobals();
  });

  test("stops retrying after 20 consecutive failures", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: false });
    vi.stubGlobal("fetch", fetchSpy);

    const { initSnapfeed, push } = await import("@microsoft/snapfeed");
    teardown = initSnapfeed({
      endpoint: "/api/telemetry/events",
      flushIntervalMs: 3000,
      trackApiErrors: false,
      trackClicks: false,
      trackErrors: false,
      trackNavigation: false,
      feedback: { enabled: false },
    });

    // Keep pushing events and advancing time for 20 failures
    // The intervals double: 3, 6, 12, 24, 48, 96, 192, 300, 300, ...
    // After each flush attempt, push new event data
    for (let i = 0; i < 20; i++) {
      push("test", "button", `detail-${i}`);
      // Advance enough time to trigger the next flush
      // Max interval is 300s, so advancing 300s each time is safe
      await vi.advanceTimersByTimeAsync(300_000);
    }
    expect(fetchSpy).toHaveBeenCalledTimes(20);

    // After 20 failures, no more retries even with data in queue
    push("test", "button", "should-not-flush");
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetchSpy).toHaveBeenCalledTimes(20); // no additional calls

    vi.unstubAllGlobals();
  });

  test("suppresses console errors after first failure", async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error("network error"));
    vi.stubGlobal("fetch", fetchSpy);
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { initSnapfeed, push } = await import("@microsoft/snapfeed");
    teardown = initSnapfeed({
      endpoint: "/api/telemetry/events",
      flushIntervalMs: 3000,
      trackApiErrors: false,
      trackClicks: false,
      trackErrors: false,
      trackNavigation: false,
      feedback: { enabled: false },
    });

    // First flush - may log error
    push("test", "button", "detail");
    await vi.advanceTimersByTimeAsync(3000);

    const errorCountAfterFirst = consoleErrorSpy.mock.calls.length;

    // Subsequent flushes should not log additional errors
    push("test", "button", "detail2");
    await vi.advanceTimersByTimeAsync(6000);

    push("test", "button", "detail3");
    await vi.advanceTimersByTimeAsync(12000);

    // No additional console.error calls after the first failure
    expect(consoleErrorSpy.mock.calls.length).toBe(errorCountAfterFirst);

    vi.unstubAllGlobals();
    consoleErrorSpy.mockRestore();
  });
});

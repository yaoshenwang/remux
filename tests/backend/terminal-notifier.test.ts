import { afterEach, describe, expect, test, vi } from "vitest";
import { createTerminalNotifier } from "../../src/backend/notifications/terminal-notifier.js";
import type { NotificationManager } from "../../src/backend/notifications/push-manager.js";

describe("createTerminalNotifier", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("calls notifyBell when data contains bell character", () => {
    const manager = {
      notifyBell: vi.fn(async () => undefined),
      notifySessionExit: vi.fn(async () => undefined),
    } as unknown as NotificationManager;

    const notifier = createTerminalNotifier("test-session", manager);
    notifier.onData("hello\x07world");

    expect(manager.notifyBell).toHaveBeenCalledWith("test-session");
  });

  test("does not call notifyBell for normal data", () => {
    const manager = {
      notifyBell: vi.fn(async () => undefined),
      notifySessionExit: vi.fn(async () => undefined),
    } as unknown as NotificationManager;

    const notifier = createTerminalNotifier("test-session", manager);
    notifier.onData("normal output");

    expect(manager.notifyBell).not.toHaveBeenCalled();
  });

  test("suppresses rapid bell notifications via cooldown", () => {
    vi.useFakeTimers();
    const manager = {
      notifyBell: vi.fn(async () => undefined),
      notifySessionExit: vi.fn(async () => undefined),
    } as unknown as NotificationManager;

    const notifier = createTerminalNotifier("test-session", manager);
    notifier.onData("\x07");
    notifier.onData("\x07");
    notifier.onData("\x07");

    expect(manager.notifyBell).toHaveBeenCalledTimes(1);

    // After cooldown expires, bell should fire again.
    vi.advanceTimersByTime(5001);
    notifier.onData("\x07");
    expect(manager.notifyBell).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  test("calls notifySessionExit on exit", () => {
    const manager = {
      notifyBell: vi.fn(async () => undefined),
      notifySessionExit: vi.fn(async () => undefined),
    } as unknown as NotificationManager;

    const notifier = createTerminalNotifier("test-session", manager);
    notifier.onExit(0);

    expect(manager.notifySessionExit).toHaveBeenCalledWith("test-session", 0);
  });

  test("calls notifySessionExit with non-zero exit code", () => {
    const manager = {
      notifyBell: vi.fn(async () => undefined),
      notifySessionExit: vi.fn(async () => undefined),
    } as unknown as NotificationManager;

    const notifier = createTerminalNotifier("test-session", manager);
    notifier.onExit(1);

    expect(manager.notifySessionExit).toHaveBeenCalledWith("test-session", 1);
  });
});

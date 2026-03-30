import { describe, it, expect, vi } from "vitest";
import { createTerminalNotifier } from "../../src/backend/notifications/terminal-notifier.js";
import type { NotificationManager } from "../../src/backend/notifications/push-manager.js";

const createMockNotifications = () => {
  return {
    notifyBell: vi.fn().mockResolvedValue(undefined),
    notifySessionExit: vi.fn().mockResolvedValue(undefined),
    notify: vi.fn().mockResolvedValue(undefined),
  } as unknown as NotificationManager;
};

describe("createTerminalNotifier", () => {
  it("detects bell character and notifies", () => {
    const notifications = createMockNotifications();
    const { onData } = createTerminalNotifier("test-session", notifications);

    onData("some output\x07more output");

    expect(notifications.notifyBell).toHaveBeenCalledWith("test-session");
  });

  it("does not notify on normal output", () => {
    const notifications = createMockNotifications();
    const { onData } = createTerminalNotifier("test-session", notifications);

    onData("just normal terminal output\r\n");

    expect(notifications.notifyBell).not.toHaveBeenCalled();
  });

  it("has cooldown for rapid bells", () => {
    const notifications = createMockNotifications();
    const { onData } = createTerminalNotifier("test-session", notifications);

    onData("\x07");
    onData("\x07");
    onData("\x07");

    // Only first bell should trigger notification.
    expect(notifications.notifyBell).toHaveBeenCalledTimes(1);
  });

  it("notifies on session exit with code", () => {
    const notifications = createMockNotifications();
    const { onExit } = createTerminalNotifier("test-session", notifications);

    onExit(1);

    expect(notifications.notifySessionExit).toHaveBeenCalledWith(
      "test-session",
      1
    );
  });

  it("notifies on successful session exit", () => {
    const notifications = createMockNotifications();
    const { onExit } = createTerminalNotifier("test-session", notifications);

    onExit(0);

    expect(notifications.notifySessionExit).toHaveBeenCalledWith(
      "test-session",
      0
    );
  });
});

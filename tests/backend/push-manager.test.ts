import { describe, expect, it, vi } from "vitest";
import { NotificationManager, type PushSubscription, type WebPushClient } from "../../src/backend/notifications/push-manager.js";

const createSubscription = (endpoint: string): PushSubscription => ({
  endpoint,
  keys: {
    p256dh: "p256dh-key",
    auth: "auth-key",
  },
});

describe("NotificationManager", () => {
  it("filters bell notifications by subscription preferences and includes deep link data", async () => {
    const pushClient = createMockPushClient();
    const notifications = new NotificationManager(undefined, pushClient);

    notifications.addSubscription("bell-on", createSubscription("https://push.example/bell-on"), {
      bell: true,
      exit: false,
    });
    notifications.addSubscription("bell-off", createSubscription("https://push.example/bell-off"), {
      bell: false,
      exit: true,
    });

    await notifications.notifyBell("alpha");

    expect(pushClient.sendNotification).toHaveBeenCalledTimes(1);
    const [subscription, body] = pushClient.sendNotification.mock.calls[0];
    expect(subscription.endpoint).toBe("https://push.example/bell-on");
    expect(JSON.parse(body)).toMatchObject({
      title: "Terminal Bell",
      data: {
        type: "bell",
        session: "alpha",
        url: "/?session=alpha",
      },
    });
  });

  it("sends exit notifications only for non-zero exit codes", async () => {
    const pushClient = createMockPushClient();
    const notifications = new NotificationManager(undefined, pushClient);

    notifications.addSubscription("exit-on", createSubscription("https://push.example/exit-on"), {
      bell: false,
      exit: true,
    });

    await notifications.notifySessionExit("alpha", 0);
    expect(pushClient.sendNotification).not.toHaveBeenCalled();

    await notifications.notifySessionExit("alpha", 17);
    expect(pushClient.sendNotification).toHaveBeenCalledTimes(1);
    const [, body] = pushClient.sendNotification.mock.calls[0];
    expect(JSON.parse(body)).toMatchObject({
      title: "Session Exited",
      data: {
        type: "exit",
        session: "alpha",
        exitCode: 17,
        url: "/?session=alpha",
      },
    });
  });
});

const createMockPushClient = (): WebPushClient & {
  sendNotification: ReturnType<typeof vi.fn>;
} => {
  return {
    sendNotification: vi.fn().mockResolvedValue(undefined),
  } as unknown as WebPushClient & {
    sendNotification: ReturnType<typeof vi.fn>;
  };
};

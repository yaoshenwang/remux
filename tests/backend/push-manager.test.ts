import { describe, expect, test, vi } from "vitest";
import { NotificationManager, type PushSubscription, type WebPushClient } from "../../src/backend/notifications/push-manager.js";

const subscription: PushSubscription = {
  endpoint: "https://push.example.test/subscription/1",
  keys: {
    p256dh: "p256dh-key",
    auth: "auth-key"
  }
};

describe("NotificationManager", () => {
  test("sends notifications through the injected web push client", async () => {
    const sendNotification = vi.fn(async () => ({ statusCode: 201 }));
    const manager = new NotificationManager(
      undefined,
      {
        generateVAPIDKeys: () => ({
          publicKey: "public",
          privateKey: "private"
        }),
        sendNotification
      } satisfies WebPushClient
    );

    manager.addSubscription("sub-1", subscription);
    await manager.notifyBell("main");

    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(sendNotification).toHaveBeenCalledWith(
      subscription,
      expect.stringContaining("\"session\":\"main\""),
      expect.objectContaining({
        vapidDetails: expect.objectContaining({
          publicKey: "public",
          privateKey: "private"
        }),
        TTL: 60,
        urgency: "high"
      })
    );
  });

  test("drops failed subscriptions after a send failure", async () => {
    const sendNotification = vi.fn(async () => {
      throw new Error("gone");
    });
    const manager = new NotificationManager(
      undefined,
      {
        generateVAPIDKeys: () => ({
          publicKey: "public",
          privateKey: "private"
        }),
        sendNotification
      } satisfies WebPushClient
    );

    manager.addSubscription("sub-1", subscription);
    await manager.notifySessionExit("main", 1);
    await manager.notifySessionExit("main", 1);

    expect(sendNotification).toHaveBeenCalledTimes(1);
  });
});

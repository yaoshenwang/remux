import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import webpush from "web-push";
import { afterEach, describe, expect, test, vi } from "vitest";
import { NotificationManager, type PushSubscription, type WebPushClient } from "../../src/backend/notifications/push-manager.js";

const subscription: PushSubscription = {
  endpoint: "https://push.example.test/subscription/1",
  keys: {
    p256dh: "p256dh-key",
    auth: "auth-key"
  }
};

describe("NotificationManager", () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }
  });

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

  test("creates push routes relative to the /api/push mount point", async () => {
    const manager = new NotificationManager(
      undefined,
      {
        generateVAPIDKeys: () => ({
          publicKey: "public",
          privateKey: "private"
        }),
        sendNotification: vi.fn(async () => ({ statusCode: 201 }))
      } satisfies WebPushClient
    );

    const app = express();
    app.use(express.json());
    app.use("/api/push", manager.createRoutes());

    const server = app.listen(0);
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected TCP address");
      }
      const response = await fetch(`http://127.0.0.1:${address.port}/api/push/vapid-key`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ publicKey: "public" });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  });

  test("uses the default web-push client when one is not injected", async () => {
    const tmpHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), "remux-push-home-"));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;

    const generateVAPIDKeys = vi.spyOn(webpush, "generateVAPIDKeys").mockReturnValue({
      publicKey: "public",
      privateKey: "private"
    });
    const sendNotification = vi.spyOn(webpush, "sendNotification").mockResolvedValue({
      statusCode: 201
    });

    try {
      const manager = new NotificationManager();
      manager.addSubscription("sub-1", subscription);

      await manager.notifyBell("main");

      expect(generateVAPIDKeys).toHaveBeenCalledTimes(1);
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
    } finally {
      await fs.promises.rm(tmpHome, { recursive: true, force: true });
    }
  });
});

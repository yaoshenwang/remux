import webPush from "web-push";
import type { PushSubscription, WebPushClient } from "./push-manager.js";

interface PushSenderOptions {
  subject?: string;
  publicKey: string;
  privateKey: string;
}

export const createWebPushClient = (options: PushSenderOptions): WebPushClient => {
  return {
    async sendNotification(subscription: PushSubscription, body: string): Promise<void> {
      await webPush.sendNotification(subscription as webPush.PushSubscription, body, {
        vapidDetails: {
          subject: options.subject ?? "mailto:remux@localhost",
          publicKey: options.publicKey,
          privateKey: options.privateKey,
        },
      });
    },
  };
};

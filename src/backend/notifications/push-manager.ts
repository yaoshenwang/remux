/**
 * Web Push notification support.
 *
 * Uses the Web Push API (VAPID) to send notifications to subscribed
 * browser clients. Notifications are triggered by terminal events:
 * - Bell character (\x07) in terminal output
 * - Session exit (process completed or errored)
 * - Long idle after activity (agent finished working)
 *
 * The server generates VAPID keys on first run and stores them in
 * ~/.remux/vapid.json. Clients subscribe via the /api/push/* endpoints.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import express, { type Router } from "express";
import webpush from "web-push";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PushSubscription {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export interface NotificationPayload {
  title: string;
  body: string;
  tag?: string;
  data?: Record<string, unknown>;
}

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

interface PushResultLike {
  statusCode?: number;
}

export interface WebPushClient {
  generateVAPIDKeys(): VapidKeys;
  sendNotification(
    subscription: PushSubscription,
    payload?: string | Buffer,
    options?: {
      vapidDetails: {
        subject: string;
        publicKey: string;
        privateKey: string;
      };
      TTL?: number;
      urgency?: "very-low" | "low" | "normal" | "high";
    }
  ): Promise<PushResultLike>;
}

// ---------------------------------------------------------------------------
// NotificationManager
// ---------------------------------------------------------------------------

export class NotificationManager {
  private subscriptions = new Map<string, PushSubscription>();
  private vapidKeys: VapidKeys;
  private readonly configDir: string;
  private readonly vapidSubject: string;

  constructor(
    private readonly logger?: Pick<Console, "log" | "error">,
    private readonly pushClient: WebPushClient = webpush
  ) {
    this.configDir = path.join(os.homedir(), ".remux");
    this.vapidSubject = process.env.REMUX_PUSH_SUBJECT || "mailto:remux@localhost.invalid";
    // When a custom pushClient is injected (testing), use its keys directly
    // instead of loading from disk.
    this.vapidKeys = pushClient === webpush
      ? this.loadOrGenerateVapidKeys()
      : pushClient.generateVAPIDKeys();
  }

  /** Get the VAPID public key (clients need this to subscribe). */
  get publicKey(): string {
    return this.vapidKeys.publicKey;
  }

  /** Register a push subscription from a client. */
  addSubscription(id: string, subscription: PushSubscription): void {
    this.subscriptions.set(id, subscription);
    this.logger?.log(
      `[push] subscription added: ${id} (${this.subscriptions.size} total)`
    );
  }

  /** Remove a push subscription. */
  removeSubscription(id: string): void {
    this.subscriptions.delete(id);
    this.logger?.log(
      `[push] subscription removed: ${id} (${this.subscriptions.size} total)`
    );
  }

  /** Send a notification to all subscribed clients. */
  async notify(payload: NotificationPayload): Promise<void> {
    if (this.subscriptions.size === 0) return;

    this.logger?.log(
      `[push] sending "${payload.title}" to ${this.subscriptions.size} subscribers`
    );

    const body = JSON.stringify(payload);
    const failures: string[] = [];

    for (const [id, sub] of this.subscriptions) {
      try {
        await this.sendPush(sub, body);
      } catch (err) {
        this.logger?.error(`[push] failed to send to ${id}: ${err}`);
        failures.push(id);
      }
    }

    // Remove failed subscriptions (likely expired).
    for (const id of failures) {
      this.subscriptions.delete(id);
    }
  }

  /** Notify about a terminal bell event. */
  async notifyBell(sessionName: string): Promise<void> {
    await this.notify({
      title: "🔔 Terminal Bell",
      body: `Session "${sessionName}" rang the bell`,
      tag: `bell-${sessionName}`,
      data: { type: "bell", session: sessionName },
    });
  }

  /** Notify about a session exit. */
  async notifySessionExit(
    sessionName: string,
    exitCode: number
  ): Promise<void> {
    const success = exitCode === 0;
    await this.notify({
      title: success ? "✅ Session Completed" : "❌ Session Failed",
      body: success
        ? `Session "${sessionName}" completed successfully`
        : `Session "${sessionName}" exited with code ${exitCode}`,
      tag: `exit-${sessionName}`,
      data: { type: "exit", session: sessionName, exitCode },
    });
  }

  /** Create Express routes for push subscription management. */
  createRoutes(): Router {
    const router = express.Router();

    // GET /api/push/vapid-key — client needs this to subscribe.
    router.get("/vapid-key", (_req, res) => {
      res.json({ publicKey: this.publicKey });
    });

    // POST /api/push/subscribe — register a push subscription.
    router.post("/subscribe", (req, res) => {
      const { id, subscription } = req.body as {
        id?: string;
        subscription?: PushSubscription;
      };

      if (!id || !subscription?.endpoint || !subscription?.keys) {
        res.status(400).json({ error: "missing id or subscription" });
        return;
      }

      this.addSubscription(id, subscription);
      res.json({ ok: true });
    });

    // POST /api/push/unsubscribe — remove a push subscription.
    router.post("/unsubscribe", (req, res) => {
      const { id } = req.body as { id?: string };
      if (!id) {
        res.status(400).json({ error: "missing id" });
        return;
      }

      this.removeSubscription(id);
      res.json({ ok: true });
    });

    // POST /api/push/test — send a test notification.
    router.post("/test", async (_req, res) => {
      await this.notify({
        title: "🧪 Test Notification",
        body: "Push notifications are working!",
        tag: "test",
      });
      res.json({ ok: true, subscribers: this.subscriptions.size });
    });

    return router;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private loadOrGenerateVapidKeys(): VapidKeys {
    const keyFile = path.join(this.configDir, "vapid.json");

    try {
      const data = fs.readFileSync(keyFile, "utf8");
      const keys = JSON.parse(data) as VapidKeys;
      if (keys.publicKey && keys.privateKey) {
        this.logger?.log("[push] loaded VAPID keys from disk");
        return keys;
      }
    } catch {
      // File doesn't exist or is invalid — generate new keys.
    }

    const keys = this.generateVapidKeys();

    try {
      fs.mkdirSync(this.configDir, { recursive: true });
      fs.writeFileSync(keyFile, JSON.stringify(keys, null, 2), {
        mode: 0o600,
      });
      this.logger?.log("[push] generated new VAPID keys");
    } catch (err) {
      this.logger?.error(`[push] failed to save VAPID keys: ${err}`);
    }

    return keys;
  }

  private generateVapidKeys(): VapidKeys {
    return this.pushClient.generateVAPIDKeys();
  }

  private async sendPush(
    subscription: PushSubscription,
    body: string
  ): Promise<void> {
    const result = await this.pushClient.sendNotification(subscription, body, {
      vapidDetails: {
        subject: this.vapidSubject,
        publicKey: this.vapidKeys.publicKey,
        privateKey: this.vapidKeys.privateKey
      },
      TTL: 60,
      urgency: "high"
    });
    this.logger?.log(
      `[push] sent notification to ${subscription.endpoint} (status=${result.statusCode ?? "unknown"})`
    );
  }
}

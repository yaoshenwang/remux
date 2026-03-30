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

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import express, { type Router } from "express";
import { createWebPushClient } from "./push-sender.js";

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

export interface NotificationPreferences {
  bell: boolean;
  exit: boolean;
}

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

// ---------------------------------------------------------------------------
// WebPushClient interface for testability
// ---------------------------------------------------------------------------

export interface WebPushClient {
  sendNotification(subscription: PushSubscription, body: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// NotificationManager
// ---------------------------------------------------------------------------

export class NotificationManager {
  private subscriptions = new Map<string, {
    subscription: PushSubscription;
    preferences: NotificationPreferences;
  }>();
  private vapidKeys: VapidKeys;
  private readonly configDir: string;

  constructor(
    private readonly logger?: Pick<Console, "log" | "error">,
    private readonly pushClient?: WebPushClient
  ) {
    this.configDir = path.join(os.homedir(), ".remux");
    this.vapidKeys = this.loadOrGenerateVapidKeys();
  }

  /** Get the VAPID public key (clients need this to subscribe). */
  get publicKey(): string {
    return this.vapidKeys.publicKey;
  }

  /** Register a push subscription from a client. */
  addSubscription(
    id: string,
    subscription: PushSubscription,
    preferences: NotificationPreferences = { bell: true, exit: true },
  ): void {
    this.subscriptions.set(id, { subscription, preferences });
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
  async notify(
    payload: NotificationPayload,
    options: { kind?: keyof NotificationPreferences } = {},
  ): Promise<void> {
    if (this.subscriptions.size === 0) return;

    this.logger?.log(
      `[push] sending "${payload.title}" to ${this.subscriptions.size} subscribers`
    );

    const body = JSON.stringify(payload);
    const failures: string[] = [];

    for (const [id, entry] of this.subscriptions) {
      if (options.kind && !entry.preferences[options.kind]) {
        continue;
      }
      try {
        await this.sendPush(entry.subscription, body);
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
      title: "Terminal Bell",
      body: `Session "${sessionName}" rang the bell`,
      tag: `bell-${sessionName}`,
      data: { type: "bell", session: sessionName, url: `/?session=${encodeURIComponent(sessionName)}` },
    }, {
      kind: "bell",
    });
  }

  /** Notify about a session exit. */
  async notifySessionExit(
    sessionName: string,
    exitCode: number
  ): Promise<void> {
    if (exitCode === 0) {
      return;
    }

    await this.notify({
      title: "Session Exited",
      body: `Session "${sessionName}" exited with code ${exitCode}`,
      tag: `exit-${sessionName}`,
      data: {
        type: "exit",
        session: sessionName,
        exitCode,
        url: `/?session=${encodeURIComponent(sessionName)}`,
      },
    }, {
      kind: "exit",
    });
  }

  /** Create Express routes for push subscription management. */
  createRoutes(): Router {
    const router = express.Router();

    // GET /api/push/vapid-key — client needs this to subscribe.
    router.get("/api/push/vapid-key", (_req, res) => {
      res.json({ publicKey: this.publicKey });
    });

    // POST /api/push/subscribe — register a push subscription.
    router.post("/api/push/subscribe", (req, res) => {
      const { id, subscription, preferences } = req.body as {
        id?: string;
        subscription?: PushSubscription;
        preferences?: Partial<NotificationPreferences>;
      };

      if (!id || !subscription?.endpoint || !subscription?.keys) {
        res.status(400).json({ error: "missing id or subscription" });
        return;
      }

      this.addSubscription(id, subscription, {
        bell: preferences?.bell ?? true,
        exit: preferences?.exit ?? true,
      });
      res.json({ ok: true });
    });

    // POST /api/push/unsubscribe — remove a push subscription.
    router.post("/api/push/unsubscribe", (req, res) => {
      const { id } = req.body as { id?: string };
      if (!id) {
        res.status(400).json({ error: "missing id" });
        return;
      }

      this.removeSubscription(id);
      res.json({ ok: true });
    });

    // POST /api/push/test — send a test notification.
    router.post("/api/push/test", async (_req, res) => {
      await this.notify({
        title: "Test Notification",
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
    // Generate ECDH P-256 key pair for VAPID.
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", {
      namedCurve: "P-256",
    });

    return {
      publicKey: publicKey
        .export({ type: "spki", format: "der" })
        .toString("base64url"),
      privateKey: privateKey
        .export({ type: "pkcs8", format: "der" })
        .toString("base64url"),
    };
  }

  private async sendPush(
    subscription: PushSubscription,
    body: string
  ): Promise<void> {
    if (this.pushClient) {
      await this.pushClient.sendNotification(subscription, body);
      return;
    }

    const sender = createWebPushClient({
      publicKey: this.vapidKeys.publicKey,
      privateKey: this.vapidKeys.privateKey,
    });
    await sender.sendNotification(subscription, body);
  }
}

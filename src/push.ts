/**
 * Web Push notification module for Remux.
 * VAPID key management (generate on first run, persist in SQLite settings),
 * push subscription helpers, and broadcast-to-all utility.
 *
 * Uses the web-push library (MIT) for VAPID auth + notification delivery.
 * https://github.com/web-push-libs/web-push
 */

import webpush from "web-push";
import {
  getSetting,
  setSetting,
  getPushSubscription,
  listPushSubscriptions,
  removePushSubscription,
} from "./store.js";

// ── VAPID Keys ──────────────────────────────────────────────────

const VAPID_PUBLIC_KEY = "vapid_public_key";
const VAPID_PRIVATE_KEY = "vapid_private_key";
const VAPID_SUBJECT = "mailto:remux@localhost";

let vapidPublicKey: string | null = null;
let vapidReady = false;

/**
 * Initialize Web Push: load existing VAPID keys from SQLite settings,
 * or generate new ones on first run.
 */
export function initPush(): void {
  let pubKey = getSetting(VAPID_PUBLIC_KEY);
  let privKey = getSetting(VAPID_PRIVATE_KEY);

  if (!pubKey || !privKey) {
    // First run: generate VAPID key pair
    const keys = webpush.generateVAPIDKeys();
    pubKey = keys.publicKey;
    privKey = keys.privateKey;
    setSetting(VAPID_PUBLIC_KEY, pubKey);
    setSetting(VAPID_PRIVATE_KEY, privKey);
    console.log("[push] generated new VAPID keys");
  } else {
    console.log("[push] loaded VAPID keys from store");
  }

  webpush.setVapidDetails(VAPID_SUBJECT, pubKey, privKey);
  vapidPublicKey = pubKey;
  vapidReady = true;
}

/**
 * Return the public VAPID key for client-side subscription.
 * Returns null if push is not initialized.
 */
export function getVapidPublicKey(): string | null {
  return vapidPublicKey;
}

/**
 * Check if push notifications are initialized and ready.
 */
export function isPushReady(): boolean {
  return vapidReady;
}

/**
 * Send a push notification to a specific device by deviceId.
 * Returns true if sent successfully, false otherwise.
 * Automatically removes stale subscriptions on 404/410.
 */
export async function sendPushNotification(
  deviceId: string,
  title: string,
  body: string,
): Promise<boolean> {
  if (!vapidReady) return false;

  const sub = getPushSubscription(deviceId);
  if (!sub) return false;

  const payload = JSON.stringify({ title, body, tag: "notification" });

  try {
    await webpush.sendNotification(
      {
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth },
      },
      payload,
    );
    return true;
  } catch (err: any) {
    // 404 or 410 means subscription is no longer valid
    if (err.statusCode === 404 || err.statusCode === 410) {
      removePushSubscription(deviceId);
      console.log(
        `[push] removed stale subscription for device ${deviceId} (${err.statusCode})`,
      );
    } else {
      console.error(`[push] failed to send to device ${deviceId}:`, err.message);
    }
    return false;
  }
}

/**
 * Broadcast a push notification to all subscribed devices,
 * optionally excluding specific device IDs (e.g., currently connected ones).
 */
export async function broadcastPush(
  title: string,
  body: string,
  excludeDeviceIds: string[] = [],
): Promise<void> {
  if (!vapidReady) return;

  const subs = listPushSubscriptions();
  const excludeSet = new Set(excludeDeviceIds);

  const promises = subs
    .filter((s) => !excludeSet.has(s.deviceId))
    .map((s) => sendPushNotification(s.deviceId, title, body));

  await Promise.allSettled(promises);
}

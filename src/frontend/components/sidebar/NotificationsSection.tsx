import { useCallback, useEffect, useMemo, useState } from "react";

interface NotificationPreferences {
  bell: boolean;
  exit: boolean;
}

const STORAGE_KEY = "remux-notification-preferences";
const SUBSCRIPTION_ID_KEY = "remux-push-subscription-id";

export const NotificationsSection = () => {
  const [preferences, setPreferences] = useState<NotificationPreferences>(() => readPreferences());
  const [permissionState, setPermissionState] = useState(Notification.permission);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const enabledCount = useMemo(
    () => Number(preferences.bell) + Number(preferences.exit),
    [preferences],
  );

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  }, [preferences]);

  const syncSubscription = useCallback(async (nextPreferences: NotificationPreferences) => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      setErrorMessage("Push notifications are not supported in this browser.");
      return;
    }

    if (!nextPreferences.bell && !nextPreferences.exit) {
      const registration = await navigator.serviceWorker.getRegistration("/remux-sw.js");
      const existingSubscription = await registration?.pushManager.getSubscription();
      if (existingSubscription) {
        await fetch("/api/push/unsubscribe", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            id: getOrCreateSubscriptionId(),
          }),
        });
        await existingSubscription.unsubscribe();
      }
      setErrorMessage(null);
      return;
    }

    if (Notification.permission === "default") {
      const permission = await Notification.requestPermission();
      setPermissionState(permission);
      if (permission !== "granted") {
        setErrorMessage("Notification permission was not granted.");
        return;
      }
    }

    if (Notification.permission !== "granted") {
      setPermissionState(Notification.permission);
      setErrorMessage("Notification permission is blocked for this site.");
      return;
    }

    const registration = await navigator.serviceWorker.register("/remux-sw.js");
    const vapidResponse = await fetch("/api/push/vapid-key");
    const vapidPayload = await vapidResponse.json() as { publicKey?: string };
    if (!vapidPayload.publicKey) {
      throw new Error("missing VAPID public key");
    }

    const existingSubscription = await registration.pushManager.getSubscription();
    const subscription = existingSubscription ?? await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: decodeBase64Url(vapidPayload.publicKey),
    });

    await fetch("/api/push/subscribe", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: getOrCreateSubscriptionId(),
        subscription,
        preferences: nextPreferences,
      }),
    });
    setErrorMessage(null);
  }, []);

  const updatePreference = useCallback(async (
    key: keyof NotificationPreferences,
    value: boolean,
  ) => {
    let nextPreferences: NotificationPreferences | null = null;
    setPreferences((previous) => {
      nextPreferences = {
        ...previous,
        [key]: value,
      };
      return nextPreferences;
    });

    try {
      if (nextPreferences) {
        await syncSubscription(nextPreferences);
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "failed to update notifications");
    }
  }, [syncSubscription]);

  return (
    <section className="sidebar-section" data-testid="notifications-section">
      <div className="device-section-header">
        <div>
          <h3 className="sidebar-section-title">Notifications</h3>
          <p className="device-section-subtitle">
            Configure bell and exit push notifications.
          </p>
        </div>
        <span className="connection-state-pill">{enabledCount} enabled</span>
      </div>

      <div className="notification-toggle-list">
        <label className="notification-toggle">
          <span>Bell alerts</span>
          <input
            checked={preferences.bell}
            onChange={(event) => void updatePreference("bell", event.target.checked)}
            type="checkbox"
          />
        </label>
        <label className="notification-toggle">
          <span>Session exit</span>
          <input
            checked={preferences.exit}
            onChange={(event) => void updatePreference("exit", event.target.checked)}
            type="checkbox"
          />
        </label>
      </div>

      <div className="notification-meta">
        <span>{`Permission: ${permissionState}`}</span>
      </div>

      {errorMessage && <div className="device-section-error">{errorMessage}</div>}
    </section>
  );
};

const readPreferences = (): NotificationPreferences => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { bell: false, exit: false };
    }
    const parsed = JSON.parse(raw) as Partial<NotificationPreferences>;
    return {
      bell: parsed.bell === true,
      exit: parsed.exit === true,
    };
  } catch {
    return { bell: false, exit: false };
  }
};

const getOrCreateSubscriptionId = (): string => {
  const existing = localStorage.getItem(SUBSCRIPTION_ID_KEY);
  if (existing) {
    return existing;
  }
  const created = crypto.randomUUID();
  localStorage.setItem(SUBSCRIPTION_ID_KEY, created);
  return created;
};

const decodeBase64Url = (value: string): ArrayBuffer => {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0)).buffer;
};

import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { token } from "../../remux-runtime";

interface DeviceRecord {
  deviceId: string;
  displayName: string;
  platform: string;
  lastSeenAt: string;
  trustLevel: "trusted" | "revoked";
  revokedAt?: string | null;
}

interface PairingPayloadV2 {
  url: string;
  token: string;
  pairingSessionId: string;
  expiresAt: string;
  protocolVersion: 2;
  serverVersion: string;
}

interface DeviceSectionProps {
  currentDeviceId?: string | null;
}

export const DeviceSection = ({
  currentDeviceId = null,
}: DeviceSectionProps) => {
  const [devices, setDevices] = useState<DeviceRecord[]>([]);
  const [pairingPayload, setPairingPayload] = useState<PairingPayloadV2 | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionError, setActionError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const loadDevices = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/devices", {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      const payload = await response.json() as { devices?: DeviceRecord[]; error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "failed to load devices");
      }
      setDevices(payload.devices ?? []);
      setActionError(null);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "failed to load devices");
    } finally {
      setLoading(false);
    }
  }, []);

  const createPairing = useCallback(async () => {
    try {
      const response = await fetch("/api/pairing/create", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      const payload = await response.json() as { payload?: PairingPayloadV2; error?: string };
      if (!response.ok || !payload.payload) {
        throw new Error(payload.error ?? "failed to create pairing session");
      }
      setPairingPayload(payload.payload);
      setActionError(null);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "failed to create pairing session");
    }
  }, []);

  const revokeDevice = useCallback(async (device: DeviceRecord) => {
    const isCurrent = currentDeviceId === device.deviceId;
    const confirmed = window.confirm(
      isCurrent
        ? `Revoke this device (${device.displayName})? This will sign out the current trusted device.`
        : `Revoke ${device.displayName}?`,
    );
    if (!confirmed) {
      return;
    }

    try {
      const response = await fetch(`/api/devices/${encodeURIComponent(device.deviceId)}/revoke`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          reason: "revoked from web ui",
        }),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "failed to revoke device");
      }
      await loadDevices();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "failed to revoke device");
    }
  }, [currentDeviceId, loadDevices]);

  useEffect(() => {
    void loadDevices();
  }, [loadDevices]);

  useEffect(() => {
    if (!pairingPayload || !canvasRef.current) {
      return;
    }

    void QRCode.toCanvas(canvasRef.current, JSON.stringify(pairingPayload), {
      margin: 1,
      width: 180,
      color: {
        dark: "#0f1720",
        light: "#f7faf8",
      },
    });

    const refreshDelay = Math.max(new Date(pairingPayload.expiresAt).getTime() - Date.now(), 0);
    const timer = setTimeout(() => {
      void createPairing();
    }, refreshDelay);
    return () => clearTimeout(timer);
  }, [createPairing, pairingPayload]);

  return (
    <section className="sidebar-section" data-testid="device-section">
      <div className="device-section-header">
        <div>
          <h3 className="sidebar-section-title">Devices</h3>
          <p className="device-section-subtitle">Manage trusted devices and pairing.</p>
        </div>
        <button className="device-action-btn" onClick={() => void createPairing()} type="button">
          Pair New Device
        </button>
      </div>

      {pairingPayload && (
        <div className="pairing-card">
          <canvas ref={canvasRef} className="pairing-qr" data-testid="pairing-qr" />
          <div className="pairing-meta">
            <span>Protocol v{pairingPayload.protocolVersion}</span>
            <span>Expires {formatTime(pairingPayload.expiresAt)}</span>
          </div>
        </div>
      )}

      {actionError && <div className="device-section-error">{actionError}</div>}

      <div className="device-list" data-testid="device-list">
        {loading ? (
          <span className="device-list-empty">Loading devices…</span>
        ) : devices.length === 0 ? (
          <span className="device-list-empty">No trusted devices yet.</span>
        ) : (
          devices.map((device) => (
            <article key={device.deviceId} className="device-card">
              <div className="device-card-top">
                <div>
                  <div className="device-card-name">
                    {device.displayName}
                    {device.deviceId === currentDeviceId && (
                      <span className="device-current-badge">Current</span>
                    )}
                  </div>
                  <div className="device-card-meta">
                    <span>{device.platform}</span>
                    <span>{device.trustLevel}</span>
                    <span>Seen {formatTime(device.lastSeenAt)}</span>
                  </div>
                </div>
                <button
                  className="device-revoke-btn"
                  disabled={device.trustLevel === "revoked"}
                  onClick={() => void revokeDevice(device)}
                  type="button"
                >
                  {device.trustLevel === "revoked" ? "Revoked" : "Revoke"}
                </button>
              </div>
            </article>
          ))
        )}
      </div>
    </section>
  );
};

const formatTime = (value: string): string => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
};

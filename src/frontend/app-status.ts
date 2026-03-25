export interface TopStatus {
  kind: "error" | "pending" | "warn" | "ok";
  label: string;
}

interface DeriveTopStatusOptions {
  authReady: boolean;
  awaitingSessionAttachment: boolean;
  awaitingSessionSelection: boolean;
  errorMessage: string;
  pendingSessionAttachment: string | null;
  statusMessage: string;
}

export const deriveTopStatus = ({
  authReady,
  awaitingSessionAttachment,
  awaitingSessionSelection,
  errorMessage,
  pendingSessionAttachment,
  statusMessage
}: DeriveTopStatusOptions): TopStatus => {
  if (errorMessage) {
    return { kind: "error", label: errorMessage };
  }
  if (awaitingSessionSelection) {
    return { kind: "pending", label: "select session" };
  }
  if (awaitingSessionAttachment && pendingSessionAttachment) {
    return { kind: "pending", label: `attaching: ${pendingSessionAttachment}` };
  }

  const lowerStatus = statusMessage.toLowerCase();
  if (lowerStatus.includes("disconnected") || lowerStatus.includes("reconnect")) {
    return { kind: "warn", label: statusMessage };
  }
  if (lowerStatus.includes("connected") || statusMessage.startsWith("attached:")) {
    return { kind: "ok", label: statusMessage };
  }
  if (statusMessage) {
    return { kind: "pending", label: statusMessage };
  }
  if (authReady) {
    return { kind: "ok", label: "connected" };
  }
  return { kind: "pending", label: "connecting" };
};

export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
};

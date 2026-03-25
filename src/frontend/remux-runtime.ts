import type { ControlServerMessage } from "../shared/protocol";

const query = new URLSearchParams(window.location.search);

export const token = query.get("token") ?? "";
export const debugMode = query.get("debug") === "1";

export const wsOrigin = (() => {
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${window.location.host}`;
})();

export const RECONNECT_BASE_MS = 1000;
export const RECONNECT_MAX_MS = 8000;

export const parseMessage = (raw: string): ControlServerMessage | null => {
  try {
    return JSON.parse(raw) as ControlServerMessage;
  } catch {
    return null;
  }
};

export const debugLog = (event: string, payload?: unknown): void => {
  if (!debugMode) {
    return;
  }
  const entry = {
    at: new Date().toISOString(),
    event,
    payload
  };
  const current = window.__remuxDebugEvents ?? [];
  current.push(entry);
  if (current.length > 500) {
    current.splice(0, current.length - 500);
  }
  window.__remuxDebugEvents = current;
  console.log("[remux-debug]", entry.at, event, payload ?? "");
};

export const formatPasswordError = (reason: string): string => {
  if (reason === "invalid password") {
    return "Wrong password. Try again.";
  }
  return reason;
};

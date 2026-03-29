export const MAX_RECONNECT_ATTEMPTS = 10;

export const resolveReconnectDelay = (
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
): number => Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);

export const shouldPauseReconnect = (attempt: number): boolean =>
  attempt >= MAX_RECONNECT_ATTEMPTS;

import { describe, expect, test } from "vitest";
import {
  MAX_RECONNECT_ATTEMPTS,
  resolveReconnectDelay,
  shouldPauseReconnect,
} from "../../src/frontend/reconnect-policy.js";

describe("reconnect policy", () => {
  test("caps reconnect delay at the configured maximum", () => {
    expect(resolveReconnectDelay(0, 1_000, 16_000)).toBe(1_000);
    expect(resolveReconnectDelay(1, 1_000, 16_000)).toBe(2_000);
    expect(resolveReconnectDelay(5, 1_000, 16_000)).toBe(16_000);
  });

  test("pauses automatic retries after the configured attempt limit", () => {
    expect(shouldPauseReconnect(MAX_RECONNECT_ATTEMPTS - 1)).toBe(false);
    expect(shouldPauseReconnect(MAX_RECONNECT_ATTEMPTS)).toBe(true);
  });
});

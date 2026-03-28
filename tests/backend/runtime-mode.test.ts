import { describe, expect, test } from "vitest";
import { isExplicitRuntimeV2TargetConfigured, isRuntimeV2Required, shouldAllowLegacyFallback } from "../../src/backend/runtime-mode.js";

describe("runtime-v2 requirement policy", () => {
  test("treats an explicit shared runtime base URL as runtime-v2 required", () => {
    expect(isExplicitRuntimeV2TargetConfigured({
      REMUXD_BASE_URL: "http://127.0.0.1:3737"
    })).toBe(true);
    expect(isRuntimeV2Required({
      REMUXD_BASE_URL: "http://127.0.0.1:3737"
    })).toBe(true);
    expect(shouldAllowLegacyFallback({
      REMUXD_BASE_URL: "http://127.0.0.1:3737"
    })).toBe(false);
  });

  test("treats an explicit runtime-v2 requirement flag as non-fallback", () => {
    expect(isRuntimeV2Required({
      REMUX_RUNTIME_V2_REQUIRED: "1"
    })).toBe(true);
    expect(shouldAllowLegacyFallback({
      REMUX_RUNTIME_V2_REQUIRED: "1"
    })).toBe(false);
  });

  test("allows legacy fallback when no explicit runtime-v2 target is configured", () => {
    expect(isExplicitRuntimeV2TargetConfigured({})).toBe(false);
    expect(isRuntimeV2Required({})).toBe(false);
    expect(shouldAllowLegacyFallback({})).toBe(true);
  });
});

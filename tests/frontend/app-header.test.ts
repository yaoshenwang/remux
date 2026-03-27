import { describe, expect, test } from "vitest";
import {
  describeRuntimeState,
  formatInspectPrecisionBadge,
} from "../../src/frontend/components/AppHeader.js";

describe("app header runtime badges", () => {
  test("describes runtime-v2 live state explicitly", () => {
    expect(
      describeRuntimeState({
        streamMode: "native-bridge",
        scrollbackPrecision: "precise",
      })
    ).toEqual({
      className: "stream-badge native",
      label: "precise live",
      title: "Using the runtime-v2 live stream with precise scrollback",
    });
  });

  test("describes degraded live state with a fallback reason", () => {
    expect(
      describeRuntimeState({
        streamMode: "cli-polling",
        degradedReason: "bridge_crashed",
        scrollbackPrecision: "approximate",
      })
    ).toEqual({
      className: "stream-badge degraded",
      label: "degraded live",
      title: "Runtime live stream degraded (bridge_crashed) - falling back to snapshot polling",
    });
  });

  test("formats inspect precision badge from real snapshot precision", () => {
    expect(formatInspectPrecisionBadge("precise")).toBeNull();
    expect(formatInspectPrecisionBadge("approximate")).toBe("approx");
    expect(formatInspectPrecisionBadge("partial")).toBe("partial");
  });
});

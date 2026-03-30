import { describe, expect, test } from "vitest";
import { buildLaunchUrl } from "../../src/backend/launch-context.js";

describe("backend launch context", () => {
  test("builds launch URL with token only", () => {
    expect(buildLaunchUrl("https://example.com/base", "tok")).toBe("https://example.com/base?token=tok");
  });
});

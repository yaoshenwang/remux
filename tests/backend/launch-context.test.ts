import { describe, expect, test } from "vitest";
import { buildLaunchUrl } from "../../src/backend/launch-context.js";

describe("backend launch context", () => {
  test("builds launch URL with token and launch hint", () => {
    expect(buildLaunchUrl("https://example.com", "tok", {
      session: "work",
      tabIndex: 2,
      paneId: "%9"
    })).toBe("https://example.com/?token=tok&session=work&tab=2&pane=%259");
  });

  test("omits optional launch hints when they are not provided", () => {
    expect(buildLaunchUrl("https://example.com/base", "tok")).toBe("https://example.com/base?token=tok");
  });
});

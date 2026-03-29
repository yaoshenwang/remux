import { describe, expect, test } from "vitest";
import {
  buildCprResponse,
  CPR_RESPONSE_REGEX,
  filterCprFromInput,
  interceptDsr,
} from "../../src/backend/terminal-state/dsr-interceptor.js";

describe("DSR/CPR interception", () => {
  describe("interceptDsr", () => {
    test("returns unchanged data when no DSR present", () => {
      const result = interceptDsr("hello world");
      expect(result.cleaned).toBe("hello world");
      expect(result.count).toBe(0);
    });

    test("strips a single DSR sequence", () => {
      const result = interceptDsr("before\x1b[6nafter");
      expect(result.cleaned).toBe("beforeafter");
      expect(result.count).toBe(1);
    });

    test("strips multiple DSR sequences", () => {
      const result = interceptDsr("\x1b[6nfoo\x1b[6nbar\x1b[6n");
      expect(result.cleaned).toBe("foobar");
      expect(result.count).toBe(3);
    });

    test("handles data that is only DSR", () => {
      const result = interceptDsr("\x1b[6n");
      expect(result.cleaned).toBe("");
      expect(result.count).toBe(1);
    });

    test("does not strip partial DSR sequences", () => {
      const result = interceptDsr("\x1b[6");
      expect(result.cleaned).toBe("\x1b[6");
      expect(result.count).toBe(0);
    });

    test("does not strip other escape sequences", () => {
      const result = interceptDsr("\x1b[1m\x1b[31m\x1b[6ntext\x1b[0m");
      expect(result.cleaned).toBe("\x1b[1m\x1b[31mtext\x1b[0m");
      expect(result.count).toBe(1);
    });

    test("handles empty string", () => {
      const result = interceptDsr("");
      expect(result.cleaned).toBe("");
      expect(result.count).toBe(0);
    });
  });

  describe("buildCprResponse", () => {
    test("builds correct CPR for row 1, col 1", () => {
      expect(buildCprResponse(1, 1)).toBe("\x1b[1;1R");
    });

    test("builds correct CPR for arbitrary position", () => {
      expect(buildCprResponse(24, 80)).toBe("\x1b[24;80R");
    });
  });

  describe("filterCprFromInput", () => {
    test("returns unchanged data when no CPR present", () => {
      expect(filterCprFromInput("hello")).toBe("hello");
    });

    test("strips a single CPR response", () => {
      expect(filterCprFromInput("text\x1b[24;80Rmore")).toBe("textmore");
    });

    test("strips multiple CPR responses", () => {
      expect(filterCprFromInput("\x1b[1;1Ra\x1b[10;50R")).toBe("a");
    });

    test("does not strip non-CPR sequences", () => {
      expect(filterCprFromInput("\x1b[1m\x1b[31m")).toBe("\x1b[1m\x1b[31m");
    });

    test("handles empty string", () => {
      expect(filterCprFromInput("")).toBe("");
    });
  });

  describe("CPR_RESPONSE_REGEX", () => {
    test("matches valid CPR responses", () => {
      expect("\x1b[1;1R").toMatch(CPR_RESPONSE_REGEX);
      expect("\x1b[24;80R").toMatch(CPR_RESPONSE_REGEX);
      expect("\x1b[999;999R").toMatch(CPR_RESPONSE_REGEX);
    });

    test("does not match non-CPR sequences", () => {
      // Reset the regex lastIndex since it has the global flag
      CPR_RESPONSE_REGEX.lastIndex = 0;
      expect("\x1b[1m").not.toMatch(CPR_RESPONSE_REGEX);
    });
  });
});

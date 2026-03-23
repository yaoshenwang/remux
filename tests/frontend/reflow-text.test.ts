import { describe, it, expect } from "vitest";
import { reflowText } from "../../src/frontend/reflow-text";

describe("reflowText", () => {
  it("joins lines that fill exactly the terminal width", () => {
    // 10-col terminal: "0123456789" (10 chars) + "abc" → should join
    const input = "0123456789\nabc\n";
    expect(reflowText(input, 10)).toBe("0123456789abc\n");
  });

  it("does not join lines shorter than terminal width", () => {
    const input = "short\nnext line\n";
    expect(reflowText(input, 40)).toBe("short\nnext line\n");
  });

  it("joins multiple consecutive wrapped lines", () => {
    // 5-col terminal
    const input = "abcde\nfghij\nk\n";
    expect(reflowText(input, 5)).toBe("abcdefghijk\n");
  });

  it("handles CJK characters (2 display width each)", () => {
    // 10-col terminal: "你好世界呀" = 5 chars × 2 = 10 display width → should join
    const input = "你好世界呀\n继续\n";
    expect(reflowText(input, 10)).toBe("你好世界呀继续\n");
  });

  it("handles CJK at cols-1 boundary (wide char can't fit)", () => {
    // 11-col terminal: "你好世界呀" = 10 display width, 11-1=10 → joins
    const input = "你好世界呀\n继续\n";
    expect(reflowText(input, 11)).toBe("你好世界呀继续\n");
  });

  it("preserves lines with ANSI codes", () => {
    // 10-col terminal: visible text is "0123456789" (10 chars), ANSI doesn't count
    const input = "\x1b[31m0123456789\x1b[0m\nabc\n";
    expect(reflowText(input, 10)).toBe("\x1b[31m0123456789\x1b[0mabc\n");
  });

  it("does not join when line width exceeds cols", () => {
    // Line longer than terminal width — not a wrapped line
    const input = "this is longer than 10\nnext\n";
    expect(reflowText(input, 10)).toBe("this is longer than 10\nnext\n");
  });

  it("returns text unchanged for very small cols", () => {
    const input = "ab\ncd\n";
    expect(reflowText(input, 3)).toBe("ab\ncd\n");
  });

  it("handles empty input", () => {
    expect(reflowText("", 80)).toBe("");
  });

  it("handles text without trailing newline", () => {
    const input = "0123456789\nabc";
    expect(reflowText(input, 10)).toBe("0123456789abc");
  });

  it("preserves blank lines", () => {
    const input = "hello\n\nworld\n";
    expect(reflowText(input, 40)).toBe("hello\n\nworld\n");
  });

  it("handles mixed ASCII and CJK wrapping", () => {
    // 20-col terminal: "abc你好世界defgh" = 3 + 4*2 + 5 = 16... not 20
    // "abc你好世界defghi" = 3 + 4*2 + 6 = 17... not 20
    // Let's use: "ab你好世界cd" = 2 + 4*2 + 2 = 12
    const input = "ab你好世界cd\nnext\n";
    expect(reflowText(input, 12)).toBe("ab你好世界cdnext\n");
  });
});

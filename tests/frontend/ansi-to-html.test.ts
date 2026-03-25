import { describe, expect, test } from "vitest";
import { ansiToHtml } from "../../src/frontend/ansi-to-html.js";

describe("ansiToHtml", () => {
  test("strips terminal private mode sequences from scrollback output", () => {
    const input = "\x1b[?1049hhello\x1b[?25l world\x1b[?25h";

    expect(ansiToHtml(input)).toBe("hello world");
  });

  test("keeps SGR styling while removing surrounding terminal mode toggles", () => {
    const input = "\x1b[?1049h\x1b[31merror\x1b[0m\x1b[?1049l";

    expect(ansiToHtml(input)).toBe('<span style="color:#ff6b6b">error</span>');
  });
});

/**
 * Tests for workspace content renderers: diff, markdown, ANSI.
 * Covers detectContentType, renderDiff, renderMarkdown, renderAnsi.
 */

import { describe, it, expect } from "vitest";
import {
  detectContentType,
  renderDiff,
  renderMarkdown,
  renderAnsi,
} from "../src/domain/workspace/artifact-renderers.ts";

// ── detectContentType ──────────────────────────────────────────

describe("detectContentType", () => {
  it("identifies unified diff (diff --git header)", () => {
    const text = `diff --git a/foo.js b/foo.js
index 1234567..abcdefg 100644
--- a/foo.js
+++ b/foo.js
@@ -1,3 +1,4 @@
 const a = 1;
+const b = 2;
 const c = 3;`;
    expect(detectContentType(text)).toBe("diff");
  });

  it("identifies unified diff (--- and +++ headers)", () => {
    const text = `--- a/file.txt
+++ b/file.txt
@@ -1,2 +1,3 @@
 hello
+world
 end`;
    expect(detectContentType(text)).toBe("diff");
  });

  it("identifies markdown with headers", () => {
    const text = `# Hello World

This is a paragraph with **bold** text.

## Section Two

- item one
- item two`;
    expect(detectContentType(text)).toBe("markdown");
  });

  it("identifies markdown with code blocks", () => {
    const text = "Some text\n\n```js\nconst x = 1;\n```\n\nMore text";
    expect(detectContentType(text)).toBe("markdown");
  });

  it("identifies markdown with links", () => {
    const text = "Check out [this link](https://example.com) for more info.";
    expect(detectContentType(text)).toBe("markdown");
  });

  it("identifies ANSI escape sequences", () => {
    const text = "\x1b[31mERROR:\x1b[0m Something went wrong";
    expect(detectContentType(text)).toBe("ansi");
  });

  it("returns plain for unformatted text", () => {
    const text = "Just a regular string with no special formatting.";
    expect(detectContentType(text)).toBe("plain");
  });

  it("returns plain for empty string", () => {
    expect(detectContentType("")).toBe("plain");
  });

  it("diff takes priority over markdown when both present", () => {
    const text = `diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1 +1,2 @@
 # Title
+**bold addition**`;
    expect(detectContentType(text)).toBe("diff");
  });

  it("ANSI takes priority over plain text", () => {
    const text = "normal text \x1b[1mbold text\x1b[0m more normal";
    expect(detectContentType(text)).toBe("ansi");
  });
});

// ── renderDiff ─────────────────────────────────────────────────

describe("renderDiff", () => {
  it("renders additions with diff-add class", () => {
    const diff = `--- a/f.txt
+++ b/f.txt
@@ -1 +1,2 @@
 existing
+added line`;
    const html = renderDiff(diff);
    expect(html).toContain('class="diff-add"');
    expect(html).toContain("added line");
  });

  it("renders deletions with diff-del class", () => {
    const diff = `--- a/f.txt
+++ b/f.txt
@@ -1,2 +1 @@
-removed line
 kept`;
    const html = renderDiff(diff);
    expect(html).toContain('class="diff-del"');
    expect(html).toContain("removed line");
  });

  it("renders hunk headers with diff-hunk class", () => {
    const diff = `--- a/f.txt
+++ b/f.txt
@@ -1,3 +1,3 @@
 context`;
    const html = renderDiff(diff);
    expect(html).toContain('class="diff-hunk"');
    expect(html).toContain("@@ -1,3 +1,3 @@");
  });

  it("renders diff --git header with diff-header class", () => {
    const diff = `diff --git a/f.txt b/f.txt
index abc..def 100644
--- a/f.txt
+++ b/f.txt
@@ -1 +1 @@
-old
+new`;
    const html = renderDiff(diff);
    expect(html).toContain('class="diff-header"');
    expect(html).toContain("diff --git");
  });

  it("renders context lines with diff-ctx class", () => {
    const diff = `--- a/f.txt
+++ b/f.txt
@@ -1,3 +1,3 @@
 context line
-old
+new`;
    const html = renderDiff(diff);
    expect(html).toContain('class="diff-ctx"');
    expect(html).toContain("context line");
  });

  it("escapes HTML entities in diff content", () => {
    const diff = `--- a/f.html
+++ b/f.html
@@ -1 +1 @@
-<div class="old">old</div>
+<div class="new">new</div>`;
    const html = renderDiff(diff);
    expect(html).toContain("&lt;div");
    expect(html).toContain("&gt;");
    expect(html).toContain("&quot;");
    expect(html).not.toContain('<div class="old">');
    expect(html).not.toContain('<div class="new">');
  });

  it("includes line numbers", () => {
    const diff = `--- a/f.txt
+++ b/f.txt
@@ -1,2 +1,2 @@
 same
-old
+new`;
    const html = renderDiff(diff);
    expect(html).toContain('class="diff-line-num"');
  });

  it("wraps output in a diff container", () => {
    const diff = `--- a/f.txt
+++ b/f.txt
@@ -1 +1 @@
-a
+b`;
    const html = renderDiff(diff);
    expect(html).toContain('class="diff-container"');
  });
});

// ── renderMarkdown ─────────────────────────────────────────────

describe("renderMarkdown", () => {
  it("renders # headers to <h1>", () => {
    expect(renderMarkdown("# Title")).toContain("<h1>Title</h1>");
  });

  it("renders ## headers to <h2>", () => {
    expect(renderMarkdown("## Subtitle")).toContain("<h2>Subtitle</h2>");
  });

  it("renders ### headers to <h3>", () => {
    expect(renderMarkdown("### Section")).toContain("<h3>Section</h3>");
  });

  it("renders **bold** to <strong>", () => {
    const html = renderMarkdown("This is **bold** text");
    expect(html).toContain("<strong>bold</strong>");
  });

  it("renders *italic* to <em>", () => {
    const html = renderMarkdown("This is *italic* text");
    expect(html).toContain("<em>italic</em>");
  });

  it("renders `inline code` to <code>", () => {
    const html = renderMarkdown("Use `console.log` here");
    expect(html).toContain("<code>console.log</code>");
  });

  it("renders fenced code blocks with language class", () => {
    const md = "```js\nconst x = 1;\n```";
    const html = renderMarkdown(md);
    expect(html).toContain("<pre>");
    expect(html).toContain('<code class="language-js">');
    expect(html).toContain("const x = 1;");
  });

  it("renders fenced code blocks without language", () => {
    const md = "```\nhello world\n```";
    const html = renderMarkdown(md);
    expect(html).toContain("<pre>");
    expect(html).toContain("<code>");
    expect(html).toContain("hello world");
  });

  it("renders unordered lists", () => {
    const md = "- item one\n- item two\n- item three";
    const html = renderMarkdown(md);
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>item one</li>");
    expect(html).toContain("<li>item two</li>");
    expect(html).toContain("</ul>");
  });

  it("renders ordered lists", () => {
    const md = "1. first\n2. second\n3. third";
    const html = renderMarkdown(md);
    expect(html).toContain("<ol>");
    expect(html).toContain("<li>first</li>");
    expect(html).toContain("<li>second</li>");
    expect(html).toContain("</ol>");
  });

  it("renders [text](url) links", () => {
    const md = "Visit [Example](https://example.com) now";
    const html = renderMarkdown(md);
    expect(html).toContain('<a href="https://example.com"');
    expect(html).toContain(">Example</a>");
  });

  it("renders > blockquotes", () => {
    const md = "> This is a quote";
    const html = renderMarkdown(md);
    expect(html).toContain("<blockquote>");
    expect(html).toContain("This is a quote");
    expect(html).toContain("</blockquote>");
  });

  it("renders --- as <hr>", () => {
    const md = "above\n\n---\n\nbelow";
    const html = renderMarkdown(md);
    expect(html).toContain("<hr>");
  });

  it("escapes HTML entities in content", () => {
    const md = "Use `<div>` in your **<template>**";
    const html = renderMarkdown(md);
    expect(html).toContain("&lt;div&gt;");
    expect(html).toContain("&lt;template&gt;");
    // Should not contain raw HTML tags from user content
    expect(html).not.toContain("<div>");
    expect(html).not.toContain("<template>");
  });

  it("renders paragraphs for plain text blocks", () => {
    const md = "First paragraph.\n\nSecond paragraph.";
    const html = renderMarkdown(md);
    expect(html).toContain("<p>First paragraph.</p>");
    expect(html).toContain("<p>Second paragraph.</p>");
  });

  it("wraps output in rendered-md container", () => {
    const html = renderMarkdown("# Hello");
    expect(html).toContain('class="rendered-md"');
  });
});

// ── renderAnsi ─────────────────────────────────────────────────

describe("renderAnsi", () => {
  it("converts red ANSI to span with color", () => {
    const text = "\x1b[31mError\x1b[0m";
    const html = renderAnsi(text);
    expect(html).toContain('style="color:#cc0000"');
    expect(html).toContain("Error");
  });

  it("converts green ANSI to span with color", () => {
    const text = "\x1b[32mSuccess\x1b[0m";
    const html = renderAnsi(text);
    expect(html).toContain('style="color:#00cc00"');
    expect(html).toContain("Success");
  });

  it("converts bold ANSI to span with class", () => {
    const text = "\x1b[1mBold text\x1b[0m";
    const html = renderAnsi(text);
    expect(html).toContain('class="ansi-bold"');
    expect(html).toContain("Bold text");
  });

  it("converts dim ANSI to span with class", () => {
    const text = "\x1b[2mDim text\x1b[0m";
    const html = renderAnsi(text);
    expect(html).toContain('class="ansi-dim"');
    expect(html).toContain("Dim text");
  });

  it("converts italic ANSI to span with class", () => {
    const text = "\x1b[3mItalic text\x1b[0m";
    const html = renderAnsi(text);
    expect(html).toContain('class="ansi-italic"');
    expect(html).toContain("Italic text");
  });

  it("converts underline ANSI to span with class", () => {
    const text = "\x1b[4mUnderline\x1b[0m";
    const html = renderAnsi(text);
    expect(html).toContain('class="ansi-underline"');
    expect(html).toContain("Underline");
  });

  it("handles bright/intense colors", () => {
    const text = "\x1b[91mBright red\x1b[0m";
    const html = renderAnsi(text);
    expect(html).toContain("Bright red");
    // Should have a color style (bright red)
    expect(html).toContain("style=");
    expect(html).toContain("color:");
  });

  it("strips non-SGR escape sequences", () => {
    // Cursor movement (CSI H), erase (CSI J)
    const text = "\x1b[2J\x1b[HHello\x1b[31m World\x1b[0m";
    const html = renderAnsi(text);
    expect(html).toContain("Hello");
    expect(html).toContain("World");
    // Non-SGR sequences should be stripped
    expect(html).not.toContain("\x1b");
  });

  it("handles reset correctly", () => {
    const text = "\x1b[31mred\x1b[0m normal";
    const html = renderAnsi(text);
    expect(html).toContain("red");
    expect(html).toContain("normal");
    // "normal" should not be inside a colored span
    // The span for "red" should be closed before "normal"
  });

  it("escapes HTML entities in ANSI text", () => {
    const text = "\x1b[31m<script>alert('xss')</script>\x1b[0m";
    const html = renderAnsi(text);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("handles combined attributes (bold + color)", () => {
    const text = "\x1b[1;33mBold yellow\x1b[0m";
    const html = renderAnsi(text);
    expect(html).toContain("Bold yellow");
    // Should have both bold class and yellow color
    expect(html).toContain("ansi-bold");
    expect(html).toContain("color:");
  });

  it("returns plain text when no ANSI sequences present", () => {
    const text = "Just plain text";
    const html = renderAnsi(text);
    expect(html).toContain("Just plain text");
    // Should not contain any spans
    expect(html).not.toContain("<span");
  });
});

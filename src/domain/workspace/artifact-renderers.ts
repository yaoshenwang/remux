/**
 * Lightweight content renderers for workspace artifacts.
 * Converts diff, markdown, and ANSI text to styled HTML.
 * No external dependencies — pure string/regex parsing.
 */

// ── Helpers ────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Content-type detection ─────────────────────────────────────

/**
 * Detect content type from raw text.
 * Priority: diff > ansi > markdown > plain.
 */
export function detectContentType(
  text: string,
): "diff" | "markdown" | "ansi" | "plain" {
  if (!text) return "plain";

  // Unified diff: "diff --git" header or "---"/"+++" pair with @@ hunks
  if (/^diff --git /m.test(text)) return "diff";
  if (
    /^--- .+\n\+\+\+ .+\n@@/m.test(text)
  )
    return "diff";

  // ANSI: contains SGR escape sequences
  if (/\x1b\[[\d;]*m/.test(text)) return "ansi";

  // Markdown heuristics: headers, bold, code blocks, links
  if (/^#{1,6}\s+\S/m.test(text)) return "markdown";
  if (/\*\*[^*]+\*\*/.test(text)) return "markdown";
  if (/```[\s\S]*?```/.test(text)) return "markdown";
  if (/\[[^\]]+\]\([^)]+\)/.test(text)) return "markdown";

  return "plain";
}

// ── Diff renderer ──────────────────────────────────────────────

/**
 * Render unified diff text to HTML.
 * Produces a <div class="diff-container"> with per-line markup.
 */
export function renderDiff(diffText: string): string {
  const lines = diffText.split("\n");
  const out: string[] = ['<div class="diff-container">'];

  // Track line numbers for old/new sides
  let oldLine = 0;
  let newLine = 0;

  for (const raw of lines) {
    const escaped = escapeHtml(raw);

    if (
      raw.startsWith("diff --git") ||
      raw.startsWith("index ") ||
      raw.startsWith("---") ||
      raw.startsWith("+++")
    ) {
      out.push(
        `<div class="diff-header">${escaped}</div>`,
      );
    } else if (raw.startsWith("@@")) {
      // Parse hunk header for line numbers
      const m = raw.match(/@@ -(\d+)/);
      if (m) {
        oldLine = parseInt(m[1], 10);
        const m2 = raw.match(/@@ -\d+(?:,\d+)? \+(\d+)/);
        newLine = m2 ? parseInt(m2[1], 10) : oldLine;
      }
      out.push(
        `<div class="diff-hunk">${escaped}</div>`,
      );
    } else if (raw.startsWith("+")) {
      out.push(
        `<div class="diff-add"><span class="diff-line-num">${newLine}</span>${escaped}</div>`,
      );
      newLine++;
    } else if (raw.startsWith("-")) {
      out.push(
        `<div class="diff-del"><span class="diff-line-num">${oldLine}</span>${escaped}</div>`,
      );
      oldLine++;
    } else {
      // Context line (starts with space or is empty)
      out.push(
        `<div class="diff-ctx"><span class="diff-line-num">${oldLine}</span>${escaped}</div>`,
      );
      oldLine++;
      newLine++;
    }
  }

  out.push("</div>");
  return out.join("\n");
}

// ── Markdown renderer ──────────────────────────────────────────

/**
 * Lightweight markdown-to-HTML converter.
 * Covers headers, bold, italic, inline code, code blocks,
 * lists, links, blockquotes, horizontal rules, paragraphs.
 */
export function renderMarkdown(md: string): string {
  const lines = md.split("\n");
  const out: string[] = ['<div class="rendered-md">'];

  let inCodeBlock = false;
  let codeLang = "";
  let codeLines: string[] = [];
  let inList: "ul" | "ol" | null = null;
  let inBlockquote = false;
  let paragraph: string[] = [];

  function flushParagraph(): void {
    if (paragraph.length > 0) {
      const text = paragraph.join(" ");
      out.push(`<p>${inlineFormat(text)}</p>`);
      paragraph = [];
    }
  }

  function flushList(): void {
    if (inList) {
      out.push(`</${inList}>`);
      inList = null;
    }
  }

  function flushBlockquote(): void {
    if (inBlockquote) {
      out.push("</blockquote>");
      inBlockquote = false;
    }
  }

  /**
   * Apply inline formatting to raw (unescaped) text.
   * Handles: inline code, bold, italic, links.
   * Escapes HTML at leaf level to avoid double-escaping.
   */
  function inlineFormat(raw: string): string {
    // Split on inline code spans first to protect their content
    const parts = raw.split(/(`[^`]+`)/);
    return parts
      .map((part) => {
        if (part.startsWith("`") && part.endsWith("`")) {
          // Inline code — escape content, wrap in <code>
          const code = part.slice(1, -1);
          return `<code>${escapeHtml(code)}</code>`;
        }
        // Non-code text: escape, then apply bold/italic/links
        let escaped = escapeHtml(part);
        escaped = escaped.replace(
          /\*\*([^*]+)\*\*/g,
          "<strong>$1</strong>",
        );
        escaped = escaped.replace(
          /(?<!\*)\*([^*]+)\*(?!\*)/g,
          "<em>$1</em>",
        );
        escaped = escaped.replace(
          /\[([^\]]+)\]\(([^)]+)\)/g,
          '<a href="$2" target="_blank" rel="noopener">$1</a>',
        );
        return escaped;
      })
      .join("");
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Code block toggle
    if (line.startsWith("```")) {
      if (!inCodeBlock) {
        flushParagraph();
        flushList();
        flushBlockquote();
        inCodeBlock = true;
        codeLang = line.slice(3).trim();
        codeLines = [];
        continue;
      } else {
        // End code block
        const langAttr = codeLang
          ? ` class="language-${escapeHtml(codeLang)}"`
          : "";
        out.push(
          `<pre><code${langAttr}>${escapeHtml(codeLines.join("\n"))}</code></pre>`,
        );
        inCodeBlock = false;
        codeLang = "";
        codeLines = [];
        continue;
      }
    }

    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    // Horizontal rule
    if (/^---+$/.test(line.trim())) {
      flushParagraph();
      flushList();
      flushBlockquote();
      out.push("<hr>");
      continue;
    }

    // Headers
    const headerMatch = line.match(/^(#{1,6})\s+(.*)/);
    if (headerMatch) {
      flushParagraph();
      flushList();
      flushBlockquote();
      const level = headerMatch[1].length;
      const text = escapeHtml(headerMatch[2]);
      out.push(`<h${level}>${text}</h${level}>`);
      continue;
    }

    // Blockquotes
    if (line.startsWith("> ")) {
      flushParagraph();
      flushList();
      if (!inBlockquote) {
        inBlockquote = true;
        out.push("<blockquote>");
      }
      out.push(inlineFormat(line.slice(2)));
      continue;
    } else if (inBlockquote) {
      flushBlockquote();
    }

    // Unordered list
    if (/^[-*]\s+/.test(line)) {
      flushParagraph();
      flushBlockquote();
      if (inList !== "ul") {
        flushList();
        inList = "ul";
        out.push("<ul>");
      }
      const text = line.replace(/^[-*]\s+/, "");
      out.push(`<li>${inlineFormat(text)}</li>`);
      continue;
    }

    // Ordered list
    if (/^\d+\.\s+/.test(line)) {
      flushParagraph();
      flushBlockquote();
      if (inList !== "ol") {
        flushList();
        inList = "ol";
        out.push("<ol>");
      }
      const text = line.replace(/^\d+\.\s+/, "");
      out.push(`<li>${inlineFormat(text)}</li>`);
      continue;
    }

    // End of list on non-list line
    if (inList && !/^\s*$/.test(line)) {
      flushList();
    }

    // Empty line = paragraph break
    if (line.trim() === "") {
      flushParagraph();
      flushList();
      continue;
    }

    // Regular text -> accumulate into paragraph (raw, inlineFormat handles escaping)
    paragraph.push(line);
  }

  // Flush remaining state
  if (inCodeBlock) {
    const langAttr = codeLang
      ? ` class="language-${escapeHtml(codeLang)}"`
      : "";
    out.push(
      `<pre><code${langAttr}>${escapeHtml(codeLines.join("\n"))}</code></pre>`,
    );
  }
  flushParagraph();
  flushList();
  flushBlockquote();

  out.push("</div>");
  return out.join("\n");
}

// ── ANSI renderer ──────────────────────────────────────────────

// Standard 8 ANSI colors (normal intensity)
const ANSI_COLORS: Record<number, string> = {
  30: "#000000",
  31: "#cc0000",
  32: "#00cc00",
  33: "#cccc00",
  34: "#0000cc",
  35: "#cc00cc",
  36: "#00cccc",
  37: "#cccccc",
};

// Bright ANSI colors
const ANSI_BRIGHT_COLORS: Record<number, string> = {
  90: "#555555",
  91: "#ff5555",
  92: "#55ff55",
  93: "#ffff55",
  94: "#5555ff",
  95: "#ff55ff",
  96: "#55ffff",
  97: "#ffffff",
};

interface AnsiState {
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  fgColor: string | null;
}

/**
 * Convert ANSI escape sequences to HTML spans.
 * Supports: basic 8 colors, bright colors, bold, dim, italic, underline, reset.
 * Strips non-SGR escape sequences (cursor movement, erase, etc).
 */
export function renderAnsi(ansiText: string): string {
  // First, strip all non-SGR CSI sequences (anything that's not \x1b[...m)
  // Also strip OSC sequences (\x1b]...\x07)
  let cleaned = ansiText.replace(/\x1b\][^\x07]*\x07/g, "");
  // Strip non-SGR CSI sequences: \x1b[ followed by params and a final byte that isn't 'm'
  cleaned = cleaned.replace(/\x1b\[[\d;]*[A-LN-Za-ln-z]/g, "");

  // Check if there are any SGR sequences at all
  if (!/\x1b\[[\d;]*m/.test(cleaned)) {
    return escapeHtml(cleaned);
  }

  const state: AnsiState = {
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    fgColor: null,
  };

  const parts: string[] = [];
  let spanOpen = false;

  // Split on SGR sequences
  const re = /\x1b\[([\d;]*)m/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = re.exec(cleaned)) !== null) {
    // Emit text before this sequence
    const text = cleaned.slice(lastIndex, match.index);
    if (text) {
      parts.push(escapeHtml(text));
    }
    lastIndex = match.index + match[0].length;

    // Parse SGR codes
    const codes = match[1]
      ? match[1].split(";").map(Number)
      : [0];

    for (const code of codes) {
      if (code === 0) {
        // Reset
        if (spanOpen) {
          parts.push("</span>");
          spanOpen = false;
        }
        state.bold = false;
        state.dim = false;
        state.italic = false;
        state.underline = false;
        state.fgColor = null;
      } else if (code === 1) {
        state.bold = true;
      } else if (code === 2) {
        state.dim = true;
      } else if (code === 3) {
        state.italic = true;
      } else if (code === 4) {
        state.underline = true;
      } else if (code >= 30 && code <= 37) {
        state.fgColor = ANSI_COLORS[code] || null;
      } else if (code >= 90 && code <= 97) {
        state.fgColor = ANSI_BRIGHT_COLORS[code] || null;
      }
    }

    // Close previous span and open new one with current state
    if (spanOpen) {
      parts.push("</span>");
      spanOpen = false;
    }

    const classes: string[] = [];
    const styles: string[] = [];

    if (state.bold) classes.push("ansi-bold");
    if (state.dim) classes.push("ansi-dim");
    if (state.italic) classes.push("ansi-italic");
    if (state.underline) classes.push("ansi-underline");
    if (state.fgColor) styles.push(`color:${state.fgColor}`);

    if (classes.length > 0 || styles.length > 0) {
      let tag = "<span";
      if (classes.length > 0) tag += ` class="${classes.join(" ")}"`;
      if (styles.length > 0) tag += ` style="${styles.join(";")}"`;
      tag += ">";
      parts.push(tag);
      spanOpen = true;
    }
  }

  // Remaining text after last sequence
  const remainder = cleaned.slice(lastIndex);
  if (remainder) {
    parts.push(escapeHtml(remainder));
  }

  // Close any open span
  if (spanOpen) {
    parts.push("</span>");
  }

  return parts.join("");
}

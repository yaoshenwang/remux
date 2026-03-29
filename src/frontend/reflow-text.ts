/**
 * Strip ANSI escape sequences from text, returning only visible characters.
 */
const stripAnsi = (text: string): string =>
  text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

/**
 * Compute the display width of a string, counting CJK/fullwidth characters as 2.
 * This matches how terminals render characters.
 */
const displayWidth = (text: string): number => {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (isWide(code)) {
      width += 2;
    } else if (code >= 0x20) {
      // printable non-wide character
      width += 1;
    }
    // control characters contribute 0 width
  }
  return width;
};

/**
 * Check if a Unicode code point is a wide (fullwidth/CJK) character.
 */
const isWide = (code: number): boolean =>
  // CJK Unified Ideographs
  (code >= 0x4E00 && code <= 0x9FFF) ||
  // CJK Unified Ideographs Extension A
  (code >= 0x3400 && code <= 0x4DBF) ||
  // CJK Compatibility Ideographs
  (code >= 0xF900 && code <= 0xFAFF) ||
  // Fullwidth Forms
  (code >= 0xFF01 && code <= 0xFF60) ||
  // CJK Radicals Supplement, Kangxi Radicals
  (code >= 0x2E80 && code <= 0x2FDF) ||
  // CJK Symbols and Punctuation, Hiragana, Katakana
  (code >= 0x3000 && code <= 0x30FF) ||
  // Hangul Syllables
  (code >= 0xAC00 && code <= 0xD7AF) ||
  // CJK Unified Ideographs Extension B+
  (code >= 0x20000 && code <= 0x2FA1F) ||
  // Enclosed CJK, CJK Compatibility
  (code >= 0x3200 && code <= 0x33FF) ||
  // Bopomofo, Katakana Phonetic Extensions
  (code >= 0x3100 && code <= 0x31FF) ||
  // Miscellaneous wide symbols (some emoji, box drawing used as wide)
  (code >= 0x2580 && code <= 0x259F);

/**
 * Reflow captured terminal text for wider display in inspect mode.
 *
 * Terminal applications format output to fit the terminal width by inserting
 * newlines. When the inspect view is wider than the terminal, this makes text
 * appear as a narrow column. This function joins lines that were likely
 * wrapped at the terminal width, allowing CSS to re-wrap at the inspect view's
 * actual width.
 *
 * A line is considered "wrapped" if its visible display width (excluding ANSI
 * codes, counting CJK chars as 2) fills or nearly fills the terminal columns.
 */
export const reflowText = (text: string, cols: number): string => {
  if (cols < 5) return text;

  const lines = text.split("\n");
  const result: string[] = [];
  let current = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const visible = stripAnsi(line);
    const width = displayWidth(visible.trimEnd());

    if (current) {
      current += line;
    } else {
      current = line;
    }

    // If this line fills the terminal width, it was likely wrapped —
    // join with the next line. Allow 1-column tolerance for wide char boundaries.
    if (width >= cols - 1 && width <= cols && i < lines.length - 1) {
      continue;
    }

    result.push(current);
    current = "";
  }

  if (current) {
    result.push(current);
  }

  return result.join("\n");
};

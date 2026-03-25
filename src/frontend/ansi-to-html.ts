const ANSI_16_COLORS: Record<number, string> = {
  30: "#4a4a4a", 31: "#ff6b6b", 32: "#69db7c", 33: "#ffd43b",
  34: "#74c0fc", 35: "#da77f2", 36: "#66d9e8", 37: "#dee2e6",
  90: "#868e96", 91: "#ff8787", 92: "#8ce99a", 93: "#ffe066",
  94: "#91a7ff", 95: "#e599f7", 96: "#99e9f2", 97: "#f8f9fa"
};

const ANSI_16_BG: Record<number, string> = {
  40: "#4a4a4a", 41: "#ff6b6b", 42: "#69db7c", 43: "#ffd43b",
  44: "#74c0fc", 45: "#da77f2", 46: "#66d9e8", 47: "#dee2e6",
  100: "#868e96", 101: "#ff8787", 102: "#8ce99a", 103: "#ffe066",
  104: "#91a7ff", 105: "#e599f7", 106: "#99e9f2", 107: "#f8f9fa"
};

const XTERM_256: string[] = (() => {
  const colors: string[] = [];
  // 0-15: standard + bright (mapped above, placeholder here)
  const base16 = [
    "#000000", "#800000", "#008000", "#808000", "#000080", "#800080", "#008080", "#c0c0c0",
    "#808080", "#ff0000", "#00ff00", "#ffff00", "#0000ff", "#ff00ff", "#00ffff", "#ffffff"
  ];
  colors.push(...base16);
  // 16-231: 6x6x6 color cube
  for (let r = 0; r < 6; r++) {
    for (let g = 0; g < 6; g++) {
      for (let b = 0; b < 6; b++) {
        colors.push(`#${[r, g, b].map(c => (c ? c * 40 + 55 : 0).toString(16).padStart(2, "0")).join("")}`);
      }
    }
  }
  // 232-255: grayscale
  for (let i = 0; i < 24; i++) {
    const v = (i * 10 + 8).toString(16).padStart(2, "0");
    colors.push(`#${v}${v}${v}`);
  }
  return colors;
})();

interface AnsiState {
  fg: string | null;
  bg: string | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
}

const escapeHtml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const buildSpanStyle = (state: AnsiState): string => {
  const parts: string[] = [];
  let fg = state.fg;
  let bg = state.bg;
  if (state.inverse) {
    [fg, bg] = [bg ?? "var(--bg-terminal)", fg ?? "var(--text-primary)"];
  }
  if (fg) parts.push(`color:${fg}`);
  if (bg) parts.push(`background:${bg}`);
  if (state.bold) parts.push("font-weight:bold");
  if (state.dim) parts.push("opacity:0.6");
  if (state.italic) parts.push("font-style:italic");
  if (state.underline) parts.push("text-decoration:underline");
  return parts.join(";");
};

const parse256Color = (params: number[], index: number): [string | null, number] => {
  if (params[index] === 5 && index + 1 < params.length) {
    const colorIndex = params[index + 1];
    return [XTERM_256[colorIndex] ?? null, index + 2];
  }
  if (params[index] === 2 && index + 3 < params.length) {
    const r = params[index + 1];
    const g = params[index + 2];
    const b = params[index + 3];
    return [`rgb(${r},${g},${b})`, index + 4];
  }
  return [null, index + 1];
};

export const ansiToHtml = (input: string): string => {
  const state: AnsiState = {
    fg: null, bg: null,
    bold: false, dim: false, italic: false, underline: false, inverse: false
  };

  let result = "";
  let spanOpen = false;
  // Match CSI sequences, including private mode toggles like ESC[?1049h.
  const regex = /\x1b\[([0-?]*)([@-~])/g;
  let lastIndex = 0;

  for (const match of input.matchAll(regex)) {
    // Append text before this escape sequence
    const textBefore = input.slice(lastIndex, match.index);
    if (textBefore) {
      result += escapeHtml(textBefore);
    }
    lastIndex = match.index! + match[0].length;

    // Only process SGR sequences (ending with 'm')
    if (match[2] !== "m") continue;

    const paramStr = match[1] || "0";
    const params = paramStr.split(";").map(Number);

    let i = 0;
    while (i < params.length) {
      const p = params[i];
      if (p === 0) {
        state.fg = null; state.bg = null;
        state.bold = false; state.dim = false; state.italic = false;
        state.underline = false; state.inverse = false;
      } else if (p === 1) { state.bold = true; }
      else if (p === 2) { state.dim = true; }
      else if (p === 3) { state.italic = true; }
      else if (p === 4) { state.underline = true; }
      else if (p === 7) { state.inverse = true; }
      else if (p === 22) { state.bold = false; state.dim = false; }
      else if (p === 23) { state.italic = false; }
      else if (p === 24) { state.underline = false; }
      else if (p === 27) { state.inverse = false; }
      else if (p >= 30 && p <= 37) { state.fg = ANSI_16_COLORS[p] ?? null; }
      else if (p === 38) { const [c, ni] = parse256Color(params, i + 1); state.fg = c; i = ni; continue; }
      else if (p === 39) { state.fg = null; }
      else if (p >= 40 && p <= 47) { state.bg = ANSI_16_BG[p] ?? null; }
      else if (p === 48) { const [c, ni] = parse256Color(params, i + 1); state.bg = c; i = ni; continue; }
      else if (p === 49) { state.bg = null; }
      else if (p >= 90 && p <= 97) { state.fg = ANSI_16_COLORS[p] ?? null; }
      else if (p >= 100 && p <= 107) { state.bg = ANSI_16_BG[p] ?? null; }
      i++;
    }

    // Close previous span if open, open new one if needed
    if (spanOpen) {
      result += "</span>";
      spanOpen = false;
    }
    const style = buildSpanStyle(state);
    if (style) {
      result += `<span style="${style}">`;
      spanOpen = true;
    }
  }

  // Append remaining text
  const remaining = input.slice(lastIndex);
  if (remaining) {
    result += escapeHtml(remaining);
  }
  if (spanOpen) {
    result += "</span>";
  }

  return result;
};

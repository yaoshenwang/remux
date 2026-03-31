/**
 * Server-side ghostty-vt (WASM) -- tsm-style VT tracking.
 * Loads the ghostty-vt WASM binary and provides a factory for VT terminals.
 */

import fs from "fs";

// ── WASM state (module-level singletons) ────────────────────────

let wasmExports: any = null;
let wasmMemory: WebAssembly.Memory | null = null;

// ── VT Terminal type ─────────────────────────────────────────────

export interface VtTerminal {
  handle: number;
  consume(data: string | Buffer): void;
  resize(cols: number, rows: number): void;
  isAltScreen(): boolean;
  /** Build a VT escape sequence snapshot from viewport cells (tsm Snapshot equivalent). */
  snapshot(): string | null;
  /** Extract plain text from viewport (for Inspect view). */
  textSnapshot(): { text: string; cols: number; rows: number };
  dispose(): void;
}

// ── Init ─────────────────────────────────────────────────────────

/**
 * Load the ghostty-vt WASM binary from disk.
 */
export async function initGhosttyVt(wasmPath: string): Promise<void> {
  const wasmBytes = fs.readFileSync(wasmPath);
  const result = await WebAssembly.instantiate(wasmBytes, {
    env: { log: () => {} },
  });
  wasmExports = result.instance.exports;
  wasmMemory = wasmExports.memory;
  console.log("[ghostty-vt] WASM loaded for server-side VT tracking");
}

// ── Factory ──────────────────────────────────────────────────────

/**
 * Create a new VT terminal instance with the given dimensions.
 * Returns null if WASM is not loaded.
 */
export function createVtTerminal(
  cols: number,
  rows: number,
): VtTerminal | null {
  if (!wasmExports) return null;
  const handle = wasmExports.ghostty_terminal_new(cols, rows);
  if (!handle) return null;

  return {
    handle,

    consume(data: string | Buffer) {
      const bytes = typeof data === "string" ? Buffer.from(data) : data;
      const ptr = wasmExports.ghostty_wasm_alloc_u8_array(bytes.length);
      new Uint8Array(wasmMemory!.buffer).set(bytes, ptr);
      wasmExports.ghostty_terminal_write(handle, ptr, bytes.length);
      wasmExports.ghostty_wasm_free_u8_array(ptr, bytes.length);
    },

    resize(cols: number, rows: number) {
      wasmExports.ghostty_terminal_resize(handle, cols, rows);
    },

    isAltScreen(): boolean {
      return !!wasmExports.ghostty_terminal_is_alternate_screen(handle);
    },

    snapshot(): string | null {
      wasmExports.ghostty_render_state_update(handle);
      const cols = wasmExports.ghostty_render_state_get_cols(handle);
      const rows = wasmExports.ghostty_render_state_get_rows(handle);
      const cellSize = 16;
      const bufSize = cols * rows * cellSize;
      const bufPtr = wasmExports.ghostty_wasm_alloc_u8_array(bufSize);
      const count = wasmExports.ghostty_render_state_get_viewport(
        handle,
        bufPtr,
        bufSize,
      );

      const view = new DataView(wasmMemory!.buffer);
      let out = "\x1b[H\x1b[2J"; // clear + home
      let lastFg: number | null = null;
      let lastBg: number | null = null;
      let lastFlags = 0;

      for (let row = 0; row < rows; row++) {
        if (row > 0) out += "\r\n";
        for (let col = 0; col < cols; col++) {
          const off = bufPtr + (row * cols + col) * cellSize;
          const cp = view.getUint32(off, true);
          const fg_r = view.getUint8(off + 4);
          const fg_g = view.getUint8(off + 5);
          const fg_b = view.getUint8(off + 6);
          const bg_r = view.getUint8(off + 7);
          const bg_g = view.getUint8(off + 8);
          const bg_b = view.getUint8(off + 9);
          const flags = view.getUint8(off + 10);
          const width = view.getUint8(off + 11);

          if (width === 0) continue; // continuation cell (wide char)

          // SGR: only emit changes
          const fgKey = (fg_r << 16) | (fg_g << 8) | fg_b;
          const bgKey = (bg_r << 16) | (bg_g << 8) | bg_b;
          let sgr = "";
          if (flags !== lastFlags) {
            sgr += "\x1b[0m"; // reset, then re-apply
            if (flags & 1) sgr += "\x1b[1m"; // bold
            if (flags & 2) sgr += "\x1b[3m"; // italic
            if (flags & 4) sgr += "\x1b[4m"; // underline
            if (flags & 128) sgr += "\x1b[2m"; // faint
            lastFg = null;
            lastBg = null; // force re-emit colors after reset
            lastFlags = flags;
          }
          if (fgKey !== lastFg && fgKey !== 0) {
            sgr += `\x1b[38;2;${fg_r};${fg_g};${fg_b}m`;
            lastFg = fgKey;
          }
          if (bgKey !== lastBg && bgKey !== 0) {
            sgr += `\x1b[48;2;${bg_r};${bg_g};${bg_b}m`;
            lastBg = bgKey;
          }
          out += sgr;
          out += cp > 0 ? String.fromCodePoint(cp) : " ";
        }
      }

      // Restore cursor position
      const cx = wasmExports.ghostty_render_state_get_cursor_x(handle);
      const cy = wasmExports.ghostty_render_state_get_cursor_y(handle);
      out += `\x1b[0m\x1b[${cy + 1};${cx + 1}H`;

      wasmExports.ghostty_wasm_free_u8_array(bufPtr, bufSize);
      return out;
    },

    textSnapshot(): { text: string; cols: number; rows: number } {
      wasmExports.ghostty_render_state_update(handle);
      const cols = wasmExports.ghostty_render_state_get_cols(handle);
      const rows = wasmExports.ghostty_render_state_get_rows(handle);
      const cellSize = 16;
      const bufSize = cols * rows * cellSize;
      const bufPtr = wasmExports.ghostty_wasm_alloc_u8_array(bufSize);
      wasmExports.ghostty_render_state_get_viewport(handle, bufPtr, bufSize);

      const view = new DataView(wasmMemory!.buffer);
      const lines: string[] = [];

      for (let row = 0; row < rows; row++) {
        let line = "";
        for (let col = 0; col < cols; col++) {
          const off = bufPtr + (row * cols + col) * cellSize;
          const cp = view.getUint32(off, true);
          const width = view.getUint8(off + 11);
          if (width === 0) continue; // continuation cell (wide char)
          line += cp > 0 ? String.fromCodePoint(cp) : " ";
        }
        lines.push(line.trimEnd());
      }

      wasmExports.ghostty_wasm_free_u8_array(bufPtr, bufSize);

      // Trim trailing empty lines
      while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
      return { text: lines.join("\n"), cols, rows };
    },

    dispose() {
      wasmExports.ghostty_terminal_free(handle);
    },
  };
}

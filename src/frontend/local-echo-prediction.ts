/**
 * Local echo prediction for reducing perceived input latency.
 *
 * Immediately writes printable characters to the terminal before server
 * confirmation arrives.  When the server echo comes back, matching
 * predictions are silently consumed; mismatches cause a full rollback
 * so the server's authoritative output takes over.
 */

export interface LocalEchoPredictionOptions {
  /** Callback to write predicted characters to the terminal. */
  writeToTerminal: (data: string) => void;

  /**
   * Maximum age (ms) of a prediction before it is considered stale and
   * auto-erased.  Defaults to 500 ms.
   */
  timeoutMs?: number;
}

// Alternate-screen enter/leave escape patterns.
// Covers ?1049h/l (most common) and ?47h/l (legacy).
const ALT_SCREEN_ENTER = /\x1b\[\?(?:1049|47)h/;
const ALT_SCREEN_LEAVE = /\x1b\[\?(?:1049|47)l/;

const BACKSPACE_ERASE = "\b \b";

/** Return true when `data` is a single printable ASCII character (0x20-0x7E). */
function isSinglePrintable(data: string): boolean {
  return data.length === 1 && data.charCodeAt(0) >= 0x20 && data.charCodeAt(0) <= 0x7e;
}

/** Return true when `data` is a single backspace / DEL. */
function isBackspace(data: string): boolean {
  return data === "\x7f" || data === "\b";
}

export class LocalEchoPrediction {
  /** Whether prediction is globally enabled. */
  enabled = true;

  private _pending = "";
  private _inAlternateScreen = false;
  private readonly _writeToTerminal: (data: string) => void;
  private readonly _timeoutMs: number;
  private _staleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: LocalEchoPredictionOptions) {
    this._writeToTerminal = options.writeToTerminal;
    this._timeoutMs = options.timeoutMs ?? 500;
  }

  // ── public getters ────────────────────────────────────────────────

  get pending(): string {
    return this._pending;
  }

  get inAlternateScreen(): boolean {
    return this._inAlternateScreen;
  }

  // ── input prediction ──────────────────────────────────────────────

  /**
   * Attempt to predict the echo for `data` (a single keystroke from
   * `terminal.onData`).  Returns `true` if a prediction was made.
   */
  predictInput(data: string): boolean {
    if (!this.enabled || this._inAlternateScreen) {
      return false;
    }

    if (isSinglePrintable(data)) {
      this._pending += data;
      this._writeToTerminal(data);
      this._resetStaleTimer();
      return true;
    }

    if (isBackspace(data) && this._pending.length > 0) {
      this._pending = this._pending.slice(0, -1);
      this._writeToTerminal(BACKSPACE_ERASE);
      this._resetStaleTimer();
      return true;
    }

    // Anything else (control chars, escape sequences, multi-char pastes,
    // Enter, etc.) — don't predict.
    return false;
  }

  // ── server output reconciliation ──────────────────────────────────

  /**
   * Reconcile incoming server output against pending predictions.
   *
   * Returns the portion of `serverOutput` that must still be written to
   * the terminal (after stripping already-predicted characters).
   * On mismatch, erases all wrong predictions and returns the full
   * corrected output.
   */
  reconcileServerOutput(serverOutput: string): string {
    if (this._pending.length === 0) {
      return serverOutput;
    }

    // Try to match pending predictions against the server output prefix.
    const matchLen = this._commonPrefixLength(this._pending, serverOutput);

    if (matchLen > 0 && matchLen <= this._pending.length) {
      // Partial or full match — consume matched predictions.
      this._pending = this._pending.slice(matchLen);
      const remainder = serverOutput.slice(matchLen);
      if (this._pending.length === 0) {
        this._clearStaleTimer();
      }
      return remainder;
    }

    // Mismatch — erase all predictions and pass full server output through.
    const eraseSeq = BACKSPACE_ERASE.repeat(this._pending.length);
    this._pending = "";
    this._clearStaleTimer();
    return eraseSeq + serverOutput;
  }

  // ── alternate screen tracking ─────────────────────────────────────

  /**
   * Scan raw server output for alternate screen enter/leave sequences.
   * Call this before `reconcileServerOutput` for every chunk.
   */
  detectAlternateScreen(data: string): void {
    // Check leave first so that a chunk containing both resolves correctly.
    if (ALT_SCREEN_LEAVE.test(data)) {
      this._inAlternateScreen = false;
    }
    if (ALT_SCREEN_ENTER.test(data)) {
      this._inAlternateScreen = true;
      this._clearPending();
    }
  }

  setAlternateScreen(active: boolean): void {
    this._inAlternateScreen = active;
    if (active) {
      this._clearPending();
    }
  }

  /**
   * Detect alternate screen enter/leave sequences directly in binary data.
   * Only scans for ASCII escape byte patterns — no TextDecoder needed.
   */
  detectAlternateScreenBinary(chunk: Uint8Array): void {
    const len = chunk.length;
    for (let i = 0; i < len; i++) {
      if (chunk[i] !== 0x1b) continue;               // ESC
      if (i + 1 >= len || chunk[i + 1] !== 0x5b) continue; // [
      if (i + 2 >= len || chunk[i + 2] !== 0x3f) continue; // ?

      // Check for ?1049h / ?1049l
      if (
        i + 7 < len &&
        chunk[i + 3] === 0x31 && // 1
        chunk[i + 4] === 0x30 && // 0
        chunk[i + 5] === 0x34 && // 4
        chunk[i + 6] === 0x39    // 9
      ) {
        if (chunk[i + 7] === 0x68) {        // h — enter
          this.setAlternateScreen(true);
        } else if (chunk[i + 7] === 0x6c) { // l — leave
          this.setAlternateScreen(false);
        }
      }

      // Check for ?47h / ?47l
      if (
        i + 5 < len &&
        chunk[i + 3] === 0x34 && // 4
        chunk[i + 4] === 0x37    // 7
      ) {
        if (chunk[i + 5] === 0x68) {        // h — enter
          this.setAlternateScreen(true);
        } else if (chunk[i + 5] === 0x6c) { // l — leave
          this.setAlternateScreen(false);
        }
      }
    }
  }

  // ── lifecycle ─────────────────────────────────────────────────────

  reset(): void {
    this._pending = "";
    this._inAlternateScreen = false;
    this._clearStaleTimer();
  }

  // ── internals ─────────────────────────────────────────────────────

  private _commonPrefixLength(a: string, b: string): number {
    const len = Math.min(a.length, b.length);
    let i = 0;
    while (i < len && a.charCodeAt(i) === b.charCodeAt(i)) {
      i += 1;
    }
    return i;
  }

  private _clearPending(): void {
    this._pending = "";
    this._clearStaleTimer();
  }

  private _clearStaleTimer(): void {
    if (this._staleTimer !== null) {
      clearTimeout(this._staleTimer);
      this._staleTimer = null;
    }
  }

  private _resetStaleTimer(): void {
    this._clearStaleTimer();
    if (this._pending.length === 0) {
      return;
    }
    this._staleTimer = setTimeout(() => {
      this._staleTimer = null;
      if (this._pending.length > 0) {
        const eraseSeq = BACKSPACE_ERASE.repeat(this._pending.length);
        this._writeToTerminal(eraseSeq);
        this._pending = "";
      }
    }, this._timeoutMs);
  }
}

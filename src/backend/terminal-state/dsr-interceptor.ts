/**
 * DSR (Device Status Report) interceptor.
 *
 * Scans PTY output for \x1b[6n (cursor position query) and generates
 * CPR (Cursor Position Report) responses server-side, avoiding the
 * browser round-trip that causes visible escape sequence leakage.
 */

/** The DSR escape sequence requesting cursor position. */
const DSR_SEQUENCE = "\x1b[6n";

/** Regex to detect DSR sequences in a string. */
const DSR_REGEX = /\x1b\[6n/g;

/**
 * Regex to match CPR (Cursor Position Report) responses: \x1b[{row};{col}R
 * Used client-side to filter CPR from terminal input.
 */
export const CPR_RESPONSE_REGEX = /\x1b\[\d+;\d+R/g;

/**
 * Build a CPR response string for the given cursor position.
 * Row and col are 1-based in the CPR protocol.
 */
export const buildCprResponse = (row: number, col: number): string =>
  `\x1b[${row};${col}R`;

export interface DsrInterceptResult {
  /** The data with DSR sequences stripped (for forwarding to clients). */
  cleaned: string;
  /** Number of DSR sequences found and intercepted. */
  count: number;
}

/**
 * Scan a PTY output string for DSR sequences (\x1b[6n).
 * Returns the cleaned string (DSR removed) and count of occurrences.
 */
export const interceptDsr = (data: string): DsrInterceptResult => {
  let count = 0;
  const cleaned = data.replace(DSR_REGEX, () => {
    count++;
    return "";
  });
  return { cleaned, count };
};

/**
 * Filter CPR responses from terminal input data (client-side defense).
 * Removes any \x1b[{row};{col}R sequences from user input before
 * sending to the server.
 */
export const filterCprFromInput = (data: string): string =>
  data.replace(CPR_RESPONSE_REGEX, "");

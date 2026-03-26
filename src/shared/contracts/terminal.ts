// ── Terminal domain types ──
// Types for terminal data plane messages.

export interface TerminalOpenPayload {
  sessionName: string;
  paneId: string;
}

export interface TerminalResizePayload {
  cols: number;
  rows: number;
}

export interface TerminalClosedPayload {
  reason: string;
}

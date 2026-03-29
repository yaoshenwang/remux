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

export type TerminalTransportMode = "raw" | "patch";

export interface TerminalPatchMessage {
  type: "terminal_patch";
  paneId: string;
  epoch: number;
  viewRevision: number;
  revision: number;
  baseRevision: number | null;
  reset: boolean;
  source: "snapshot" | "stream";
  dataBase64: string;
  cols?: number;
  rows?: number;
}

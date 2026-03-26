import type { WebSocket } from "ws";
import type { TerminalRuntime } from "../pty/terminal-runtime.js";

export interface ControlContext {
  socket: WebSocket;
  authed: boolean;
  clientId: string;
  messageQueue: Promise<void>;
  runtime?: TerminalRuntime;
  baseSession?: string;
  attachedSession?: string;
  terminalClients: Set<DataContext>;
  pendingResize?: { cols: number; rows: number };
}

export interface DataContext {
  socket: WebSocket;
  authed: boolean;
  controlClientId?: string;
  controlContext?: ControlContext;
}

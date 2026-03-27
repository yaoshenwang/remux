import type { TerminalGeometryState, WorkspaceRuntimeState } from "../../shared/protocol.js";

export interface PtyProcess {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(handler: (data: string) => void): void;
  onExit(handler: (code: number) => void): void;
  getRuntimeState?(): WorkspaceRuntimeState | null;
  onRuntimeStateChange?(handler: (state: WorkspaceRuntimeState) => void): void;
  getRuntimeGeometry?(): TerminalGeometryState | null;
  onRuntimeGeometryChange?(handler: (geometry: TerminalGeometryState) => void): void;
  onWorkspaceChange?(handler: (reason: "session_switch" | "session_renamed") => void): void;
  kill(): void;
}

export interface PtyFactory {
  spawnAttach(session: string): PtyProcess;
}

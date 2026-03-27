import { EventEmitter } from "node:events";
import type { PtyFactory, PtyProcess } from "../../src/backend/pty/pty-adapter.js";
import type { TerminalGeometryState, WorkspaceRuntimeState } from "../../src/shared/protocol.js";

class FakePtyProcess implements PtyProcess {
  private readonly events = new EventEmitter();
  public readonly writes: string[] = [];
  public readonly resizes: Array<{ cols: number; rows: number }> = [];
  private runtimeState: WorkspaceRuntimeState | null = null;
  private runtimeGeometry: TerminalGeometryState | null = null;

  public write(data: string): void {
    this.writes.push(data);
  }

  public resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }

  public onData(handler: (data: string) => void): void {
    this.events.on("data", handler);
  }

  public onExit(handler: (code: number) => void): void {
    this.events.on("exit", handler);
  }

  public getRuntimeState(): WorkspaceRuntimeState | null {
    return this.runtimeState;
  }

  public onRuntimeStateChange(handler: (state: WorkspaceRuntimeState) => void): void {
    this.events.on("runtime-state", handler);
  }

  public getRuntimeGeometry(): TerminalGeometryState | null {
    return this.runtimeGeometry;
  }

  public onRuntimeGeometryChange(handler: (geometry: TerminalGeometryState) => void): void {
    this.events.on("runtime-geometry", handler);
  }

  public onWorkspaceChange(handler: (reason: "session_switch" | "session_renamed") => void): void {
    this.events.on("workspace-change", handler);
  }

  public kill(): void {
    this.events.emit("exit", 0);
  }

  public emitData(data: string): void {
    this.events.emit("data", data);
  }

  public emitRuntimeState(state: WorkspaceRuntimeState): void {
    this.runtimeState = state;
    this.events.emit("runtime-state", state);
  }

  public emitRuntimeGeometry(geometry: TerminalGeometryState): void {
    this.runtimeGeometry = geometry;
    this.events.emit("runtime-geometry", geometry);
  }

  public emitWorkspaceChange(reason: "session_switch" | "session_renamed"): void {
    this.events.emit("workspace-change", reason);
  }
}

export class FakePtyFactory implements PtyFactory {
  public lastSpawnedSession?: string;
  public readonly processes: FakePtyProcess[] = [];

  public spawnAttach(session: string): PtyProcess {
    this.lastSpawnedSession = session;
    const process = new FakePtyProcess();
    this.processes.push(process);
    return process;
  }

  public latestProcess(): FakePtyProcess {
    const latest = this.processes.at(-1);
    if (!latest) {
      throw new Error("No PTY process has been created");
    }
    return latest;
  }
}

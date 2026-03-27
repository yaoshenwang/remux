import { EventEmitter } from "node:events";
import type { TerminalGeometryState, WorkspaceRuntimeState } from "../../shared/protocol.js";
import type { PtyFactory, PtyProcess } from "./pty-adapter.js";

interface TerminalRuntimeEvents {
  data: (payload: string) => void;
  exit: (code: number) => void;
  attach: (session: string) => void;
  resize: (cols: number, rows: number) => void;
  runtimeState: (state: WorkspaceRuntimeState) => void;
  geometry: (geometry: TerminalGeometryState) => void;
  workspaceChange: (reason: "session_switch" | "session_renamed") => void;
}

export class TerminalRuntime {
  private readonly events = new EventEmitter();
  private process?: PtyProcess;
  private session?: string;
  private lastDimensions: { cols: number; rows: number } = { cols: 80, rows: 24 };
  /** Cached last data chunk for replaying to late-joining terminal clients. */
  private lastDataChunk?: string;
  private runtimeState: WorkspaceRuntimeState | null = null;
  private runtimeGeometry: TerminalGeometryState | null = null;

  public constructor(private readonly factory: PtyFactory) {}

  public currentSession(): string | undefined {
    return this.session;
  }

  public isAlive(): boolean {
    return this.process !== undefined;
  }

  public currentRuntimeState(): WorkspaceRuntimeState | null {
    return this.runtimeState;
  }

  public currentGeometry(): TerminalGeometryState | null {
    return this.runtimeGeometry;
  }

  public attachToSession(session: string, force = false): void {
    if (!force && this.session === session && this.process) {
      return;
    }

    if (this.process) {
      this.process.kill();
      this.process = undefined;
    }

    this.session = session;
    const processRef = this.factory.spawnAttach(session);
    processRef.onData((data) => {
      this.lastDataChunk = data;
      this.events.emit("data", data);
    });
    processRef.onExit((code) => {
      this.events.emit("exit", code);
      if (this.process === processRef) {
        this.process = undefined;
      }
    });
    if (processRef.onRuntimeStateChange) {
      processRef.onRuntimeStateChange((state) => {
        this.runtimeState = state;
        this.events.emit("runtimeState", state);
      });
    }
    if (processRef.onRuntimeGeometryChange) {
      processRef.onRuntimeGeometryChange((geometry) => {
        this.runtimeGeometry = geometry;
        this.events.emit("geometry", geometry);
      });
    }
    if (processRef.onWorkspaceChange) {
      processRef.onWorkspaceChange((reason) => {
        this.events.emit("workspaceChange", reason);
      });
    }
    if (processRef.getRuntimeState) {
      const currentState = processRef.getRuntimeState();
      if (currentState) {
        this.runtimeState = currentState;
        this.events.emit("runtimeState", currentState);
      }
    } else {
      this.runtimeState = null;
    }
    if (processRef.getRuntimeGeometry) {
      const currentGeometry = processRef.getRuntimeGeometry();
      if (currentGeometry) {
        this.runtimeGeometry = currentGeometry;
        this.events.emit("geometry", currentGeometry);
      }
    } else {
      this.runtimeGeometry = null;
    }
    processRef.resize(this.lastDimensions.cols, this.lastDimensions.rows);
    this.events.emit("resize", this.lastDimensions.cols, this.lastDimensions.rows);
    this.process = processRef;
    this.events.emit("attach", session);
  }

  /** Replay cached data to a late-joining listener (e.g. terminal WS client). */
  public replayLast(handler: (data: string) => void): void {
    if (this.lastDataChunk) {
      handler(this.lastDataChunk);
    }
  }

  public write(data: string): void {
    this.process?.write(data);
  }

  public resize(cols: number, rows: number): void {
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 2 || rows < 2) {
      return;
    }
    this.lastDimensions = { cols: Math.floor(cols), rows: Math.floor(rows) };
    if (this.process) {
      this.process.resize(this.lastDimensions.cols, this.lastDimensions.rows);
      this.events.emit("resize", this.lastDimensions.cols, this.lastDimensions.rows);
    }
  }

  public on<K extends keyof TerminalRuntimeEvents>(
    event: K,
    handler: TerminalRuntimeEvents[K]
  ): () => void {
    this.events.on(event, handler as (...args: unknown[]) => void);
    return () => this.events.off(event, handler as (...args: unknown[]) => void);
  }

  public shutdown(): Promise<void> {
    if (!this.process) {
      this.session = undefined;
      this.lastDataChunk = undefined;
      this.runtimeState = null;
      this.runtimeGeometry = null;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const proc = this.process!;
      const timeout = setTimeout(() => {
        this.process = undefined;
        this.session = undefined;
        this.lastDataChunk = undefined;
        this.runtimeState = null;
        this.runtimeGeometry = null;
        resolve();
      }, 500);
      proc.onExit(() => {
        clearTimeout(timeout);
        this.process = undefined;
        this.session = undefined;
        this.lastDataChunk = undefined;
        this.runtimeState = null;
        this.runtimeGeometry = null;
        resolve();
      });
      proc.kill();
    });
  }
}

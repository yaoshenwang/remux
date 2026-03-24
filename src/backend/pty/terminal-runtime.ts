import { EventEmitter } from "node:events";
import type { PtyFactory, PtyProcess } from "./pty-adapter.js";

interface TerminalRuntimeEvents {
  data: (payload: string) => void;
  exit: (code: number) => void;
  attach: (session: string) => void;
}

export class TerminalRuntime {
  private readonly events = new EventEmitter();
  private process?: PtyProcess;
  private session?: string;
  private lastDimensions: { cols: number; rows: number } = { cols: 80, rows: 24 };
  /** Cached last data chunk for replaying to late-joining terminal clients. */
  private lastDataChunk?: string;

  public constructor(private readonly factory: PtyFactory) {}

  public currentSession(): string | undefined {
    return this.session;
  }

  public isAlive(): boolean {
    return this.process !== undefined;
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
    processRef.resize(this.lastDimensions.cols, this.lastDimensions.rows);
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
    this.process?.resize(this.lastDimensions.cols, this.lastDimensions.rows);
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
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const proc = this.process!;
      const timeout = setTimeout(() => {
        this.process = undefined;
        resolve();
      }, 500);
      proc.onExit(() => {
        clearTimeout(timeout);
        this.process = undefined;
        resolve();
      });
      proc.kill();
    });
  }
}

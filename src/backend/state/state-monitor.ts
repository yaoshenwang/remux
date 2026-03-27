import { buildSnapshot } from "../multiplexer/types.js";
import type { WorkspaceSnapshot } from "../../shared/protocol.js";
import type { MultiplexerBackend } from "../multiplexer/types.js";

export class TmuxStateMonitor {
  private timer?: NodeJS.Timeout;
  private lastSerializedState?: string;
  private running = false;
  /** Bumped on every forcePublish so in-flight ticks can detect staleness. */
  private forceGeneration = 0;

  public constructor(
    private readonly backend: MultiplexerBackend,
    private readonly pollIntervalMs: number | (() => number),
    private readonly onUpdate: (state: WorkspaceSnapshot) => void,
    private readonly onError: (error: Error) => void
  ) {}

  public async start(): Promise<void> {
    this.running = true;
    try {
      await this.publishSnapshot(false);
    } catch (error) {
      this.onError(error instanceof Error ? error : new Error(String(error)));
    }
    this.scheduleNextTick();
  }

  public stop(): void {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  public async forcePublish(): Promise<void> {
    // Cancel any pending tick and bump the generation so that an in-flight
    // tick whose buildSnapshot is still resolving will discard its result.
    clearTimeout(this.timer);
    this.timer = undefined;
    const generation = ++this.forceGeneration;
    try {
      await this.publishSnapshot(true);
    } catch (error) {
      this.onError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      // Only the latest concurrent forcePublish should schedule the next tick.
      if (generation === this.forceGeneration) {
        this.scheduleNextTick();
      }
    }
  }

  private scheduleNextTick(): void {
    if (!this.running) {
      return;
    }
    this.timer = setTimeout(() => {
      this.tick().finally(() => {
        this.scheduleNextTick();
      });
    }, this.resolvePollIntervalMs());
  }

  private resolvePollIntervalMs(): number {
    const value = typeof this.pollIntervalMs === "function"
      ? this.pollIntervalMs()
      : this.pollIntervalMs;
    if (!Number.isFinite(value) || value < 1) {
      return 1;
    }
    return Math.floor(value);
  }

  private async tick(): Promise<void> {
    try {
      await this.publishSnapshot(false);
    } catch (error) {
      this.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private async publishSnapshot(force: boolean): Promise<void> {
    const gen = this.forceGeneration;
    const snapshot = await buildSnapshot(this.backend);

    // A newer forcePublish happened while we were building; discard stale data.
    if (gen !== this.forceGeneration) {
      return;
    }

    const serialized = JSON.stringify(snapshot.sessions);
    if (force || serialized !== this.lastSerializedState) {
      this.lastSerializedState = serialized;
      this.onUpdate(snapshot);
    }
  }
}

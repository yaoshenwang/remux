/**
 * Semantic adapter registry.
 *
 * Manages registration, detection, and lifecycle of semantic adapters.
 * The registry is designed to run with zero, one, or many adapters.
 */

import type {
  SemanticAdapter,
  SemanticAdapterInstance,
  AdapterDetectContext,
  AdapterMatch,
  AdapterRuntimeContext,
  SemanticClientAction,
  SemanticActionResult
} from "./types.js";
import type { SemanticCapabilities } from "../../shared/contracts/semantic.js";

export interface AdapterRegistryOptions {
  logger?: Pick<Console, "log" | "error">;
}

interface ActiveAdapter {
  adapter: SemanticAdapter;
  instance: SemanticAdapterInstance;
  sessionName: string;
  paneId: string;
}

export class AdapterRegistry {
  private readonly adapters: SemanticAdapter[] = [];
  private readonly active = new Map<string, ActiveAdapter>();
  private readonly logger?: Pick<Console, "log" | "error">;

  constructor(options?: AdapterRegistryOptions) {
    this.logger = options?.logger;
  }

  /** Register an adapter. Order matters for detection priority on equal confidence. */
  register(adapter: SemanticAdapter): void {
    if (this.adapters.some((a) => a.id === adapter.id)) {
      this.logger?.error(`[adapter-registry] duplicate adapter id: ${adapter.id}`);
      return;
    }
    this.adapters.push(adapter);
    this.logger?.log(`[adapter-registry] registered: ${adapter.id} (${adapter.displayName})`);
  }

  /** List all registered adapter IDs. */
  listAdapterIds(): string[] {
    return this.adapters.map((a) => a.id);
  }

  /** Detect the best adapter for a given context. Returns null if no match. */
  async detect(context: AdapterDetectContext): Promise<{ adapter: SemanticAdapter; match: AdapterMatch } | null> {
    let best: { adapter: SemanticAdapter; match: AdapterMatch } | null = null;

    for (const adapter of this.adapters) {
      try {
        const match = await adapter.detect(context);
        if (match.matched && (!best || match.confidence > best.match.confidence)) {
          best = { adapter, match };
        }
      } catch (err) {
        this.logger?.error(`[adapter-registry] detection error for ${adapter.id}:`, err);
      }
    }

    return best;
  }

  /** Start an adapter for a session/pane. */
  async startAdapter(
    adapterId: string,
    context: AdapterRuntimeContext
  ): Promise<boolean> {
    const adapter = this.adapters.find((a) => a.id === adapterId);
    if (!adapter) {
      this.logger?.error(`[adapter-registry] unknown adapter: ${adapterId}`);
      return false;
    }

    const key = `${context.sessionName}:${context.paneId}`;
    if (this.active.has(key)) {
      await this.stopAdapter(context.sessionName, context.paneId);
    }

    try {
      const instance = await adapter.start(context);
      this.active.set(key, { adapter, instance, sessionName: context.sessionName, paneId: context.paneId });
      this.logger?.log(`[adapter-registry] started ${adapterId} for ${key}`);
      return true;
    } catch (err) {
      this.logger?.error(`[adapter-registry] start error for ${adapterId}:`, err);
      return false;
    }
  }

  /** Stop an active adapter for a session/pane. */
  async stopAdapter(sessionName: string, paneId: string): Promise<void> {
    const key = `${sessionName}:${paneId}`;
    const entry = this.active.get(key);
    if (!entry) return;

    try {
      await entry.instance.stop();
    } catch (err) {
      this.logger?.error(`[adapter-registry] stop error for ${entry.adapter.id}:`, err);
    }
    this.active.delete(key);
  }

  /** Handle a client action for an active adapter. */
  async handleAction(action: SemanticClientAction): Promise<SemanticActionResult> {
    for (const entry of this.active.values()) {
      if (entry.adapter.id === action.adapterId && entry.instance.handleClientAction) {
        return entry.instance.handleClientAction(action);
      }
    }
    return { ok: false, error: `no active adapter with id: ${action.adapterId}` };
  }

  /** Get capabilities for all registered adapters. */
  getCapabilitiesMap(): Record<string, SemanticCapabilities> {
    const result: Record<string, SemanticCapabilities> = {};
    for (const adapter of this.adapters) {
      result[adapter.id] = adapter.getCapabilities();
    }
    return result;
  }

  /** Clean up all active adapters. */
  async dispose(): Promise<void> {
    for (const [, entry] of this.active) {
      try {
        await entry.instance.stop();
      } catch (err) {
        this.logger?.error(`[adapter-registry] dispose error for ${entry.adapter.id}:`, err);
      }
    }
    this.active.clear();
  }
}

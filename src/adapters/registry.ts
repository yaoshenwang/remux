// E10-003: AdapterRegistry — manages adapter registration, queries, event dispatch

import { SemanticAdapter, SemanticEvent, AdapterState } from "./types.js";

export class AdapterRegistry {
  private adapters: Map<string, SemanticAdapter> = new Map();
  private eventSeq = 0;
  private listeners: ((event: SemanticEvent) => void)[] = [];

  register(adapter: SemanticAdapter): void {
    this.adapters.set(adapter.id, adapter);
    adapter.start?.();
  }

  unregister(id: string): void {
    const adapter = this.adapters.get(id);
    adapter?.stop?.();
    this.adapters.delete(id);
  }

  get(id: string): SemanticAdapter | undefined {
    return this.adapters.get(id);
  }

  getAll(): SemanticAdapter[] {
    return Array.from(this.adapters.values());
  }

  getAllStates(): AdapterState[] {
    return this.getAll().map((a) => a.getCurrentState());
  }

  /** Subscribe to adapter events */
  onEvent(listener: (event: SemanticEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  /** Emit an event from an adapter */
  emit(adapterId: string, type: string, data: Record<string, unknown>): void {
    const event: SemanticEvent = {
      type,
      seq: ++this.eventSeq,
      timestamp: new Date().toISOString(),
      data,
      adapterId,
    };
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  /** Forward terminal data to all passive adapters */
  dispatchTerminalData(sessionName: string, data: string): void {
    for (const adapter of this.adapters.values()) {
      if (adapter.mode === "passive" && adapter.onTerminalData) {
        try {
          adapter.onTerminalData(sessionName, data);
        } catch {
          // Don't let adapter errors crash the server
        }
      }
    }
  }

  /** Forward event file data to all passive adapters */
  dispatchEventFile(
    path: string,
    event: Record<string, unknown>,
  ): void {
    for (const adapter of this.adapters.values()) {
      if (adapter.mode === "passive" && adapter.onEventFile) {
        try {
          adapter.onEventFile(path, event);
        } catch {
          // Ignore adapter errors
        }
      }
    }
  }
}

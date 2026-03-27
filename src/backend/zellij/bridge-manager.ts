/**
 * Session-level bridge manager.
 *
 * Maintains one native bridge per zellij session, shared across all panes.
 * Caches pane render state and command routing so that pane switches and
 * inspect captures don't need to spawn fresh bridge instances.
 */
import type {
  ZellijNativeBridge,
  ZellijNativeBridgeEvent,
  ZellijNativeBridgeCommand,
  ZellijNativeBridgeFactory,
  CreateZellijNativeBridgeOptions
} from "./native-bridge.js";
import {
  getDefaultZellijNativeBridgeStateStore,
  type ZellijNativeBridgeStateStore
} from "./native-bridge-state.js";

export interface BridgeManagerOptions {
  bridgeFactory: ZellijNativeBridgeFactory;
  stateStore?: ZellijNativeBridgeStateStore;
  logger?: Pick<Console, "log" | "error">;
}

interface SessionBridge {
  bridge: ZellijNativeBridge;
  session: string;
  paneIds: Set<string>;
  eventHandlers: Map<string, Array<(event: ZellijNativeBridgeEvent) => void>>;
}

/**
 * Manages bridge instances at the session level.
 *
 * - One bridge per session, subscribing to all active panes
 * - Pane handlers are registered/unregistered as panes attach/detach
 * - Pane render cache is maintained by the state store
 */
export class ZellijBridgeManager {
  private sessions = new Map<string, SessionBridge>();
  private readonly stateStore: ZellijNativeBridgeStateStore;
  private readonly bridgeFactory: ZellijNativeBridgeFactory;
  private readonly logger?: Pick<Console, "log" | "error">;

  constructor(options: BridgeManagerOptions) {
    this.bridgeFactory = options.bridgeFactory;
    this.stateStore = options.stateStore ?? getDefaultZellijNativeBridgeStateStore();
    this.logger = options.logger;
  }

  /**
   * Register a pane to receive events from the session's bridge.
   * If no bridge exists for the session, one will be created.
   */
  registerPane(
    session: string,
    paneId: string,
    handler: (event: ZellijNativeBridgeEvent) => void
  ): void {
    let sessionBridge = this.sessions.get(session);
    if (!sessionBridge) {
      // Will be populated when bridge is created
      sessionBridge = {
        bridge: null as unknown as ZellijNativeBridge,
        session,
        paneIds: new Set(),
        eventHandlers: new Map()
      };
      this.sessions.set(session, sessionBridge);
    }

    sessionBridge.paneIds.add(paneId);
    const handlers = sessionBridge.eventHandlers.get(paneId) ?? [];
    handlers.push(handler);
    sessionBridge.eventHandlers.set(paneId, handlers);
  }

  /**
   * Unregister a pane from the session's bridge.
   * If no panes remain, the bridge is killed.
   */
  unregisterPane(session: string, paneId: string): void {
    const sessionBridge = this.sessions.get(session);
    if (!sessionBridge) return;

    sessionBridge.paneIds.delete(paneId);
    sessionBridge.eventHandlers.delete(paneId);
    this.stateStore.clearPane(session, paneId);

    if (sessionBridge.paneIds.size === 0) {
      sessionBridge.bridge?.kill();
      this.sessions.delete(session);
      this.logger?.log?.(`[bridge-manager] session ${session}: no panes left, bridge killed`);
    }
  }

  /**
   * Send a command to the session's bridge.
   */
  sendCommand(session: string, command: ZellijNativeBridgeCommand): boolean {
    const sessionBridge = this.sessions.get(session);
    if (!sessionBridge?.bridge) return false;
    return sessionBridge.bridge.sendCommand(command);
  }

  /**
   * Get the number of active session bridges.
   */
  get activeBridgeCount(): number {
    return this.sessions.size;
  }

  /**
   * Dispose all bridges.
   */
  dispose(): void {
    for (const [, sessionBridge] of this.sessions) {
      sessionBridge.bridge?.kill();
    }
    this.sessions.clear();
    this.stateStore.clearAll();
  }

  /**
   * Dispatch a bridge event to registered pane handlers.
   */
  private dispatchEvent(session: string, event: ZellijNativeBridgeEvent): void {
    const sessionBridge = this.sessions.get(session);
    if (!sessionBridge) return;

    if (event.type === "pane_render" || event.type === "pane_closed") {
      const handlers = sessionBridge.eventHandlers.get(event.paneId);
      if (handlers) {
        for (const handler of handlers) {
          try { handler(event); } catch { /* ignore */ }
        }
      }
      return;
    }

    // Broadcast non-pane-specific events to all handlers
    for (const handlers of sessionBridge.eventHandlers.values()) {
      for (const handler of handlers) {
        try { handler(event); } catch { /* ignore */ }
      }
    }
  }
}

import type {
  SemanticEvent,
  SemanticSessionState,
} from "../../shared/contracts/semantic.js";

export interface SemanticEventTransportSubscriber {
  onEvent(event: SemanticEvent): void;
  onState?(state: SemanticSessionState): void;
}

export interface SemanticEventTransport {
  subscribe(subscriber: SemanticEventTransportSubscriber): () => void;
  broadcast(event: SemanticEvent): void;
  updateState(state: SemanticSessionState): void;
}

export class SemanticEventBroadcaster implements SemanticEventTransport {
  private readonly subscribers = new Set<SemanticEventTransportSubscriber>();

  subscribe(subscriber: SemanticEventTransportSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  broadcast(event: SemanticEvent): void {
    for (const subscriber of this.subscribers) {
      subscriber.onEvent(event);
    }
  }

  updateState(state: SemanticSessionState): void {
    for (const subscriber of this.subscribers) {
      subscriber.onState?.(state);
    }
  }
}

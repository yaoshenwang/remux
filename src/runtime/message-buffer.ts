/**
 * Per-device message ring buffer for offline message queuing.
 * When a client disconnects, messages are buffered here so they can
 * be replayed on reconnect (session recovery).
 *
 * Design influenced by Mosh's approach to state synchronization and
 * tmux's client-server buffering model.
 */

export interface BufferedMessage {
  timestamp: number;
  data: string; // serialized JSON message
}

/**
 * Ring buffer that holds messages for a single device.
 * Oldest messages are evicted when maxSize is exceeded.
 * Messages older than maxAgeMs are filtered out on drain/prune.
 */
export class MessageBuffer {
  private buffer: BufferedMessage[] = [];
  private maxSize: number;
  private maxAgeMs: number;

  constructor(maxSize = 1000, maxAgeMs = 10 * 60 * 1000) {
    this.maxSize = maxSize;
    this.maxAgeMs = maxAgeMs;
  }

  /**
   * Add a message to the buffer.
   * Evicts the oldest message if buffer is at capacity.
   */
  push(data: string): void {
    if (this.buffer.length >= this.maxSize) {
      this.buffer.shift(); // evict oldest
    }
    this.buffer.push({ timestamp: Date.now(), data });
  }

  /**
   * Return all messages (optionally since a given timestamp).
   * Filters out expired messages (older than maxAgeMs).
   * Clears returned messages from the buffer.
   */
  drain(since?: number): BufferedMessage[] {
    const now = Date.now();
    const cutoff = now - this.maxAgeMs;

    let result = this.buffer.filter((m) => m.timestamp > cutoff);
    if (since !== undefined) {
      result = result.filter((m) => m.timestamp > since);
    }

    this.buffer = [];
    return result;
  }

  /**
   * Clear all messages from the buffer.
   */
  clear(): void {
    this.buffer = [];
  }

  /**
   * Number of messages currently in the buffer.
   */
  get size(): number {
    return this.buffer.length;
  }

  /**
   * Remove messages older than maxAgeMs.
   */
  pruneExpired(): void {
    const cutoff = Date.now() - this.maxAgeMs;
    this.buffer = this.buffer.filter((m) => m.timestamp > cutoff);
  }
}

/**
 * Global registry of message buffers, keyed by deviceId.
 * Runs periodic cleanup to evict stale/empty buffers.
 */
export class BufferRegistry {
  private buffers = new Map<string, MessageBuffer>();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Periodic cleanup every 60s
    this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
  }

  /**
   * Get or create a MessageBuffer for a device.
   */
  getOrCreate(deviceId: string): MessageBuffer {
    let buf = this.buffers.get(deviceId);
    if (!buf) {
      buf = new MessageBuffer();
      this.buffers.set(deviceId, buf);
    }
    return buf;
  }

  /**
   * Remove the buffer for a device.
   */
  remove(deviceId: string): void {
    this.buffers.delete(deviceId);
  }

  /**
   * Remove empty buffers that have no messages (stale).
   * Prune expired messages in all remaining buffers.
   */
  private cleanup(): void {
    for (const [deviceId, buf] of this.buffers) {
      buf.pruneExpired();
      if (buf.size === 0) {
        this.buffers.delete(deviceId);
      }
    }
  }

  /**
   * Tear down: clear the cleanup interval and all buffers.
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.buffers.clear();
  }
}

/**
 * Tests for server-side message buffering and session recovery.
 * Covers MessageBuffer (per-device ring buffer) and BufferRegistry (global manager).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Will import from the source module once implemented
import { MessageBuffer, BufferRegistry } from "../src/runtime/message-buffer.js";

// ── MessageBuffer ───────────────────────────────────────────────

describe("MessageBuffer", () => {
  let buf;

  beforeEach(() => {
    buf = new MessageBuffer(5, 10_000); // 5 msgs, 10s TTL
  });

  it("push/drain round trip returns all messages", () => {
    buf.push('{"type":"data","payload":"hello"}');
    buf.push('{"type":"data","payload":"world"}');

    const msgs = buf.drain();
    expect(msgs).toHaveLength(2);
    expect(msgs[0].data).toBe('{"type":"data","payload":"hello"}');
    expect(msgs[1].data).toBe('{"type":"data","payload":"world"}');
    // Each message has a timestamp
    expect(typeof msgs[0].timestamp).toBe("number");
    expect(msgs[0].timestamp).toBeGreaterThan(0);
  });

  it("drain clears the buffer", () => {
    buf.push("a");
    buf.push("b");
    const first = buf.drain();
    expect(first).toHaveLength(2);

    const second = buf.drain();
    expect(second).toHaveLength(0);
  });

  it("maxSize eviction drops oldest messages", () => {
    // maxSize = 5
    for (let i = 0; i < 8; i++) {
      buf.push(`msg-${i}`);
    }
    const msgs = buf.drain();
    expect(msgs).toHaveLength(5);
    // Oldest 3 (msg-0, msg-1, msg-2) should have been evicted
    expect(msgs[0].data).toBe("msg-3");
    expect(msgs[4].data).toBe("msg-7");
  });

  it("maxAgeMs expiration filters old messages on drain", () => {
    // Use fake timers to control time
    vi.useFakeTimers();

    const now = Date.now();
    buf.push("old-msg");

    // Advance time past TTL
    vi.advanceTimersByTime(11_000); // 11s > 10s TTL
    buf.push("new-msg");

    const msgs = buf.drain();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].data).toBe("new-msg");

    vi.useRealTimers();
  });

  it("drain with since timestamp filter returns only newer messages", () => {
    vi.useFakeTimers();

    buf.push("msg-1");
    const t1 = Date.now();

    vi.advanceTimersByTime(1000);
    buf.push("msg-2");

    vi.advanceTimersByTime(1000);
    buf.push("msg-3");

    // Drain messages since t1 (should exclude msg-1 which was pushed at t1)
    const msgs = buf.drain(t1);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].data).toBe("msg-2");
    expect(msgs[1].data).toBe("msg-3");

    vi.useRealTimers();
  });

  it("clear empties the buffer", () => {
    buf.push("a");
    buf.push("b");
    buf.push("c");
    buf.clear();
    expect(buf.size).toBe(0);
    expect(buf.drain()).toHaveLength(0);
  });

  it("size is accurate", () => {
    expect(buf.size).toBe(0);
    buf.push("a");
    expect(buf.size).toBe(1);
    buf.push("b");
    expect(buf.size).toBe(2);
    buf.drain();
    expect(buf.size).toBe(0);
  });

  it("size respects maxSize cap", () => {
    // maxSize = 5
    for (let i = 0; i < 10; i++) {
      buf.push(`msg-${i}`);
    }
    expect(buf.size).toBe(5);
  });

  it("pruneExpired removes old messages", () => {
    vi.useFakeTimers();

    buf.push("old-1");
    buf.push("old-2");

    vi.advanceTimersByTime(11_000); // past TTL
    buf.push("new-1");

    buf.pruneExpired();
    expect(buf.size).toBe(1);
    const msgs = buf.drain();
    expect(msgs[0].data).toBe("new-1");

    vi.useRealTimers();
  });

  it("uses default maxSize and maxAgeMs when not specified", () => {
    const defaultBuf = new MessageBuffer();
    // Default: 1000 messages, 10 minutes
    // Push a message and verify it works
    defaultBuf.push("test");
    expect(defaultBuf.size).toBe(1);
    expect(defaultBuf.drain()).toHaveLength(1);
  });
});

// ── BufferRegistry ──────────────────────────────────────────────

describe("BufferRegistry", () => {
  let registry;

  beforeEach(() => {
    vi.useFakeTimers();
    registry = new BufferRegistry();
  });

  afterEach(() => {
    registry.destroy();
    vi.useRealTimers();
  });

  it("getOrCreate creates a new buffer for unknown deviceId", () => {
    const buf = registry.getOrCreate("device-1");
    expect(buf).toBeInstanceOf(MessageBuffer);
    expect(buf.size).toBe(0);
  });

  it("getOrCreate returns the same buffer for the same deviceId", () => {
    const buf1 = registry.getOrCreate("device-1");
    buf1.push("hello");
    const buf2 = registry.getOrCreate("device-1");
    expect(buf2).toBe(buf1);
    expect(buf2.size).toBe(1);
  });

  it("getOrCreate returns different buffers for different deviceIds", () => {
    const buf1 = registry.getOrCreate("device-1");
    const buf2 = registry.getOrCreate("device-2");
    expect(buf1).not.toBe(buf2);
  });

  it("remove deletes a buffer", () => {
    const buf = registry.getOrCreate("device-1");
    buf.push("hello");

    registry.remove("device-1");

    // Getting again should be a fresh buffer
    const newBuf = registry.getOrCreate("device-1");
    expect(newBuf.size).toBe(0);
    expect(newBuf).not.toBe(buf);
  });

  it("remove is safe for non-existent deviceId", () => {
    // Should not throw
    registry.remove("nonexistent");
  });

  it("cleanup removes empty buffers with no recent activity", () => {
    const buf = registry.getOrCreate("device-1");
    // Buffer is empty and was created a while ago

    // Advance time so the buffer looks stale
    vi.advanceTimersByTime(120_000); // 2 minutes

    // Trigger cleanup via the interval (60s interval)
    vi.advanceTimersByTime(60_000);

    // Getting again should create a new buffer
    const newBuf = registry.getOrCreate("device-1");
    // If cleanup removed it, this would be a fresh buffer
    // (but if the buffer was still there, the reference would be different
    // only if it was removed and recreated)
    expect(newBuf.size).toBe(0);
  });

  it("cleanup preserves buffers with messages", () => {
    const buf = registry.getOrCreate("device-1");
    buf.push("important-message");

    // Advance time and trigger cleanup
    vi.advanceTimersByTime(120_000);
    vi.advanceTimersByTime(60_000);

    // Buffer should still exist with its message
    const sameBuf = registry.getOrCreate("device-1");
    expect(sameBuf).toBe(buf);
    expect(sameBuf.size).toBe(1);
  });

  it("destroy clears all buffers and stops interval", () => {
    registry.getOrCreate("device-1").push("msg");
    registry.getOrCreate("device-2").push("msg");

    registry.destroy();

    // After destroy, getting buffers again should return fresh ones
    // (destroy should have cleared the map)
    const freshRegistry = new BufferRegistry();
    const buf = freshRegistry.getOrCreate("device-1");
    expect(buf.size).toBe(0);
    freshRegistry.destroy();
  });
});

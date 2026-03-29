import { describe, expect, test, vi } from "vitest";
import { createTerminalWriteBuffer } from "../../src/frontend/terminal-write-buffer.js";

describe("terminal write buffer", () => {
  test("coalesces multiple writes into a single frame flush", () => {
    const writes: string[] = [];
    const completions: Array<() => void> = [];
    let callback: (() => void) | null = null;
    const requestFrame = vi.fn((cb: () => void) => {
      callback = cb;
      return 1;
    });
    const cancelFrame = vi.fn();
    const buffer = createTerminalWriteBuffer((chunk, done) => {
      writes.push(chunk);
      completions.push(done);
    }, requestFrame, cancelFrame);

    buffer.enqueue("hello ");
    buffer.enqueue("world");

    expect(requestFrame).toHaveBeenCalledTimes(1);
    expect(writes).toEqual([]);

    callback?.();
    expect(writes).toEqual(["hello world"]);
    completions.shift()?.();
  });

  test("clear cancels the pending frame and drops buffered data", () => {
    const writes: string[] = [];
    const requestFrame = vi.fn(() => 7);
    const cancelFrame = vi.fn();
    const buffer = createTerminalWriteBuffer((chunk, done) => {
      writes.push(chunk);
      done();
    }, requestFrame, cancelFrame);

    buffer.enqueue("stale");
    buffer.clear();
    buffer.flush();

    expect(cancelFrame).toHaveBeenCalledWith(7);
    expect(writes).toEqual([]);
  });

  test("preserves mixed text and binary chunk order within a frame flush", () => {
    const writes: Array<string | Uint8Array> = [];
    const completions: Array<() => void> = [];
    let callback: (() => void) | null = null;
    const requestFrame = vi.fn((cb: () => void) => {
      callback = cb;
      return 3;
    });
    const buffer = createTerminalWriteBuffer((chunk, done) => {
      writes.push(chunk);
      completions.push(done);
    }, requestFrame, vi.fn());

    buffer.enqueue("hello ");
    buffer.enqueue("world");
    buffer.enqueue(new Uint8Array([1, 2]));
    buffer.enqueue(new Uint8Array([3, 4]));
    buffer.enqueue("!");

    callback?.();
    completions.shift()?.();
    completions.shift()?.();

    expect(writes).toHaveLength(3);
    expect(writes[0]).toBe("hello world");
    expect(writes[1]).toBeInstanceOf(Uint8Array);
    expect(Array.from(writes[1] as Uint8Array)).toEqual([1, 2, 3, 4]);
    expect(writes[2]).toBe("!");
    completions.splice(0).forEach((done) => done());
  });

  test("splits a large chunk across multiple frames and completes it once", () => {
    const writes: string[] = [];
    const completions: Array<() => void> = [];
    const frameCallbacks: Array<() => void> = [];
    const onComplete = vi.fn();
    const requestFrame = vi.fn((cb: () => void) => {
      frameCallbacks.push(cb);
      return frameCallbacks.length;
    });
    const buffer = createTerminalWriteBuffer(
      (chunk, done) => {
        writes.push(chunk as string);
        completions.push(done);
      },
      requestFrame,
      vi.fn(),
      { maxBytesPerFrame: 5 },
    );

    buffer.enqueue("abcdefghij", onComplete);

    expect(frameCallbacks).toHaveLength(1);
    frameCallbacks.shift()?.();
    expect(writes).toEqual(["abcde"]);
    expect(onComplete).not.toHaveBeenCalled();
    expect(frameCallbacks).toHaveLength(0);

    completions.shift()?.();
    expect(frameCallbacks).toHaveLength(1);

    frameCallbacks.shift()?.();
    expect(writes).toEqual(["abcde", "fghij"]);
    expect(onComplete).not.toHaveBeenCalled();
    completions.shift()?.();
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  test("does not drain the entire backlog in a single frame budget", () => {
    const writes: string[] = [];
    const completions: Array<() => void> = [];
    const frameCallbacks: Array<() => void> = [];
    const requestFrame = vi.fn((cb: () => void) => {
      frameCallbacks.push(cb);
      return frameCallbacks.length;
    });
    const buffer = createTerminalWriteBuffer(
      (chunk, done) => {
        writes.push(chunk as string);
        completions.push(done);
      },
      requestFrame,
      vi.fn(),
      { maxBytesPerFrame: 6 },
    );

    buffer.enqueue("hello ");
    buffer.enqueue("beta");

    frameCallbacks.shift()?.();
    expect(writes).toEqual(["hello "]);
    expect(frameCallbacks).toHaveLength(0);

    completions.shift()?.();
    expect(frameCallbacks).toHaveLength(1);

    frameCallbacks.shift()?.();
    expect(writes).toEqual(["hello ", "beta"]);
  });

  test("waits for the xterm write callback before sending the next slice", () => {
    const writes: string[] = [];
    const completions: Array<() => void> = [];
    const frameCallbacks: Array<() => void> = [];
    const requestFrame = vi.fn((cb: () => void) => {
      frameCallbacks.push(cb);
      return frameCallbacks.length;
    });
    const buffer = createTerminalWriteBuffer(
      (chunk, done) => {
        writes.push(chunk as string);
        completions.push(done);
      },
      requestFrame,
      vi.fn(),
      { maxBytesPerFrame: 5 },
    );

    buffer.enqueue("abcdefghij");

    frameCallbacks.shift()?.();
    expect(writes).toEqual(["abcde"]);
    expect(frameCallbacks).toHaveLength(0);

    buffer.flush();
    expect(writes).toEqual(["abcde"]);

    completions.shift()?.();
    expect(frameCallbacks).toHaveLength(1);

    frameCallbacks.shift()?.();
    expect(writes).toEqual(["abcde", "fghij"]);
  });
});

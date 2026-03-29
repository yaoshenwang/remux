import { describe, expect, test, vi } from "vitest";
import { createTerminalWriteBuffer } from "../../src/frontend/terminal-write-buffer.js";

describe("terminal write buffer", () => {
  test("coalesces multiple writes into a single frame flush", () => {
    const writes: string[] = [];
    let callback: (() => void) | null = null;
    const requestFrame = vi.fn((cb: () => void) => {
      callback = cb;
      return 1;
    });
    const cancelFrame = vi.fn();
    const buffer = createTerminalWriteBuffer((chunk) => writes.push(chunk), requestFrame, cancelFrame);

    buffer.enqueue("hello ");
    buffer.enqueue("world");

    expect(requestFrame).toHaveBeenCalledTimes(1);
    expect(writes).toEqual([]);

    callback?.();
    expect(writes).toEqual(["hello world"]);
  });

  test("clear cancels the pending frame and drops buffered data", () => {
    const writes: string[] = [];
    const requestFrame = vi.fn(() => 7);
    const cancelFrame = vi.fn();
    const buffer = createTerminalWriteBuffer((chunk) => writes.push(chunk), requestFrame, cancelFrame);

    buffer.enqueue("stale");
    buffer.clear();
    buffer.flush();

    expect(cancelFrame).toHaveBeenCalledWith(7);
    expect(writes).toEqual([]);
  });

  test("preserves mixed text and binary chunk order within a frame flush", () => {
    const writes: Array<string | Uint8Array> = [];
    let callback: (() => void) | null = null;
    const requestFrame = vi.fn((cb: () => void) => {
      callback = cb;
      return 3;
    });
    const buffer = createTerminalWriteBuffer((chunk) => writes.push(chunk), requestFrame, vi.fn());

    buffer.enqueue("hello ");
    buffer.enqueue("world");
    buffer.enqueue(new Uint8Array([1, 2]));
    buffer.enqueue(new Uint8Array([3, 4]));
    buffer.enqueue("!");

    callback?.();

    expect(writes).toHaveLength(3);
    expect(writes[0]).toBe("hello world");
    expect(writes[1]).toBeInstanceOf(Uint8Array);
    expect(Array.from(writes[1] as Uint8Array)).toEqual([1, 2, 3, 4]);
    expect(writes[2]).toBe("!");
  });
});

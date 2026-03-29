import { describe, expect, test } from "vitest";
import { createTerminalInputBatcher } from "../../src/frontend/terminal-input-batcher.js";

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("createTerminalInputBatcher", () => {
  test("batches same-tick keystrokes into one websocket payload", async () => {
    const payloads: string[] = [];
    const batcher = createTerminalInputBatcher((payload) => {
      payloads.push(new TextDecoder().decode(payload));
    });

    batcher.enqueue("a");
    batcher.enqueue("b");
    batcher.enqueue("c");
    await flushMicrotasks();

    expect(payloads).toEqual(["abc"]);
  });

  test("flushes buffered disconnected input once the socket becomes writable", async () => {
    const payloads: string[] = [];
    const batcher = createTerminalInputBatcher((payload) => {
      payloads.push(new TextDecoder().decode(payload));
    });

    batcher.bufferWhileDisconnected("echo ");
    batcher.bufferWhileDisconnected("hi");
    batcher.flushBufferedInput();

    expect(payloads).toEqual(["echo hi"]);
  });
});

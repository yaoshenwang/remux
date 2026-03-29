import { describe, expect, test, vi } from "vitest";
import { sendComposeToRuntime } from "../../src/backend/server/compose-submit.js";

const flushComposeQueue = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe("sendComposeToRuntime", () => {
  test("submits shell commands immediately", async () => {
    const writes: string[] = [];

    sendComposeToRuntime({
      runtime: {
        write(data) {
          writes.push(data);
        },
      },
      text: "echo hi",
      paneCommand: "zsh",
    });

    await flushComposeQueue();

    expect(writes).toEqual(["echo hi\r"]);
  });

  test("serializes delayed compose submissions so codex commands do not concatenate", async () => {
    const writes: string[] = [];
    const scheduled: Array<() => void> = [];

    const runtime = {
      write(data: string) {
        writes.push(data);
      },
    };

    const scheduleDelayedWrite = (callback: () => void) => {
      scheduled.push(callback);
    };

    sendComposeToRuntime({
      runtime,
      text: "first command",
      submitMode: "delayed",
      scheduleDelayedWrite,
    });
    sendComposeToRuntime({
      runtime,
      text: "second command",
      submitMode: "delayed",
      scheduleDelayedWrite,
    });

    await flushComposeQueue();

    expect(writes).toEqual(["first command"]);
    expect(scheduled).toHaveLength(1);

    scheduled.shift()?.();
    await flushComposeQueue();

    expect(writes).toEqual(["first command", "\r", "second command"]);
    expect(scheduled).toHaveLength(1);

    scheduled.shift()?.();
    await flushComposeQueue();

    expect(writes).toEqual(["first command", "\r", "second command", "\r"]);
  });

  test("logs compose queue errors before clearing the failed task", async () => {
    const logger = {
      error: (..._args: unknown[]) => undefined,
    };
    const errorSpy = vi.spyOn(logger, "error");

    sendComposeToRuntime({
      runtime: {
        write() {
          throw new Error("runtime unavailable");
        },
      },
      text: "echo hi",
      paneCommand: "zsh",
      logger,
    });

    await flushComposeQueue();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.[0]).toBe("compose queue error:");
    expect(errorSpy.mock.calls[0]?.[1]).toBeInstanceOf(Error);
  });
});

import { describe, expect, test } from "vitest";
import { TerminalRuntime } from "../../src/backend/pty/terminal-runtime.js";
import { FakePtyFactory } from "../harness/fakePty.js";

describe("terminal runtime", () => {
  test("applies latest resize when attaching after an early resize", () => {
    const factory = new FakePtyFactory();
    const runtime = new TerminalRuntime(factory);

    runtime.resize(140, 50);
    runtime.attachToSession("main");

    expect(factory.latestProcess().resizes.at(0)).toEqual({ cols: 140, rows: 50 });
  });

  test("ignores invalid resize values", () => {
    const factory = new FakePtyFactory();
    const runtime = new TerminalRuntime(factory);

    runtime.resize(Number.NaN, 40);
    runtime.resize(1, 1);
    runtime.attachToSession("main");

    expect(factory.latestProcess().resizes.at(0)).toEqual({ cols: 80, rows: 24 });
  });

  test("clears cached replay data and session on shutdown", async () => {
    const factory = new FakePtyFactory();
    const runtime = new TerminalRuntime(factory);

    runtime.attachToSession("main");
    factory.latestProcess().emitData("stale viewport");
    expect(runtime.currentSession()).toBe("main");

    const replayedBeforeShutdown: string[] = [];
    runtime.replayLast((data) => replayedBeforeShutdown.push(data));
    expect(replayedBeforeShutdown).toEqual(["stale viewport"]);

    await runtime.shutdown();

    expect(runtime.currentSession()).toBeUndefined();
    expect(runtime.isAlive()).toBe(false);
    const replayedAfterShutdown: string[] = [];
    runtime.replayLast((data) => replayedAfterShutdown.push(data));
    expect(replayedAfterShutdown).toEqual([]);
  });
});

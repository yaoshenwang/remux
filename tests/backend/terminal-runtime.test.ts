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

  test("forwards runtime state changes from PTY processes", () => {
    const factory = new FakePtyFactory();
    const runtime = new TerminalRuntime(factory);
    const states: Array<{ streamMode: string; scrollbackPrecision: string }> = [];

    runtime.on("runtimeState", (state) => states.push(state));
    runtime.attachToSession("main");

    factory.latestProcess().emitRuntimeState({
      streamMode: "native-bridge",
      scrollbackPrecision: "precise"
    });
    factory.latestProcess().emitRuntimeState({
      streamMode: "cli-polling",
      degradedReason: "bridge_crashed",
      scrollbackPrecision: "approximate"
    });

    expect(states).toEqual([
      { streamMode: "native-bridge", scrollbackPrecision: "precise" },
      {
        streamMode: "cli-polling",
        degradedReason: "bridge_crashed",
        scrollbackPrecision: "approximate"
      }
    ]);
    expect(runtime.currentRuntimeState()).toEqual({
      streamMode: "cli-polling",
      degradedReason: "bridge_crashed",
      scrollbackPrecision: "approximate"
    });
  });

  test("forwards workspace change signals from PTY processes", () => {
    const factory = new FakePtyFactory();
    const runtime = new TerminalRuntime(factory);
    const reasons: string[] = [];

    runtime.on("workspaceChange", (reason) => reasons.push(reason));
    runtime.attachToSession("main");
    factory.latestProcess().emitWorkspaceChange("session_switch");
    factory.latestProcess().emitWorkspaceChange("session_renamed");

    expect(reasons).toEqual(["session_switch", "session_renamed"]);
  });

  test("forwards runtime geometry changes from PTY processes", () => {
    const factory = new FakePtyFactory();
    const runtime = new TerminalRuntime(factory);
    const geometries: Array<{
      requested: { cols: number; rows: number };
      confirmed: { cols: number; rows: number };
      status: string;
    }> = [];

    runtime.on("geometry", (geometry) => geometries.push(geometry));
    runtime.attachToSession("main");

    factory.latestProcess().emitRuntimeGeometry({
      requested: { cols: 132, rows: 38 },
      confirmed: { cols: 128, rows: 36 },
      status: "syncing",
    });
    factory.latestProcess().emitRuntimeGeometry({
      requested: { cols: 132, rows: 38 },
      confirmed: { cols: 132, rows: 38 },
      status: "stable",
    });

    expect(geometries).toEqual([
      {
        requested: { cols: 132, rows: 38 },
        confirmed: { cols: 128, rows: 36 },
        status: "syncing",
      },
      {
        requested: { cols: 132, rows: 38 },
        confirmed: { cols: 132, rows: 38 },
        status: "stable",
      }
    ]);
    expect(runtime.currentGeometry()).toEqual({
      requested: { cols: 132, rows: 38 },
      confirmed: { cols: 132, rows: 38 },
      status: "stable",
    });
  });
});

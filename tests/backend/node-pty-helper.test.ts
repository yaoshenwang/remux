import { describe, expect, test, vi } from "vitest";
import { ensureNodePtySpawnHelperExecutable } from "../../src/backend/pty/node-pty-helper.js";

describe("ensureNodePtySpawnHelperExecutable", () => {
  test("marks the first available unix spawn-helper as executable", () => {
    const chmodSync = vi.fn();

    ensureNodePtySpawnHelperExecutable(undefined, {
      platform: "darwin",
      processPlatform: "darwin",
      processArch: "arm64",
      resolveUnixTerminalPath: () => "/tmp/node-pty/lib/unixTerminal.js",
      existsSync: (candidate) => candidate === "/tmp/node-pty/prebuilds/darwin-arm64/spawn-helper",
      chmodSync,
    });

    expect(chmodSync).toHaveBeenCalledWith("/tmp/node-pty/prebuilds/darwin-arm64/spawn-helper", 0o755);
  });

  test("does nothing on Windows", () => {
    const chmodSync = vi.fn();

    ensureNodePtySpawnHelperExecutable(undefined, {
      platform: "win32",
      chmodSync,
    });

    expect(chmodSync).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

import { ZellijController } from "../../src/backend/zellij-controller.js";

describe("ZellijController session helpers", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it("parses structured session info from zellij list-sessions", async () => {
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(null, {
        stdout: [
          "remux-dev [Created 14h 17m 18s ago]",
          "old-project [Created 4days ago] (EXITED - attach to resurrect)",
        ].join("\n"),
      });
    });

    const controller = new ZellijController({ session: "remux-dev", zellijBin: "zellij" });
    await expect(controller.listSessionsStructured()).resolves.toEqual([
      {
        name: "remux-dev",
        createdAgo: "14h 17m 18s",
        isActive: true,
      },
      {
        name: "old-project",
        createdAgo: "4days",
        isActive: false,
      },
    ]);
  });

  it("uses global zellij commands for kill and force delete session", async () => {
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(null, { stdout: "" });
    });

    const controller = new ZellijController({ session: "ignored", zellijBin: "zellij" });
    await controller.killSession("alpha");
    await controller.deleteSession("alpha");

    expect(execFileMock).toHaveBeenNthCalledWith(
      1,
      "zellij",
      ["kill-session", "alpha"],
      { timeout: 5000 },
      expect.any(Function),
    );
    expect(execFileMock).toHaveBeenNthCalledWith(
      2,
      "zellij",
      ["delete-session", "--force", "alpha"],
      { timeout: 5000 },
      expect.any(Function),
    );
  });
});

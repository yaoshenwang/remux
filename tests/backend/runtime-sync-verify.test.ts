import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => fs.promises.rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("runtime sync verification", () => {
  test("accepts legacy config payloads that only expose version", async () => {
    const tempHome = await fs.promises.mkdtemp(path.join(os.tmpdir(), "remux-runtime-verify-test-"));
    tempDirs.push(tempHome);

    const fakeBinDir = path.join(tempHome, "bin");
    await fs.promises.mkdir(fakeBinDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(fakeBinDir, "curl"),
      `#!/bin/bash
set -euo pipefail
printf '%s' '{"version":"0.1.48","passwordRequired":false}'
`,
      { mode: 0o755 }
    );

    const command = [
      "source scripts/runtime-lib.sh",
      "wait_for_runtime_api main deadbeef main 0.1.48",
      "verify_public_runtime main deadbeef main 0.1.48"
    ].join(" && ");

    expect(() =>
      execFileSync("bash", ["-c", command], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: tempHome,
          PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`
        },
        stdio: "pipe"
      })
    ).not.toThrow();
  });
});

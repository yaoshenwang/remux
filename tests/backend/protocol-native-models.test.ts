import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, expect, it } from "vitest";

const fixtures = [
  { target: "LegacyAuthOk", fixture: "tests/fixtures/protocol/core/auth_ok.legacy.json" },
  { target: "LegacyAuthError", fixture: "tests/fixtures/protocol/core/auth_error.legacy.json" },
  { target: "LegacyErrorMessage", fixture: "tests/fixtures/protocol/core/error.legacy.json" },
  { target: "LegacyPong", fixture: "tests/fixtures/protocol/core/pong.legacy.json" },
  { target: "LegacyWorkspaceState", fixture: "tests/fixtures/protocol/runtime/workspace_state.legacy.json" },
  { target: "WorkspaceStateEnvelope", fixture: "tests/fixtures/protocol/runtime/workspace_state.envelope.json" },
  { target: "LegacyRequestInspect", fixture: "tests/fixtures/protocol/inspect/request_inspect.legacy.json" },
  { target: "RequestInspectEnvelope", fixture: "tests/fixtures/protocol/inspect/request_inspect.envelope.json" },
  { target: "LegacyInspectSnapshot", fixture: "tests/fixtures/protocol/inspect/inspect_snapshot.legacy.json" },
  { target: "InspectSnapshotEnvelope", fixture: "tests/fixtures/protocol/inspect/inspect_snapshot.envelope.json" },
  { target: "LegacyBandwidthStats", fixture: "tests/fixtures/protocol/admin/bandwidth_stats.legacy.json" },
  { target: "BandwidthStatsEnvelope", fixture: "tests/fixtures/protocol/admin/bandwidth_stats.envelope.json" },
] as const;

const fixturePaths = fixtures.map((entry) => path.resolve(entry.fixture));
const compiledFixtures = fixtures.map((entry, index) => ({
  id: `fixture-${index + 1}`,
  target: entry.target,
  json: JSON.parse(fs.readFileSync(path.resolve(entry.fixture), "utf8")),
}));

describe("native protocol models", () => {
  it("decodes all golden payload fixtures with Swift models", () => {
    expect(hasUsableSwift()).toBe(true);

    const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), "remux-swift-protocol-"));
    const outputBinary = path.join(buildDir, "decode-swift");
    execFileSync(
      "swiftc",
      [
        "native/ios/ProtocolModels.swift",
        "native/ios/DecodeGoldenPayloads.swift",
        "-o",
        outputBinary,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    const output = execFileSync(
      outputBinary,
      [
        JSON.stringify(compiledFixtures),
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    for (const fixture of compiledFixtures) {
      expect(output).toContain(fixture.target);
    }
  });

  it("decodes all golden payload fixtures with Kotlin models", () => {
    expect(hasUsableKotlinc()).toBe(true);

    const outputJar = path.resolve("native/android/build/protocol-golden-payloads.jar");
    fs.mkdirSync(path.dirname(outputJar), { recursive: true });

    execFileSync(
      "kotlinc",
      [
        "native/android/ProtocolModels.kt",
        "native/android/DecodeGoldenPayloads.kt",
        "-include-runtime",
        "-d",
        outputJar,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    const output = execFileSync(
      "java",
      ["-jar", outputJar, ...fixturePaths],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    for (const fixturePath of fixturePaths) {
      expect(output).toContain(path.basename(fixturePath));
    }
  });
});

function hasUsableKotlinc(): boolean {
  try {
    execFileSync("kotlinc", ["-version"], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function hasUsableSwift(): boolean {
  return spawnSync("sh", ["-lc", "command -v swiftc"], { encoding: "utf8" }).status === 0;
}

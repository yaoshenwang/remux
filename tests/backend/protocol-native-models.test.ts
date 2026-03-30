import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const fixturePaths = [
  "tests/fixtures/protocol/core/auth_ok.legacy.json",
  "tests/fixtures/protocol/core/auth_error.legacy.json",
  "tests/fixtures/protocol/core/error.legacy.json",
  "tests/fixtures/protocol/core/pong.legacy.json",
  "tests/fixtures/protocol/runtime/workspace_state.legacy.json",
  "tests/fixtures/protocol/runtime/workspace_state.envelope.json",
  "tests/fixtures/protocol/inspect/request_inspect.legacy.json",
  "tests/fixtures/protocol/inspect/request_inspect.envelope.json",
  "tests/fixtures/protocol/inspect/inspect_snapshot.legacy.json",
  "tests/fixtures/protocol/inspect/inspect_snapshot.envelope.json",
  "tests/fixtures/protocol/admin/bandwidth_stats.legacy.json",
  "tests/fixtures/protocol/admin/bandwidth_stats.envelope.json",
].map((fixturePath) => path.resolve(fixturePath));

describe("native protocol models", () => {
  it("decodes all golden payload fixtures with Swift Codable models when swift is available", () => {
    if (!hasUsableSwift()) {
      return;
    }

    const output = execFileSync(
      "swift",
      [
        "native/ios/ProtocolModels.swift",
        "native/ios/DecodeGoldenPayloads.swift",
        ...fixturePaths,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    for (const fixturePath of fixturePaths) {
      expect(output).toContain(path.basename(fixturePath));
    }
  });

  it("decodes all golden payload fixtures with Kotlin models when kotlinc is available", () => {
    if (!hasUsableKotlinc()) {
      return;
    }

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
  try {
    execFileSync("swift", ["-e", "import Foundation\nprint(\"ok\")"], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

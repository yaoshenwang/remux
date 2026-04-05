import { describe, expect, it } from "vitest";

import {
  evaluateExpectedAssets,
  findMissingDocSnippets,
  releaseTagForVersion,
} from "../scripts/lib/release-readiness.mjs";

describe("release readiness helpers", () => {
  it("computes missing release assets", () => {
    expect(
      evaluateExpectedAssets(
        ["remux-macos.dmg", "appcast.xml"],
        ["appcast.xml", "notes.md"],
      ),
    ).toEqual({
      expectedAssetNames: ["remux-macos.dmg", "appcast.xml"],
      existingAssetNames: ["appcast.xml", "notes.md"],
      missingAssetNames: ["remux-macos.dmg"],
      unexpectedAssetNames: ["notes.md"],
      isComplete: false,
    });
  });

  it("finds missing documentation snippets", () => {
    const content = `
      # Official Surfaces
      Web: https://remux.yaoshen.wang
      npm: npx @wangyaoshen/remux
    `;

    expect(
      findMissingDocSnippets(content, [
        "https://remux.yaoshen.wang",
        "npx @wangyaoshen/remux",
        "https://github.com/yaoshenwang/remux/releases/latest/download/remux-macos.dmg",
      ]),
    ).toEqual(["https://github.com/yaoshenwang/remux/releases/latest/download/remux-macos.dmg"]);
  });

  it("normalizes package versions into release tags", () => {
    expect(releaseTagForVersion("0.3.14")).toBe("v0.3.14");
    expect(releaseTagForVersion("v0.3.14")).toBe("v0.3.14");
  });
});

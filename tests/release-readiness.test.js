import { describe, expect, it } from "vitest";

import {
  evaluateExpectedAssets,
  findMissingDocSnippets,
  findPublicLinkGroup,
  isAllowedExternalBuildState,
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
        "https://testflight.apple.com/join/DhXZEKUU",
      ]),
    ).toEqual(["https://testflight.apple.com/join/DhXZEKUU"]);
  });

  it("treats approved external TestFlight states as installable", () => {
    expect(isAllowedExternalBuildState("IN_BETA_TESTING")).toBe(true);
    expect(isAllowedExternalBuildState("READY_FOR_BETA_TESTING")).toBe(true);
    expect(isAllowedExternalBuildState("WAITING_FOR_REVIEW")).toBe(false);
  });

  it("selects the configured public TestFlight group", () => {
    const group = findPublicLinkGroup(
      [
        { id: "a", attributes: { publicLink: "https://testflight.apple.com/join/old" } },
        { id: "b", attributes: { publicLink: "https://testflight.apple.com/join/DhXZEKUU" } },
      ],
      "https://testflight.apple.com/join/DhXZEKUU",
    );

    expect(group?.id).toBe("b");
  });

  it("normalizes package versions into release tags", () => {
    expect(releaseTagForVersion("0.3.14")).toBe("v0.3.14");
    expect(releaseTagForVersion("v0.3.14")).toBe("v0.3.14");
  });
});

import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  IMMUTABLE_RELEASE_ASSETS,
  RELEASE_ASSET_GUARD_STATE,
  evaluateReleaseAssetGuard,
} = require("../scripts/release-asset-guard.cjs");

describe("release asset guard", () => {
  it("marks the release as complete when every immutable asset already exists", () => {
    const result = evaluateReleaseAssetGuard({
      existingAssetNames: [...IMMUTABLE_RELEASE_ASSETS, "notes.txt"],
    });

    expect(result.conflicts).toEqual(IMMUTABLE_RELEASE_ASSETS);
    expect(result.missingImmutableAssets).toEqual([]);
    expect(result.guardState).toBe(RELEASE_ASSET_GUARD_STATE.COMPLETE);
    expect(result.hasPartialConflict).toBe(false);
    expect(result.shouldSkipBuildAndUpload).toBe(true);
    expect(result.shouldSkipUpload).toBe(true);
  });

  it("marks the release as clear when none of the immutable assets exist yet", () => {
    const result = evaluateReleaseAssetGuard({
      existingAssetNames: ["notes.txt", "checksums.txt"],
    });

    expect(result.conflicts).toEqual([]);
    expect(result.missingImmutableAssets).toEqual(IMMUTABLE_RELEASE_ASSETS);
    expect(result.guardState).toBe(RELEASE_ASSET_GUARD_STATE.CLEAR);
    expect(result.hasPartialConflict).toBe(false);
    expect(result.shouldSkipBuildAndUpload).toBe(false);
    expect(result.shouldSkipUpload).toBe(false);
  });

  it("marks the release as partial when only some immutable assets exist", () => {
    const partialAssets = ["appcast.xml", "remuxd-remote-manifest.json"];
    const result = evaluateReleaseAssetGuard({
      existingAssetNames: partialAssets,
    });

    expect(result.conflicts).toEqual(partialAssets);
    expect(result.missingImmutableAssets).toEqual(
      IMMUTABLE_RELEASE_ASSETS.filter((assetName) => !partialAssets.includes(assetName)),
    );
    expect(result.guardState).toBe(RELEASE_ASSET_GUARD_STATE.PARTIAL);
    expect(result.hasPartialConflict).toBe(true);
    expect(result.shouldSkipBuildAndUpload).toBe(false);
    expect(result.shouldSkipUpload).toBe(false);
  });
});

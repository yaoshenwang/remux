import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

describe("publish workflow guards", () => {
  it("guards immutable macOS release assets before rebuilding or uploading", () => {
    const workflow = readRepoFile(".github/workflows/publish.yml");
    const guardScript = readRepoFile("scripts/release-asset-guard.cjs");
    expect(workflow).toContain("Guard immutable release assets");
    expect(workflow).toContain("actions/github-script@v7");
    expect(workflow).toContain("CREATE_DMG_VERSION: 8.0.0");
    expect(workflow).toContain('npm install --global "create-dmg@${CREATE_DMG_VERSION}"');
    expect(workflow).toContain("release-asset-guard.cjs");
    expect(workflow).toContain("partial immutable asset state");
    expect(guardScript).toContain("IMMUTABLE_RELEASE_ASSETS");
  });

  it("installs native build prerequisites in the Docker image", () => {
    const dockerfile = readRepoFile("Dockerfile");
    expect(dockerfile).toMatch(/apt-get update && apt-get install -y --no-install-recommends python3 make g\+\+/);
    expect(dockerfile).toMatch(/rm -rf \/var\/lib\/apt\/lists\/\*/);
  });

  it("lets macOS version bump continue when the latest appcast is temporarily unavailable", () => {
    const script = readRepoFile("apps/macos/scripts/bump-version.sh");
    expect(script).toContain("REMUX_RELEASE_APPCAST_URL");
    expect(script).toMatch(/curl -fsSL --max-time 8 "\$LATEST_RELEASE_APPCAST_URL" 2>\/dev\/null \|\| true/);
  });

  it("does not run the removed iOS TestFlight publish path in the stable workflow", () => {
    const workflow = readRepoFile(".github/workflows/publish.yml");
    expect(workflow).not.toMatch(/^\s{2}ios:\s*$/m);
    expect(workflow).not.toContain("Configure TestFlight distribution");
    expect(workflow).not.toContain("Upload to TestFlight");
  });

  it("fails the macOS publish job if the release assets were not uploaded", () => {
    const workflow = readRepoFile(".github/workflows/publish.yml");
    expect(workflow).toContain("Verify macOS release assets");
    expect(workflow).toContain("Missing release asset:");
    expect(workflow).toContain('gh release view "$TAG" --repo "$GITHUB_REPOSITORY" --json assets');
  });

  it("updates Homebrew in a separate post-publish workflow", () => {
    const workflow = readRepoFile(".github/workflows/update-homebrew.yml");
    expect(workflow).toContain('workflows: ["Publish"]');
    expect(workflow).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(workflow).toContain("Download published assets and compute SHA256");
    expect(workflow).toContain("set -euo pipefail");
    expect(workflow).toContain('curl -fsSL "$NPM_URL" -o "$NPM_PATH"');
  });

  it("runs the public release gate after the npm and macOS jobs finish", () => {
    const workflow = readRepoFile(".github/workflows/publish.yml");
    expect(workflow).toMatch(/release-gate:[\s\S]*needs: \[npm, macos\]/);
    expect(workflow).toMatch(/release-gate:[\s\S]*pnpm run verify:release-readiness:docs/);
    expect(workflow).toMatch(/release-gate:[\s\S]*pnpm run verify:release-readiness/);
  });

  it("allows the macOS release script to take Sparkle and notary credentials from the environment", () => {
    const workflow = readRepoFile(".github/workflows/publish.yml");
    const script = readRepoFile("apps/macos/scripts/build-sign-upload.sh");
    expect(workflow).toContain("SPARKLE_PRIVATE_KEY: ${{ secrets.SPARKLE_PRIVATE_KEY }}");
    expect(script).toContain("Missing macOS release environment file:");
    expect(script).toContain("APP_STORE_CONNECT_API_KEY_PATH");
    expect(script).toContain("Using App Store Connect API key for notarization");
  });

  it("builds GhosttyKit from the monorepo vendor checkout when the embedded macOS tree is incomplete", () => {
    const script = readRepoFile("apps/macos/scripts/build-sign-upload.sh");
    const cliHelper = readRepoFile("apps/macos/scripts/build-ghostty-cli-helper.sh");
    const helper = readRepoFile("scripts/build-ghostty-kit.sh");
    const setup = readRepoFile("apps/macos/scripts/setup.sh");
    const vendorHeader = readRepoFile("vendor/ghostty/include/ghostty.h");
    const vendorBuild = readRepoFile("vendor/ghostty/build.zig");
    const vendorSurface = readRepoFile("vendor/ghostty/src/Surface.zig");
    const vendorEmbedded = readRepoFile("vendor/ghostty/src/apprt/embedded.zig");
    expect(script).toContain("ghostty/src/build/main.zig");
    expect(script).toContain('MONOREPO_GHOSTTY_DIR="$REPO_ROOT/vendor/ghostty"');
    expect(script).toContain('$MONOREPO_GHOSTTY_DIR/src/build/main.zig');
    expect(script).toContain("scripts/build-ghostty-kit.sh");
    expect(script).toContain('local vendor_xcframework="$MONOREPO_GHOSTTY_DIR/macos/GhosttyKit.xcframework"');
    expect(script).toContain('BUILD_LOG="build/xcodebuild-release.log"');
    expect(script).toContain('tee "$BUILD_LOG"');
    expect(script).not.toContain("| tail -5");
    expect(cliHelper).toContain('MONOREPO_GHOSTTY_DIR="$MONOREPO_ROOT/vendor/ghostty"');
    expect(cliHelper).toContain("Embedded apps/macos/ghostty tree is incomplete; falling back to monorepo vendor/ghostty");
    expect(cliHelper).toContain('! -f "$GHOSTTY_DIR/src/build/main.zig"');
    expect(setup).toContain('MONOREPO_GHOSTTY_DIR="$MONOREPO_ROOT/vendor/ghostty"');
    expect(setup).toContain("Embedded apps/macos/ghostty tree is incomplete; using monorepo vendor/ghostty");
    expect(setup).toContain('git -C "$MONOREPO_ROOT" rev-parse HEAD:vendor/ghostty');
    expect(vendorBuild).toContain('b.step("cli-helper", "Build the Ghostty CLI helper")');
    expect(vendorBuild).toContain("cli_helper_step.dependOn(&exe.install_step.step);");
    expect(helper).toContain("-Dxcframework-target=universal");
    expect(helper).toContain("-Demit-macos-app=false");
    expect(vendorHeader).toContain("ghostty_surface_select_cursor_cell");
    expect(vendorHeader).toContain("ghostty_surface_clear_selection");
    expect(vendorSurface).toContain("pub fn selectCursorCell(self: *Surface) !bool");
    expect(vendorEmbedded).toContain("export fn ghostty_surface_select_cursor_cell(surface: *Surface) bool");
    expect(vendorEmbedded).toContain("export fn ghostty_surface_clear_selection(surface: *Surface) bool");
  });
});

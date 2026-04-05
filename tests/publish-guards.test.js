import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

describe("publish workflow guards", () => {
  it("keeps WWDR certificate install non-fatal on GitHub-hosted macOS runners", () => {
    const workflow = readRepoFile(".github/workflows/publish.yml");
    expect(workflow).toMatch(
      /sudo security add-certificates -k \/Library\/Keychains\/System\.keychain AppleWWDRCAG3\.cer \|\| true/,
    );
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

  it("uses a virtualenv when configuring TestFlight distribution", () => {
    const workflow = readRepoFile(".github/workflows/publish.yml");
    expect(workflow).toContain('python3 -m venv "$RUNNER_TEMP/asc-venv"');
    expect(workflow).toContain('source "$RUNNER_TEMP/asc-venv/bin/activate"');
    expect(workflow).toContain("python -m pip install PyJWT cryptography");
  });

  it("fails the macOS publish job if the release assets were not uploaded", () => {
    const workflow = readRepoFile(".github/workflows/publish.yml");
    expect(workflow).toContain("Verify macOS release assets");
    expect(workflow).toContain("Missing release asset:");
    expect(workflow).toContain('gh release view "$TAG" --repo "$GITHUB_REPOSITORY" --json assets');
  });

  it("uses strict shell handling when updating the Homebrew tap", () => {
    const workflow = readRepoFile(".github/workflows/publish.yml");
    expect(workflow).toMatch(/- name: Update Homebrew formula and cask[\s\S]*set -euo pipefail/);
    expect(workflow).toContain('curl -fsSL "$DMG_URL" -o "$DMG_PATH"');
    expect(workflow).toContain('curl -fsSL "$NPM_URL" -o "$NPM_PATH"');
  });

  it("runs the public release gate after publish jobs finish", () => {
    const workflow = readRepoFile(".github/workflows/publish.yml");
    expect(workflow).toMatch(/release-gate:[\s\S]*needs: \[npm, docker, ios, macos, homebrew\]/);
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
});

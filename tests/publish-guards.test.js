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
});

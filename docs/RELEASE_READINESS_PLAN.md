# Public Release Readiness Plan

Status date: 2026-04-05

## New Definition

Remux can only be described as "release-ready" when every official user-facing surface is both healthy and directly accessible to users without source builds.

Current official surfaces:

- Web / browser shell
- npm / CLI
- macOS client

Adjacent but non-gated repository surfaces:

- `apps/ios/` remains in-repo, but it is not part of the current public release-ready definition until a real public distribution channel is intentionally restored.

## Current Verified State

### Healthy now

- `dev` web deployment is live and reachable
- `dev` CI, deploy, and prerelease publication are green
- the Node.js + ghostty-web + direct PTY web path is internally coherent

### Blocking gaps

1. macOS direct-download path is broken
   - `apps/macos/README.md` points to `manaflow-ai/remux` DMG links that currently return 404
   - the current GitHub repo does not yet expose a public macOS release asset
   - the documented Homebrew cask path is not available

2. Release gate automation still focuses on code health more than user installability
   - CI and deploy prove build, test, deploy, and prerelease correctness
   - they do not yet fail on broken macOS download links or missing public release assets

3. Documentation does not yet provide one canonical "download and try every official surface" entrypoint
   - root docs describe the web path clearly
   - native install docs remain inconsistent with the current repository and release topology

## Repair Plan

### Phase 1. Lock the new release definition into authority docs

- update `AGENTS.md` so "merge to dev" and "release-ready" are explicitly separated
- update `docs/TESTING.md` so merge gate and release gate are distinct concepts
- keep this plan indexed in `docs/ACTIVE_DOCS_INDEX.md`

Exit criteria:

- nobody can honestly call Remux "release-ready" while any official surface still lacks a working direct-experience path

### Phase 2. Repair macOS public distribution

- decide the canonical macOS release home under `yaoshenwang/remux`
- produce a signed macOS artifact through the native release pipeline
- publish the DMG to GitHub Releases in the current repository
- move Homebrew updates behind a follow-on workflow instead of coupling them into the primary publish job
- fix stable and nightly download links in `apps/macos/README.md` and root docs
- verify install -> launch -> connect on a clean macOS user path

Exit criteria:

- a user can click one official link, download the macOS app, install it, and connect without building from source

### Phase 3. Adopt cmux-style stable release orchestration

- add an immutable release-asset guard so partial GitHub Releases fail fast
- keep the stable publish focused on npm + macOS release assets
- let Homebrew update only after the stable publish succeeds
- remove the iOS publish path from the stable release workflow

Exit criteria:

- stable release publication cannot silently leave a half-populated GitHub Release
- Homebrew no longer races release asset upload timing

### Phase 4. Add public-surface release gates

- add automated checks for public release assets and documented download URLs
- add a clean-environment npm install and startup verification
- keep web smoke and deploy verification in place
- require sign-off for web, npm, and macOS before promotion to `main`

- a broken download link, missing asset, or missing official install path blocks promotion

### Phase 5. Promote only after all surfaces pass

- rerun the full all-surface checklist on `dev`
- promote `dev` to `main`
- rerun smoke checks against the production endpoints and official download/install paths

Exit criteria:

- `main` represents a state where every official surface is directly usable by end users

## Immediate Next Work

1. Repair macOS release distribution first, because that surface is confirmed present in-repo but currently has broken public install links.
2. Restructure stable publication around the cmux-style release guard plus post-publish Homebrew update.
3. Add release-asset and install-path checks third, so the same gap cannot recur silently.

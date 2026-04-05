# All-Surface Release Readiness Plan

Status date: 2026-04-05

## New Definition

Remux can only be described as "release-ready" when every official user-facing surface is both healthy and directly accessible to users without source builds.

Current official surfaces:

- Web / browser shell
- npm / CLI
- macOS client
- iOS client

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

2. iOS public install path is not surfaced to users
   - the repository contains an iOS app and a TestFlight upload pipeline
   - the repository does not yet document a current user-facing install entry, invite flow, or acceptance check for that surface

3. Release gate automation still focuses on code health more than user installability
   - CI and deploy prove build, test, deploy, and prerelease correctness
   - they do not yet fail on broken macOS download links, missing iOS install entry, or missing public release assets

4. Documentation does not yet provide one canonical "download and try every official surface" entrypoint
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
- either restore a working Homebrew cask flow or remove Homebrew from user docs until restored
- fix stable and nightly download links in `apps/macos/README.md` and root docs
- verify install -> launch -> connect on a clean macOS user path

Exit criteria:

- a user can click one official link, download the macOS app, install it, and connect without building from source

### Phase 3. Repair iOS direct experience

- confirm the official iOS distribution channel: TestFlight external beta or App Store
- validate the existing TestFlight/App Store Connect pipeline against the chosen channel
- publish one canonical install entry in active docs
- run a real install -> first launch -> connect/attach check against the current server
- document any required invite, token, or pairing bootstrap so the user journey is complete

Exit criteria:

- a user can install the iOS client through the documented official channel and reach a working first-run experience

### Phase 4. Add all-surface release gates

- add automated checks for public release assets and documented download URLs
- add a clean-environment npm install and startup verification
- keep web smoke and deploy verification in place
- add a release checklist that requires sign-off for web, npm, macOS, and iOS before promotion to `main`

Exit criteria:

- a broken download link, missing asset, or missing official install path blocks promotion

### Phase 5. Promote only after all surfaces pass

- rerun the full all-surface checklist on `dev`
- promote `dev` to `main`
- rerun smoke checks against the production endpoints and official download/install paths

Exit criteria:

- `main` represents a state where every official surface is directly usable by end users

## Immediate Next Work

1. Repair macOS release distribution first, because that surface is confirmed present in-repo but currently has broken public install links.
2. Surface the iOS install path second, because the build pipeline exists but the user-facing entry is still missing.
3. Add release-asset and install-path checks third, so the same gap cannot recur silently.

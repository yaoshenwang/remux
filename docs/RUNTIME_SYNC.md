# Runtime Sync

This repository now includes a dedicated runtime sync path for keeping the long-running `main` and `dev` instances aligned with `origin/main` and `origin/dev`.

## Why

The previous setup only restarted services when local files changed. It did not prove that the running process matched the remote branch tip, and the `dev` instance could drift if it ran directly from an actively edited working tree.

The new runtime flow fixes that by:

- exposing `version`, `gitBranch`, `gitCommitSha`, and `gitDirty` from `/api/config`
- deploying from dedicated detached runtime worktrees instead of the live editing tree
- polling `origin/main` and `origin/dev`, fast-forwarding runtime worktrees, and rebuilding only from those refs
- verifying the local and public `/api/config` responses after each sync

## Runtime Layout

- `main` runtime worktree: `.worktrees/runtime-main`
- `dev` runtime worktree: `.worktrees/runtime-dev`
- local services:
  - `com.remux.main`
  - `com.remux.dev`
- sync service:
  - `com.remux.runtime-sync`

## Install

Generate the launch agents:

```bash
npm run runtime:install-launchd
```

Then load them:

```bash
launchctl bootout gui/$(id -u)/com.remux.main 2>/dev/null || true
launchctl bootout gui/$(id -u)/com.remux.dev 2>/dev/null || true
launchctl bootout gui/$(id -u)/com.remux.runtime-sync 2>/dev/null || true

launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/com.remux.main.plist"
launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/com.remux.dev.plist"
launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/com.remux.runtime-sync.plist"
```

## Manual Commands

Check current alignment:

```bash
npm run runtime:status
```

Force a one-shot sync:

```bash
npm run runtime:sync
```

Dry-run a sync:

```bash
scripts/sync-runtime.sh all --dry-run
```

## Operational Rules

- do not make manual edits inside `.worktrees/runtime-main` or `.worktrees/runtime-dev`
- if `runtime:status` shows `dirty=true`, treat that instance as out of policy
- if `runtime:status` shows a branch or SHA mismatch, run `runtime:sync`
- if launchd plists still point at the root repo or `.worktrees/main`, rerun `runtime:install-launchd`

## Next Upgrade

If you want push-triggered deploys instead of 60-second polling, the next step is a GitHub Actions self-hosted runner on this same machine. The recommended pattern is:

- trigger on `push` to `main` and `dev`
- use separate GitHub environments for production and development
- use workflow `concurrency` so each environment deploy stays single-flight
- call `scripts/sync-runtime.sh main --verify-public` or `scripts/sync-runtime.sh dev --verify-public`

That second stage is now wired through [docs/SELF_HOSTED_RUNNER.md](./SELF_HOSTED_RUNNER.md) and [deploy-runtime.yml](../.github/workflows/deploy-runtime.yml).

# Runtime Sync

This repository now includes a dedicated runtime sync path for keeping the long-running `main` and `dev` instances aligned with `origin/main` and `origin/dev`.

## Why

The previous setup only restarted services when local files changed. It did not prove that the running process matched the remote branch tip, and the `dev` instance could drift if it ran directly from an actively edited working tree.

The new runtime flow fixes that by:

- exposing `version`, `gitBranch`, `gitCommitSha`, and `gitDirty` from `/api/config`
- deploying from dedicated detached runtime worktrees instead of the live editing tree
- polling `origin/main` and `origin/dev`, fast-forwarding runtime worktrees, and rebuilding only from those refs
- verifying the local and public `/api/config` responses after each sync
- keeping a shared machine-level `remuxd` daemon alive across `main` / `dev` gateway restarts so both public URLs attach to the same runtime-v2 workspace truth
- separating the shared runtime core into its own detached worktree so `dev` gateway deploys do not mutate the shared daemon by default
- requiring an explicit promote step before the shared core moves to a newer `dev` SHA, with attach healthchecks and automatic rollback on failure
- blocking shared-core promotion when the target runtime-v2 protocol contract does not match the `main` or `dev` gateway source contract
- writing a promote report with before/target/after shared-runtime state under `$HOME/.remux/reports/`

## Runtime Layout

- runtime worktree root: `$HOME/.remux/runtime-worktrees`
- `main` runtime worktree: `$HOME/.remux/runtime-worktrees/runtime-main`
- `dev` runtime worktree: `$HOME/.remux/runtime-worktrees/runtime-dev`
- shared runtime core worktree: `$HOME/.remux/runtime-worktrees/runtime-shared`
- local services:
  - `com.remux.runtime-v2-shared`
  - `com.remux.main`
  - `com.remux.dev`
- sync service:
  - `com.remux.runtime-sync`

## Install

Generate the launch agents:

```bash
npm run runtime:install-launchd
```

Then sync once to create the detached worktrees, install dependencies, build the runtime, and restart the services:

```bash
npm run runtime:sync
npm run runtime:promote-shared
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

Promote the shared runtime core to the current `origin/dev` SHA:

```bash
npm run runtime:promote-shared
```

Every explicit shared-core promote prints a short compatibility summary and writes a JSON report to `$HOME/.remux/reports/shared-runtime-promote-<timestamp>.json`.

Dry-run a sync:

```bash
scripts/sync-runtime.sh all --dry-run
```

## Operational Rules

- do not make manual edits inside `$HOME/.remux/runtime-worktrees/runtime-main`, `$HOME/.remux/runtime-worktrees/runtime-dev`, or `$HOME/.remux/runtime-worktrees/runtime-shared`
- public `main` and `dev` must stay on the shared local `remuxd` daemon instead of spawning per-version private runtimes
- ordinary `dev` syncs may update the `dev` gateway only; they do not automatically replace the shared runtime core
- only explicit shared-core promotion is allowed to move `com.remux.runtime-v2-shared` forward
- shared-core promotion must keep the target runtime protocol identical to the `main` and `dev` gateway contracts; mismatched promotes are blocked before restart
- if `runtime:status` shows `dirty=true`, treat that instance as out of policy
- if `runtime:status` shows a branch or SHA mismatch, run `runtime:sync`
- if launchd plists still point at the root repo checkout or `.worktrees/main`, rerun `runtime:install-launchd`

## Next Upgrade

If you want push-triggered deploys instead of 60-second polling, the next step is a GitHub Actions self-hosted runner on this same machine. The recommended pattern is:

- trigger on `push` to `main` and `dev`
- use separate GitHub environments for production and development
- use workflow `concurrency` so each environment deploy stays single-flight
- call `scripts/sync-runtime.sh main --verify-public` or `scripts/sync-runtime.sh dev --verify-public`
- call `scripts/sync-runtime.sh dev --verify-public --promote-shared-runtime` only when you explicitly want to advance the shared runtime core

That second stage is now wired through [docs/SELF_HOSTED_RUNNER.md](./SELF_HOSTED_RUNNER.md) and [deploy-runtime.yml](../.github/workflows/deploy-runtime.yml).

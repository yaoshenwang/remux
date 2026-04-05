# Remux Testing Guide

Remux's current product path is the Node.js gateway plus direct PTY runtime. The default test loop should optimize for fast TypeScript feedback and browser behavior.

## Quick Loop

Use the smallest meaningful loop while iterating:

```bash
pnpm run typecheck
pnpm test
pnpm run build
```

What each command covers:

- `pnpm run typecheck`: backend and frontend TypeScript compile safety
- `pnpm test`: rebuilds the server bundle first, then runs Vitest coverage for gateway, runtime, persistence, and browser behavior
- `pnpm run build`: produces the backend output and frontend bundle used by the packaged CLI

## Browser Check

When a change touches browser transport, terminal rendering, inspect output, upload behavior, auth, or resize handling, also run:

```bash
pnpm run test:e2e
```

Notes:

- `pnpm run test:e2e` is the Playwright smoke pass shipped in this repository
- CI on `dev` / `main` also runs this browser smoke job before prerelease / release publication
- some local harness file names still carry legacy naming; treat that as harness internals, not as the current product contract

## Merge Gate

Before merging to `dev`, the required gate is:

```bash
pnpm run typecheck && pnpm test && pnpm run build
```

Add `pnpm run test:e2e` when the change affects frontend or transport behavior.

## Release Static Checks

When a change touches packaging, official install docs, native release automation, or promotion-to-`main` policy, also run:

```bash
pnpm run verify:package-smoke
pnpm run verify:release-readiness:docs
```

What these commands cover:

- `pnpm run verify:package-smoke`: builds the package, installs the packed tarball into a clean temp directory, launches the CLI, and probes the served UI
- `pnpm run verify:release-readiness:docs`: confirms active docs point to the canonical public entrypoints
- `pnpm run verify:release-readiness`: checks the hosted web shell, the published npm `latest` install/startup path, and GitHub release assets (DMG, appcast, remote daemon binaries + manifest)

## Release Gate

Passing the merge gate is not enough to call Remux "release-ready".

Remux is only release-ready when every official user-facing surface is both healthy and directly installable or reachable without source builds:

- Web / browser shell
- npm / CLI
- macOS client

That means a release-ready state must include:

- a working public web entrypoint with a verified first-run path
- a working `npx @wangyaoshen/remux` install and startup path
- a working official macOS install path such as a signed DMG
- active documentation links that resolve to the real install or usage paths users need

If any official surface lacks a current download path, public install route, or directly usable first-run experience, the repository may be merge-ready but it is not release-ready.

The public release gate command is:

```bash
pnpm run verify:release-readiness
```

That command verifies the current public Web, npm, and macOS entrypoints, including the active GitHub release assets, the npm `latest` package, and the canonical docs entry.

The stable publish workflow must end with the same public gate. A green build or deploy job is not sufficient if the public npm install path or GitHub release assets are still broken.

The Homebrew tap is updated by a follow-on workflow after stable publish succeeds. It remains a convenience path, not the canonical release-ready gate.

## Native Dependency Note

`better-sqlite3` and `node-pty` are native modules. This repository is pinned to Node 24. If local verification fails with an ABI mismatch, rerun the test loop with Node 24 or reinstall native dependencies for your active Node 24 toolchain.

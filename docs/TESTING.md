# Remux Testing Guide

Remux now treats the unified `runtime-v2` path as the only default product contract.

The default test loop should therefore optimize for:

- fast TypeScript and frontend/backend contract feedback
- runtime-v2 browser behavior
- explicit terminal width validation
- minimal high-cost harness coverage

Legacy `tmux` / `zellij` / `conpty` suites are transitional and are no longer part of the default CI path or the default `npm test` path.
The default `npm run build` also skips the legacy `zellij-bridge` compile, which keeps normal iteration materially shorter.

## Quick Loop

Use the smallest meaningful loop while iterating:

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e:functional
```

What each command covers:

- `npm run typecheck`: TypeScript compile safety for backend and frontend
- `npm test`: runtime-v2 and product-core Vitest coverage only; compatibility suites are excluded by design
- `npm run build`: produces the frontend bundle used by Playwright harnesses
- `npm run test:e2e:functional`: narrow runtime-v2 browser contract checks against the fake runtime-v2 upstream

If you have not changed the frontend bundle since the last successful build, you can usually skip rerunning `npm run build` and execute the targeted Playwright command directly.

## Browser Suites

The browser harness is intentionally narrow.

```bash
npm run test:e2e:functional
npm run test:e2e:width
npm run test:e2e:screenshots
```

- `test:e2e:functional`: runtime-v2 browser contract tests only
- `test:e2e:width`: explicit terminal width invariant checks; this is the required width gate before merging to `dev`
- `test:e2e:screenshots`: PR-only screenshot capture for visual review

## Merge Gate

Before merging to `dev`, run the full runtime-v2 gate:

```bash
npm run test:gate
```

That expands to:

```bash
npm run typecheck
npm test
npm run native:v2:check
npm run build
npm run test:e2e
```

## Release Gate

For a release-ready pass:

```bash
npm run test:release
```

This adds:

- screenshot capture for PR/release review
- `npm pack --dry-run` package verification

## Legacy Compatibility Coverage

These paths remain available only for migration and debugging work:

```bash
npm run test:legacy
npm run test:e2e:legacy-ui
npm run test:legacy:tmux-smoke
npm run build:legacy:zellij-bridge
```

They are intentionally excluded from the default CI workflow so the normal feedback loop stays focused and short.

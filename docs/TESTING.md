# Remux Testing Guide

Remux now treats the unified `runtime-v2` path as the primary product contract.

The default test loop should therefore optimize for:

- fast TypeScript and frontend/backend contract feedback
- runtime-v2 browser behavior
- explicit terminal width validation
- minimal high-cost harness coverage

Legacy `tmux` / `zellij` / `conpty` suites are transitional and are no longer part of the default CI path.
The default `npm run build` also skips the legacy `zellij-bridge` compile, which keeps normal iteration materially shorter.

## Default Loop

Run these in normal day-to-day iteration:

```bash
npm run typecheck
npm test
npm run native:v2:check
npm run test:e2e
```

What each command covers:

- `npm run typecheck`: TypeScript compile safety for backend and frontend
- `npm test`: fast Vitest unit and integration coverage, including runtime-v2 gateway translation
- `npm run native:v2:check`: compile sanity for the Rust runtime workspace
- `npm run test:e2e`: targeted runtime-v2 browser contract tests plus the width suite

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

## Release Gate

Before merging to `dev`, the required baseline is:

```bash
npm run typecheck
npm test
npm run native:v2:check
npm run build
npm run test:e2e:width
```

If the change touches runtime-v2 browser behavior, run:

```bash
npm run test:e2e:functional
```

## Transitional Legacy Coverage

These paths remain available only for migration and debugging work:

```bash
npm run test:legacy:tmux-smoke
npm run build:legacy:zellij-bridge
```

They are intentionally excluded from the default CI workflow so the normal feedback loop stays focused and short.

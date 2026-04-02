# Current Baseline

Remux currently ships as a ghostty-web-backed remote terminal workspace. The production path is:

1. a Node.js + TypeScript gateway
2. a browser shell served by the gateway
3. direct shell / PTY tabs with optional detached daemon persistence

The repository should be read through that baseline first. Historical runtime experiments and transition documents are archived and do not define current behavior.

## Shipping Path

| Layer | Current implementation | Key entrypoints |
| --- | --- | --- |
| Package / CLI | npm package `@wangyaoshen/remux` | `package.json`, `build.mjs`, `src/server.ts` |
| Backend gateway | Node.js + TypeScript + `ws` | `src/server.ts`, `src/ws-handler.ts`, `src/auth.ts`, `src/service.ts` |
| Runtime substrate | `node-pty` direct shell tabs + detached PTY daemon | `src/session.ts`, `src/pty-daemon.ts`, `src/vt-tracker.ts` |
| Browser shell | inline HTML/JS + ghostty-web assets | `src/server.ts`, `ghostty-web` package assets |
| Persistence / workspace | SQLite store, device trust, push, search, workspace objects | `src/store.ts`, `src/push.ts`, `src/workspace.ts`, `src/workspace-head.ts` |
| Native surfaces | adjacent iOS and macOS apps in-repo | `apps/ios/`, `apps/macos/` |
| Tests | Vitest + Playwright | `tests/*.test.js`, `tests/e2e/app.spec.js` |
| Documentation | repo root README + `docs/` active index | `README.md`, `docs/README.md`, `docs/SPEC.md`, `docs/TESTING.md` |

## Current Product Surfaces

- `Inspect`: readable workspace history and catch-up surface
- `Live`: raw terminal interaction surface
- `Control`: structured workspace navigation and mutation surface

## What Is Current

- The checked-in source layout is still centered on the root `src/` tree.
- The gateway is implemented in Node.js and TypeScript.
- The browser remains the primary shipped client surface for the npm package.
- Session runtime truth is managed through PTYs, persistence, and detached daemons in the current codebase.
- Native iOS and macOS shells exist in-repo, but they are adjacent surfaces rather than the npm package entrypoint.
- The repository merge gate is `npm run typecheck && npm test && npm run build`.

## What Is Not Current

- The old `src/backend/` and `src/frontend/` split is not the current checked-in layout.
- A standalone React + Vite web package is not the current browser implementation at this HEAD.
- Archived runtime research is not the active implementation path.
- Rust sidecars remain research or future platform work until explicitly promoted by code and docs.

## Fast Orientation

If you are new to the repository, read these in order:

1. `README.md`
2. `docs/CURRENT_BASELINE.md`
3. `docs/SPEC.md`
4. `docs/TESTING.md`
5. `docs/ACTIVE_DOCS_INDEX.md`

## Validation Commands

```bash
npm run typecheck
npm test
npm run build
```

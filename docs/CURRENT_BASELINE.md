# Current Baseline

Remux currently ships from a single GPL monorepo with a ghostty-web-backed remote terminal workspace at the root. The primary production path is:

1. a Node.js + TypeScript gateway
2. a browser shell served by the gateway
3. direct shell / PTY tabs with optional detached daemon persistence

The repository should be read through that baseline first. Historical runtime experiments and transition documents are archived and do not define current behavior.

## Shipping Path

| Layer | Current implementation | Key entrypoints |
| --- | --- | --- |
| Package / CLI | npm package `@wangyaoshen/remux` | `package.json`, `build.mjs`, `src/cli/remux-server.ts` |
| Backend gateway | Node.js + TypeScript + `ws` | `src/cli/remux-server.ts`, `src/gateway/ws/websocket-server.ts`, `src/domain/auth/auth-service.ts`, `src/integrations/macos/launchd-service.ts` |
| Runtime substrate | `node-pty` direct shell tabs + detached PTY daemon | `src/runtime/session-runtime.ts`, `src/runtime/pty-daemon.ts`, `src/runtime/vt-snapshot.ts` |
| Browser shell | inline HTML/JS + ghostty-web assets | `src/cli/remux-server.ts`, `ghostty-web` package assets |
| Persistence / workspace | SQLite store, device trust, push, search, workspace objects | `src/persistence/store.ts`, `src/integrations/push/push-service.ts`, `src/domain/workspace/workspace-service.ts`, `src/domain/workspace/workspace-head.ts` |
| Native surfaces | adjacent iOS and macOS apps in-repo | `apps/ios/`, `apps/macos/` |
| Tests | Vitest + Playwright | `tests/*.test.js`, `tests/e2e/app.spec.js` |
| Documentation | repo root README + `docs/` active index | `README.md`, `docs/README.md`, `docs/SPEC.md`, `docs/TESTING.md` |

## Current Product Surfaces

- `Inspect`: readable workspace history and catch-up surface
- `Live`: raw terminal interaction surface
- `Control`: structured workspace navigation and mutation surface

## What Is Current

- The source tree is organized by responsibility under `src/cli`, `src/gateway`, `src/runtime`, `src/persistence`, `src/domain`, and `src/integrations`.
- The gateway is implemented in Node.js and TypeScript.
- The browser remains the primary shipped client surface for the npm package.
- Session runtime truth is managed through PTYs, persistence, and detached daemons in the current codebase.
- Native iOS and macOS shells exist in-repo; `apps/macos/` and `apps/ios/` consume the same server truth rather than defining it.
- `labs/` contains non-shipping or historical lines and is not part of the current product contract.
- The repository merge gate is `npm run typecheck && npm test && npm run build`.

## Current Source Map

```text
src/
  cli/
  gateway/
  runtime/
  persistence/
  domain/
  integrations/

apps/
  ios/
  macos/

packages/
  RemuxKit/

labs/
  discovery-service/
  protocol-goldens/
  team-mode/
  tui/
```

## What Is Not Current

- The old flat `src/*.ts` root-module layout is no longer the architecture authority.
- A standalone React + Vite web package is not the current browser implementation at this HEAD.
- Archived runtime research is not the active implementation path.
- `labs/` content does not define current runtime or client behavior.

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

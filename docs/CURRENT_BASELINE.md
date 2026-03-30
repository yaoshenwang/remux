# Current Baseline

Remux currently ships as a Zellij-backed remote workspace cockpit. The production path is:

1. a Node.js + TypeScript gateway
2. a React web shell
3. Zellij as the shared workspace runtime

The repository should be read through that baseline first. Historical runtime experiments and transition documents are archived and do not define current behavior.

## Shipping Path

| Layer | Current implementation | Key entrypoints |
| --- | --- | --- |
| Package / CLI | npm package `remux` | `package.json`, `src/backend/cli-zellij.ts` |
| Backend gateway | Node.js + TypeScript + Express + `ws` | `src/backend/server-zellij.ts`, `src/backend/auth/`, `src/backend/extensions.ts` |
| Runtime substrate | Zellij + `node-pty` attach clients | `src/backend/zellij-controller.ts`, `src/backend/pty/zellij-pty.ts` |
| Frontend shell | React + Vite + xterm.js | `src/frontend/App.tsx`, `src/frontend/hooks/` |
| Tests | Vitest + Playwright | `tests/backend/`, `tests/frontend/`, `tests/e2e/` |
| Documentation | repo root README + `docs/` active index | `README.md`, `docs/README.md`, `docs/SPEC.md`, `docs/TESTING.md` |

## Current Product Surfaces

- `Inspect`: readable workspace history and catch-up surface
- `Live`: raw terminal interaction surface
- `Control`: structured workspace navigation and mutation surface

## What Is Current

- Zellij is the only public runtime substrate.
- The gateway is implemented in Node.js and TypeScript.
- The browser remains the shipping client surface.
- Tunnel support is an access layer, not a second runtime.
- The repository merge gate is `npm run typecheck && npm test && npm run build`.

## What Is Not Current

- Archived runtime research is not the active implementation path.
- Desktop host work is not yet the shipping surface.
- Native mobile shells are roadmap work, not the present baseline.
- Rust sidecars remain research or future platform work until explicitly promoted by an ADR and code.

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


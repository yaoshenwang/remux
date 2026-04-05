# Remux Documentation

This directory is organized around the current Node.js gateway plus direct-PTY product line.

Start here:

- [CURRENT_BASELINE.md](./CURRENT_BASELINE.md): the fastest way to understand the shipping architecture
- [ACTIVE_DOCS_INDEX.md](./ACTIVE_DOCS_INDEX.md): authority map for active, draft, and archived documents
- [OFFICIAL_SURFACES.md](./OFFICIAL_SURFACES.md): canonical public Web, npm, macOS, and iOS entrypoints
- [SPEC.md](./SPEC.md): current transport, API, and surface specification
- [TESTING.md](./TESTING.md): current validation loop and merge gate
- [GLOSSARY.md](./GLOSSARY.md): canonical product and runtime terminology
- [adr/ADR_TERMINOLOGY.md](./adr/ADR_TERMINOLOGY.md): canonical surface vocabulary and banned product terms

## Current Authority

Use these documents as implementation references:

- `README.md` for product positioning and quick start
- `docs/OFFICIAL_SURFACES.md` for public install and download truth
- `docs/CURRENT_BASELINE.md` for architecture truth
- `docs/SPEC.md` for the current protocol and API surface
- `docs/TESTING.md` for the active quality gate
- `docs/adr/*.md` for active terminology and naming constraints
- `docs/ACTIVE_DOCS_INDEX.md` for authority classification before following any draft or archived doc

## Draft / Planning

These documents drive upcoming work, but they do not override shipped behavior until code and active docs agree:

- [remux-master-plan-2026-v2.md](./remux-master-plan-2026-v2.md)
- [ROADMAP_SCOPE.md](./ROADMAP_SCOPE.md)
- [REPO_EVOLUTION_PLAN.md](./REPO_EVOLUTION_PLAN.md)

## Superseded Material

Archived documents are preserved for context only. They are not current implementation authority.

- [archive/README.md](./archive/README.md)
- [decisions/ADR-0001-zellij-era.md](./decisions/ADR-0001-zellij-era.md)
- [decisions/ADR-0002-desktop-host.md](./decisions/ADR-0002-desktop-host.md)
- [decisions/ADR-0003-tauri-shell-alpha.md](./decisions/ADR-0003-tauri-shell-alpha.md)

## Directory Skeleton

- [architecture/README.md](./architecture/README.md)
- [product/README.md](./product/README.md)
- [protocols/README.md](./protocols/README.md)
- [native/README.md](./native/README.md)
- [epics/README.md](./epics/README.md)
- [adr/README.md](./adr/README.md)

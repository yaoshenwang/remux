# Active Docs Index

This index classifies repository documents by authority level so implementation work does not accidentally follow superseded material.

## Authority Levels

- `Active`: current implementation authority
- `Draft`: planning or migration guidance; does not override shipped behavior on its own
- `Archive`: preserved for context only

## Active

| Document | Authority | Purpose |
| --- | --- | --- |
| `README.md` | Active | Product positioning, installation, quick start |
| `docs/README.md` | Active | Documentation entrypoint and routing |
| `docs/OFFICIAL_SURFACES.md` | Active | Canonical public download and install entrypoints |
| `docs/CURRENT_BASELINE.md` | Active | Current shipping architecture truth |
| `docs/licensing.md` | Active | Repository-wide GPL and third-party licensing rules |
| `docs/SPEC.md` | Active | Current transport, API, and surface spec |
| `docs/TESTING.md` | Active | Merge gate and test loops |
| `docs/GLOSSARY.md` | Active | Canonical terms used across product and engineering |
| `docs/adr/ADR_TERMINOLOGY.md` | Active | Canonical product vocabulary and banned product terms |

## Draft

| Document | Authority | Purpose |
| --- | --- | --- |
| `docs/remux-master-plan-2026-v2.md` | Draft | Strategic plan and epic checklist for upcoming work |
| `docs/ROADMAP_SCOPE.md` | Draft | Scope boundaries and roadmap thinking; does not override current source layout |
| `docs/REPO_EVOLUTION_PLAN.md` | Draft | Historical repo-evolution notes kept for planning context |
| `docs/RELEASE_READINESS_PLAN.md` | Draft | All-surface release-readiness definition and repair plan |
| `docs/LEGACY_PLAN_GAPS.md` | Draft | Mapping between old assumptions and current reality |
| `docs/TERMINOLOGY_AUDIT.md` | Draft | Audit record for archived-runtime terms and exceptions |

## Archive

| Document set | Authority | Purpose |
| --- | --- | --- |
| `docs/archive/README.md` | Archive | Archive index and navigation |
| `docs/archive/runtime-v2/` | Archive | Historical plans, guides, and transition documents |
| `docs/decisions/ADR-0001-zellij-era.md` | Archive | Superseded runtime decision kept for history |
| `docs/decisions/ADR-0002-desktop-host.md` | Archive | Superseded desktop-host evaluation kept for decision history |
| `docs/decisions/ADR-0003-tauri-shell-alpha.md` | Archive | Superseded desktop-shell exploration kept for context |

## How To Use This Index

- When code and a draft disagree, follow the active docs and the current code.
- When an archive doc and an active doc disagree, the archive doc loses automatically.
- If a change needs to overturn an active document, write or update an ADR first.

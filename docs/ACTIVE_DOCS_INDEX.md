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
| `docs/CURRENT_BASELINE.md` | Active | Current shipping architecture truth |
| `docs/SPEC.md` | Active | Current transport, API, and surface spec |
| `docs/TESTING.md` | Active | Merge gate and test loops |
| `docs/GLOSSARY.md` | Active | Canonical terms used across product and engineering |
| `docs/ROADMAP_SCOPE.md` | Active | Scope boundaries for v1, v1.5, and research work |
| `docs/REPO_EVOLUTION_PLAN.md` | Active | Incremental repo evolution path |
| `docs/decisions/ADR-0001-zellij-era.md` | Active | Runtime substrate decision |
| `docs/decisions/ADR-0002-desktop-host.md` | Active | Desktop host decision and reevaluation trigger |

## Draft

| Document | Authority | Purpose |
| --- | --- | --- |
| `docs/remux-zellij-master-plan-2026-v2.md` | Draft | Strategic plan and epic checklist for upcoming work |
| `docs/LEGACY_PLAN_GAPS.md` | Draft | Mapping between old assumptions and current reality |
| `docs/TERMINOLOGY_AUDIT.md` | Draft | Audit record for archived-runtime terms and exceptions |

## Archive

| Document set | Authority | Purpose |
| --- | --- | --- |
| `docs/archive/README.md` | Archive | Archive index and navigation |
| `docs/archive/runtime-v2/` | Archive | Historical plans, guides, and transition documents |

## How To Use This Index

- When code and a draft disagree, follow the active docs and the current code.
- When an archive doc and an active doc disagree, the archive doc loses automatically.
- If a change needs to overturn an active document, write or update an ADR first.


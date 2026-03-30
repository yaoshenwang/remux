# Terminology Audit

Date: 2026-03-31

This audit records archived-runtime terminology that was scanned across active repository paths and explains what was renamed versus what remains as an intentional exception.

## Scan Scope

- `README.md`
- `AGENTS.md`
- `docs/` excluding `docs/archive/`
- `src/`
- `tests/`
- `.github/`

## Renamed During Z01

| Path | Change |
| --- | --- |
| `tests/e2e/harness/runtime-v2-server.ts` | Renamed to `tests/e2e/harness/zellij-e2e-server.ts` |
| `RuntimeV2E2EServer*` symbols | Renamed to `ZellijE2EServer*` |
| `docs/archive/legacy-guides/*` | Moved to `docs/archive/runtime-v2/guides/` |
| `docs/archive/legacy-roadmaps/*` | Moved to `docs/archive/runtime-v2/roadmaps/` |

## Intentional Exceptions

These files still mention archived-runtime terminology because the term itself is the subject of the document:

| Path | Reason |
| --- | --- |
| `docs/remux-zellij-master-plan-2026-v2.md` | Current planning document explicitly compares current reality to archived assumptions |
| `docs/LEGACY_PLAN_GAPS.md` | Explains which older assumptions no longer hold |
| `docs/TERMINOLOGY_AUDIT.md` | Audit record must name the archived terms it is tracking |

## Current Result

Active implementation docs, source files, tests, and workflows should no longer use archived-runtime terminology as if it described the shipping path. New occurrences outside the exception list fail the terminology guard.


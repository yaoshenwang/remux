# Legacy Plan Gaps

This document records where older planning assumptions diverged from the current repository, so nobody has to manually reconcile multiple generations of roadmap text.

## Invalidated Assumptions

| Old assumption | Current reality |
| --- | --- |
| A self-owned replacement runtime was already the active backbone | The shipping product is a Zellij-backed Node.js + TypeScript gateway |
| Desktop work should start from a rewritten runtime core | Desktop work must host the current gateway rather than block on a rewrite |
| Archive-era protocol drafts still describe the live system | `docs/SPEC.md` and the codebase define the current system |
| Repo evolution should start with immediate large-scale directory surgery | Boundary extraction comes before package splitting |

## Still Valid Themes

| Theme | Why it still matters |
| --- | --- |
| Cross-device continuity | Remains core to the product promise |
| Better inspectability than a raw terminal | Still a differentiator |
| Agent-facing workflow objects | Still a valid long-term direction |
| Multi-surface product thinking | Still necessary for web, desktop, and mobile |

## How To Use This File

- Use it when an older plan is cited during design review.
- Do not use it as a substitute for `docs/CURRENT_BASELINE.md`.
- If another legacy assumption is discovered, append it here with a concrete correction.


# Licensing

Remux is now maintained as a single GPL-3.0-or-later monorepo.

## Repository License

- The repository root is distributed under `GPL-3.0-or-later`.
- The root Node.js gateway, browser shell, and the imported macOS client under `apps/macos/` are released together under that GPL umbrella.
- Historical MIT distribution history is part of the repository history, but current HEAD should be treated as GPL-3.0-or-later for ongoing development and release work.

## Third-Party Code

- Third-party dependencies keep their own upstream licenses.
- Vendored and imported license notices must remain intact.
- The macOS client keeps additional third-party notices in `apps/macos/THIRD_PARTY_LICENSES.md`.
- The root runtime also depends on permissive third-party packages such as `ghostty-web`, `node-pty`, `ws`, and `web-push`; those upstream licenses remain in force for their respective code.

## Source Distribution

- Any published binary release should point back to the exact source revision in this repository.
- macOS release assets should be built from `apps/macos/` and distributed with a matching source tag or commit.
- Root npm releases and macOS releases should continue to use the same repository commit as the corresponding source reference.

## Practical Rules

- Do not remove or overwrite third-party `LICENSE`, `COPYING`, or notice files.
- When importing new third-party code, record its license before merging.
- If a future release needs a different licensing strategy, update this document and the root `LICENSE` together in the same change.

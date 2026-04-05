# Official Surfaces

This is the canonical "download and try every current official surface" entrypoint for Remux.

Remux can only be called release-ready when every surface below is directly usable without a source build.

## Stable Entrypoints

| Surface | Official entrypoint | First-run expectation |
| --- | --- | --- |
| Web / browser shell | https://remux.yaoshen.wang | Open the hosted login page, authenticate, and reach the workspace UI |
| npm / CLI | `npx @wangyaoshen/remux` | The CLI prints a local URL and serves the browser shell immediately |
| macOS client | https://github.com/yaoshenwang/remux/releases/latest/download/remux-macos.dmg | Download the signed DMG, drag `remux.app` into Applications, launch, and connect |

## Optional macOS Cask

Homebrew remains a convenience path, but the signed DMG above is the canonical release-ready gate.

When the follow-on Homebrew update workflow succeeds, the optional cask path is:

```bash
brew install --cask yaoshenwang/tap/remux-app
```

## Notes

- If any link above breaks, or any listed first-run path stops working, Remux is not release-ready.
- The optional Homebrew cask is updated after the main stable publish completes; it is not the canonical public release gate.
- The release gate script validates these public entrypoints with `pnpm run verify:release-readiness`.

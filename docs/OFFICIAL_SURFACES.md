# Official Surfaces

This is the canonical "download and try every official surface" entrypoint for Remux.

Remux can only be called release-ready when every surface below is directly usable without a source build.

## Stable Entrypoints

| Surface | Official entrypoint | First-run expectation |
| --- | --- | --- |
| Web / browser shell | https://remux.yaoshen.wang | Open the hosted login page, authenticate, and reach the workspace UI |
| npm / CLI | `npx @wangyaoshen/remux` | The CLI prints a local URL and serves the browser shell immediately |
| macOS client | https://github.com/yaoshenwang/remux/releases/latest/download/remux-macos.dmg | Download the signed DMG, drag `remux.app` into Applications, launch, and connect |
| macOS optional cask | `brew install --cask yaoshenwang/tap/remux-app` | Install the same signed macOS app through Homebrew |
| iOS client | https://testflight.apple.com/join/DhXZEKUU | Install through TestFlight, launch Remux, then use manual connect or QR pairing |

## iOS Bootstrap

The current official iOS channel is a public TestFlight beta.

Expected install flow:

1. Install TestFlight from the App Store if it is not already present.
2. Open the public invitation link above and accept the Remux beta.
3. Install Remux on iPhone or iPad.
4. On first launch, use one of the supported bootstrap paths:
   - scan a Remux pairing QR code
   - enter the server URL and token manually

## Notes

- If any link above breaks, or any listed first-run path stops working, Remux is not release-ready.
- The release gate script validates these public entrypoints with `pnpm run verify:release-readiness`.

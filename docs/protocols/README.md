# Protocol Docs

This directory is reserved for active protocol references, message contracts, and transport-level compatibility notes.

Only document protocol behavior that exists in the shipped product or is being introduced with matching code.

## Current Assets

- `schemas/`: machine-validated JSON Schema files for `core`, `runtime`, `inspect`, and `admin`.
- `tests/fixtures/protocol/`: golden payloads for both legacy and envelope wire formats.
- `native/ios/` and `native/android/`: cross-language protocol model sources used to sanity-check fixture decoding.

#!/usr/bin/env bash
set -euo pipefail

requested_identity="${REMUX_MACOS_SIGN_IDENTITY:-}"
available_identities="$(security find-identity -v -p codesigning)"

if [[ -n "$requested_identity" ]]; then
  matched_hash="$(
    printf '%s\n' "$available_identities" |
      awk -v requested="$requested_identity" '
        $0 ~ /Developer ID Application/ && ($2 == requested || index($0, requested) > 0) {
          print $2
          exit
        }
      '
  )"
  if [[ -z "$matched_hash" ]]; then
    echo "Requested Developer ID Application identity not found: $requested_identity" >&2
    printf '%s\n' "$available_identities" >&2
    exit 1
  fi

  printf '%s\n' "$matched_hash"
  exit 0
fi

default_hash="$(
  printf '%s\n' "$available_identities" |
    awk '
      $0 ~ /Developer ID Application/ {
        print $2
        exit
      }
    '
)"

if [[ -z "$default_hash" ]]; then
  echo "No Developer ID Application signing identity is available in the current keychain." >&2
  printf '%s\n' "$available_identities" >&2
  exit 1
fi

printf '%s\n' "$default_hash"

#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

bootstrap_temp_signing_keychain() {
  local keychain_password
  local keychain_path
  local cert_archive_path

  keychain_password="${REMUX_MACOS_KEYCHAIN_PASSWORD:-remux-signing-ci}"
  keychain_path="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/remux-signing.keychain-db"
  cert_archive_path="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/apple-certificates.p12"

  rm -f "$keychain_path" "$cert_archive_path"
  APPLE_CERTIFICATES_P12="$APPLE_CERTIFICATES_P12" CERT_ARCHIVE_PATH="$cert_archive_path" python3 <<'PYEOF'
import base64
import os
import pathlib

path = pathlib.Path(os.environ["CERT_ARCHIVE_PATH"])
path.write_bytes(base64.b64decode(os.environ["APPLE_CERTIFICATES_P12"]))
PYEOF

  security create-keychain -p "$keychain_password" "$keychain_path"
  security set-keychain-settings -lut 21600 "$keychain_path"
  security unlock-keychain -p "$keychain_password" "$keychain_path"
  security import "$cert_archive_path" \
    -k "$keychain_path" \
    -P "$APPLE_CERTIFICATES_PASSWORD" \
    -T /usr/bin/codesign \
    -T /usr/bin/security
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$keychain_password" "$keychain_path"
  security list-keychains -d user -s "$keychain_path" "$HOME/Library/Keychains/login.keychain-db"
  security default-keychain -d user -s "$keychain_path"

  echo "Imported Apple signing certificates into temporary keychain: $keychain_path"
}

unlock_login_keychain() {
  local keychain_password
  local login_keychain

  keychain_password="${REMUX_KEYCHAIN_PASSWORD:-${REMUX_PASSWORD:-}}"
  if [[ -z "$keychain_password" ]]; then
    echo "No Apple signing keychain credentials were provided." >&2
    exit 1
  fi

  login_keychain="${REMUX_LOGIN_KEYCHAIN_PATH:-$HOME/Library/Keychains/login.keychain-db}"
  security unlock-keychain -p "$keychain_password" "$login_keychain"
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$keychain_password" "$login_keychain" >/dev/null 2>&1 || true
  echo "Unlocked login keychain for macOS signing: $login_keychain"
}

if [[ -n "${APPLE_CERTIFICATES_P12:-}" && -n "${APPLE_CERTIFICATES_PASSWORD:-}" ]]; then
  bootstrap_temp_signing_keychain
else
  unlock_login_keychain
fi

bash "$SCRIPT_DIR/resolve-signing-identity.sh" >/dev/null
echo "macOS signing keychain is ready"

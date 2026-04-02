#!/bin/bash
# Export signing certificates and configure GitHub Secrets for CI/CD.
# Must be run interactively (GUI session required for keychain export).
set -euo pipefail

REPO="yaoshenwang/remux"
EXPORT_PW="ci-remux-2024"
TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

echo "=== Remux CI/CD Secrets Setup ==="
echo ""

# Step 1: Export certificates
echo "[1/4] 导出签名证书..."
echo "  macOS 会弹出 Keychain 授权对话框，请点击「允许」"
echo ""

# Find cert hashes
DEV_HASH=$(security find-identity -v -p codesigning | grep "Apple Development" | head -1 | awk '{print $2}')
DIST_HASH=$(security find-identity -v -p codesigning | grep "Apple Distribution" | head -1 | awk '{print $2}')
DEVID_HASH=$(security find-identity -v -p codesigning | grep "Developer ID Application" | head -1 | awk '{print $2}')

echo "  Apple Development: $DEV_HASH"
echo "  Apple Distribution: $DIST_HASH"
echo "  Developer ID Application: $DEVID_HASH"
echo ""

# Export all identities as one .p12 (Keychain will prompt for each)
security export -k ~/Library/Keychains/login.keychain-db \
  -t identities -f pkcs12 -P "$EXPORT_PW" \
  -o "$TMPDIR/certs.p12"

echo "✓ 证书导出成功"

# Step 2: Base64 encode
echo ""
echo "[2/4] 编码证书和 API Key..."

CERTS_B64=$(base64 < "$TMPDIR/certs.p12")
P8_B64=$(base64 < ~/.private_keys/AuthKey_2D79888WND.p8)

echo "✓ 编码完成"

# Step 3: Set GitHub Secrets
echo ""
echo "[3/4] 设置 GitHub Secrets..."

gh secret set APPLE_CERTIFICATES_P12 --repo "$REPO" --body "$CERTS_B64"
echo "  ✓ APPLE_CERTIFICATES_P12"

gh secret set APPLE_CERTIFICATES_PASSWORD --repo "$REPO" --body "$EXPORT_PW"
echo "  ✓ APPLE_CERTIFICATES_PASSWORD"

gh secret set APP_STORE_CONNECT_API_KEY_ID --repo "$REPO" --body "2D79888WND"
echo "  ✓ APP_STORE_CONNECT_API_KEY_ID"

gh secret set APP_STORE_CONNECT_ISSUER_ID --repo "$REPO" --body "871408b2-72c1-4989-9530-5b72d99f4f27"
echo "  ✓ APP_STORE_CONNECT_ISSUER_ID"

gh secret set APP_STORE_CONNECT_API_KEY_P8 --repo "$REPO" --body "$P8_B64"
echo "  ✓ APP_STORE_CONNECT_API_KEY_P8"

gh secret set APPLE_TEAM_ID --repo "$REPO" --body "LY8QD6TJN6"
echo "  ✓ APPLE_TEAM_ID"

# Step 4: Verify
echo ""
echo "[4/4] 验证..."
gh secret list --repo "$REPO"

echo ""
echo "=== 全部完成 ✅ ==="
echo "已配置以下 Secrets:"
echo "  APPLE_CERTIFICATES_P12          — 签名证书 (Development + Distribution + Developer ID)"
echo "  APPLE_CERTIFICATES_PASSWORD     — 证书导出密码"
echo "  APP_STORE_CONNECT_API_KEY_ID    — API Key ID"
echo "  APP_STORE_CONNECT_ISSUER_ID     — Issuer ID"
echo "  APP_STORE_CONNECT_API_KEY_P8    — API Key .p8 (base64)"
echo "  APPLE_TEAM_ID                   — Apple Team ID"

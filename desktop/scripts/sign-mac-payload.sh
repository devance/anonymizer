#!/bin/bash
# Signs the code Tauri doesn't sign itself, innermost first, with the hardened
# runtime and a secure timestamp: every Mach-O inside the frozen engine, then
# the engine bundle. Run before `tauri build`.
#   APPLE_SIGNING_IDENTITY="Developer ID Application: …" scripts/sign-mac-payload.sh path/to/AnonEngine.app
set -euo pipefail
cd "$(dirname "$0")/.."
: "${APPLE_SIGNING_IDENTITY:?set APPLE_SIGNING_IDENTITY}"
ENGINE="${1:?path to AnonEngine.app}"
ENT="src-tauri/entitlements/engine.plist"
sign() { codesign --force --options runtime --timestamp --entitlements "$ENT" --sign "$APPLE_SIGNING_IDENTITY" "$@"; }

n=0
# Deepest paths first so a framework's contents are signed before the framework.
while IFS= read -r f; do
  if file -b "$f" | grep -q 'Mach-O'; then sign "$f" >/dev/null; n=$((n + 1)); fi
done < <(find "$ENGINE/Contents" -type f \( -name '*.so' -o -name '*.dylib' -o -perm -u+x \) | awk '{ print length, $0 }' | sort -rn | cut -d' ' -f2-)
sign "$ENGINE"
codesign --verify --deep --strict "$ENGINE"
echo "signed $n Mach-O files in $(basename "$ENGINE")"

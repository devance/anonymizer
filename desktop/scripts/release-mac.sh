#!/bin/bash
# Local macOS release: frozen engine + llama-server + app, signed with the
# Developer ID, notarized and stapled, packed in a drag-to-Applications DMG.
#   scripts/release-mac.sh [--no-notarize]
# Needs: the Developer ID certificate in the keychain, and either a notarytool
# keychain profile (default "gabgren"; NOTARY_PROFILE overrides) or, on CI,
# APPLE_ID + APPLE_APP_PASSWORD. Without the certificate it builds an unsigned
# DMG, to check the build only.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(cd .. && pwd)"
export PATH="$HOME/.cargo/bin:$PATH"
export APPLE_SIGNING_IDENTITY="${APPLE_SIGNING_IDENTITY:-Developer ID Application: Gabgren 2000 Inc. (9TJ9D565BJ)}"
TEAM_ID="$(sed -E 's/.*\(([A-Z0-9]+)\)$/\1/' <<< "$APPLE_SIGNING_IDENTITY")"
if [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_APP_PASSWORD:-}" ]; then
  NOTARY=(--apple-id "$APPLE_ID" --password "$APPLE_APP_PASSWORD" --team-id "$TEAM_ID")
else
  NOTARY=(--keychain-profile "${NOTARY_PROFILE:-gabgren}")
fi
NOTARIZE=1
[ "${1:-}" = "--no-notarize" ] && NOTARIZE=0
SIGN=1
if ! security find-identity -v -p codesigning | grep -qF "$APPLE_SIGNING_IDENTITY"; then
  echo "!! no \"$APPLE_SIGNING_IDENTITY\" in the keychain: unsigned build, not for distribution"
  SIGN=0
  NOTARIZE=0
  unset APPLE_SIGNING_IDENTITY
fi
# Tauri notarizes on its own when these are set; we do it below instead.
unset APPLE_ID APPLE_PASSWORD APPLE_APP_PASSWORD APPLE_API_KEY APPLE_API_ISSUER

VERSION=$(python3 -c "import json; print(json.load(open('src-tauri/tauri.conf.json'))['version'])")
PRODUCT=$(python3 -c "import json; print(json.load(open('src-tauri/tauri.conf.json'))['productName'])")
OUT="build/release/$VERSION"
mkdir -p "$OUT"

echo "== llama-server"
scripts/build-llama-mac.sh arm64

CONFIG='{}'
if [ -x "$ROOT/engine/scripts/build.sh" ]; then
  echo "== document engine"
  "$ROOT/engine/scripts/build.sh"
  rm -rf build/AnonEngine.app
  ditto "$ROOT/engine/dist/AnonEngine.app" build/AnonEngine.app
  build/AnonEngine.app/Contents/MacOS/anon-engine --selftest
  [ $SIGN = 1 ] && scripts/sign-mac-payload.sh build/AnonEngine.app
  CONFIG="{\"bundle\":{\"macOS\":{\"files\":{\"Helpers/AnonEngine.app\":\"../build/AnonEngine.app\"}}}}"
else
  echo "!! engine/scripts/build.sh missing: building without the document engine"
fi

echo "== third-party notices"
SITE=$(ls -d "$ROOT"/engine/.venv/lib/python3*/site-packages 2>/dev/null | head -1 || true)
python3 scripts/notices.py ${SITE:+"$SITE"} > build/THIRD_PARTY_NOTICES.txt
CONFIG=$(python3 -c "import json,sys; c=json.loads(sys.argv[1]); c.setdefault('bundle',{})['resources']={'../build/THIRD_PARTY_NOTICES.txt':'THIRD_PARTY_NOTICES.txt'}; print(json.dumps(c))" "$CONFIG")

echo "== app"
npx tauri build --target aarch64-apple-darwin --bundles app --config "$CONFIG"
APP="src-tauri/target/aarch64-apple-darwin/release/bundle/macos/$PRODUCT.app"
[ $SIGN = 1 ] && codesign --verify --deep --strict --verbose=2 "$APP"

notarize() {
  xcrun notarytool submit "$1" "${NOTARY[@]}" --wait --timeout 30m | tee "$OUT/notary-$(basename "$1").log"
  grep -q 'status: Accepted' "$OUT/notary-$(basename "$1").log"
}

if [ $NOTARIZE = 1 ]; then
  echo "== notarize app"
  ditto -c -k --keepParent "$APP" "$OUT/app.zip"
  notarize "$OUT/app.zip"
  xcrun stapler staple "$APP"
  rm "$OUT/app.zip"
fi

echo "== dmg"
DMG="$OUT/Devance-Anonymiseur_${VERSION}_aarch64.dmg"
scripts/make-dmg.sh "$APP" "$DMG"
[ $SIGN = 1 ] && codesign --force --timestamp --sign "$APPLE_SIGNING_IDENTITY" "$DMG"
if [ $NOTARIZE = 1 ]; then
  echo "== notarize dmg"
  notarize "$DMG"
  xcrun stapler staple "$DMG"
  xcrun stapler validate "$DMG"
  spctl -a -vvv -t open --context context:primary-signature "$DMG"
  spctl -a -vvv -t exec "$APP"
fi
shasum -a 256 "$DMG" | tee "$DMG.sha256"
du -h "$DMG"

#!/bin/bash
# Builds the drag-to-Applications DMG for a signed .app, over the Devance
# background. Uses create-dmg (Finder lays out the window itself, which is
# what makes the background show on recent macOS), so it needs a logged-in
# GUI session and Finder automation permission.
#   scripts/make-dmg.sh "path/to/Devance Anonymiseur.app" out.dmg
set -euo pipefail
cd "$(dirname "$0")/.."
APP="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
OUT="$2"
CREATE_DMG_TAG=v1.3.0
[ -x build/create-dmg/create-dmg ] || git clone -q --depth 1 --branch "$CREATE_DMG_TAG" https://github.com/create-dmg/create-dmg build/create-dmg
# Retina background: 1x and 2x in one TIFF.
tiffutil -cathidpicheck assets/dmg-background.png assets/dmg-background@2x.png -out build/dmg-background.tiff >/dev/null
STAGE="$(mktemp -d)"
ditto "$APP" "$STAGE/$(basename "$APP")"
VOL="$(basename "$APP" .app)"
dmg() {
  rm -f "$OUT"
  build/create-dmg/create-dmg \
    --volname "$VOL" \
    --background build/dmg-background.tiff \
    --window-pos 200 160 --window-size 660 428 \
    --icon-size 112 --text-size 13 \
    --icon "$(basename "$APP")" 180 214 --hide-extension "$(basename "$APP")" \
    --app-drop-link 480 214 \
    --no-internet-enable --filesystem HFS+ --format UDZO \
    "$@" "$OUT" "$STAGE"
}
# A CI runner's Finder sometimes won't take the AppleScript: the DMG is then
# made without the window layout rather than not at all.
dmg || { [ -n "${CI:-}" ] && echo "!! Finder layout failed: DMG without it" && dmg --skip-jenkins; }
rm -rf "$STAGE"

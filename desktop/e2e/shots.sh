#!/bin/bash
# Screenshots of the app window, taken when a script reports "SHOT <name>".
#   desktop/e2e/shots.sh script.js out-dir [--keep-data DIR]
# (paths relative to desktop/, or absolute)
# The script runs like run.sh's (throwaway data folder unless --keep-data);
# after reporting SHOT it should wait ~1 s before changing the screen.
# SHOTS_SIZE=1024x700 opens the window at another size (the minimum, say).
set -euo pipefail
cd "$(dirname "$0")/.."
SCRIPT="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
OUT="$(mkdir -p "$2" && cd "$2" && pwd)"
DATA="${4:-$(mktemp -d)}"
mkdir -p "$DATA"
BIN="$(pwd)/e2e/.winid"
[ -x "$BIN" ] || swiftc -O e2e/winid.swift -o "$BIN"
export ANON_DATA_DIR="$DATA" ANON_E2E="$SCRIPT" PATH="$HOME/.cargo/bin:$PATH"
LOG="$OUT/run.log"
: > "$LOG"
EXTRA=()
if [ -n "${SHOTS_SIZE:-}" ]; then
  CONF="$(mktemp -t shots-conf).json"
  node -e 'const c = require("./src-tauri/tauri.conf.json"); const [w, h] = process.argv[1].split("x").map(Number);
    console.log(JSON.stringify({ app: { windows: c.app.windows.map((x) => ({ ...x, width: w, height: h })) } }));' "$SHOTS_SIZE" > "$CONF"
  EXTRA=(--config "$CONF")
fi
# If the app dies before DONE, say so, or the loop below would wait forever.
{ npx tauri dev --no-watch ${EXTRA[@]+"${EXTRA[@]}"} || true; echo "E2E FAIL app exited"; } > "$LOG" 2>&1 &
APP=$!
tail -n +1 -f "$LOG" | while read -r line; do
  case "$line" in
    "E2E SHOT "*)
      name="${line#E2E SHOT }"
      id="$("$BIN" devance-anonymizer)"
      [ -n "$id" ] && screencapture -x -o -l "$id" "$OUT/$name.png" && echo "shot $name"
      ;;
    "E2E DONE"*|"E2E FAIL"*) echo "$line"; break ;;
    "E2E "*) echo "$line" ;;
  esac
done
wait $APP || true

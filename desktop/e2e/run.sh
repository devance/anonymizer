#!/bin/bash
# Run an e2e script inside the debug app with a throwaway data folder, then
# check that nothing real sits on disk in the clear.
#   desktop/e2e/run.sh [script.js]
#   E2E_MODELS=desktop/build/e2e-models desktop/e2e/run.sh model.js
set -euo pipefail
# E2E_MODELS is relative to where the script was called from.
if [ -n "${E2E_MODELS:-}" ]; then mkdir -p "$E2E_MODELS" && E2E_MODELS="$(cd "$E2E_MODELS" && pwd)"; fi
cd "$(dirname "$0")/.."
SCRIPT="$(cd e2e && pwd)/${1:-smoke.js}"
DATA="$(mktemp -d)"
export ANON_DATA_DIR="$DATA" ANON_E2E="$SCRIPT" PATH="$HOME/.cargo/bin:$PATH"
# E2E_MODELS=dir keeps downloaded models there between runs.
if [ -n "${E2E_MODELS:-}" ]; then ln -s "$E2E_MODELS" "$DATA/models"; fi
LOG="$DATA.log"
set +e
npx tauri dev --no-watch > "$LOG" 2>&1
code=$?
set -e
grep '^E2E ' "$LOG" || true
if [ $code -ne 0 ] || ! grep -q '^E2E DONE' "$LOG"; then
  tail -30 "$LOG"
  echo "e2e failed (log: $LOG)"
  exit 1
fi
# Data at rest: the database and blobs must not hold real values in the clear.
if grep -rl -a -E 'Tremblay|662-1934|046 454 286' "$DATA" >/dev/null; then
  echo "real values found in clear under $DATA"
  exit 1
fi
head -c 16 "$DATA/data.db" | grep -q 'SQLite format 3' && { echo "data.db is not encrypted"; exit 1; }
# The app's diagnostic log is under the data folder too (checked above); keep the last one to read.
cp "$DATA/logs/anonymizer.log" build/e2e-app.log 2>/dev/null || true
echo "e2e ok; data at rest encrypted ($DATA); app log in desktop/build/e2e-app.log"
rm -rf "$DATA" "$LOG"

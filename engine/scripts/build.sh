#!/usr/bin/env bash
# Build the frozen engine: dist/AnonEngine.app on macOS (dist/anon-engine/ elsewhere),
# then run its self-test. On Windows it runs in Git Bash. Unsigned: signing happens when the desktop app is packaged.
#
#   engine/scripts/build.sh            PYTHON=/path/to/python3.12 to pick the interpreter
#
# By default the interpreter is uv's standalone CPython, built for macOS 11 and
# up. Homebrew's Python (and the OpenSSL it links) target the macOS of the
# machine that built them, which the bundle would then require; the check at
# the end refuses a bundle that needs a newer macOS than MIN_MACOS.
set -euo pipefail
cd "$(dirname "$0")/.."

PYTHON_VERSION=3.12.13
MIN_MACOS="${MIN_MACOS:-14.0}"  # the app's minimumSystemVersion; onnxruntime needs 14 too
if [ -z "${PYTHON:-}" ]; then
  uv python install --quiet "$PYTHON_VERSION"
  PYTHON="$(uv python find --managed-python "$PYTHON_VERSION")"
fi
VPY=.venv/bin/python
[ "${OS:-}" = Windows_NT ] && VPY=.venv/Scripts/python.exe
# A venv made from another interpreter is rebuilt.
base() { "$1" -c 'import sys; print(sys.base_prefix)'; }
if [ -x "$VPY" ] && [ "$(base "$VPY")" != "$(base "$PYTHON")" ]; then rm -rf .venv; fi
[ -x "$VPY" ] || "$PYTHON" -m venv .venv
"$VPY" -m pip install --quiet --disable-pip-version-check --require-hashes -r requirements.lock -r requirements-dev.lock
"$VPY" scripts/fetch_models.py
rm -rf build dist
"$VPY" -m PyInstaller --noconfirm --clean --log-level WARN anon-engine.spec

if [ "$(uname)" = Darwin ]; then
  BIN=dist/AnonEngine.app/Contents/MacOS/anon-engine
  newest="$(find dist/AnonEngine.app -type f -exec otool -l {} + 2>/dev/null | awk '$1 == "minos" {print $2}' | sort -V | tail -1)"
  if [ "$(printf '%s\n%s\n' "$newest" "$MIN_MACOS" | sort -V | tail -1)" != "$MIN_MACOS" ]; then
    echo "bundle needs macOS $newest, above MIN_MACOS=$MIN_MACOS (built with $PYTHON)" >&2
    exit 1
  fi
elif [ "${OS:-}" = Windows_NT ]; then
  BIN=dist/anon-engine/anon-engine.exe
else
  BIN=dist/anon-engine/anon-engine
fi
"$BIN" --selftest
echo "built $BIN"

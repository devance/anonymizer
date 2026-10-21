#!/bin/bash
# Windows release, in Git Bash (the CI runner, or a Windows PC with Node, Rust,
# uv and Python): frozen engine + llama-server (llama.cpp's prebuilt Vulkan
# build, pinned in llama.lock.json) + app, in a per-user NSIS installer.
#   scripts/release-windows.sh
# Signs with SSL.com eSigner (scripts/sign-windows.ps1) when CODESIGN_CREDENTIAL_ID
# is set: the two helpers first, then Tauri signs the app and the installer.
# Without it the installer is unsigned, to check the build only.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(cd .. && pwd)"
PY="${PYTHON_BIN:-python}"
# Python on Windows ends its lines with CRLF; Bash would keep the CR.
py() { "$PY" "$@" | tr -d '\r'; }
# OpenSSL (built for SQLCipher) needs a full Windows Perl; Git Bash's own perl
# comes first in PATH and lacks its modules.
if [ -z "${OPENSSL_SRC_PERL:-}" ] && [ -x /c/Strawberry/perl/bin/perl.exe ]; then
  export OPENSSL_SRC_PERL=C:/Strawberry/perl/bin/perl.exe
fi

VERSION=$(py -c "import json; print(json.load(open('src-tauri/tauri.conf.json'))['version'])")
OUT="build/release/$VERSION"
mkdir -p "$OUT"
SIGN=0
[ -n "${CODESIGN_CREDENTIAL_ID:-}" ] && SIGN=1 || echo "!! no CODESIGN_CREDENTIAL_ID: unsigned build, not for distribution"
SIGNER="$(cygpath -w "$PWD/scripts/sign-windows.ps1")"
sign() { pwsh -NoProfile -File "$SIGNER" "$(cygpath -w "$1")"; }

echo "== llama-server"
read -r TAG ASSET SHA < <(py -c "import json; l=json.load(open('llama.lock.json')); print(l['tag'], l['windows']['asset'], l['windows']['sha256'])")
if [ "$(cat build/llama.tag 2>/dev/null)" != "$ASSET" ]; then
  curl -fsSL -o build/llama.zip "https://github.com/ggml-org/llama.cpp/releases/download/$TAG/$ASSET"
  echo "$SHA *build/llama.zip" | sha256sum -c -
  rm -rf build/llama && mkdir -p build/llama
  unzip -q build/llama.zip -d build/llama
  # The server and the DLLs it loads sit together, at the root of the folder.
  SERVER="$(find build/llama -name llama-server.exe | head -1)"
  [ "$(dirname "$SERVER")" = build/llama ] || { cp -r "$(dirname "$SERVER")"/. build/llama/; }
  # Only the server: the zip also carries llama.cpp's other tools (cli, bench, quantize…).
  find build/llama -maxdepth 1 \( -name '*.exe' ! -name llama-server.exe \) -delete
  find build/llama -maxdepth 1 \( -name '*-impl.dll' ! -name llama-server-impl.dll \) -delete
  echo "$ASSET" > build/llama.tag
  rm build/llama.zip
fi
build/llama/llama-server.exe --version
[ $SIGN = 1 ] && sign build/llama/llama-server.exe

echo "== document engine"
"$ROOT/engine/scripts/build.sh"
rm -rf build/engine
cp -r "$ROOT/engine/dist/anon-engine" build/engine
[ $SIGN = 1 ] && sign build/engine/anon-engine.exe

echo "== third-party notices"
"$PY" scripts/notices.py "$ROOT/engine/.venv/Lib/site-packages" > build/THIRD_PARTY_NOTICES.txt

echo "== app"
# Resources land next to the app's exe: engine\anon-engine.exe and llama\llama-server.exe
# are where src-tauri/src/sidecars.rs looks for them.
CONFIG=$(py - "$SIGN" "$SIGNER" <<'EOF'
import json, sys
sign, signer = sys.argv[1] == "1", sys.argv[2]
bundle = {"resources": {
    "../build/engine/": "engine/",
    "../build/llama/": "llama/",
    "../build/THIRD_PARTY_NOTICES.txt": "THIRD_PARTY_NOTICES.txt",
}}
if sign:
    bundle["windows"] = {"signCommand": {"cmd": "pwsh", "args": ["-NoProfile", "-File", signer, "%1"]}}
print(json.dumps({"bundle": bundle}))
EOF
)
npx tauri build --bundles nsis --config "$CONFIG"

SETUP="$(ls src-tauri/target/release/bundle/nsis/*-setup.exe | head -1)"
DEST="$OUT/Devance-Anonymiseur_${VERSION}_x64-setup.exe"
cp "$SETUP" "$DEST"
if [ $SIGN = 1 ]; then
  pwsh -NoProfile -Command "\$s = Get-AuthenticodeSignature '$(cygpath -w "$DEST")'; if (\$s.Status -ne 'Valid') { throw \"installer signature: \$(\$s.Status)\" }; \$s.SignerCertificate.Subject"
fi
sha256sum "$DEST" | tee "$DEST.sha256"
du -h "$DEST"

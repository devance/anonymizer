#!/bin/bash
# Builds llama-server for the app: one static binary with the Metal shaders
# embedded, so the bundle carries no dylibs. Tag pinned in desktop/llama.lock.json.
# Output: desktop/src-tauri/binaries/llama-server-<target triple>
set -euo pipefail
cd "$(dirname "$0")/.."
TAG=$(python3 -c "import json; print(json.load(open('llama.lock.json'))['tag'])")
ARCH=${1:-arm64}
TRIPLE=$([ "$ARCH" = arm64 ] && echo aarch64-apple-darwin || echo x86_64-apple-darwin)
OUT="src-tauri/binaries/llama-server-$TRIPLE"
SRC="build/llama.cpp-$TAG"
if [ -x "$OUT" ] && [ "$(cat "$OUT.tag" 2>/dev/null)" = "$TAG-$ARCH" ]; then echo "llama-server $TAG ($ARCH) already built"; exit 0; fi
mkdir -p build src-tauri/binaries
[ -d "$SRC" ] || git clone --depth 1 --branch "$TAG" https://github.com/ggml-org/llama.cpp "$SRC"
METAL=$([ "$ARCH" = arm64 ] && echo ON || echo OFF)
cmake -S "$SRC" -B "$SRC/build-$ARCH" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DLLAMA_BUILD_NUMBER="${TAG#b}" \
  -DGGML_METAL=$METAL -DGGML_METAL_EMBED_LIBRARY=ON -DGGML_NATIVE=OFF \
  -DGGML_CCACHE=OFF -DGGML_OPENMP=OFF -DLLAMA_OPENSSL=OFF -DLLAMA_USE_PREBUILT_UI=OFF -DLLAMA_BUILD_UI=OFF -DLLAMA_CURL=OFF -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF -DLLAMA_BUILD_SERVER=ON \
  -DCMAKE_OSX_ARCHITECTURES="$ARCH" -DCMAKE_OSX_DEPLOYMENT_TARGET=14.0
cmake --build "$SRC/build-$ARCH" --target llama-server -j
cp "$SRC/build-$ARCH/bin/llama-server" "$OUT"
echo "$TAG-$ARCH" > "$OUT.tag"
otool -L "$OUT" | tail -n +2
"$OUT" --version

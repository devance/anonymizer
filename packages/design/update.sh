#!/bin/bash
# Replaces this copy with the files of a devance/design release. Needs read
# access to devance/design (private); the CI never does, it builds from the copy.
#   packages/design/update.sh v0.1.2
# Then: npm install, check the app, commit with the tag in the message.
set -euo pipefail
cd "$(dirname "$0")"
TAG="${1:?devance/design tag, e.g. v0.1.2}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
git clone -q --depth 1 --branch "$TAG" git@github.com:devance/design.git "$TMP"
for d in css fonts icons brand; do
  rm -rf "$d"
  cp -R "$TMP/$d" "$d"
done
# devance/design has no licence file for the icons; ours comes back from git.
git checkout -- icons/LICENSE-phosphor.txt
VERSION="${TAG#v}"
sed -i '' -E "s/\"version\": \"[^\"]+\"/\"version\": \"$VERSION\"/; s/devance\/design v[0-9.]+/devance\/design $TAG/" package.json
sed -i '' -E "s/devance\/design\` v[0-9.]+ \(commit [0-9a-f]+\)/devance\/design\` $TAG (commit $(git -C "$TMP" rev-parse --short HEAD))/" README.md
echo "packages/design is now devance/design $TAG"

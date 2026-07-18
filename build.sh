#!/usr/bin/env bash
# Package the extension for the Chrome Web Store.
# Only the files Chrome actually loads go in the zip: no docs, no build tooling,
# no store assets, no macOS resource forks.
set -euo pipefail

cd "$(dirname "$0")"

version=$(python3 -c 'import json; print(json.load(open("extension/manifest.json"))["version"])')
out="dist/single-group-window-${version}.zip"

mkdir -p dist
rm -f "$out"

# Zip from inside extension/ so manifest.json sits at the root of the archive,
# which the Web Store requires. -X drops xattrs and __MACOSX entries.
(cd extension && zip -rX "../$out" . -x '*.DS_Store' >/dev/null)

echo "$out"
unzip -l "$out" | tail -n +4 | sed '$d;$d'

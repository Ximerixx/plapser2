#!/usr/bin/env bash
set -euo pipefail

BUILD="${1:?usage: pack-release.sh <build_number> [output.zip]}"
OUT="${2:-release.zip}"

APK="${APK:-app-release.apk}"
CHANGELOG="${CHANGELOG:-changelog.md}"

if [[ ! -f "$APK" ]]; then
  echo "missing APK: $APK" >&2
  exit 1
fi
if [[ ! -f "$CHANGELOG" ]]; then
  echo "missing changelog: $CHANGELOG" >&2
  exit 1
fi

MARKER="v${BUILD}"
rm -f "$OUT" "$MARKER"
touch "$MARKER"
zip -j "$OUT" "$APK" "$CHANGELOG" "$MARKER"
rm -f "$MARKER"

echo "Created $OUT (build ${MARKER})"

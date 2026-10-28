#!/bin/bash
# Local 3.7.5 candidate packaging — Blue Argon remediation (2026-10-28).
#
# Unlike CI (which runs `git archive HEAD:extension` on a committed tree),
# this script packages the CURRENT WORKING TREE so uncommitted-reviewed
# fixes cannot be silently dropped from the candidate ZIP. It:
#
#   1. stages a clean copy of extension/ (excluding nothing that belongs,
#      rejecting junk/backup/temp files — the policy scan would fail on
#      them anyway),
#   2. runs the remote-code policy scan on the staged tree,
#   3. zips it with manifest.json at the archive ROOT (no extension/
#      prefix, no __MACOSX/.DS_Store), exactly like the CI artifact,
#   4. re-runs the policy scan on the ZIP itself (negative control: the
#      3.7.4 artifact fails it),
#   5. writes dist-extension/SHA256SUMS.
#
# Usage: bash scripts/package_extension_local.sh [output-dir]
# (default dist-extension; the original 3.7.4 ZIP in the main workspace is
# never touched).

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT=$(pwd)
OUT_DIR="${1:-dist-extension}"
VERSION=$(python3 -c 'import json; print(json.load(open("extension/manifest.json"))["version"])')
ARCHIVE="$OUT_DIR/open-file-bridge-extension-$VERSION.zip"
STAGE=$(mktemp -d "${TMPDIR:-/tmp}/ofb-pkg-XXXXXX")
trap 'rm -rf "$STAGE"' EXIT

echo "packaging extension $VERSION from the working tree into $ARCHIVE"

# 1. stage the working tree (rsync preserves content only; explicit excludes
#    for the OS/VCS noise that must never ship)
mkdir -p "$STAGE/root"
rsync -a --exclude '.DS_Store' --exclude '__MACOSX' --exclude '*.bak' \
      --exclude '*.orig' --exclude '*.rej' --exclude '*.tmp' \
      "$ROOT/extension/" "$STAGE/root/"

# no backup/temp droppings may remain (belt — the policy scan checks too)
find "$STAGE/root" \( -name '.DS_Store' -o -name '*.bak' -o -name '*.orig' \
   -o -name '*.rej' -o -name '*.tmp' -o -name '~*' -o -name '*~' \) \
   -print | (grep . && { echo "REFUSING: junk files staged"; exit 1; } || true)

# 2. policy-scan the staged tree BEFORE zipping (faster feedback)
node scripts/check-remote-code.mjs --dir "$STAGE/root" --expect-version "$VERSION"

# 3. zip with manifest.json at the root, matching the 3.7.4 artifact's
#    entry shape (zip -r keeps the 7 directory entries; 74 files + 1 new
#    provenance file = 75)
mkdir -p "$OUT_DIR"
rm -f "$ARCHIVE"
(cd "$STAGE/root" && zip -r -X -q "$ROOT/$ARCHIVE" .)

# structural rooting checks (same as CI)
unzip -t "$ARCHIVE" >/dev/null
test "$(unzip -Z1 "$ARCHIVE" | grep -cx 'manifest.json')" -eq 1
test "$(unzip -Z1 "$ARCHIVE" | grep -c '^extension/')" -eq 0
test "$(unzip -Z1 "$ARCHIVE" | grep -c '__MACOSX\|\.DS_Store')" -eq 0

# 4. policy-scan the packaged artifact
node scripts/check-remote-code.mjs --zip "$ARCHIVE" --expect-version "$VERSION"

# 5. checksum (this directory's zips only; the main workspace's 3.7.4
#    evidence artifact and its recorded hash are untouched)
(cd "$OUT_DIR" && shasum -a 256 *.zip > SHA256SUMS)

echo
echo "OK: $ARCHIVE"
unzip -Z1 "$ARCHIVE" | wc -l | tr -d ' ' | xargs echo "files:"
cat "$OUT_DIR/SHA256SUMS"

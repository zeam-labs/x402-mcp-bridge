#!/usr/bin/env bash
# Build the tarball a buyer downloads.
#
# THE VERSION IS IN THE FILENAME because npm caches remote tarballs BY URL. A
# fixed name served whatever a buyer cached the first time, forever: one cold
# buyer got a version with no line support, silently paid per call, burned the
# unpaid ceiling in about fifty seconds and locked their own funded wallet out.
#
# THE README IS REBUILT INTO THE TARBALL. A README corrected here and not packed
# is a README nobody reads -- the shipped 1.5.4 told buyers to fetch 1.5.0 and
# verify 1.5.0's checksum, which is the exact cache trap the versioning exists to
# avoid. npm pack takes what is on disk, so the only rule is: commit first.
set -euo pipefail
cd "$(dirname "$0")/.."

git diff --quiet || { echo "uncommitted changes — commit before packing, the tarball ships what is on disk" >&2; exit 1; }

VERSION=$(node -p "require('./package.json').version")
OUT="x402-mcp-bridge-$VERSION.tgz"

grep -q "$VERSION" README.md || { echo "README.md does not mention $VERSION — it will ship telling buyers to fetch something else" >&2; exit 1; }

rm -f ./*.tgz
npm pack --silent >/dev/null
mv "$(ls -1 *.tgz | head -1)" "$OUT"
sha256sum "$OUT" > "$OUT.sha256"

echo "  $OUT  $(sha256sum "$OUT" | cut -c1-16)…"
echo "  serve it from the MCP:  cp $OUT $OUT.sha256 <prism-mcp>/public/"
echo "  then bump bridgeManifest in the MCP's src/bridge.json"

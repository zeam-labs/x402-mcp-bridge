#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
REF="${1:?usage: scripts/test-dev.sh <ref>   (BRIDGE_TEST_HOST picks the host; BRIDGE_SMOKE_URLS adds the read-only smoke)}"
TARGET="${BRIDGE_TEST_HOST:-development}"
SSH="ssh -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=30"

case "$TARGET" in *production*) echo "$TARGET is production; tests never run there" >&2; exit 1 ;; esac
git fetch -q --all
SHA=$(git rev-parse --verify "$REF^{commit}")
[ -n "$(git for-each-ref --contains "$SHA" refs/remotes)" ] || { echo "$REF ($SHA) is on no remote; push it first — this tests what was pushed, never a working tree" >&2; exit 1; }
$SSH "$TARGET" true 2>/dev/null || { echo "cannot ssh to $TARGET" >&2; exit 1; }
HOST=$($SSH "$TARGET" "docker info --format '{{.Name}}'" 2>/dev/null || true)
[ -n "$HOST" ] || { echo "cannot read the docker daemon on $TARGET" >&2; exit 1; }
[ "$HOST" = production ] && { echo "$TARGET is production; tests never run there" >&2; exit 1; }

SHORT=$(git rev-parse --short "$SHA")
TAG="x402-mcp-bridge-test:$SHORT"
echo "==> building $SHORT ($REF) on $TARGET"
git archive --format=tar "$SHA" | $SSH "$TARGET" "docker build -q -f test/Dockerfile -t $TAG --label zeam.product=bridge --label zeam.commit=$SHORT - >/dev/null" \
  || { echo "the test image did not build" >&2; exit 1; }

status=0
echo "==> npm test, inside the image"
$SSH "$TARGET" "docker run --rm --name bridge-test-$SHORT $TAG" || status=1
if [ -n "${BRIDGE_SMOKE_URLS:-}" ]; then
  echo "==> read-only smoke against: $BRIDGE_SMOKE_URLS"
  $SSH "$TARGET" "docker run --rm --network host --name bridge-smoke-$SHORT -e BRIDGE_SMOKE_URLS='$BRIDGE_SMOKE_URLS' $TAG npm run smoke" || status=1
fi
$SSH "$TARGET" "docker rmi -f $TAG >/dev/null; docker image prune -f --filter label=zeam.product=bridge >/dev/null" || true
[ $status = 0 ] && echo "==> $SHORT passed on $TARGET" || echo "==> $SHORT FAILED on $TARGET" >&2
exit $status

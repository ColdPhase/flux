#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
if [ "${FLUX_LIVE_CALIBRATION_GRANTED:-}" != 231 ]; then
  echo 'This isolated Docker check needs the serial #231 calibration slot.' >&2
  exit 1
fi
case "${1:-}" in inventory|codec) mode=$1 ;; *) echo 'Usage: check_live_editing_calibration.sh inventory|codec' >&2; exit 1 ;; esac
fixture="$PWD/app/tooling/live-editing-calibration"
test -s "$fixture/pnpm-lock.yaml"
image="flux-231-codec:calibration-$$"
container="flux-231-codec-$mode-$$"
evidence="${FLUX_LIVE_CALIBRATION_EVIDENCE:-/tmp/flux-231-codec}"
mkdir -p "$evidence"
cleanup() {
  status=$?
  docker rm -f "$container" >/dev/null 2>&1 || true
  docker image rm "$image" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
git rev-parse HEAD > "$evidence/source-head.txt"
git diff --binary > "$evidence/tracked-source.diff"
find "$fixture" -maxdepth 1 -type f ! -name '.lock.*' -print0 | sort -z | xargs -0 sha256sum > "$evidence/fixture-sha256.txt"
sha256sum docker/live-editing-calibration.Dockerfile scripts/prepare_live_editing_calibration.sh \
  scripts/check_live_editing_calibration.sh > "$evidence/runner-sha256.txt"
timeout --signal=TERM --kill-after=10s 300s docker build --progress=plain \
  -f "$PWD/docker/live-editing-calibration.Dockerfile" -t "$image" "$fixture"
docker image inspect "$image" --format '{{.Id}}' > "$evidence/image-id.txt"
# This finite preflight records exact resolved versions/licenses and aborts on surprises.
timeout --signal=TERM --kill-after=10s 30s docker run --rm --name "$container" \
  --init --network=none --read-only --cap-drop=ALL --security-opt=no-new-privileges \
  --memory=512m --memory-swap=512m --cpus=2 --pids-limit=64 "$image" \
  node inventory.mjs > "$evidence/inventory.json"
cat "$evidence/inventory.json"
if [ "$mode" = codec ]; then
  timeout --signal=TERM --kill-after=10s 120s docker run --rm --name "$container" \
    --init --network=none --read-only --cap-drop=ALL --security-opt=no-new-privileges \
    --memory=512m --memory-swap=512m --cpus=2 --pids-limit=64 "$image" \
    node --test --test-concurrency=1 --test-timeout=90000 codec.test.mjs > "$evidence/codec.tap" 2>&1
  cat "$evidence/codec.tap"
fi

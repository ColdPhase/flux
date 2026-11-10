#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
if [ "${FLUX_LIVE_CALIBRATION_GRANTED:-}" != 231 ]; then
  echo 'This isolated Docker preparation needs the serial #231 calibration slot.' >&2
  exit 1
fi
fixture="$PWD/app/tooling/live-editing-calibration"
container="flux-231-codec-lock-$$"
temporary=$(mktemp "$fixture/.lock.XXXXXX")
cleanup() {
  status=$?
  docker rm -f "$container" >/dev/null 2>&1 || true
  rm -f "$temporary"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# Only source manifests are mounted. The dependency store and install stay in Docker.
timeout --signal=TERM --kill-after=10s 180s docker run --rm --name "$container" \
  --memory=512m --cpus=2 \
  -v "$fixture/package.json:/seed/package.json:ro,Z" \
  -v "$fixture/pnpm-workspace.yaml:/seed/pnpm-workspace.yaml:ro,Z" \
  node@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8 \
  sh -eu -c 'mkdir /tmp/calibration; cd /tmp/calibration; cp /seed/* .; corepack enable >&2; corepack install -g pnpm@12.6.0 >&2; pnpm install --lockfile-only --ignore-scripts >&2; cat pnpm-lock.yaml' > "$temporary"
test -s "$temporary"
mv "$temporary" "$fixture/pnpm-lock.yaml"
chmod 0644 "$fixture/pnpm-lock.yaml"
echo 'Standalone lock prepared; next build and inspect the inventory before executing codec tests.'

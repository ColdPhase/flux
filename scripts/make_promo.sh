#!/bin/sh
# Builds the README promo animation in Docker (#780): docs/assets/promo/flux-promo-{light,dark}.svg and the
# animated WebP fallback docs/assets/promo/flux-promo.webp. See docs/assets/promo/README.md.
#
#   ./scripts/make_promo.sh                 # SVGs + WebP
#   ./scripts/make_promo.sh run <cmd...>    # any command in the same image (e.g. render_promo.py sheet ...)
set -eu

cd "$(dirname "$0")/.."
image=flux-promo-tools:local
docker build -q -t "$image" -f scripts/promo/Dockerfile scripts/promo >/dev/null
run() { docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w "$image" "$@"; }

if [ "${1:-}" = run ]; then
  shift
  run "$@"
  exit
fi
run python3 scripts/promo/build_promo.py
run python3 scripts/promo/render_promo.py webp docs/assets/promo/flux-promo-light.svg docs/assets/promo/flux-promo.webp 12

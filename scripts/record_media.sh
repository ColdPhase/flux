#!/bin/sh
# One command that regenerates every launch medium from the running application, in Docker only (#307, L-3):
#
#   1. the README demo GIF            -> docs/assets/demo/flux-demo.gif       (scripts/record_demo.sh)
#   2. the README stills, light/dark  -> docs/assets/readme/*.webp            (same run)
#   3. the docs screens and README
#      highlights, light and dark     -> docs/assets/screens/*.webp           (same run, record_docs_media.py)
#   4. the launch video's shots 1-4, 8 -> <video-dir>/<lang>/*.webm            (scripts/record_video.sh)
#
#   ./scripts/record_media.sh [video-dir]
#   FLUX_VIDEO_VERSION=v0.1.0 ./scripts/record_media.sh /path/to/out
#
# Run it on a clone of the build the media must show. The founder gate #763 requires the README, docs-site
# and video media to come from the audited build after its UI/UX fixes, so run this once, then commit only the
# GIF, the stills and the screens (the clips are not committed; see docs/product/launch-video.md). Each step starts its own
# Compose project on its own loopback ports and a fresh demo, and removes them afterwards; the steps run one
# after another. Shots 5-7 of the video need a person (docs/product/launch-video.md#after-the-recording).
set -eu

cd "$(dirname "$0")/.."
video="${1:-${TMPDIR:-/tmp}/flux-launch-video}"
echo "== 1/2: README GIF, stills, documentation screens and README highlights"
./scripts/record_demo.sh docs/assets/demo/flux-demo.gif docs/assets/readme docs/assets/screens
echo "== 2/2: launch video shots 1-4 and 8, English and Polish, into $video"
./scripts/record_video.sh "$video"
echo
echo "Done. Review the GIF, the stills and the screens (git diff --stat docs/assets) and update the 'Recorded at' lines in"
echo "docs/assets/demo/README.md, docs/assets/readme/README.md and docs/assets/screens/README.md to this revision: $(git rev-parse --short HEAD)."
echo "The GIF must stay within its allowlisted size (scripts/docs-size-allowlist.txt); python3 scripts/check_agent_setup.py checks it."

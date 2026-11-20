#!/usr/bin/env bash
# The browser pass of the post-upgrade journeys (scripts/release/smoke_journeys_browser.py): the UI tests' pinned Playwright image
# (docker/ui-tests.Dockerfile, built from this tree; Docker caches it), on the host network, against an upgraded instance.
#
#   journeys_browser.sh <origin> <directory with account.json and journeys.json> <screenshot directory>
set -euo pipefail
origin=${1:?origin required}
state=$(cd "${2:?state directory required}" && pwd -P)
shots=${3:?screenshot directory required}
root=$(cd "$(dirname "$0")/../.." && pwd)
image=flux-journeys-browser:local
mkdir -p "$shots"
shots=$(cd "$shots" && pwd -P)
docker build -q -f "$root/docker/ui-tests.Dockerfile" -t "$image" "$root/app" >/dev/null
# The state files are private (0600): the browser user of the image reads copies made for this run.
copy=$(mktemp -d "$state/browser.XXXXXX")
trap 'rm -rf "$copy"' EXIT
cp "$state/account.json" "$state/journeys.json" "$copy/"
chmod 644 "$copy"/*.json; chmod 755 "$copy"; chmod 777 "$shots"
docker run --rm --network host --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$copy:/state:ro,z" -v "$shots:/shots:z" \
  -v "$root/scripts/release/smoke_journeys_browser.py:/check.py:ro,z" "$image" \
  python3 /check.py --origin "$origin" --account /state/account.json --state /state/journeys.json --shots /shots

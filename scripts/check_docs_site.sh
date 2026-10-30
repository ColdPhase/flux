#!/bin/sh
# Builds the documentation site (site/) in Docker and checks its links, the same way as the
# "Docs site" workflow. Pages come from docs/ and README.md through site/scripts/sync-docs.mjs;
# starlight-links-validator fails the build on a broken internal link or anchor.
#
#   ./scripts/check_docs_site.sh            # build into site/dist
#   ./scripts/check_docs_site.sh --serve    # build, then serve on http://127.0.0.1:${FLUX_DOCS_PORT:-33800}/flux/
set -eu
cd "$(dirname "$0")/.."
image="node@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1"
port="${FLUX_DOCS_PORT:-33800}"
command="npm ci --no-audit --no-fund && npm run build"
publish=""
if [ "${1:-}" = "--serve" ]; then
  command="$command && npx astro preview --host 0.0.0.0 --port 4321"
  publish="-p 127.0.0.1:$port:4321"
fi
# shellcheck disable=SC2086 # $publish is either empty or two words on purpose.
docker run --rm $publish --user "$(id -u):$(id -g)" -e HOME=/tmp -e ASTRO_TELEMETRY_DISABLED=1 \
  -v "$PWD:/repo" -w /repo/site "$image" sh -c "$command"

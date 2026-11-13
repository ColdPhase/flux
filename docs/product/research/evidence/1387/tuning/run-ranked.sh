#!/bin/sh
# usage: run-ranked.sh <image tag> <out.jsonl> [docker run args...]
tag=$1; out=$2; shift 2
d=$(cd "$(dirname "$0")" && pwd)  # this folder, with seed.json and cache.json beside the scripts
RUNNER=${RUNNER:-runner.mjs}; docker run -e RUNNER=$RUNNER --rm --network flux-1387-tune_default -v "$d:/work:ro,z" -w /app/packages/db \
  -e DATABASE_URL=postgres://flux:flux-1387-tune@db:5432/flux "$@" --user 0 --entrypoint sh flux-foundation:$tag -c 'cp /work/${RUNNER:-runner.mjs} /app/packages/db/${RUNNER:-runner.mjs} && node ${RUNNER:-runner.mjs}' > "$out"

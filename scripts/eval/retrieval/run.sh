#!/bin/sh
# The retrieval bench (#1242), in Docker: PostgreSQL (pg_search, pgvector, Polish Hunspell), text-embeddings-inference and
# Meilisearch on the same two CPUs, then the harness. Run it under the shared Docker slot limiter when other suites run.
#
#   scripts/eval/retrieval/run.sh                  seed, load, index, recall, write, access, tokens, deletion (default model)
#   BENCH_EMBED_MODEL=BAAI/bge-m3 BENCH_EMBED_MEMORY=4g scripts/eval/retrieval/run.sh load index recall
#   scripts/eval/retrieval/run.sh answer --mock    answer accuracy plumbing (answer.py); a real model: BENCH_LLM_URL/KEY/MODEL,
#     or BENCH_LLM_CONTAINER=strata BENCH_LLM_MODEL=<name> run.sh answer --build-summaries   (the container must already run)
#   scripts/eval/retrieval/run.sh down             stop and remove the bench containers (the model cache volume stays)
#
# Settings: BENCH_CPUS (the shared cpuset, default 20,21), COMPOSE_PROJECT_NAME (flux-v021-rag), BENCH_DB_PORT/BENCH_EMBED_PORT/
# BENCH_MEILI_PORT (25910-25912, loopback only), BENCH_EMBED_MODEL (intfloat/multilingual-e5-small), BENCH_EMBED_MEMORY (2g).
# Output: out/seed.json, out/results-<model>.json, out/stats-<model>.tsv (docker stats every 2 s: peak memory and CPU per service).
set -eu
cd "$(dirname "$0")"
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-flux-v021-rag}"
export BENCH_EMBED_MODEL="${BENCH_EMBED_MODEL:-intfloat/multilingual-e5-small}"
compose="docker compose -p $COMPOSE_PROJECT_NAME"
tag=$(printf '%s' "$BENCH_EMBED_MODEL" | tr '/' '_')
if [ "${1:-}" = down ]; then $compose --profile run down --remove-orphans; exit 0; fi
python3 seed.py
$compose --profile run build -q
$compose up -d --wait db meili
$compose up -d embed
# The model downloads on the first start (into the flux-v021-rag-hf volume); wait until it serves.
i=0; until docker logs "$($compose ps -q embed)" 2>&1 | grep -q Ready; do
  i=$((i+2)); sleep 2; [ $i -lt 900 ] || { echo "embedding server not ready after 15 min" >&2; exit 1; }
done
stats="out/stats-$tag.tsv"
( while :; do docker stats --no-stream --format '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}' $($compose ps -q db embed meili) \
    | sed "s/^/$(date +%s)\t/" >> "$stats"; sleep 2; done ) &
sampler=$!
trap 'kill $sampler 2>/dev/null || true' EXIT
if [ "${1:-}" = answer ]; then
  shift
  # A model in a container on this host (BENCH_LLM_CONTAINER, e.g. strata, started beforehand by whoever schedules the run):
  # attach it to the bench network as flux-model for the run, and read its key from BENCH_LLM_KEY_FILE inside it.
  if [ -n "${BENCH_LLM_CONTAINER:-}" ]; then
    docker network connect --alias flux-model "${COMPOSE_PROJECT_NAME}_default" "$BENCH_LLM_CONTAINER"
    trap 'docker network disconnect "${COMPOSE_PROJECT_NAME}_default" "$BENCH_LLM_CONTAINER" || true; kill $sampler 2>/dev/null || true' EXIT
    export BENCH_LLM_URL="${BENCH_LLM_URL:-http://flux-model:${BENCH_LLM_PORT:-8080}/v1}"
    export BENCH_LLM_KEY="${BENCH_LLM_KEY:-$(docker exec "$BENCH_LLM_CONTAINER" cat "${BENCH_LLM_KEY_FILE:-/data/state/api-key}")}"
  fi
  $compose run --rm -T -e BENCH_LLM_URL -e BENCH_LLM_KEY -e BENCH_LLM_MODEL -e BENCH_ANSWER_SEARCH harness python -u answer.py "$@"
  exit 0
fi
steps="${*:-load index recall write access tokens deletion}"
$compose run --rm -T harness python -u harness.py $steps --out "out/results-$tag.json"

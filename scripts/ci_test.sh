#!/bin/sh
# Runs targeted test modules on GitHub Actions instead of this host (founder direction, Hubert, 2026-11-12;
# docs/agents/ci-and-releases.md). It dispatches .github/workflows/test-modules.yml, waits for the run and prints
# the result lines of every shard and how to download the screenshots. The exit code is the run's result.
#
#   scripts/ci_test.sh [--shards N] <ref> <ui|live|api> <chromium|webkit> <module>...
#
# ref      a branch (an `origin/` prefix is dropped), a tag, HEAD or a commit SHA that is already pushed. It is resolved to
#          a full SHA first, so the run tests exactly that commit and a moving branch cannot change it.
# suite    ui   -> scripts/check_ui.sh <modules>           (test_docs, or Module.Class.test_name)
#          live -> scripts/check_live_ui.sh per module     (test_live_sessions; Chromium only)
#          api  -> scripts/check_application.sh <files>    (tests/app/search.test.ts)
# browser  chromium or webkit (live is Chromium only; api ignores it, pass chromium)
#
# Environment: FLUX_CI_SHARDS (default 1; the same as --shards), FLUX_CI_WORKFLOW_REF (the ref the workflow definition
# is read from, default main), FLUX_CI_OUT (where the result files are saved, default ~/flux-evidence/ci/<run id>),
# FLUX_CI_REPO (default: the repository of the current directory).
#
# Never start it on every push: a run is a few minutes of a shared runner. Do not rerun an unchanged commit and module set.
# Exit codes: 0 the run succeeded, 1 it failed, was cancelled or timed out, 2 wrong arguments, 3 it could not be dispatched or found.
set -eu

usage() {
  sed -n '2,/^set -eu/p' "$0" | sed -e '/^set -eu/d' -e 's/^# \{0,1\}//' >&2
  exit 2
}

shards="${FLUX_CI_SHARDS:-1}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --shards) [ "$#" -ge 2 ] || usage; shards=$2; shift 2 ;;
    --shards=*) shards=${1#--shards=}; shift ;;
    -h|--help) usage ;;
    --) shift; break ;;
    -*) printf 'unknown option: %s\n' "$1" >&2; exit 2 ;;
    *) break ;;
  esac
done
[ "$#" -ge 4 ] || usage
ref=$1 suite=$2 browser=$3
shift 3
case "$suite" in ui|live|api) ;; *) printf 'suite must be ui, live or api, not %s\n' "$suite" >&2; exit 2 ;; esac
case "$browser" in chromium|webkit) ;; *) printf 'browser must be chromium or webkit, not %s\n' "$browser" >&2; exit 2 ;; esac
if [ "$suite" = live ] && [ "$browser" != chromium ]; then
  echo 'the live suite runs Chromium only' >&2
  exit 2
fi
case "$shards" in ''|*[!0-9]*) echo 'shards must be a number from 1 to 8' >&2; exit 2 ;; esac
if [ "$shards" -lt 1 ] || [ "$shards" -gt 8 ]; then
  echo 'shards must be a number from 1 to 8' >&2
  exit 2
fi
for module in "$@"; do
  case "$module" in
    ''|*[!A-Za-z0-9_./-]*) printf 'not a module name: %s\n' "$module" >&2; exit 2 ;;
  esac
done
modules="$*"
ref=${ref#origin/}
case "$ref" in
  ''|-*|*[!A-Za-z0-9._/-]*|*..*) printf 'not a ref: %s\n' "$ref" >&2; exit 2 ;;
esac

command -v gh >/dev/null 2>&1 || { echo 'the GitHub CLI (gh) is needed' >&2; exit 3; }
repo=${FLUX_CI_REPO:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}
workflow_ref=${FLUX_CI_WORKFLOW_REF:-main}

# The commit to test: a SHA stays itself, a branch or tag becomes its head. It has to be on GitHub already.
if [ "$ref" = HEAD ]; then
  ref=$(git rev-parse HEAD)
fi
sha=
case "$ref" in
  *[!0-9a-f]*) ;;
  *) [ "${#ref}" -ge 7 ] && sha=$(gh api "repos/$repo/commits/$ref" --jq .sha 2>/dev/null || true) ;;
esac
if [ -z "$sha" ]; then
  sha=$(gh api "repos/$repo/git/ref/heads/$ref" --jq .object.sha 2>/dev/null || true)
fi
if [ -z "$sha" ]; then
  sha=$(gh api "repos/$repo/git/ref/tags/$ref" --jq '.object | if .type == "tag" then empty else .sha end' 2>/dev/null || true)
fi
if [ -z "$sha" ]; then
  printf 'ref %s is not on GitHub (%s); push it first\n' "$ref" "$repo" >&2
  exit 3
fi

request="ci-$(date +%s)-$$-$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')"
printf 'ci_test: %s %s %s shard(s) of %s @ %s\n' "$suite" "$browser" "$shards" "$modules" "$sha"
gh workflow run test-modules.yml -R "$repo" --ref "$workflow_ref" \
  -f "ref=$sha" -f "suite=$suite" -f "browser=$browser" -f "modules=$modules" -f "shards=$shards" -f "request_id=$request" >/dev/null \
  || { echo 'ci_test: the dispatch was refused (is test-modules.yml on the default branch?)' >&2; exit 3; }

# The run name carries the request id, so concurrent dispatches of other people are never mistaken for this one.
run_id=
attempt=0
while [ -z "$run_id" ] && [ "$attempt" -lt 40 ]; do
  sleep 3
  run_id=$(gh run list -R "$repo" --workflow test-modules.yml --event workflow_dispatch --limit 50 --json databaseId,displayTitle \
    --jq ".[] | select(.displayTitle | contains(\"$request\")) | .databaseId" 2>/dev/null | head -n 1 || true)
  attempt=$((attempt + 1))
done
if [ -z "$run_id" ]; then
  echo "ci_test: the run was dispatched but not found (request $request); see: gh run list -R $repo --workflow test-modules.yml" >&2
  exit 3
fi
printf 'ci_test: run https://github.com/%s/actions/runs/%s\n' "$repo" "$run_id"

# A line now and then while waiting (gh run watch itself repeats the whole screen without a terminal).
(
  waited=0
  while sleep 120; do
    waited=$((waited + 2))
    printf 'ci_test: still running after %s min\n' "$waited" >&2
  done
) &
ticker=$!
trap 'kill "$ticker" 2>/dev/null || true' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
gh run watch "$run_id" -R "$repo" --interval 20 --compact --exit-status >/dev/null 2>&1 || true
kill "$ticker" 2>/dev/null || true

conclusion=$(gh run view "$run_id" -R "$repo" --json conclusion --jq .conclusion)
echo
printf 'ci_test: run %s finished: %s\n' "$run_id" "$conclusion"
gh run view "$run_id" -R "$repo" --json jobs --jq '.jobs[] | select(.conclusion != "skipped") | "  \(.name): \((.conclusion | select(. != "")) // .status), \(
  if (.startedAt | startswith("0001")) or (.completedAt | startswith("0001")) then "-" else (((.completedAt | fromdateiso8601) - (.startedAt | fromdateiso8601)) | tostring) end) s"' || true
gh run view "$run_id" -R "$repo" --json createdAt,updatedAt --jq '"  wall time: \((.updatedAt | fromdateiso8601) - (.createdAt | fromdateiso8601)) s (queue, build and tests)"' || true

out=${FLUX_CI_OUT:-$HOME/flux-evidence/ci/$run_id}
mkdir -p "$out"
downloaded=0
if gh run download "$run_id" -R "$repo" --pattern 'result-*' --dir "$out" >/dev/null 2>&1; then
  downloaded=1
  for result in "$out"/result-shard-*; do
    [ -f "$result/result.txt" ] || continue
    printf '\n--- %s ---\n' "$(basename "$result")"
    cat "$result/result.txt"
  done
  printf '\nci_test: result, command and the log tail (run.log.gz) of each shard: %s\n' "$out"
else
  # The plan or the build failed before any test ran: the error annotations say why (the whole failed step is far longer).
  printf '\nci_test: no result artifact (the plan or the build failed before any test ran). Why:\n'
  failed=$(gh run view "$run_id" -R "$repo" --log-failed 2>/dev/null | sed -e 's/\x1b\[[0-9;]*[A-Za-z]//g' || true)
  errors=$(printf '%s\n' "$failed" | grep -F '##[error]' | cut -f3- | sed -e 's/^[^ ]* //' || true)
  if [ -n "$errors" ]; then printf '%s\n' "$errors"; else printf '%s\n' "$failed" | tail -n 30; fi
fi
if [ "$downloaded" = 1 ] && [ "$suite" != api ]; then
  printf 'ci_test: screenshots: gh run download %s -R %s --pattern "screenshots-*" --dir %s\n' "$run_id" "$repo" "$out"
fi
printf 'ci_test: whole log: gh run view %s -R %s --log\n' "$run_id" "$repo"

[ "$conclusion" = success ]

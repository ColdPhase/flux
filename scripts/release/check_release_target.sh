#!/usr/bin/env bash
# Check both the draft/published release target and any remote tag's peeled commit.
set -euo pipefail

version=${1:?release version required}
source_sha=${2:?source SHA required}
state=${3:?draft or published required}
[[ "$version" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-rc\.[1-9][0-9]*)?$ ]]
[[ "$source_sha" =~ ^[0-9a-f]{40}$ ]]
[[ "$state" == draft || "$state" == published ]]
repo_root=${GITHUB_WORKSPACE:-$(git rev-parse --show-toplevel)}

expected_draft=true
if [[ "$state" == published ]]; then expected_draft=false; fi
gh release view "$version" --repo "${GITHUB_REPOSITORY:?}" \
  --json isDraft,tagName,targetCommitish | \
  jq -e --arg version "$version" --arg source "$source_sha" \
    --argjson draft "$expected_draft" \
    '.isDraft == $draft and .tagName == $version and .targetCommitish == $source' \
    >/dev/null

# A draft may not have created its tag yet. If it has, the peeled remote commit
# must still be the reviewed source. Never trust the asset metadata alone.
remote_tag=$(git -C "$repo_root" ls-remote --tags --refs origin "refs/tags/$version")
if [[ -n "$remote_tag" ]]; then
  git -C "$repo_root" fetch --quiet --no-tags origin "refs/tags/$version"
  test "$(git -C "$repo_root" rev-parse --verify 'FETCH_HEAD^{commit}')" = "$source_sha"
elif [[ "$state" == published ]]; then
  echo 'Published release is missing its remote version tag.' >&2
  exit 1
fi

#!/usr/bin/env bash
# Point the never-retag GHCR version tag at the reviewed digest, or confirm that it already does.
set -euo pipefail

version=${1:?release version required}
digest=${2:?image digest required}
[[ "$version" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-rc\.[1-9][0-9]*)?$ ]]
[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]
image=ghcr.io/coldphase/flux
tag="$image:$version"

# Only the registry's "not found" means the tag is free. Another inspect failure (network, rate
# limit, authorization) is not absence: creating the tag then could move an existing one.
if inspect_error=$(docker buildx imagetools inspect "$tag" 2>&1 >/dev/null); then
  echo 'Version image tag already exists; never retag it.' >&2
elif [[ "$inspect_error" == *"$tag: not found"* ]]; then
  docker buildx imagetools create --prefer-index=false --tag "$tag" "$image@$digest"
else
  printf '%s\n' "$inspect_error" >&2
  echo 'Could not read the version image tag; not assuming it is unused.' >&2
  exit 1
fi
actual=$(docker buildx imagetools inspect "$tag" --format '{{json .Manifest}}' | jq -r .digest)
test "$actual" = "$digest"

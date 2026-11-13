#!/bin/sh
# Unpacks a release's flux.tar.gz the way an owner does (#1471 decision 5; docs/operations/install.md) and prints the install folder.
#
#   scripts/release/unpack_release.sh <release asset directory> <empty destination directory>
#
# The archive is checked against the release's SHA256SUMS first. The folder's docker/release.env names the images; a script that runs
# docker compose on the folder's files without ./flux exports them first: set -a; . "$folder/docker/release.env"; set +a
set -eu
assets=${1:?release asset directory required}
destination=${2:?destination directory required}
expected=$(awk '$2 == "flux.tar.gz" { print $1 }' "$assets/SHA256SUMS")
if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$assets/flux.tar.gz" | cut -d' ' -f1)
else actual=$(shasum -a 256 "$assets/flux.tar.gz" | cut -d' ' -f1); fi
[ -n "$expected" ] && [ "$actual" = "$expected" ] || { echo "unpack_release: $assets/flux.tar.gz does not match its SHA256SUMS" >&2; exit 1; }
mkdir -p "$destination"
[ -z "$(ls -A "$destination")" ] || { echo "unpack_release: $destination is not empty" >&2; exit 1; }
tar -xzf "$assets/flux.tar.gz" -C "$destination"
[ -x "$destination/flux/flux" ] && [ -f "$destination/flux/docker/release.env" ] || { echo "unpack_release: no flux/flux and flux/docker/release.env" >&2; exit 1; }
CDPATH='' cd -- "$destination/flux" && pwd -P

#!/bin/sh
# Checks that release images were signed by Flux's release workflow (#840).
#
#   scripts/release/verify_signatures.sh ghcr.io/coldphase/flux@sha256:<digest> [ghcr.io/coldphase/flux-agent-runtime@sha256:<digest> ...]
#
# Each image must be named by digest (a tag can move) and must carry a keyless Sigstore signature whose certificate says it was made by
# this repository's `final-release.yml` workflow on `main`, with GitHub's OIDC issuer. This is the check publish-release.yml makes
# before a draft becomes a release, and the one operators make before `docker pull` (docs/operations/release-guide.md). It needs
# `cosign` v3 or later on the PATH (the release is signed with v3) and, for ghcr.io, a Docker login if the images are private.
#
# FLUX_RELEASE_REPOSITORY (default ColdPhase/flux) names the repository whose workflow signed. FLUX_COSIGN_KEY (a public key file) and
# FLUX_COSIGN_VERIFY_ARGS are for scripts/release/check_signing.sh only: they swap the keyless identity for a test key.
# Exit 0: every image verified. 1: one did not. 2: the call itself was wrong.
set -eu

[ "$#" -ge 1 ] || { echo "usage: $0 IMAGE@sha256:DIGEST [IMAGE@sha256:DIGEST ...]" >&2; exit 2; }
repository="${FLUX_RELEASE_REPOSITORY:-ColdPhase/flux}"
# The certificate's identity is the workflow file at its ref; a dispatch from main is the only way the release workflow runs.
identity="^https://github\\.com/$(printf '%s' "$repository" | sed 's/[.]/\\./g')/\\.github/workflows/final-release\\.yml@refs/heads/main\$"
issuer="https://token.actions.githubusercontent.com"

for image in "$@"; do
  case "$image" in
    *@sha256:????????????????????????????????????????????????????????????????) ;;
    *) echo "$image is not an image@sha256:<64 hex digits> reference; a tag can move, so only a digest is checked" >&2; exit 2 ;;
  esac
done
status=0
for image in "$@"; do
  if [ -n "${FLUX_COSIGN_KEY:-}" ]; then
    # shellcheck disable=SC2086
    cosign verify --key "$FLUX_COSIGN_KEY" ${FLUX_COSIGN_VERIFY_ARGS:-} "$image" > /dev/null || status=1
  else
    cosign verify --certificate-identity-regexp "$identity" --certificate-oidc-issuer "$issuer" "$image" > /dev/null || status=1
  fi
  if [ "$status" -ne 0 ]; then
    echo "NOT VERIFIED: $image has no signature from $repository's final-release.yml on main" >&2
    exit "$status"
  fi
  echo "verified: $image"
done

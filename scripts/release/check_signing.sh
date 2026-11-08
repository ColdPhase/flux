#!/bin/sh
# Release signing, tried locally (#840): what a release does with cosign, against a throwaway registry and a throwaway key, in Docker.
#
# The real thing is keyless (GitHub OIDC) and runs only in final-release.yml, so a signature from a real release cannot be made
# here. This proves the rest: that the images are signed by digest, that scripts/release/verify_signatures.sh (the check publish-release.yml
# and operators make) accepts a signed digest and refuses an unsigned one, a digest signed by another key, a tag, and an image whose
# signature belongs to another digest of the same repository. The script's keyless command line is checked by tests/test_release_signing.py.
#
# Ports: FLUX_SIGNING_TEST_PORT (default 25900) is the registry on 127.0.0.1. Nothing is left behind.
set -eu

cd "$(dirname "$0")/../.."
# cosign v3.0.6 and the registry (distribution 3), by digest.
cosign_image="ghcr.io/sigstore/cosign/cosign@sha256:de9c65609e6bde17e6b48de485ee788407c9502fa08b8f4459f595b21f56cd00"
registry_image="registry@sha256:38907510915c3f1604c7e83d6ab602ab3020d092f73bdaed8696773693ff768c"
port="${FLUX_SIGNING_TEST_PORT:-25900}"
run_id="fluxsign$$"
work=$(mktemp -d)
chmod 0777 "$work"
registry="$run_id-registry"
local_registry="127.0.0.1:$port"

cleanup() {
  status=$?
  docker rm -f "$registry" >/dev/null 2>&1 || true
  docker image rm -f "$local_registry/flux:signed" "$local_registry/flux:unsigned" "$local_registry/flux-agent-runtime:signed" >/dev/null 2>&1 || true
  rm -rf "$work"
  exit $status
}
trap cleanup EXIT HUP INT TERM

step() { printf '\n== %s\n' "$*"; }
expect_fail() { # description, command...
  description=$1; shift
  if "$@" >"$work/out" 2>&1; then echo "FAILED: $description was accepted" >&2; cat "$work/out" >&2; exit 1; fi
  echo "ok: $description"
}

# `cosign` for verify_signatures.sh: the pinned image, on the host network so 127.0.0.1 is the registry.
mkdir -p "$work/bin"
cat > "$work/bin/cosign" <<SHIM
#!/bin/sh
exec docker run --rm --network host --user "$(id -u):$(id -g)" -e COSIGN_PASSWORD= -e HOME=/tmp -v "$work:/keys:rw,z" "$cosign_image" "\$@"
SHIM
chmod +x "$work/bin/cosign"
PATH="$work/bin:$PATH"
export PATH

step "Throwaway registry on $local_registry"
docker run -d --name "$registry" -p "127.0.0.1:$port:5000" "$registry_image" >/dev/null
for _ in $(seq 1 30); do curl -fsS "http://$local_registry/v2/" >/dev/null 2>&1 && break; sleep 1; done
curl -fsS "http://$local_registry/v2/" >/dev/null

push() { # repository tag marker
  printf 'FROM scratch\nCOPY marker /marker\n' > "$work/Dockerfile"
  printf '%s\n' "$3" > "$work/marker"
  docker build --quiet -t "$local_registry/$1:$2" -f "$work/Dockerfile" "$work" >/dev/null
  docker push --quiet "$local_registry/$1:$2" >/dev/null
}
digest_of() { # repository tag: the digest the registry serves
  curl -fsSI -H 'Accept: application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' \
    "http://$local_registry/v2/$1/manifests/$2" | tr -d '\r' | sed -n 's/^[Dd]ocker-[Cc]ontent-[Dd]igest: *//p'
}

step "Two images and an unsigned one"
push flux signed "release image $run_id"
push flux-agent-runtime signed "runtime image $run_id"
push flux unsigned "never signed $run_id"
flux="$local_registry/flux@$(digest_of flux signed)"
runtime="$local_registry/flux-agent-runtime@$(digest_of flux-agent-runtime signed)"
unsigned="$local_registry/flux@$(digest_of flux unsigned)"
echo "$flux"; echo "$runtime"; echo "$unsigned"

step "Sign both digests with a test key (no transparency log: this is not the real release)"
cosign generate-key-pair --output-key-prefix /keys/test >/dev/null
cosign generate-key-pair --output-key-prefix /keys/other >/dev/null
cosign sign --yes --key /keys/test.key --tlog-upload=false --use-signing-config=false --allow-insecure-registry "$flux" "$runtime"

export FLUX_COSIGN_VERIFY_ARGS="--allow-insecure-registry --insecure-ignore-tlog=true"
step "verify_signatures.sh"
FLUX_COSIGN_KEY=/keys/test.pub scripts/release/verify_signatures.sh "$flux" "$runtime"
expect_fail "an image that was never signed" env FLUX_COSIGN_KEY=/keys/test.pub scripts/release/verify_signatures.sh "$unsigned"
expect_fail "a digest signed with another key" env FLUX_COSIGN_KEY=/keys/other.pub scripts/release/verify_signatures.sh "$flux"
expect_fail "a tag instead of a digest" env FLUX_COSIGN_KEY=/keys/test.pub scripts/release/verify_signatures.sh "$local_registry/flux:signed"
expect_fail "one signed and one unsigned image in the same call" env FLUX_COSIGN_KEY=/keys/test.pub scripts/release/verify_signatures.sh "$flux" "$unsigned"
# A signature belongs to a digest: pushing different content under the signed tag does not carry it over.
push flux signed "changed after signing $run_id"
changed="$local_registry/flux@$(digest_of flux signed)"
test "$changed" != "$flux"
expect_fail "new content under the signed tag" env FLUX_COSIGN_KEY=/keys/test.pub scripts/release/verify_signatures.sh "$changed"
FLUX_COSIGN_KEY=/keys/test.pub scripts/release/verify_signatures.sh "$flux" >/dev/null
echo "ok: the signed digest still verifies"
echo "Release signing check passed."

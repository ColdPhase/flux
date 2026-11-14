#!/usr/bin/env bash
# The owner's install path of a release, end to end (#1471, founder decision 5; docs/operations/install.md), with the release's own
# images: the documented commands, then backup, restore, an upgrade by ./flux upgrade and its refusal of a damaged download.
#
#   smoke_launcher.sh <release asset directory> <state directory> <project>
#
#   1. Install: check flux.tar.gz against SHA256SUMS, unpack it, ./flux up (no terminal: nothing is asked). The images are pulled, not
#      built; every Flux container runs an image of docker/release.env; docker/.env has new secrets, push keys and no fixture token.
#   2. ./flux backup, then ./flux restore of that archive: Flux is healthy again on the same data.
#   3. ./flux upgrade from a release URL (FLUX_RELEASE_URL, here a file:// folder with GitHub's layout): an archive that does not match
#      its SHA256SUMS, and one whose SHA256SUMS is signed by another key, are refused with nothing changed and Flux running; the "next
#      release" (this candidate packaged again under another source commit, with the same images) is downloaded, checked, its signature
#      verified, backed up, put in place and migrated; the previous files are kept. The signature check is the launcher's own, through
#      the pinned cosign image (no cosign on the PATH here), with a throwaway key in place of the release workflow's identity
#      (FLUX_TEST_COSIGN_KEY: the real identity only signs on GitHub, after this job).
#   4. ./flux clean -y removes the project.
# Port defaults to 18084 (FLUX_SMOKE_LAUNCHER_PORT). The images must be pullable (a docker login for private packages).
set -euo pipefail

assets=$(realpath "${1:?release asset directory required}")
state=${2:?state directory required}
project=${3:?project name required}
port=${FLUX_SMOKE_LAUNCHER_PORT:-18084}
root=$(cd "$(dirname "$0")/../.." && pwd)
mkdir -p "$state"
state=$(realpath "$state")
fail() { echo "smoke_launcher: $*" >&2; exit 1; }
step() { printf '\n== %s\n' "$*"; }
json_field() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$1" "$2"; }
health() { curl --fail --show-error --silent "http://127.0.0.1:$port/api/v1/health"; }
folder="$state/owner/flux"
cleanup() {
  status=$?
  if [ -x "$folder/flux" ]; then
    if [ "$status" -ne 0 ]; then docker logs --tail 40 "$project-api-1" >&2 2>&1 || true; fi
    (cd "$folder" && ./flux clean -y >/dev/null 2>&1) || true
  fi
  exit "$status"
}
trap cleanup EXIT

version=$(json_field "$assets/release.json" version)
app=$(json_field "$assets/release.json" image)
database=$(json_field "$assets/release.json" database_image)

step "1. Install as docs/operations/install.md says: check, unpack, ./flux up"
mkdir -p "$state/owner" "$state/download"
cp "$assets/flux.tar.gz" "$assets/SHA256SUMS" "$state/download/"
( cd "$state/download" && sha256sum --ignore-missing -c SHA256SUMS )
tar -xzf "$state/download/flux.tar.gz" -C "$state/owner"
cd "$folder"
FLUX_PORT=$port FLUX_PROJECT=$project ./flux up </dev/null 2>&1 | tee "$state/up.log"
! grep -q 'Building Flux' "$state/up.log" || fail "a release built its images"
health; echo
grep -q '^FLUX_FIXTURE_TOKEN=$' docker/.env || fail "a release turned the integration fixtures on"
grep -q '^FLUX_VAPID_PUBLIC_KEY=.' docker/.env || fail "no push keys were generated"
[ "$(stat -c %a docker/.env 2>/dev/null || stat -f %Lp docker/.env)" = 600 ] || fail "docker/.env is not private"
for service in api worker keyring; do
  [ "$(docker inspect -f '{{.Config.Image}}' "$project-$service-1")" = "$app" ] || fail "$service does not run $app"
done
[ "$(docker inspect -f '{{.Config.Image}}' "$project-db-1")" = "$database" ] || fail "db does not run $database"
FLUX_PORT=$port ./flux up </dev/null > "$state/up-again.log" 2>&1 || { cat "$state/up-again.log"; fail "the second ./flux up failed"; }
! grep -q 'Downloading' "$state/up-again.log" || fail "the second ./flux up downloaded the images again"

step "2. ./flux backup and ./flux restore"
./flux backup --output "$state/backups" 2>&1 | tail -n 3
archive=$(ls "$state"/backups/flux-backup-*.tar | head -n 1)
./flux restore "$archive" -y 2>&1 | tail -n 3
health >/dev/null || fail "Flux is not healthy after the restore"

step "3. ./flux upgrade from a release URL: a damaged archive is refused, the next release is installed"
web="$state/web"
# The next release: this candidate, packaged again under another source commit (the images stay; the files and release.env change).
printf '{"packages":[{"name":"smoke","versionInfo":"1"}]}\n' > "$state/sbom.json"
registry=${app%/flux@*}
python3 "$root/scripts/release/prepare_assets.py" --version "$version" --source-sha "$(printf 'f%.0s' $(seq 40))" \
  --digest "${app#*@}" --runtime-digest "$(json_field "$assets/release.json" runtime_image | sed 's/.*@//')" \
  --database-digest "${database#*@}" --sbom "$state/sbom.json" --runtime-sbom "$state/sbom.json" --database-sbom "$state/sbom.json" \
  --source "$root" --registry "$registry" --destination "$web/download/next" >/dev/null
# A throwaway key pair signs the next release's SHA256SUMS the way the sign job does (sign-blob with a bundle), with the cosign image
# the launcher pins; "other" signs a copy that must be refused.
cosign_image=$(sed -n 's/^COSIGN_IMAGE=//p' "$folder/flux")
keys="$state/keys"
mkdir -p "$keys"
cosign() { docker run --rm --user "$(id -u):$(id -g)" -e COSIGN_PASSWORD= -e HOME=/tmp --tmpfs /tmp -v "$keys:/keys:rw,z" "$cosign_image" "$@"; }
cosign generate-key-pair --output-key-prefix /keys/test >/dev/null 2>&1
cosign generate-key-pair --output-key-prefix /keys/other >/dev/null 2>&1
sign() { # release folder, key name
  cp "$1/SHA256SUMS" "$keys/SHA256SUMS"
  cosign sign-blob --yes --key "/keys/$2.key" --tlog-upload=false --use-signing-config=false --bundle /keys/bundle.json /keys/SHA256SUMS >/dev/null 2>&1
  cp "$keys/bundle.json" "$1/SHA256SUMS.sigstore.json"
}
sign "$web/download/next" test
mkdir -p "$web/download/v0.0.1" "$web/download/v9.9.9" "$web/latest"
cp "$web/download/next/"* "$web/download/v0.0.1/"
printf x >> "$web/download/v0.0.1/flux.tar.gz"
cp "$web/download/next/"* "$web/download/v9.9.9/"
sign "$web/download/v9.9.9" other
ln -s ../download/next "$web/latest/download"
export FLUX_TEST_COSIGN_KEY="$keys/test.pub"
before=$(find . -type f -not -name .env -not -path './backups/*' -exec sha256sum {} + | sort | sha256sum)
if FLUX_RELEASE_URL="file://$web" ./flux upgrade v0.0.1 -y --output "$state/backups" > "$state/refused.log" 2>&1; then
  cat "$state/refused.log"; fail "./flux upgrade accepted an archive that does not match SHA256SUMS"
fi
grep -q 'flux.tar.gz does not match SHA256SUMS' "$state/refused.log" || { cat "$state/refused.log"; fail "the refusal does not say why"; }
[ "$(find . -type f -not -name .env -not -path './backups/*' -exec sha256sum {} + | sort | sha256sum)" = "$before" ] || fail "a refused upgrade changed files"
[ ! -e .flux-upgrade ] || fail "a refused upgrade left its staging folder"
health >/dev/null || fail "Flux stopped for a refused upgrade"
echo "refused: $(grep -o 'flux.tar.gz does not match SHA256SUMS' "$state/refused.log")"
if FLUX_RELEASE_URL="file://$web" ./flux upgrade v9.9.9 -y --output "$state/backups" > "$state/refused-signature.log" 2>&1; then
  cat "$state/refused-signature.log"; fail "./flux upgrade accepted a SHA256SUMS signed by another key"
fi
grep -q 'SHA256SUMS does not verify as signed by Flux' "$state/refused-signature.log" || { cat "$state/refused-signature.log"; fail "the signature refusal does not say why"; }
[ "$(find . -type f -not -name .env -not -path './backups/*' -exec sha256sum {} + | sort | sha256sum)" = "$before" ] || fail "a refused signature changed files"
[ ! -e .flux-upgrade ] || fail "a refused signature left its staging folder"
health >/dev/null || fail "Flux stopped for a refused signature"
echo "refused: $(grep -o 'SHA256SUMS does not verify as signed by Flux.s release workflow' "$state/refused-signature.log")"
FLUX_RELEASE_URL="file://$web" ./flux upgrade -y --output "$state/backups" 2>&1 | tee "$state/upgrade.log"
grep -q '^Checked Flux ' "$state/upgrade.log" || fail "the upgrade did not check the archive"
grep -q "^Verified the release's signature" "$state/upgrade.log" || fail "the upgrade did not verify the signature"
grep -q '^Upgraded ' "$state/upgrade.log" || fail "the upgrade did not finish"
grep -q '^FLUX_RELEASE_COMMIT=ffffffffffffffffffffffffffffffffffffffff$' docker/release.env || fail "the new release's files are not in place"
ls "$state"/backups/flux-files-"$version"-*.tar.gz >/dev/null || fail "the previous release's files were not kept"
[ ! -e .flux-upgrade ] || fail "the upgrade left its staging folder"
health; echo
FLUX_RELEASE_URL="file://$web" ./flux upgrade -y 2>&1 | grep -q 'already runs Flux' || fail "a second upgrade to the same release did something"

step "4. ./flux clean"
./flux clean -y > /dev/null
[ -z "$(docker ps -aq --filter "label=com.docker.compose.project=$project")" ] || fail "containers remain after ./flux clean"
echo "The owner's path of Flux $version passed: install, backup, restore, two refused upgrades (checksum, signature), a completed one, clean."

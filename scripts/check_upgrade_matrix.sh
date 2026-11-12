#!/usr/bin/env bash
# Upgrade matrix (#1241): an instance installed from ANY release from v0.2.0 on upgrades to this candidate, and every release proves it.
# In Docker, on throwaway Compose projects, volumes and ports; it publishes nothing and never touches another project.
#
#   scripts/check_upgrade_matrix.sh
#
# 1. The released migrations are byte-identical to their tags (scripts/release/check_released_migrations.py).
# 2. For every published release from v0.2.0 on (gh release list; v0.1 is not upgraded, #1176) before the candidate:
#      a. RELEASE INSTALLATION: the release's own assets are downloaded and checked against SHA256SUMS, the release is installed
#         from them (compose.yaml, its image by digest, env.example), seeded through its API (scripts/release/smoke_data.py:
#         people and a guest, spaces with an encrypted one, threads, direct messages, files, wiki history, a map, tasks with due dates
#         and waits, notification settings, a second device, an AI connection with an API key, an agent with memory and schedules and a
#         completed run, on a provider mock), backed up, and upgraded to the candidate by the release guide's steps. Then everything
#         is read back, the second device's session still works, the encrypted space unlocks, a schedule's next times lie ahead and
#         the instance accepts new work, including a new agent run on the mock. The upgraded instance and the pre-upgrade backup are
#         restored into fresh volumes (scripts/release/smoke_artifacts.sh, leg 2).
#      b. SOURCE CHECKOUT: the release's source tree is started with ./flux up, seeded the same way, replaced by the candidate's tree,
#         and moved with ./flux upgrade -y; everything is read back and written to again.
#    Each release goes straight to the candidate, so every release but the newest also proves that versions can be skipped.
# 3. A migration that breaks old data is added to the candidate: against the oldest release the upgrade must stop, API and worker must
#    not start, and the paired backup taken with the old files must restore into fresh volumes and read back (smoke_artifacts.sh leg 3).
#
# The candidate is the working tree (committed or not), built into an image and pushed by digest to a throwaway registry on
# 127.0.0.1 and rendered into release assets by prepare_assets.py, as dry_run.sh does, or the assets that FLUX_MATRIX_CANDIDATE_ASSETS
# names (the release workflow's own `release-assets`, whose image is on ghcr.io).
#
# Negative controls (each makes the check fail; run with FLUX_MATRIX_CONTROL=<name>, the run succeeds only when the check refuses):
#   edited-migration   a released migration file is changed in a copy of the tree: check_released_migrations.py must refuse it.
#   old-data           a migration that works on an empty database and fails on the data of a release is added to the candidate:
#                      the upgrade must fail at the migration (smoke_artifacts.sh with FLUX_SMOKE_INJECT=old-data).
#
# Environment:
#   FLUX_MATRIX_PORT=25800          registry on +9; installations +1 and +2 (one after another); source checkouts +3 to +5
#   FLUX_MATRIX_PROJECT=fluxupg<pid>  prefix of the Compose projects, the registry container and the images of the source checkouts
#   FLUX_MATRIX_ONLY="v0.2.0 ..."   only these releases (default every published release from v0.2.0 on before the candidate)
#   FLUX_MATRIX_RELEASES_DIR=DIR    DIR/<tag>/ holds the release's downloaded assets (default: gh release download)
#   FLUX_MATRIX_CANDIDATE_ASSETS=DIR, FLUX_MATRIX_VERSION=vX.Y.Z   the candidate's assets, and its version when it is built here
#   FLUX_MATRIX_SOURCE=0            skip the source-checkout legs; FLUX_MATRIX_RELEASE_INSTALL=0 skips the release-installation legs.
#                                   A skipped leg is listed as SKIPPED in the result and the run says it is not the full matrix; it never
#                                   writes FLUX_MATRIX_TESTED_FILE, so a release cannot claim an upgrade that was not tested.
#   FLUX_MATRIX_TESTED_FILE=FILE    on success, the releases that were tested, space separated (the release notes say them)
#   FLUX_MATRIX_DUMP_DIR=DIR        also writes each release's seeded database as DIR/<tag>.sql.gz (the fixtures of
#                                   app/tests/app/released-databases.test.ts)
# Run it alone (concurrent Docker suites time out), through the slot limiter on a shared host. Needs docker with Compose, python3, git, gh.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
base=${FLUX_MATRIX_PORT:-25800}
run_id=${FLUX_MATRIX_PROJECT:-fluxupg$$}
control=${FLUX_MATRIX_CONTROL:-}
only=${FLUX_MATRIX_ONLY:-}
registry_port=$((base + 9))
registry="$run_id-registry"
step() { printf '\n== %s\n' "$*"; }
fail() { echo "check_upgrade_matrix: $*" >&2; exit 1; }
sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }
case "$control" in ''|edited-migration|old-data) ;; *) fail "FLUX_MATRIX_CONTROL is 'edited-migration' or 'old-data', not '$control'" ;; esac
work=$(mktemp -d "${TMPDIR:-/tmp}/flux-upgrade-matrix.XXXXXX")
work=$(cd "$work" && pwd -P)
results="$work/results"
: > "$results"
cleanup() {
  status=$?
  for checkout in "$work"/src-*; do
    [ -x "$checkout/flux" ] && [ -f "$checkout/docker/.env" ] && "$checkout/flux" clean -y >/dev/null 2>&1 || true
  done
  docker ps -aq --filter "name=$run_id-" | xargs -r docker rm -fv >/dev/null 2>&1 || true
  for project in $(docker ps -a --format '{{.Label "com.docker.compose.project"}}' | grep "^$run_id" | sort -u); do
    docker ps -aq --filter "label=com.docker.compose.project=$project" | xargs -r docker rm -fv >/dev/null 2>&1 || true
    docker volume ls -q --filter "label=com.docker.compose.project=$project" | xargs -r docker volume rm -f >/dev/null 2>&1 || true
    docker network ls -q --filter "label=com.docker.compose.project=$project" | xargs -r docker network rm >/dev/null 2>&1 || true
  done
  docker rm -f "$registry" >/dev/null 2>&1 || true
  docker image rm -f "127.0.0.1:$registry_port/flux:matrix" >/dev/null 2>&1 || true
  rm -rf "$work"
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

step "Preflight"
docker info >/dev/null 2>&1 || fail "the Docker daemon is not reachable (this check never restarts it)"
docker compose version >/dev/null
echo "Docker $(docker info --format '{{.ServerVersion}}'); candidate: $(git -C "$root" rev-parse --short HEAD)$([ -z "$(git -C "$root" status --porcelain)" ] || echo ' + uncommitted changes (the working tree is the candidate)')"

step "1. Released migrations are byte-identical to their release tags"
if [ "$control" = edited-migration ]; then
  mkdir "$work/edited"
  cp "$root"/app/packages/db/migrations/*.sql "$work/edited/"
  first=$(ls "$work/edited" | head -n 1)
  printf -- '-- edited after release\n' >> "$work/edited/$first"
  if python3 "$root/scripts/release/check_released_migrations.py" --tree "$work/edited" > "$work/control.out" 2>&1; then
    cat "$work/control.out"; fail "NEGATIVE CONTROL FAILED: an edited released migration ($first) was accepted"
  fi
  cat "$work/control.out"
  grep -q "$first differs from the file of" "$work/control.out" || fail "the refusal does not name the edited file"
  echo "NEGATIVE CONTROL PASSED: the edited released migration $first was refused"
  exit 0
fi
python3 "$root/scripts/release/check_released_migrations.py"

step "2. The releases to upgrade from"
mkdir -p "$work/releases"
if [ -n "${FLUX_MATRIX_CANDIDATE_ASSETS:-}" ]; then
  candidate_assets=$(cd "$FLUX_MATRIX_CANDIDATE_ASSETS" && pwd -P)
  candidate_version=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$candidate_assets/release.json")
else
  candidate_assets=""
  candidate_version=${FLUX_MATRIX_VERSION:-}
fi
if [ -n "${FLUX_MATRIX_RELEASES_DIR:-}" ]; then
  published=$(ls "$FLUX_MATRIX_RELEASES_DIR" | python3 -c 'import json,sys; print(json.dumps([{"tagName": l.strip(), "isDraft": False} for l in sys.stdin if l.strip()]))')
else
  published=$(gh release list --limit 200 --json tagName,isDraft)
fi
printf '%s' "$published" > "$work/published.json"
[ -n "$candidate_version" ] || candidate_version=$(python3 "$root/scripts/release/release_versions.py" next --releases "$work/published.json")
releases=$(python3 "$root/scripts/release/release_versions.py" from --candidate "$candidate_version" --releases "$work/published.json")
if [ -n "$only" ]; then
  filtered=""
  for tag in $releases; do case " $only " in *" $tag "*) filtered="$filtered $tag" ;; esac; done
  releases=$filtered
fi
releases=$(printf '%s\n' $releases)
[ -n "$releases" ] || { echo "No release from v0.2.0 on comes before $candidate_version: nothing to upgrade from."; exit 0; }
oldest=$(printf '%s\n' "$releases" | head -n 1)
echo "candidate $candidate_version upgrades from: $(printf '%s ' $releases)(oldest: $oldest; every one goes straight to the candidate)"

for tag in $releases; do
  dir="$work/releases/$tag"
  if [ -n "${FLUX_MATRIX_RELEASES_DIR:-}" ]; then cp -r "$FLUX_MATRIX_RELEASES_DIR/$tag" "$dir"; else mkdir "$dir"; gh release download "$tag" --dir "$dir" >/dev/null; fi
  ( cd "$dir" && sha256 -c SHA256SUMS >/dev/null ) || fail "$tag's assets do not match its SHA256SUMS"
  echo "$tag: $(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d["source_sha"][:9], d["image"].split("@")[1][:19])' "$dir/release.json")"
done

if [ -z "$candidate_assets" ]; then
  step "The candidate: the image built from this tree, pushed by digest to a throwaway registry, rendered into release assets"
  docker run -d --name "$registry" -p "127.0.0.1:$registry_port:5000" registry:2 >/dev/null
  for _ in $(seq 1 30); do curl -fsS "http://127.0.0.1:$registry_port/v2/" >/dev/null 2>&1 && break; sleep 1; done
  mkdir "$work/candidate-src"
  (cd "$root" && git ls-files -z --cached --others --exclude-standard | tar --null -T - -cf -) | (cd "$work/candidate-src" && tar -xf -)
  sha=$(git -C "$root" rev-parse HEAD)
  platform="linux/$(docker version --format '{{.Server.Arch}}')"
  ( cd "$work/candidate-src" && docker buildx build --platform "$platform" --target runtime -f docker/Dockerfile \
      --label "org.opencontainers.image.revision=$sha" --label "org.opencontainers.image.version=$candidate_version" \
      -t "127.0.0.1:$registry_port/flux:matrix" --load --progress plain app ) > "$work/build.log" 2>&1 || { tail -n 40 "$work/build.log"; fail "the candidate image did not build"; }
  docker push "127.0.0.1:$registry_port/flux:matrix" > "$work/push.log" 2>&1 || { cat "$work/push.log"; fail "push to the throwaway registry failed"; }
  digest=$(curl -fsSI -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' \
    "http://127.0.0.1:$registry_port/v2/flux/manifests/matrix" | tr -d '\r' | sed -n 's/^[Dd]ocker-[Cc]ontent-[Dd]igest: *//p')
  [ -n "$digest" ] || fail "the registry did not report the candidate's digest"
  # The SBOMs and the agent-runtime image are not under test: the newest release's stand in, so that the asset set renders.
  newest=$(printf '%s\n' "$releases" | tail -n 1)
  runtime_digest=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["runtime_image"].split("@")[1])' "$work/releases/$newest/release.json")
  ( cd "$work/candidate-src" && python3 scripts/release/prepare_assets.py --version "$candidate_version" --source-sha "$sha" --digest "$digest" \
      --sbom "$work/releases/$newest/sbom.spdx.json" --runtime-digest "$runtime_digest" \
      --runtime-sbom "$work/releases/$newest/sbom-agent-runtime.spdx.json" --destination "$work/candidate-assets" ) > "$work/prepare.log" 2>&1 || { cat "$work/prepare.log"; fail "the candidate's release assets did not render"; }
  for file in compose.yaml release.json; do
    sed "s#ghcr.io/coldphase/#127.0.0.1:$registry_port/#g" "$work/candidate-assets/$file" > "$work/candidate-assets/$file.edit"
    mv "$work/candidate-assets/$file.edit" "$work/candidate-assets/$file"
  done
  candidate_assets="$work/candidate-assets"
  echo "candidate image $digest"
fi

record() { echo "$1" >> "$results"; }

if [ "$control" = old-data ]; then
  step "NEGATIVE CONTROL: a migration that breaks old data is part of the candidate; the upgrade from $oldest must fail"
  mkdir -p "$work/state-control"
  if FLUX_SMOKE_LEGS=upgrade FLUX_SMOKE_INJECT=old-data FLUX_SMOKE_PREVIOUS_ASSETS="$work/releases/$oldest" FLUX_SMOKE_PORT=$((base + 1)) FLUX_SMOKE_RESTORE_PORT=$((base + 2)) \
      bash "$root/scripts/release/smoke_artifacts.sh" "$candidate_assets" "$work/state-control" "$run_id-ctl" "$run_id-ctr" > "$work/control.out" 2>&1; then
    tail -n 20 "$work/control.out"; fail "NEGATIVE CONTROL FAILED: the upgrade with a migration that breaks the old data succeeded"
  fi
  grep -q 'the upgrade stopped at the injected migration' "$work/control.out" || { tail -n 40 "$work/control.out"; fail "the control failed for another reason than the injected migration"; }
  grep -B3 -A1 'upgrade_check_no_messages' "$work/control.out" | head -n 12
  echo "NEGATIVE CONTROL PASSED: the migration that breaks old data stopped the upgrade from $oldest"
  exit 0
fi

n=0
skipped=""
for tag in $releases; do
  n=$((n + 1))
  if [ "${FLUX_MATRIX_RELEASE_INSTALL:-1}" != 0 ]; then
    step "$tag -> $candidate_version: release installation (own assets, image by digest), seed, upgrade, read back, write, backup and restore"
    mkdir -p "$work/state-$tag"
    recovery=""
    [ "$tag" != "$oldest" ] || recovery=1
    if [ -n "${FLUX_MATRIX_DUMP_DIR:-}" ]; then
      mkdir -p "$FLUX_MATRIX_DUMP_DIR"
      dump_dir=$(cd "$FLUX_MATRIX_DUMP_DIR" && pwd -P)
      export FLUX_SMOKE_DUMP="$dump_dir/$tag.sql.gz"
    fi
    started=$(date +%s)
    FLUX_SMOKE_LEGS=upgrade FLUX_SMOKE_RECOVERY=$recovery FLUX_SMOKE_PREVIOUS_ASSETS="$work/releases/$tag" \
      FLUX_SMOKE_PORT=$((base + 1)) FLUX_SMOKE_RESTORE_PORT=$((base + 2)) \
      bash "$root/scripts/release/smoke_artifacts.sh" "$candidate_assets" "$work/state-$tag" "$run_id-i$n" "$run_id-r$n" | tee "$work/install-$tag.out"
    unset FLUX_SMOKE_DUMP
    record "$tag -> $candidate_version  release installation  PASS  $(( $(date +%s) - started )) s$([ -z "$recovery" ] || echo '  (+ a migration that breaks old data stops it, the backup restores)')"
  else
    record "$tag -> $candidate_version  release installation  SKIPPED  (FLUX_MATRIX_RELEASE_INSTALL=0: not tested)"
    skipped="$skipped release-installation"
  fi
  if [ "${FLUX_MATRIX_SOURCE:-1}" != 0 ]; then
    step "$tag -> $candidate_version: source checkout (./flux up on the tag's tree, seed, replace by the candidate's tree, ./flux upgrade -y, read back, write)"
    started=$(date +%s)
    checkout="$work/src-$tag"
    project="$run_id-s$n"
    port=$((base + 3))
    mkdir "$checkout"
    git -C "$root" archive "$tag" | tar -xf - -C "$checkout"
    ( cd "$checkout" && FLUX_PROJECT="$project" FLUX_PORT=$port FLUX_DEV_PORT=$((port + 1)) FLUX_MAILPIT_PORT=$((port + 2)) ./flux up >/dev/null )
    env_file="$checkout/docker/.env"
    head -c 32 /dev/urandom > "$work/background.key"; chmod 644 "$work/background.key"
    for pair in "FLUX_PERSONAL_RUNS=on" "FLUX_AI_PRIVATE_TARGETS=provider-mock" "FLUX_BACKGROUND_KEY_HOST_FILE=$work/background.key"; do
      key=${pair%%=*}
      if grep -q "^$key=" "$env_file"; then sed "s#^$key=.*#$pair#" "$env_file" > "$env_file.edit" && mv "$env_file.edit" "$env_file"; else echo "$pair" >> "$env_file"; fi
    done
    chmod 600 "$env_file"
    node_image=$(sed -n 's/^FROM \(node@sha256:[0-9a-f]\{64\}\) AS toolchain$/\1/p' "$root/docker/Dockerfile")
    ( cd "$checkout" && FLUX_PROJECT="$project" FLUX_PORT=$port FLUX_DEV_PORT=$((port + 1)) FLUX_MAILPIT_PORT=$((port + 2)) ./flux up >/dev/null )
    docker run -d --name "$run_id-s$n-provider-mock" --network "${project}_default" --network-alias provider-mock \
      -v "$root/scripts/release/provider_mock.mjs:/mock/provider_mock.mjs:ro,z" --entrypoint node "$node_image" /mock/provider_mock.mjs >/dev/null
    for _ in $(seq 1 30); do docker exec "$run_id-s$n-provider-mock" node -e "fetch('http://127.0.0.1:8091/__health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))" && break; sleep 1; done
    python3 "$root/scripts/release/smoke_data.py" seed --origin "http://127.0.0.1:$port" --state "$work/source-$tag.json" --provider-url http://provider-mock:8091/v1
    # `git pull`: the files of the checkout change, its .env and the data stay.
    cp "$env_file" "$work/source-$tag.env"
    find "$checkout" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
    (cd "$root" && git ls-files -z --cached --others --exclude-standard | tar --null -T - -cf -) | (cd "$checkout" && tar -xf -)
    mkdir -p "$checkout/docker"; cp "$work/source-$tag.env" "$env_file"; chmod 600 "$env_file"
    ( cd "$checkout" && FLUX_PORT=$port FLUX_DEV_PORT=$((port + 1)) FLUX_MAILPIT_PORT=$((port + 2)) ./flux upgrade -y ) > "$work/upgrade-$tag.out" 2>&1 || { cat "$work/upgrade-$tag.out"; fail "./flux upgrade from $tag failed"; }
    tail -n 4 "$work/upgrade-$tag.out"
    grep -q "Upgraded $project from schema [0-9]* to [0-9]*" "$work/upgrade-$tag.out" || fail "./flux upgrade did not report the schemas"
    python3 "$root/scripts/release/smoke_data.py" verify --origin "http://127.0.0.1:$port" --state "$work/source-$tag.json" --write
    record "$tag -> $candidate_version  source checkout        PASS  $(( $(date +%s) - started )) s"
    ( cd "$checkout" && FLUX_PORT=$port FLUX_DEV_PORT=$((port + 1)) FLUX_MAILPIT_PORT=$((port + 2)) ./flux clean -y >/dev/null 2>&1 ) || true
    docker rm -fv "$run_id-s$n-provider-mock" >/dev/null 2>&1 || true
    rm -rf "$checkout"
  else
    record "$tag -> $candidate_version  source checkout        SKIPPED  (FLUX_MATRIX_SOURCE=0: not tested)"
    skipped="$skipped source-checkout"
  fi
done

step "Upgrade matrix"
cat "$results"
if [ -n "$skipped" ]; then
  legs_off=$(printf '%s\n' $skipped | sort -u | tr '\n' ' ' | sed 's/ $//')
  echo "NOT THE FULL MATRIX: switched off: $legs_off. The legs that ran passed, the others were not tested, and no tested-releases file is written."
  if [ "$(printf '%s\n' $skipped | sort -u | wc -l)" -ge 2 ]; then
    echo "NOTHING WAS UPGRADED: every leg is switched off."
  else
    echo "PARTIAL: $candidate_version upgrades from $(printf '%s ' $releases)by the leg that ran, with the data read back and new work accepted."
  fi
  exit 0
fi
[ -z "${FLUX_MATRIX_TESTED_FILE:-}" ] || printf '%s' "$(printf '%s ' $releases | sed 's/ $//')" > "$FLUX_MATRIX_TESTED_FILE"
echo "PASS: $candidate_version upgrades from $(printf '%s ' $releases)by release installation and source checkout, with the data read back and new work accepted."

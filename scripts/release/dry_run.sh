#!/usr/bin/env bash
# Local dry run of final-release.yml's build and package steps for BOTH images (#77, #358). It publishes
# nothing: no ghcr.io login or push, no attestation, no tag, no GitHub release. The images are built for the
# host platform from `git archive HEAD` (the workflow checks out the same commit), pushed to a throwaway
# registry on 127.0.0.1, so they get real manifest digests and are pulled by digest. The release assets are
# rendered with those digests, verified like the workflow does, and then the image names of the Compose
# files (not the digests) are rewritten from ghcr.io/coldphase to the local registry for the two smokes.
#
#   scripts/release/dry_run.sh [output directory]
#   FLUX_DRYRUN_PREVIOUS=<git revision> scripts/release/dry_run.sh   (adds the upgrade leg of smoke_artifacts.sh)
#
# FLUX_DRYRUN_PREVIOUS builds that revision's application image the same way, renders ITS operator assets from its
# own templates and script as the "previous release" (v0.1.0-rc.1; the candidate becomes v0.1.0-rc.2), installs it,
# upgrades it to this commit's assets and restores backups of both (see smoke_artifacts.sh). The revision must have
# the release asset set of #654 or later (a6e9851d1). Its agent-runtime digest and SBOMs are this commit's: the upgrade
# leg never pulls the runtime image.
#
# Ports: FLUX_DRYRUN_PORT (default 25800): registry on +9, packaged install on +1, restore on +2, runtime on +3.
# FLUX_DRYRUN_PROJECT (default fluxdry<pid>) prefixes the Compose projects, the registry container and nothing else.
# Runs on GNU/Linux and macOS (bash 3.2, BSD sed); on Docker Desktop the engine is a Linux VM of the host architecture.
# The runtime smoke needs the engine's kernel to have Yama ptrace_scope >= 1; otherwise this script runs the
# part that does not need it and says what was not run. Not covered (needs the workflow): linux/arm64 and the
# multi-platform index, QEMU, provenance and SBOM attestations, GHCR, anonymous pulls.
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
base=${FLUX_DRYRUN_PORT:-25800}
registry_port=$((base + 9))
out=${1:-}
run_id=${FLUX_DRYRUN_PROJECT:-fluxdry$$}
previous_rev=${FLUX_DRYRUN_PREVIOUS:-}
syft_image=${FLUX_DRYRUN_SYFT:-anchore/syft:v1.54.0}
version=v0.1.0-rc.1
previous_version=
if [ -n "$previous_rev" ]; then version=v0.1.0-rc.2; previous_version=v0.1.0-rc.1; fi
work=$(mktemp -d "${TMPDIR:-/tmp}/flux-release-dryrun.XXXXXX")
registry="$run_id-registry"
step() { printf '\n== %s\n' "$*"; }
fail() { echo "dry_run: $*" >&2; exit 1; }
sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }
# `sed -i` differs between GNU and BSD sed: edit through a temporary file.
edit() { file=$1; shift; sed "$@" "$file" > "$file.edit" && mv "$file.edit" "$file"; }
cleanup() {
  status=$?
  for project in "$run_id-src" "$run_id-rst" "$run_id-rt"; do
    docker ps -aq --filter "label=com.docker.compose.project=$project" | xargs -r docker rm -fv >/dev/null 2>&1 || true
    docker volume ls -q --filter "label=com.docker.compose.project=$project" | xargs -r docker volume rm -f >/dev/null 2>&1 || true
    docker network ls -q --filter "label=com.docker.compose.project=$project" | xargs -r docker network rm >/dev/null 2>&1 || true
  done
  docker rm -f "$registry" >/dev/null 2>&1 || true
  docker image rm -f "127.0.0.1:$registry_port/flux:dry" "127.0.0.1:$registry_port/flux:prev" \
    "127.0.0.1:$registry_port/flux-agent-runtime:dry" >/dev/null 2>&1 || true
  rm -rf "$work"
  exit "$status"
}
trap cleanup EXIT

step "Tools"
date -u '+%Y-%m-%dT%H:%M:%SZ'
docker version --format 'Docker server {{.Server.Version}} {{.Server.Os}}/{{.Server.Arch}}; client {{.Client.Version}}'
docker buildx version; docker compose version
sha=$(git -C "$root" rev-parse HEAD)
echo "source $sha ($(git -C "$root" log -1 --format=%s))"
[ -z "$(git -C "$root" status --porcelain)" ] || echo "NOTE: the working tree has uncommitted changes; the dry run uses the committed HEAD only"
mkdir "$work/src"
git -C "$root" archive "$sha" | tar -xf - -C "$work/src"
cd "$work/src"

step "Throwaway registry on 127.0.0.1:$registry_port"
docker run -d --name "$registry" -p "127.0.0.1:$registry_port:5000" registry:2 >/dev/null
for _ in $(seq 1 30); do curl -fsS "http://127.0.0.1:$registry_port/v2/" >/dev/null 2>&1 && break; sleep 1; done
curl -fsS "http://127.0.0.1:$registry_port/v2/" >/dev/null

platform="linux/$(docker version --format '{{.Server.Arch}}')"
# The digest the registry serves for a tag. `docker inspect` RepoDigests can name another manifest than the one a
# push stored (observed on Docker Desktop's containerd image store), and pulling by it would then fail.
registry_digest() { # repository tag
  curl -fsSI -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json' \
    "http://127.0.0.1:$registry_port/v2/$1/manifests/$2" | tr -d '\r' | sed -n 's/^[Dd]ocker-[Cc]ontent-[Dd]igest: *//p'
}
build_push() { # target repository tag [directory holding docker/Dockerfile and app/; default the candidate] [revision] [version]
  start=$(date +%s)
  dir=${4:-$work/src}; rev=${5:-$sha}; ver=${6:-$version}
  ( cd "$dir" && docker buildx build --platform "$platform" --target "$1" -f docker/Dockerfile \
      --label org.opencontainers.image.source=https://github.com/ColdPhase/flux \
      --label "org.opencontainers.image.revision=$rev" --label "org.opencontainers.image.version=$ver" \
      --progress plain -t "127.0.0.1:$registry_port/$2:$3" --load app ) > "$work/build-$2-$3.log" 2>&1 ||
    { tail -n 60 "$work/build-$2-$3.log"; fail "build of $2:$3 failed"; }
  docker push "127.0.0.1:$registry_port/$2:$3" > "$work/push-$2-$3.log" 2>&1 || { cat "$work/push-$2-$3.log"; fail "push of $2:$3 failed"; }
  echo "$2:$3: built and pushed in $(( $(date +%s) - start )) s ($platform)"
}
step "Build and push both images (targets runtime and agent-runtime-release; the second reuses the first's stages)"
build_push runtime flux dry
build_push agent-runtime-release flux-agent-runtime dry
app_digest=$(registry_digest flux dry)
runtime_digest=$(registry_digest flux-agent-runtime dry)
[ -n "$app_digest" ] && [ -n "$runtime_digest" ] || fail "the registry did not report both manifest digests"
echo "application   $app_digest"; echo "agent-runtime $runtime_digest"
[ "$app_digest" != "$runtime_digest" ] || fail "both images have one digest"
for image in flux flux-agent-runtime; do
  [ "$(docker image inspect "127.0.0.1:$registry_port/$image:dry" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = "$sha" ] || fail "$image revision label"
  docker image inspect "127.0.0.1:$registry_port/$image:dry" --format "$image: {{.Os}}/{{.Architecture}}, {{.Size}} bytes, user {{.Config.User}}, cmd {{.Config.Cmd}}"
done

previous_digest=
if [ -n "$previous_rev" ]; then
  step "Previous release for the upgrade leg: $previous_rev built the same way (image $previous_version)"
  previous_sha=$(git -C "$root" rev-parse --verify "$previous_rev^{commit}") || fail "unknown revision $previous_rev"
  mkdir "$work/prev-src"
  git -C "$root" archive "$previous_sha" | tar -xf - -C "$work/prev-src"
  grep -q -- '--runtime-digest' "$work/prev-src/scripts/release/prepare_assets.py" || fail "$previous_rev predates the release asset set of #654"
  echo "previous source $previous_sha ($(git -C "$root" log -1 --format=%s "$previous_sha"))"
  build_push runtime flux prev "$work/prev-src" "$previous_sha" "$previous_version"
  previous_digest=$(registry_digest flux prev)
  [ -n "$previous_digest" ] && [ "$previous_digest" != "$app_digest" ] || fail "the previous image has no digest or the candidate's"
  echo "previous application $previous_digest"
fi

step "Pinned Codex in, Claude Code out (the workflow's check, on the host platform)"
pinned=$(grep -o 'rust-v[0-9]*\.[0-9]*\.[0-9]*' docker/Dockerfile | sort -u)
runtime_ref="127.0.0.1:$registry_port/flux-agent-runtime@$runtime_digest"
version_line=$(docker run --rm --network none --entrypoint /opt/flux-runtime/codex/bin/codex "$runtime_ref" --version)
[ "$version_line" = "codex-cli ${pinned#rust-v}" ] || fail "Codex reports '$version_line'"
docker run --rm --network none --entrypoint sh "$runtime_ref" -c '
  ! command -v claude >/dev/null 2>&1 &&
  [ -z "$(find / -xdev \( -name claude -o -name claude-code \) -not -path "/proc/*" 2>/dev/null | head -n 1)" ] &&
  [ -z "$(ls -A /opt/flux-tools)" ]' || fail "Claude Code is in the runtime image"
echo "$version_line; no Claude Code; empty /opt/flux-tools"
docker run --rm --network none --entrypoint sh "$runtime_ref" -c 'command -v gpg' && echo "gpg present (runtime-install)"
echo "arm64 Codex download checksum (BuildKit ADD --checksum, no emulation):"
docker buildx build --platform linux/arm64 --target codex-arm64 -f docker/Dockerfile --progress plain --output type=cacheonly app 2>&1 | grep -E 'DONE|ERROR|checksum' | tail -n 3

step "SBOMs: $syft_image on docker-archives (the workflow uses anchore/sbom-action on the pushed digests)"
docker pull -q "$syft_image" >/dev/null
for image in flux flux-agent-runtime; do
  docker save "127.0.0.1:$registry_port/$image:dry" -o "$work/$image.tar"
  docker run --rm --network none -e SYFT_CHECK_FOR_APP_UPDATE=false -v "$work:/w" "$syft_image" \
    "docker-archive:/w/$image.tar" -o "spdx-json=/w/sbom-$image.spdx.json" -q
  rm -f "$work/$image.tar"
  python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(sys.argv[2], d['spdxVersion'], len(d['packages']), 'packages')" "$work/sbom-$image.spdx.json" "$image"
done

step "Prepare and verify the release assets (digests are real manifest digests of the local registry)"
python3 scripts/release/prepare_assets.py --version "$version" --source-sha "$sha" --digest "$app_digest" \
  --sbom "$work/sbom-flux.spdx.json" --runtime-digest "$runtime_digest" \
  --runtime-sbom "$work/sbom-flux-agent-runtime.spdx.json" --destination "$work/release-assets"
( cd "$work/release-assets" && ls -l && sha256 -c SHA256SUMS && python3 "$work/src/scripts/release/check_asset_set.py" . &&
  python3 "$work/src/scripts/release/verify_assets.py" . --version "$version" --source-sha "$sha" --digest "$app_digest" )
grep -n 'image:' "$work/release-assets/compose.runtime.yaml"
cat "$work/release-assets/release.json"
echo "-- negative controls (each must fail)"
refuses() { label=$1; shift; if "$@" >"$work/out" 2>&1; then fail "$label was accepted"; fi; echo "refused ($label): $(tail -n 1 "$work/out")"; }
cp -r "$work/release-assets" "$work/tampered"; echo '# x' >> "$work/tampered/compose.runtime.yaml"
refuses 'tampered overlay (checksum)' python3 scripts/release/verify_assets.py "$work/tampered"
cp -r "$work/release-assets" "$work/swapped"
edit "$work/swapped/compose.runtime.yaml" -e "s#flux-agent-runtime@$runtime_digest#flux@$app_digest#"
# The new sums are written outside the directory: a file created inside it would be globbed into its own list.
( cd "$work/swapped" && for f in *; do [ "$f" = SHA256SUMS ] || sha256 "$f"; done > "$work/swapped.sums" ) && mv "$work/swapped.sums" "$work/swapped/SHA256SUMS"
refuses 'runtime image swapped for the application image' python3 scripts/release/verify_assets.py "$work/swapped"
refuses 'same digest for both images' python3 scripts/release/prepare_assets.py --version "$version" --source-sha "$sha" --digest "$app_digest" \
  --sbom "$work/sbom-flux.spdx.json" --runtime-digest "$app_digest" --runtime-sbom "$work/sbom-flux-agent-runtime.spdx.json" --destination "$work/same"

step "Runtime overlay against the source stack (docker compose config)"
(
  export POSTGRES_PASSWORD=x FLUX_FIXTURE_TOKEN=x FLUX_PUBLIC_ORIGIN=http://127.0.0.1 FLUX_AUTH_SECRET=x
  docker compose -f docker/compose.source.yaml --profile runtime config --format json > "$work/source-config.json"
  FLUX_PROJECT=fluxcompare docker compose -f "$work/release-assets/compose.yaml" -f "$work/release-assets/compose.runtime.yaml" \
    --profile runtime config --format json > "$work/release-config.json"
  python3 scripts/release/compare_runtime_overlay.py "$work/source-config.json" "$work/release-config.json"
)

localize() { # asset directory, destination: image names (not digests) to the local registry, SHA256SUMS regenerated
  mkdir "$2"
  cp "$1"/* "$2/"
  for f in compose.yaml compose.runtime.yaml release.json; do edit "$2/$f" -e "s#ghcr.io/coldphase/#127.0.0.1:$registry_port/#g"; done
  ( cd "$2" && for f in *; do [ "$f" = SHA256SUMS ] || sha256 "$f"; done > "$work/localized.sums" ) && mv "$work/localized.sums" "$2/SHA256SUMS"
}
step "Point the Compose image names at the local registry (digests unchanged) for the smokes"
localize "$work/release-assets" "$work/local-assets"
grep -n 'image:' "$work/local-assets/compose.yaml"
previous_env=()
if [ -n "$previous_rev" ]; then
  # The previous release is rendered by ITS OWN script from ITS OWN templates, as its workflow would have. The SBOMs and the
  # runtime image are this commit's (the SBOM files only have to exist, the upgrade leg never pulls the runtime image).
  ( cd "$work/prev-src" && python3 scripts/release/prepare_assets.py --version "$previous_version" --source-sha "$previous_sha" \
      --digest "$previous_digest" --sbom "$work/sbom-flux.spdx.json" --runtime-digest "$runtime_digest" \
      --runtime-sbom "$work/sbom-flux-agent-runtime.spdx.json" --destination "$work/previous-assets" &&
    cd "$work/previous-assets" && sha256 -c SHA256SUMS >/dev/null &&
    python3 "$work/prev-src/scripts/release/verify_assets.py" . --version "$previous_version" --source-sha "$previous_sha" --digest "$previous_digest" )
  localize "$work/previous-assets" "$work/previous-local-assets"
  echo "previous release assets: $previous_version $previous_sha $previous_digest"
  grep -n 'image:' "$work/previous-local-assets/compose.yaml" | head -n 2
  previous_env=(env "FLUX_SMOKE_PREVIOUS_ASSETS=$work/previous-local-assets")
fi

step "Packaged clean install, paired backup and restore (scripts/release/smoke_artifacts.sh; image pulled by digest)${previous_rev:+ and the upgrade from $previous_version}"
start=$(date +%s)
FLUX_SMOKE_PORT=$((base + 1)) FLUX_SMOKE_RESTORE_PORT=$((base + 2)) \
  ${previous_env[@]+"${previous_env[@]}"} \
  bash scripts/release/smoke_artifacts.sh "$work/local-assets" "$work/smoke-state" "$run_id-src" "$run_id-rst"
echo "smoke took $(( $(date +%s) - start )) s"

step "Packaged agent runtime (scripts/release/smoke_runtime.sh)"
# Read in the ENGINE's kernel (on Docker Desktop a Linux VM, not the host), with the runtime image itself like smoke_runtime.sh does.
scope=$(docker run --rm --network none --entrypoint cat "$runtime_ref" /proc/sys/kernel/yama/ptrace_scope 2>/dev/null || echo none)
if [ "$scope" -ge 1 ] 2>/dev/null; then
  FLUX_SMOKE_RUNTIME_PORT=$((base + 3)) bash scripts/release/smoke_runtime.sh "$work/local-assets" "$work/runtime-state" "$run_id-rt"
else
  echo "NOT RUN IN FULL: this engine's kernel.yama.ptrace_scope is '$scope' (needs 1 or higher), so smoke_runtime.sh exits at its host check:"
  if FLUX_SMOKE_RUNTIME_PORT=$((base + 3)) bash scripts/release/smoke_runtime.sh "$work/local-assets" "$work/runtime-state" "$run_id-rt"; then fail "smoke_runtime passed on a host without Yama"; fi
  echo "Partial run on this engine: runtime-manager, runtime-egress and runtime-install start; a slot refuses to start (the documented requirement)."
  env_file="$work/partial.env"
  python3 scripts/release/write_test_env.py --source "$work/local-assets/env.example" --destination "$env_file" --port $((base + 3))
  edit "$env_file" -e "s/^FLUX_PROJECT=.*/FLUX_PROJECT=$run_id-rt/" -e 's/^FLUX_AGENT_RUNTIME=.*/FLUX_AGENT_RUNTIME=codex/'
  chmod 600 "$env_file"
  for n in 1 2 3 4; do echo "FLUX_RUNTIME_SECRET_$n=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')" >> "$env_file"; done
  echo "FLUX_RUNTIME_MANAGER_SECRET=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')" >> "$env_file"
  c() { docker compose --env-file "$env_file" -f "$work/local-assets/compose.yaml" -f "$work/local-assets/compose.runtime.yaml" --profile runtime "$@"; }
  c up -d --wait --wait-timeout 300 api worker
  c up -d runtime-manager runtime-egress runtime-1
  sleep 8
  [ -n "$(c ps -q --status running runtime-manager)" ] || fail "runtime-manager is not running"
  [ -n "$(c ps -q --status running runtime-egress)" ] || fail "runtime-egress is not running"
  [ "$(docker inspect -f '{{.State.ExitCode}}' "$(c ps -aq runtime-install)")" = 0 ] || fail "runtime-install did not exit 0"
  slot_log=$(c logs --no-color runtime-1 2>&1 || true) # captured: `grep -q` on a pipe can SIGPIPE the writer under pipefail
  printf '%s\n' "$slot_log" | tail -n 4
  printf '%s' "$slot_log" | grep -qi 'ptrace' || fail "the slot did not name the Yama requirement"
  # shellcheck disable=SC2046
  docker inspect $(docker ps -q --filter "label=com.docker.compose.project=$run_id-rt") > "$work/inspect.json"
  python3 scripts/agent-runtime/inspect.py "$run_id-rt" "$work/local-assets" < "$work/inspect.json" || true
  c down -v --remove-orphans >/dev/null 2>&1
fi

if [ -n "$out" ]; then
  mkdir -p "$out"
  cp "$work/release-assets/SHA256SUMS" "$out/SHA256SUMS.txt"
  cp "$work/release-assets/release.json" "$out/release.json.txt"
  cp "$work/release-assets/compose.runtime.yaml" "$out/compose.runtime.yaml.txt"
fi
echo "DRY RUN COMPLETE: $sha, application $app_digest, agent-runtime $runtime_digest; nothing published."

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
# the release asset set of #654 or later (a6e9851d1) and migration 0003 (v0.2's first, one company and spaces): v0.1 had no
# users, so v0.2 converts nothing and v0.1 itself has no upgrade leg (#1176). Its agent-runtime digest and SBOMs are this
# commit's: the upgrade leg never pulls the runtime image.
#
# v0.1 ships linux/amd64 only (final-release.yml's `platforms` input); arm64 returns in v0.1.1.
# FLUX_DRYRUN_PLATFORMS=linux/amd64,linux/arm64 builds both images (and the previous one) for those platforms like the
# workflow: a docker-container builder with the workflow's pinned BuildKit, BuildKit provenance (mode=max) and SBOM
# attestations with the workflow's pinned scanner, pushed to the throwaway registry as one index each. It then checks
# the index platforms and attestations and runs the Codex/Claude Code checks on every platform. Foreign platforms need
# QEMU binfmt on the engine (the workflow's pinned emulator, which changes the host kernel's binfmt_misc until reboot):
#   docker run --privileged --rm docker.io/tonistiigi/binfmt:qemu-v10.2.3@sha256:400a4873b838d1b89194d982c45e5fb3cda4593fbfd7e08a02e76b03b21166f0 --install arm64
# The per-platform `docker run` checks need an engine with the containerd image store (the classic store keeps one
# platform per digest) and, on SELinux hosts, a policy that lets containers run the binfmt interpreter (Fedora's denies
# it: emulated processes die with SIGSEGV unless --security-opt label=disable). scripts/agent-runtime/supported_guest.sh
# with FLUX_GUEST_BINFMT=arm64 gives such an engine.
# FLUX_DRYRUN_SMOKE_PLATFORM=linux/arm64 runs the packaged install, backup/restore and upgrade smokes on that platform
# (DOCKER_DEFAULT_PLATFORM; emulated unless the engine is native). Emulation is not a native platform test.
# Ports: FLUX_DRYRUN_PORT (default 25800): registry on +9, packaged install on +1, restore on +2, runtime on +3.
# FLUX_DRYRUN_PROJECT (default fluxdry<pid>) prefixes the Compose projects, the registry container and nothing else.
# Runs on GNU/Linux and macOS (bash 3.2, BSD sed); on Docker Desktop the engine is a Linux VM of the host architecture.
# The runtime smoke needs the engine's kernel to have Yama ptrace_scope >= 1; otherwise this script runs the
# part that does not need it and says what was not run. Not covered (needs the workflow): linux/arm64 and the
# multi-platform index, QEMU, provenance and SBOM attestations unless FLUX_DRYRUN_PLATFORMS is set; always GHCR,
# actions/attest (Sigstore), anonymous pulls.
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
base=${FLUX_DRYRUN_PORT:-25800}
registry_port=$((base + 9))
out=${1:-}
run_id=${FLUX_DRYRUN_PROJECT:-fluxdry$$}
previous_rev=${FLUX_DRYRUN_PREVIOUS:-}
if [ -n "$previous_rev" ] && ! git -C "$root" cat-file -e "$previous_rev:app/packages/db/migrations/0003_one_company_spaces.sql" 2>/dev/null; then
  echo "dry_run: $previous_rev is Flux v0.1 or older (no migration 0003): v0.2 does not upgrade it, because v0.1 had no users (#1176). Use a revision that has migration 0003, or omit FLUX_DRYRUN_PREVIOUS." >&2
  exit 2
fi
syft_image=${FLUX_DRYRUN_SYFT:-anchore/syft:v1.54.0}
platforms=${FLUX_DRYRUN_PLATFORMS:-}
smoke_platform=${FLUX_DRYRUN_SMOKE_PLATFORM:-}
# The workflow's pins (final-release.yml): BuildKit and the BuildKit SBOM scanner.
buildkit_image=moby/buildkit:v0.33.0@sha256:6c2fa84a6b61ccd72899dde4239f8d5717f05f9a8ca6f3cad185fb1a95a94de3
sbom_scanner=docker/buildkit-syft-scanner@sha256:ae4f3b554449e7e25548e7d8ccc029d17357348e30c6e3df01b92bc93654d6a9
version=v0.1.0-rc.1
previous_version=
if [ -n "$previous_rev" ]; then version=v0.1.0-rc.2; previous_version=v0.1.0-rc.1; fi
work=$(mktemp -d "${TMPDIR:-/tmp}/flux-release-dryrun.XXXXXX")
registry="$run_id-registry"
builder="$run_id-builder"
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
  [ -z "$platforms" ] || docker buildx rm -f "$builder" >/dev/null 2>&1 || true
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
if [ -n "$platforms" ]; then
  step "Multi-platform builder: $platforms, BuildKit $buildkit_image"
  printf '[registry."127.0.0.1:%s"]\n  http = true\n  insecure = true\n' "$registry_port" > "$work/buildkitd.toml"
  docker buildx create --name "$builder" --driver docker-container --driver-opt network=host \
    --driver-opt "image=$buildkit_image" --buildkitd-config "$work/buildkitd.toml" >/dev/null
  docker buildx inspect --bootstrap "$builder" | grep -E '^(Name|Driver|Platforms|BuildKit version):' || true
  # Each platform runs a step in the builder (the pinned Node base, as the Dockerfile does); no local image or tag changes.
  mkdir "$work/probe"
  # The Dockerfile's one Node base: `FROM node@sha256:<digest> AS toolchain` (the tag is in the comment above the first stage).
  node_pin=$(sed -n 's/^FROM \(node@sha256:[0-9a-f]\{64\}\) AS toolchain$/\1/p' docker/Dockerfile)
  [ -n "$node_pin" ] || fail "docker/Dockerfile has no 'FROM node@sha256:<digest> AS toolchain' line to probe the builder with"
  printf 'FROM %s\nRUN node -p "process.platform + \x27/\x27 + process.arch" > /arch\n' "$node_pin" > "$work/probe/Dockerfile"
  for p in ${platforms//,/ }; do
    docker buildx build --builder "$builder" --platform "$p" --no-cache --progress quiet --output "type=local,dest=$work/probe/$p" "$work/probe" >/dev/null 2>&1 ||
      fail "the builder cannot run $p (install QEMU binfmt, see the header of this script)"
    echo "$p runs in the builder as $(cat "$work/probe/$p/arch")"
  done
fi
# The digest the registry serves for a tag. `docker inspect` RepoDigests can name another manifest than the one a
# push stored (observed on Docker Desktop's containerd image store), and pulling by it would then fail.
registry_digest() { # repository tag
  curl -fsSI -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json' \
    "http://127.0.0.1:$registry_port/v2/$1/manifests/$2" | tr -d '\r' | sed -n 's/^[Dd]ocker-[Cc]ontent-[Dd]igest: *//p'
}
build_push() { # target repository tag [directory holding docker/Dockerfile and app/; default the candidate] [revision] [version]
  start=$(date +%s)
  dir=${4:-$work/src}; rev=${5:-$sha}; ver=${6:-$version}
  # The target `database` is the database image (F-042): its own Dockerfile and context, no target stage.
  if [ "$1" = database ]; then file=docker/database/Dockerfile context=docker/database target=(); else file=docker/Dockerfile context=app target=(--target "$1"); fi
  labels=(--label org.opencontainers.image.source=https://github.com/ColdPhase/flux
    --label "org.opencontainers.image.revision=$rev" --label "org.opencontainers.image.version=$ver")
  if [ -n "$platforms" ]; then
    # The workflow's build-push-action settings, with a tag instead of push-by-digest so the registry can name the index.
    ( cd "$dir" && docker buildx build --builder "$builder" --platform "$platforms" ${target[@]+"${target[@]}"} -f "$file" \
        "${labels[@]}" --provenance mode=max --sbom "generator=$sbom_scanner" --progress plain \
        --output "type=image,name=127.0.0.1:$registry_port/$2:$3,push=true" "$context" ) > "$work/build-$2-$3.log" 2>&1 ||
      { tail -n 60 "$work/build-$2-$3.log"; fail "build of $2:$3 failed"; }
    docker pull -q "127.0.0.1:$registry_port/$2:$3" > "$work/push-$2-$3.log" 2>&1 || { cat "$work/push-$2-$3.log"; fail "pull of $2:$3 failed"; }
    echo "$2:$3: built for $platforms and pushed in $(( $(date +%s) - start )) s"
    return
  fi
  ( cd "$dir" && docker buildx build --platform "$platform" ${target[@]+"${target[@]}"} -f "$file" \
      "${labels[@]}" --progress plain -t "127.0.0.1:$registry_port/$2:$3" --load "$context" ) > "$work/build-$2-$3.log" 2>&1 ||
    { tail -n 60 "$work/build-$2-$3.log"; fail "build of $2:$3 failed"; }
  docker push "127.0.0.1:$registry_port/$2:$3" > "$work/push-$2-$3.log" 2>&1 || { cat "$work/push-$2-$3.log"; fail "push of $2:$3 failed"; }
  echo "$2:$3: built and pushed in $(( $(date +%s) - start )) s ($platform)"
}
step "Build and push the three images (targets runtime and agent-runtime-release, which reuses the first's stages, and the database image)"
build_push runtime flux dry
build_push agent-runtime-release flux-agent-runtime dry
build_push database flux-database dry
app_digest=$(registry_digest flux dry)
runtime_digest=$(registry_digest flux-agent-runtime dry)
database_digest=$(registry_digest flux-database dry)
[ -n "$app_digest" ] && [ -n "$runtime_digest" ] && [ -n "$database_digest" ] || fail "the registry did not report every manifest digest"
echo "application   $app_digest"; echo "agent-runtime $runtime_digest"; echo "database      $database_digest"
[ "$app_digest" != "$runtime_digest" ] || fail "both images have one digest"
for image in flux flux-agent-runtime flux-database; do
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

if [ -n "$platforms" ]; then
  step "Index platforms and attestations (the workflow's 'Confirm the platform manifests', plus BuildKit's attestations)"
  for image in flux flux-agent-runtime flux-database; do
    docker buildx imagetools inspect --raw "127.0.0.1:$registry_port/$image:dry" > "$work/index-$image.json"
    python3 - "$work/index-$image.json" "$image" "$platforms" <<'PY'
import json, sys
index = json.load(open(sys.argv[1], encoding="utf-8"))
items = index.get("manifests", [])
found = {f"{m['platform']['os']}/{m['platform']['architecture']}" for m in items if m.get("platform", {}).get("os") != "unknown"}
wanted = set(sys.argv[3].split(","))
assert wanted <= found, (found, wanted)
attest = [m for m in items if m.get("annotations", {}).get("vnd.docker.reference.type") == "attestation-manifest"]
assert len(attest) == len(wanted), f"{len(attest)} attestation manifests for {len(wanted)} platforms"
print(f"{sys.argv[2]}: index {index.get('mediaType')}, platforms {sorted(found)}, {len(attest)} attestation manifests")
PY
    # BuildKit's in-toto statements: SLSA provenance (mode=max) and SPDX SBOM per platform.
    docker buildx imagetools inspect "127.0.0.1:$registry_port/$image:dry" --format '{{json .Provenance}}' > "$work/prov-$image.json"
    docker buildx imagetools inspect "127.0.0.1:$registry_port/$image:dry" --format '{{json .SBOM}}' > "$work/sbom-attest-$image.json"
    python3 - "$work/prov-$image.json" "$work/sbom-attest-$image.json" "$image" "$sha" <<'PY'
import json, sys
prov, sbom = json.load(open(sys.argv[1])), json.load(open(sys.argv[2]))
def per_platform(doc):  # one platform: the statement itself; several: a map platform -> statement
    return doc if all(k.startswith("linux/") for k in doc) else {"single": doc}
for plat, p in per_platform(prov).items():
    pred = p.get("SLSA", {})
    assert pred, f"no provenance for {plat}"
    text = json.dumps(pred)
    assert "buildDefinition" in text or "invocation" in text, plat
for plat, b in per_platform(sbom).items():
    assert b.get("SPDX", {}).get("packages"), f"no SPDX SBOM for {plat}"
    print(f"{sys.argv[3]} {plat}: SLSA provenance present; SBOM attestation {len(b['SPDX']['packages'])} packages")
PY
  done
fi

pinned=$(grep -o 'rust-v[0-9]*\.[0-9]*\.[0-9]*' docker/Dockerfile | sort -u)
runtime_ref="127.0.0.1:$registry_port/flux-agent-runtime@$runtime_digest"
for check_platform in $(printf '%s' "${platforms:-$platform}" | tr ',' ' '); do
  step "Pinned Codex in, Claude Code out (the workflow's check) on $check_platform"
  version_line=$(docker run --rm --platform "$check_platform" --network none --entrypoint /opt/flux-runtime/codex/bin/codex "$runtime_ref" --version)
  [ "$version_line" = "codex-cli ${pinned#rust-v}" ] || fail "Codex reports '$version_line' on $check_platform"
  docker run --rm --platform "$check_platform" --network none --entrypoint sh "$runtime_ref" -c '
    ! command -v claude >/dev/null 2>&1 &&
    [ -z "$(find / -xdev \( -name claude -o -name claude-code \) -not -path "/proc/*" 2>/dev/null | head -n 1)" ] &&
    [ -z "$(ls -A /opt/flux-tools)" ]' || fail "Claude Code is in the runtime image ($check_platform)"
  echo "$check_platform: $version_line; no Claude Code; empty /opt/flux-tools; $(docker run --rm --platform "$check_platform" --network none --entrypoint uname "$runtime_ref" -m)"
  docker run --rm --platform "$check_platform" --network none --entrypoint sh "$runtime_ref" -c 'command -v gpg' && echo "gpg present (runtime-install)"
  docker run --rm --platform "$check_platform" --network none --entrypoint node "127.0.0.1:$registry_port/flux@$app_digest" -e \
    'console.log(`application image: node ${process.version} ${process.arch}`)'
done
# The workflow's `scan` job (#835): the same script and pins, on the digests of the throwaway registry (plain HTTP on the host network).
if [ -z "${FLUX_DRYRUN_SKIP_SCAN:-}" ]; then
  step "Image scan: Trivy on the three digests; a HIGH/CRITICAL finding with a fix fails unless .github/security-allowlist.json names it"
  python3 scripts/security_scan.py image --network host --insecure --platforms "$platforms" --report-dir "$work/scan" \
    "127.0.0.1:$registry_port/flux@$app_digest" "127.0.0.1:$registry_port/flux-agent-runtime@$runtime_digest" \
    "127.0.0.1:$registry_port/flux-database@$database_digest" || fail "the image scan failed"
fi
case ",${platforms}," in
  *,linux/arm64,*)
    echo "arm64 Codex download checksum (BuildKit ADD --checksum, no emulation):"
    docker buildx build --platform linux/arm64 --target codex-arm64 -f docker/Dockerfile --progress plain --output type=cacheonly app 2>&1 | grep -E 'DONE|ERROR|checksum' | tail -n 3
    ;;
esac

step "SBOMs: $syft_image on docker-archives (the workflow uses anchore/sbom-action on the pushed digests)"
docker pull -q "$syft_image" >/dev/null
for image in flux flux-agent-runtime flux-database; do
  docker save "127.0.0.1:$registry_port/$image:dry" -o "$work/$image.tar"
  docker run --rm --network none -e SYFT_CHECK_FOR_APP_UPDATE=false -v "$work:/w:z" "$syft_image" \
    "docker-archive:/w/$image.tar" -o "spdx-json=/w/sbom-$image.spdx.json" -q
  rm -f "$work/$image.tar"
  python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(sys.argv[2], d['spdxVersion'], len(d['packages']), 'packages')" "$work/sbom-$image.spdx.json" "$image"
done

step "Prepare and verify the release assets (digests are real manifest digests of the local registry, which the folder names)"
built_platforms=${platforms:-$platform}
python3 scripts/release/prepare_assets.py --version "$version" --source-sha "$sha" --digest "$app_digest" \
  --sbom "$work/sbom-flux.spdx.json" --runtime-digest "$runtime_digest" \
  --runtime-sbom "$work/sbom-flux-agent-runtime.spdx.json" --database-digest "$database_digest" \
  --database-sbom "$work/sbom-flux-database.spdx.json" --platforms "$built_platforms" --source . \
  --registry "127.0.0.1:$registry_port" --destination "$work/release-assets"
( cd "$work/release-assets" && ls -l && sha256 -c SHA256SUMS && python3 "$work/src/scripts/release/check_asset_set.py" . &&
  python3 "$work/src/scripts/release/verify_assets.py" . --version "$version" --source-sha "$sha" --digest "$app_digest" \
    --platforms "$built_platforms" --registry "127.0.0.1:$registry_port" )
tar -xzOf "$work/release-assets/flux.tar.gz" flux/docker/release.env
cat "$work/release-assets/release.json"
echo "-- negative controls (each must fail)"
refuses() { label=$1; shift; if "$@" >"$work/out" 2>&1; then fail "$label was accepted"; fi; echo "refused ($label): $(tail -n 1 "$work/out")"; }
cp -r "$work/release-assets" "$work/tampered"; printf x >> "$work/tampered/flux.tar.gz"
refuses 'tampered archive (checksum)' python3 scripts/release/verify_assets.py "$work/tampered" --registry "127.0.0.1:$registry_port"
refuses 'same digest for both images' python3 scripts/release/prepare_assets.py --version "$version" --source-sha "$sha" --digest "$app_digest" \
  --sbom "$work/sbom-flux.spdx.json" --runtime-digest "$app_digest" --runtime-sbom "$work/sbom-flux-agent-runtime.spdx.json" \
  --database-digest "$database_digest" --database-sbom "$work/sbom-flux-database.spdx.json" --destination "$work/same"

step "Runtime overlay against the source stack (docker compose config)"
(
  export POSTGRES_PASSWORD=x FLUX_FIXTURE_TOKEN=x FLUX_PUBLIC_ORIGIN=http://127.0.0.1 FLUX_AUTH_SECRET=x
  docker compose --env-file /dev/null -f docker/compose.source.yaml -f docker/compose.source.runtime.yaml --profile runtime config --format json > "$work/source-config.json"
  folder=$(sh scripts/release/unpack_release.sh "$work/release-assets" "$work/compare")
  set -a; . "$folder/docker/release.env"; set +a
  FLUX_PROJECT=fluxcompare docker compose --env-file /dev/null -f "$folder/docker/compose.yaml" -f "$folder/docker/compose.runtime.yaml" \
    --profile runtime config --format json > "$work/release-config.json"
  python3 scripts/release/compare_runtime_overlay.py "$work/source-config.json" "$work/release-config.json"
)

step "The HTTPS, calls and embeddings overlays resolve on the release compose.yaml (docker compose config, as in final-release.yml)"
bash scripts/release/check_overlays.sh "$work/release-assets"

localize() { # a release before v0.2.1 (compose.yaml and release.json as assets), destination: image names to the local registry
  mkdir "$2"
  cp "$1"/* "$2/"
  for f in compose.yaml compose.runtime.yaml release.json; do [ ! -f "$2/$f" ] || edit "$2/$f" -e "s#ghcr.io/coldphase/#127.0.0.1:$registry_port/#g"; done
  ( cd "$2" && for f in *; do [ "$f" = SHA256SUMS ] || sha256 "$f"; done > "$work/localized.sums" ) && mv "$work/localized.sums" "$2/SHA256SUMS"
}
previous_env=()
if [ -n "$previous_rev" ]; then
  # The previous release is rendered by ITS OWN script from ITS OWN templates, as its workflow would have. The SBOMs and the
  # runtime image are this commit's (the SBOM files only have to exist, the upgrade leg never pulls the runtime image).
  # A previous release from before F-042 ran the official PostgreSQL image and takes no database digest; one from v0.2.1 on is a
  # flux.tar.gz and names the local registry itself.
  previous_args=()
  grep -q -- '--database-digest' "$work/prev-src/scripts/release/prepare_assets.py" &&
    previous_args=(--database-digest "$database_digest" --database-sbom "$work/sbom-flux-database.spdx.json")
  grep -q -- '--registry' "$work/prev-src/scripts/release/prepare_assets.py" &&
    previous_args+=(--source . --registry "127.0.0.1:$registry_port")
  ( cd "$work/prev-src" && python3 scripts/release/prepare_assets.py --version "$previous_version" --source-sha "$previous_sha" \
      --digest "$previous_digest" --sbom "$work/sbom-flux.spdx.json" --runtime-digest "$runtime_digest" \
      --runtime-sbom "$work/sbom-flux-agent-runtime.spdx.json" ${previous_args[@]+"${previous_args[@]}"} --destination "$work/previous-assets" &&
    cd "$work/previous-assets" && sha256 -c SHA256SUMS >/dev/null )
  if [ -f "$work/previous-assets/compose.yaml" ]; then localize "$work/previous-assets" "$work/previous-local-assets"
  else cp -r "$work/previous-assets" "$work/previous-local-assets"; fi
  echo "previous release assets: $previous_version $previous_sha $previous_digest"
  previous_env=(env "FLUX_SMOKE_PREVIOUS_ASSETS=$work/previous-local-assets")
fi

if [ -n "$smoke_platform" ]; then
  # Compose pulls and creates every container for this platform (from the multi-platform indexes).
  export DOCKER_DEFAULT_PLATFORM=$smoke_platform
  export FLUX_SMOKE_WAIT=${FLUX_SMOKE_WAIT:-1800}
  echo "smokes on $smoke_platform (DOCKER_DEFAULT_PLATFORM; up --wait allows $FLUX_SMOKE_WAIT s)"
fi
step "The owner's path: the install folder with ./flux up, backup, restore and ./flux upgrade (scripts/release/smoke_launcher.sh)"
FLUX_SMOKE_LAUNCHER_PORT=$((base + 4)) bash scripts/release/smoke_launcher.sh "$work/release-assets" "$work/launcher-state" "$run_id-own"

step "Packaged clean install, paired backup and restore (scripts/release/smoke_artifacts.sh; image pulled by digest)${previous_rev:+ and the upgrade from $previous_version}"
start=$(date +%s)
FLUX_SMOKE_PORT=$((base + 1)) FLUX_SMOKE_RESTORE_PORT=$((base + 2)) \
  ${previous_env[@]+"${previous_env[@]}"} \
  bash scripts/release/smoke_artifacts.sh "$work/release-assets" "$work/smoke-state" "$run_id-src" "$run_id-rst"
echo "smoke took $(( $(date +%s) - start )) s"

step "Packaged agent runtime (scripts/release/smoke_runtime.sh)"
# Read in the ENGINE's kernel (on Docker Desktop a Linux VM, not the host), with the runtime image itself like smoke_runtime.sh does.
scope=$(docker run --rm --network none --entrypoint cat "$runtime_ref" /proc/sys/kernel/yama/ptrace_scope 2>/dev/null || echo none)
if [ "$scope" -ge 1 ] 2>/dev/null; then
  FLUX_SMOKE_RUNTIME_PORT=$((base + 3)) bash scripts/release/smoke_runtime.sh "$work/release-assets" "$work/runtime-state" "$run_id-rt"
else
  echo "NOT RUN IN FULL: this engine's kernel.yama.ptrace_scope is '$scope' (needs 1 or higher), so smoke_runtime.sh exits at its host check:"
  if FLUX_SMOKE_RUNTIME_PORT=$((base + 3)) bash scripts/release/smoke_runtime.sh "$work/release-assets" "$work/runtime-state" "$run_id-rt"; then fail "smoke_runtime passed on a host without Yama"; fi
fi

if [ -n "$out" ]; then
  mkdir -p "$out"
  cp "$work/release-assets/SHA256SUMS" "$out/SHA256SUMS.txt"
  cp "$work/release-assets/release.json" "$out/release.json.txt"
  tar -xzOf "$work/release-assets/flux.tar.gz" flux/docker/release.env > "$out/release.env.txt"
fi
echo "DRY RUN COMPLETE: $sha, application $app_digest, agent-runtime $runtime_digest; nothing published."

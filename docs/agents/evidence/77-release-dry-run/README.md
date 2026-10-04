# #77 local release dry run (T77-A)

Date: 2026-10-04 (21:30 UTC). Prepared by Zamojski5 (claude-maurycy) under the founder
direction in [#185](https://github.com/ColdPhase/flux/issues/185) as preparation for
[#77](https://github.com/ColdPhase/flux/issues/77) (owner PelikanFix16). Author evidence;
PelikanFix16 evaluates it. **Nothing was published:** no registry login or push, no
attestation, no tag, no GitHub release, no workflow dispatch.

**Source:** `origin/main` [`662aec62e2e05c3d944053a5b35771986900b9e3`](https://github.com/ColdPhase/flux/commit/662aec62),
taken with `git archive` of that exact commit, as `final-release.yml` checks it out.
**Result: pass** ([log](dry-run.txt), [script](dry-run.sh.txt), run through the shared
Docker slot wrapper on Docker Desktop 29.1.2, linux/arm64). Trailing whitespace was stripped
from the `.txt` files before [`sha256.txt`](sha256.txt) was written; the copied assets still match
their `SHA256SUMS` lines.

## What ran

| Workflow step (`final-release.yml`) | Local equivalent | Result |
| --- | --- | --- |
| Validate candidate (`candidate` job) | The SHA is a commit on `origin/main`; `docker/compose.yaml` and `docker/.env.example` exist. Acceptance comments, the tag check and `HEAD == origin/main` were not exercised (no acceptance issue exists). | partial |
| Build (`image` job): `./app` context, `docker/Dockerfile`, target `runtime`, OCI labels | `docker buildx build --platform linux/arm64 --target runtime` with the same context, file and the three `org.opencontainers.image.*` labels; loaded locally | pass: `linux/arm64`, user `node`, revision label equals the SHA. Image id `sha256:374302c3…` (a local config digest, **not** a registry manifest digest) |
| Image contents | `node tooling/dist/operations.js migration-files` in the image, without network | `FLUX_MIGRATIONS 1…45`: the image's own #118 parser accepts its 45 files |
| SBOM (`anchore/sbom-action` on the pushed digest) | `anchore/syft` 1.54.0 (`sha256:0356562f…`) on a `docker save` archive, without network | SPDX-2.3, 604 packages |
| Prepare assets (`package` job) | `prepare_assets.py --version v0.1.0-rc.1 --source-sha <sha> --digest sha256:000…000` in `python:3.12-slim-trixie` | pass: 7 assets plus `SHA256SUMS`; `sha256sum -c` OK; `check_asset_set.py` OK; `compose.yaml` pins the placeholder on `api`, `worker`, `migrate` and keeps PostgreSQL's digest ([rendered compose](compose.yaml.txt), [release.json](release.json.txt), [checksums](SHA256SUMS.txt)) |
| — | `write_test_env.py` from the rendered `env.example`, then `docker compose --env-file … -f compose.yaml config --quiet` and `config --images` | pass: valid; services `api db migrate worker`; images are the placeholder digest three times plus `postgres@sha256:77f58511…` ([images](compose-images.txt)) |
| Packaged smoke (`smoke_artifacts.sh`) | The same script with two recorded harness changes: the rendered `compose.yaml` points at the local image tag instead of the placeholder digest, and its `pull` line is removed | pass in 63 s: clean install, health, account and workspace, file probe, paired `pg_dump` + files archive, restore into a second project, data and file (non-root owner) verified |
| — | `python3 -m unittest discover -s tests -p 'test_release_*.py'` (host Python 3.12.4, standard library only, as `Agent setup` runs them) | 26 tests OK ([names](release-unittests.txt)) |

Negative controls, all refused with their error (see the log): a tampered `env.example`
(`sha256sum -c`), an unlisted extra asset (`check_asset_set.py`), a template with the
marker on two services only, version `v0.1`, an abbreviated source SHA, and a non-empty
destination (`prepare_assets.py`).

## Not covered (still open in #77)

- **The placeholder digest.** The rendered `compose.yaml` and `release.json` name
  `sha256:000…000`. A real manifest digest exists only after the dispatched build pushes to
  GHCR. `prepare_assets.py` hard-codes `ghcr.io/coldphase/flux`, so a fully local pull-by-digest
  smoke needs either an `--image` option or a local registry; neither was added here.
- **amd64 and the multi-platform index.** Only linux/arm64 was built, natively. The
  workflow's QEMU arm64 build, the amd64 build, provenance (`mode=max`), the BuildKit SBOM
  attestation and `actions/attest` were not run. The local buildx is
  v0.30.1-desktop.1, not the workflow's pinned v0.37.1 and BuildKit v0.33.0.
- **SBOM tool parity.** syft 1.54.0 from `anchore/syft:latest` (digest recorded) is not
  necessarily the version that `anchore/sbom-action` v0.24.2 downloads.
- **Credentials and policy** (needs Maurycy): `FLUX_RELEASE_ADMIN_READ_TOKEN`, GHCR package
  visibility, and whether the Actions policy admits `docker/*` and `anchore/*` on the
  first run.
- **Upgrade from a published rc** (T77-B) and independent install on both platforms from the
  downloaded draft (#77 AC-3/AC-4).

**Finding (not a failure):** Compose v2.40.3 printed `mount of type volume should not define
bind option` on every command that touches `api` or `worker`. It comes from `files:/data/files:z`
in `docker/compose.yaml` (lines 76 and 102): `z` is a bind-mount SELinux option on a named
volume. Nothing failed on this non-SELinux host; whether the volume is relabelled on an
SELinux host was not tested. For #76/#77 to decide.

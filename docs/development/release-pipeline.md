# Final OCI release pipeline

The [distribution decision](repository-distribution-proposal.md) requires an
explicit final build and publication after the complete application is accepted.
Both workflows below run only by an explicit `workflow_dispatch`, refuse any ref but
`main`, and default to read-only permissions; they are dormant during ordinary PR and `main`
pushes. Operators
install the result with the release's `INSTALL.md`
([source](../operations/release-guide.md)); the repository-side overview is
[Install Flux from a release](../operations/install-release.md).

## Release assets

`scripts/release/prepare_assets.py` renders these files from the repository and the
accepted digest, deterministically and without timestamps:

| Asset | Source |
| --- | --- |
| `compose.yaml` | [`docker/compose.yaml`](../../docker/compose.yaml) with the marker `ghcr.io/coldphase/flux@sha256:RELEASE_DIGEST` replaced by the accepted digest on `api`, `worker` and `migrate`. Only the leading repository-oriented header comment is replaced by a release header; every other line is unchanged. |
| `compose.runtime.yaml` | [`docker/compose.runtime.yaml`](../../docker/compose.runtime.yaml): the optional agent-runtime overlay (#358). `ghcr.io/coldphase/flux@sha256:RELEASE_DIGEST` is replaced on `runtime-manager` and `runtime-egress`, `ghcr.io/coldphase/flux-agent-runtime@sha256:RUNTIME_DIGEST` on the slot anchor and `runtime-install`; the leading header comment is replaced. Off unless the operator opts in. |
| `runtime.sh` | [`docker/runtime.sh`](../../docker/runtime.sh), unchanged: `on`, `off`, `up`, `status`, `release`, `purge`. |
| `compose.live.yaml`, `compose.live.turn.yaml` | [`docker/compose.live.yaml`](../../docker/compose.live.yaml) and [`docker/compose.live.turn.yaml`](../../docker/compose.live.turn.yaml): the optional calls and screen-sharing overlays (#63). Only the leading header comment is replaced; the third-party LiveKit image is already pinned by digest in the repository file and recorded as `live_media_image` in `release.json`. `prepare_assets.py` refuses a build, an image not pinned by digest, a Flux image, a socket or a source path. Flux builds no image for them. |
| `env.example` | [`docker/.env.example`](../../docker/.env.example), unchanged. GitHub stores a Release asset whose name begins with a period under another name (`.env.example` becomes `default.env.example`) and `actions/upload-artifact` skips hidden files, so the template is published without the period. |
| `INSTALL.md` | [`docs/operations/release-guide.md`](../operations/release-guide.md). It must stay self-contained (no repository-relative links). |
| `release.json` | Version, source SHA, both images (`ghcr.io/coldphase/flux@sha256:…`, `ghcr.io/coldphase/flux-agent-runtime@sha256:…`), their platforms (the dispatch input `platforms`, `linux/amd64` by default), the pinned Codex tag, that Claude Code is not included, and the LiveKit image (`live_media_image`). |
| `sbom.spdx.json`, `THIRD_PARTY_NOTICES.json` | SPDX SBOM generated from the pushed application image digest and the dependency notice inventory derived from it. |
| `sbom-agent-runtime.spdx.json`, `THIRD_PARTY_NOTICES.agent-runtime.json` | The same for the agent-runtime image; the notices add the pinned official Codex (Apache-2.0, tag read from `docker/Dockerfile`) when the scanner does not list the vendor binary. |
| `LICENSE`, `SHA256SUMS` | The repository license and the checksums of every other asset. |

`tests/test_release_assets.py` packages the real operator files and fails when the
packaged `compose.yaml` differs from the tested one in anything but comments and the
digest, when an asset name would not survive GitHub, or when `INSTALL.md` stops matching
the assets and variables. The application image is built from `docker/Dockerfile` (target `runtime`)
with `app/` as the context, the same inputs as the source Compose and the PR check. The agent-runtime
image is built from the same file and context with target `agent-runtime-release` (the slot supervisor,
node-pty, the checksum-pinned official Codex and gpg for `runtime-install`; never Claude Code). Both
are pushed by digest, untagged, attested, with SBOMs. `scripts/release/verify_assets.py` checks an asset
directory (exact asset set, checksums, both digests in every file that pins them, platforms, the
LiveKit digest in `compose.live.yaml`, no marker, build, floating tag, socket or Flux image in the
live overlays); the workflow runs it on the prepared assets and the draft, and
the publication workflow on the draft and again on the public downloads.

## Flow

1. Finish integrated acceptance at one protected-main commit. The release owner
   (PelikanFix16) and an independent agent reviewer who did not write the code under
   review record their evidence in the acceptance issue (founder decision on
   [#249](https://github.com/ColdPhase/flux/issues/249), 2026-10-31). The owner posts
   `ACCEPTED RELEASE CANDIDATE <40-character source SHA>`; the reviewer posts, through a
   founder login,
   `INDEPENDENT RELEASE REVIEW <source SHA> reviewer=<agent name> session=<session id or URL>`.
   `scripts/release/verify_acceptance.py` refuses a review whose session appears in any commit
   message reachable from the SHA (agent commits carry it as a trailer such as
   `Claude-Session:`), so an author cannot review their own code.
2. Dispatch `Final release candidate` on `main` with that SHA, a fresh
   `vX.Y.Z` or `vX.Y.Z-rc.N` version and the acceptance issue number. The
   workflow requires the SHA to equal the dispatched main head, refuses a version whose
   remote tag exists (or cannot be read) and checks both acceptance comments. It builds
   the pinned application and agent-runtime images for the `platforms` input (default `linux/amd64`;
   v0.1 ships amd64 only, v0.1.1 dispatches `linux/amd64,linux/arm64` and QEMU is set up only then)
   and pushes only by digest, with BuildKit provenance and SBOM
   attestations and an `actions/attest` build provenance attestation for the index. It writes
   the assets above. The packaged image must then install, create account/workspace data and
   restore a paired PostgreSQL/files backup in fresh Compose volumes
   (`scripts/release/smoke_artifacts.sh`), and the packaged agent runtime must start, stay inside its
   limits and networks and purge cleanly (`scripts/release/smoke_runtime.sh`; the overlay is compared with
   the source stack by `scripts/release/compare_runtime_overlay.py`), and the live-media overlays must resolve on the
   packaged `compose.yaml` (`scripts/release/check_live_overlay.sh`) before the workflow creates a **draft** GitHub
   Release. The draft job checks the asset set against `SHA256SUMS` first.
3. Independently review that draft and its exact digest. Test downloaded assets
   on every published platform (`linux/amd64` for v0.1), a real forward upgrade from the previous
   supported version, backup/restore, the `gh attestation verify` command of
   `INSTALL.md` and user-facing behavior. The packaged install, upgrade and both backup/restore
   paths are one command per platform: download the previous release's assets and the draft's assets
   into two directories and run
   `FLUX_SMOKE_PREVIOUS_ASSETS=<previous assets> bash scripts/release/smoke_artifacts.sh <draft assets> <state dir> <project> <restore project>`
   from a checkout of the candidate commit (see [the upgrade leg](#the-upgrade-leg)).
   Record run, commands, versions, digest, results, downtime and limits in #77.
   A new build digest requires a new artifact review. An independent agent reviewer who did
   not write the code posts this exact line in the review issue, through a founder login
   (`verify_artifact_review.py` applies the same session rule as step 1):

   ```text
   ACCEPTED RELEASE ARTIFACT <version> <source SHA> <sha256: image digest> <SHA-256 of SHA256SUMS> reviewer=<agent name> session=<session id or URL>
   ```

4. Dispatch `Publish reviewed release` on `main` with those exact values and
   review issue number. It checks that the draft target and any peeled Git tag
   resolve to the accepted source SHA, then downloads and rechecks the draft
   assets (every file must be covered by `SHA256SUMS`, and nothing else may be attached)
   and the peer record. The agent-runtime digest is not a dispatch input: it is read from
   `release.json`, which the reviewer's `SHA256SUMS` hash binds. It promotes both existing digests to
   the never-retag `vX.Y.Z` GHCR tags (`ghcr.io/coldphase/flux` and `ghcr.io/coldphase/flux-agent-runtime`), verifies anonymous image access, repeats the tag/target
   check immediately before publishing the immutable GitHub Release, then
   checks public asset downloads against `SHA256SUMS`. Record the final image
   digest, tag and release URL in #77. If publication fails mid-step, inspect
   the existing tag/release first; the workflow refuses to move a version tag
   to a different digest.

The workflow's packaged smoke is a gate, not the whole release evaluation. It runs on
one platform (amd64), does not cover a bound slot's sign-out and reuse (they need a vendor login; the fake-CLI
`scripts/check_agent_runtime.sh` covers them against the source stack), and does not run the upgrade leg
(next section), a TLS reverse proxy, browsers, Web Push or SMTP. In particular, the first release has no
previous version from which to exercise a real forward upgrade: its schema is the single v0.1 baseline
(#779) and pre-release schemas cannot be upgraded, so `FLUX_DRYRUN_PREVIOUS` must name a revision with
that baseline. From v0.1 on, publish a candidate `-rc.N` first and upgrade from it. Arm64 QEMU build and manifest inspection are not a native arm64 install test. Those
results remain open until the independent artifact review records them. The source
workspace and test stack continue using their own Compose path; the attached
`compose.yaml` is the pull-only operator path.

## The upgrade leg

`scripts/release/smoke_artifacts.sh` runs the clean-install leg always. With
`FLUX_SMOKE_PREVIOUS_ASSETS=<directory>` (the downloaded assets of the previous release: `compose.yaml`,
`env.example`, `release.json` and `SHA256SUMS` are required; the previous release must pin another image
and the same PostgreSQL digest, or the script stops before pulling anything) it adds `INSTALL.md`'s upgrade,
followed literally, with throwaway credentials and the same ports as the first leg:

1. Install the previous release from its own assets and create content through its public API
   (`scripts/release/smoke_data.py`): an account, a workspace, a project, a conversation with a reply and a
   binary attachment, a document with two versions, a work item and a private note, plus a file in the
   files volume.
2. Take the paired backup with the previous release's files, then stop its writers.
3. Pull and start the candidate's `compose.yaml` with the **same** environment file and project (same volumes).
4. Check that data and migrations survived: the `migrate` service exited 0; `/api/v1/health` reports a
   `schemaVersion` that did not go down; `flux_schema_version` equals the candidate's migration files
   (`app/packages/db/migrations`) and keeps every earlier row; thirteen content tables (the `content_tables`
   list in the script; a table the previous release lacks is skipped) have identical counts and row checksums over
   the previous columns; the `pgdata` and `files` volumes were not recreated; the account signs in, every created
   item reads back (explicit fields and the exact attachment bytes) and the instance accepts a new message.
   The downtime from stopping the writers to a healthy candidate is printed.
5. Back up the upgraded installation and restore it into fresh volumes with the candidate's files.
6. Recovery path of `INSTALL.md`: restore the **pre-upgrade** backup into fresh volumes with the **previous**
   release's files, check it, then upgrade that restored installation to the candidate and check it again.

`scripts/release/dry_run.sh` runs it against locally built images. `FLUX_DRYRUN_PREVIOUS=<git revision>`
(at or after `a6e9851d1`, the asset set of #654) builds that revision's application image, renders its
assets from its own templates as release `v0.1.0-rc.1` (the candidate becomes `v0.1.0-rc.2`) and passes
them as the previous release:

```sh
FLUX_DRYRUN_PORT=25800 FLUX_DRYRUN_PROJECT=fluxdry FLUX_DRYRUN_PREVIOUS=a6e9851d1 bash scripts/release/dry_run.sh
```

The leg is not wired into `final-release.yml`: the first release has no predecessor, and which published
release is "previous" is a decision for the reviewer, who runs the command above on each platform. The
leg proves the documented upgrade for one pair of releases; it does not cover a PostgreSQL major
change (`INSTALL.md`: restore into a fresh installation instead), the optional agent runtime, a TLS
proxy, or content created through the browser.

## Local multi-platform dry run

v0.1 is amd64-only, so a plain `dry_run.sh` on an amd64 host matches its workflow run. For v0.1.1,
`FLUX_DRYRUN_PLATFORMS=linux/amd64,linux/arm64` makes `dry_run.sh` build both images (and the previous one)
the way the `image` job does: a `docker-container` builder with the workflow's pinned BuildKit, provenance
`mode=max` and SBOM attestations with the workflow's pinned scanner, one index per image in the throwaway
registry. It then checks that each index lists both platforms and one attestation manifest per platform,
that every platform has SLSA provenance and an SPDX SBOM, and runs the Codex / no-Claude-Code checks and a
Node start on each platform. `FLUX_DRYRUN_SMOKE_PLATFORM=linux/arm64` additionally runs the packaged clean
install, backup/restore and upgrade smokes with that platform's images (`DOCKER_DEFAULT_PLATFORM`).
A foreign platform needs QEMU binfmt on the engine; the script names the workflow's pinned
`tonistiigi/binfmt` command (it registers `qemu-aarch64` in the host kernel until reboot or
`--uninstall qemu-aarch64`). Emulated arm64 is not a native arm64 test, and the dry run never covers GHCR,
`actions/attest` (Sigstore) or anonymous pulls.

```sh
FLUX_DRYRUN_PLATFORMS=linux/amd64,linux/arm64 FLUX_DRYRUN_SMOKE_PLATFORM=linux/arm64 \
  FLUX_DRYRUN_PORT=25800 FLUX_DRYRUN_PREVIOUS=a6e9851d1 bash scripts/release/dry_run.sh
```

## A supported host for the runtime checks

`smoke_runtime.sh` and `scripts/check_agent_runtime.sh` need a kernel with Yama `ptrace_scope` of 1 or more.
On a workstation without one (Yama 0, Docker Desktop), `scripts/agent-runtime/supported_guest.sh <state dir>
[command]` boots the official Ubuntu 24.04 cloud image (checksums verified against Ubuntu's signing key) as a
KVM guest, with QEMU in a container that gets only `/dev/kvm` and SSH on `127.0.0.1`, installs Ubuntu's Docker
packages, checks out this commit from a git bundle and runs the command (default
`scripts/check_agent_runtime.sh`; `scripts/release/dry_run.sh` gives the full release dry run including the
runtime smoke). It changes nothing on the host.

## Gates that remain open

Observed on 2026-10-01 unless stated otherwise. None of these can be closed by editing
this repository, and no release workflow has been dispatched.

- **Immutable-release read credential.** Provision the repository Actions secret
  `FLUX_RELEASE_ADMIN_READ_TOKEN` (below). The repository secrets API lists none (organization
  secrets could not be read with the available token), and `publish-release.yml` stops at its
  first release step without it. A fine-grained token can only be created by a person.
- **GHCR packages.** `ghcr.io/coldphase/flux-agent-runtime` is a second package with the same gate: it is
  created by the first candidate push, starts private and must be made public by someone with admin permission
  on the package before publication (the anonymous pull of both version tags fails otherwise).
- **GHCR package (application).** `ghcr.io/coldphase/flux` does not exist yet (the organization packages API
  returned 404, an anonymous token request 403). The first candidate push creates it. A new
  package starts private unless the organization's package settings say otherwise, and the
  publication workflow's anonymous pull needs it public; someone with admin permission on the
  package must set that (no REST endpoint for it is documented). Confirm that the `package`
  job's `packages: read` token can pull the digest too.
- **Actions policy.** The repository allows GitHub-owned and Marketplace-verified-creator actions
  and lists no other patterns. `docker/*` and `anchore/sbom-action` show as verified creators on
  their Marketplace pages; only a run proves that GitHub accepts them.
- **Complete application acceptance.** The owner's exact-SHA `ACCEPTED RELEASE CANDIDATE` and an
  independent reviewer's `INDEPENDENT RELEASE REVIEW` comments, including the Android/iPhone/iPad installation and push evidence required by
  [the mobile PWA contract](../product/mobile-pwa.md#acceptance-evidence).
- **First candidate run.** Untested until dispatched: the amd64 build of both images within the
  150-minute limit (for v0.1.1, the arm64 build under QEMU; a native arm64 runner is the alternative), the attestation push, the SBOM scope
  (inferred, not observed: Syft resolves the multi-platform index for the amd64 runner, while
  BuildKit's per-platform SBOM attestations in the index cover each platform), the draft creation,
  and the public package link.
- **Runtime smoke on the runner.** `smoke_runtime.sh` needs a runner kernel with `kernel.yama.ptrace_scope` of
  1 or higher (assumed for `ubuntu-latest`, not observed); from v0.1.1 the arm64 `docker run` checks of the runtime
  image rely on the QEMU emulator. Neither has run on GitHub. Locally, the full `dry_run.sh` including `smoke_runtime.sh`
  passed in a Yama 1 KVM guest on 2026-10-30 (`scripts/agent-runtime/supported_guest.sh`; evidence in
  `docs/development/evidence/release-closeout-20261030/`). A bound slot's sign-out and reuse with real
  vendor CLIs and the Claude Code installation (`runtime-install` reaching `downloads.claude.ai`) are
  independent-review items on the downloaded draft (#358 AC-3).
- **Packaged installation on amd64 (arm64 from v0.1.1), and a forward upgrade**, by the independent
  evaluator from the downloaded draft assets, following `INSTALL.md` literally; the upgrade leg of
  `smoke_artifacts.sh` is the checked command ([above](#the-upgrade-leg)). A local run of it on arm64
  and amd64 with locally built images is not this evidence: it is not the published digest.
- **Public downloads and the documented installation path** after publication, recorded in #77.

GitHub immutable Releases were enabled in the repository on 2026-09-27 and
read back as `enabled: true` using the [repository setting
API](https://docs.github.com/en/rest/repos/repos#check-if-immutable-releases-are-enabled-for-a-repository)
(read again on 2026-10-01 with a maintainer token).
Before running the publication workflow, configure the repository Actions secret
`FLUX_RELEASE_ADMIN_READ_TOKEN` as a fine-grained token limited to this repository
with **Administration (read)** permission. The built-in `GITHUB_TOKEN` cannot
request that permission. The token is used only to read this setting; release
edits still use the job's scoped `GITHUB_TOKEN`. Without the secret, or if the
token has expired or lacks access, publication stops. Give the token a bounded
expiration and renew the secret before the next release; do not place it in the
repository or release assets. If the setting is disabled, publication also stops.
The workflow checks the setting before
accepting the draft and again immediately before making it public, then verifies
the final release's `immutable` field. GHCR version tags remain governed by the
explicit never-retag checks because GitHub Release immutability does not control
package tags.

## Design notes

- GitHub documents that only identities with push access receive draft Releases (and a
  third-party report shows a read-only job getting "release not found"), so the first job of
  `publish-release.yml`, which inspects the draft, has `contents: write`; it only reads. This
  is not exercised without a dispatch.
- Drafts have no tag, so `gh release create` can add a second draft for the same version. The
  draft job therefore refuses to run when any release for the version exists. After a failed
  run, delete the unpublished draft (never a published release or a tag) and dispatch again, or
  use the next version. The GHCR digest pushed by the failed run carries no version tag.
- Every action is pinned to the commit of a reviewed tag (all nine resolved to those tags on
  2026-10-01), and the moving defaults of the build tooling are pinned too: buildx v0.37.1,
  BuildKit v0.33.0 by digest, the QEMU `tonistiigi/binfmt` image (qemu-v10.2.3, arm64 only) and
  the BuildKit SBOM scanner (`docker/buildkit-syft-scanner` 1.12.0) by digest. Re-check these pins
  before each release run.
- The workflows read acceptance and review comments only as data (exact lines by author
  login) and pass every input through the environment after validating it, never into a shell.
- `actions/attest` also tries to write an artifact-metadata storage record, which needs the
  `artifact-metadata: write` permission that the job does not have. Its source treats that
  as a warning, not a failure.

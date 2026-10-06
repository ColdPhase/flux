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
| `env.example` | [`docker/.env.example`](../../docker/.env.example), unchanged. GitHub stores a Release asset whose name begins with a period under another name (`.env.example` becomes `default.env.example`) and `actions/upload-artifact` skips hidden files, so the template is published without the period. |
| `INSTALL.md` | [`docs/operations/release-guide.md`](../operations/release-guide.md). It must stay self-contained (no repository-relative links). |
| `release.json` | Version, source SHA, image `ghcr.io/coldphase/flux@sha256:…` and platforms. |
| `sbom.spdx.json`, `THIRD_PARTY_NOTICES.json` | SPDX SBOM generated from the pushed image digest and the dependency notice inventory derived from it. |
| `LICENSE`, `SHA256SUMS` | The repository license and the checksums of every other asset. |

`tests/test_release_assets.py` packages the real operator files and fails when the
packaged `compose.yaml` differs from the tested one in anything but comments and the
digest, when an asset name would not survive GitHub, or when `INSTALL.md` stops matching
the assets and variables. The image is built from `docker/Dockerfile` (target `runtime`)
with `app/` as the context, the same inputs as the source Compose and the PR check.

## Flow

1. Finish integrated acceptance at one protected-main commit. Both delegated
   agents record their independent evidence in the acceptance issue. Each then
   posts an exact line `ACCEPTED RELEASE CANDIDATE <40-character source SHA>`.
2. Dispatch `Final release candidate` on `main` with that SHA, a fresh
   `vX.Y.Z` or `vX.Y.Z-rc.N` version and the acceptance issue number. The
   workflow requires the SHA to equal the dispatched main head, refuses a version whose
   remote tag exists (or cannot be read) and checks both acceptance comments. It builds
   the pinned amd64/arm64 image and pushes only by digest, with BuildKit provenance and SBOM
   attestations and an `actions/attest` build provenance attestation for the index. It writes
   the assets above. The packaged image must then install, create account/workspace data and
   restore a paired PostgreSQL/files backup in fresh Compose volumes
   (`scripts/release/smoke_artifacts.sh`) before the workflow creates a **draft** GitHub
   Release. The draft job checks the asset set against `SHA256SUMS` first.
3. Independently review that draft and its exact digest. Test downloaded assets
   on both supported platforms, a real forward upgrade from the previous
   supported version, backup/restore, the `gh attestation verify` command of
   `INSTALL.md` and user-facing behavior.
   Record run, commands, versions, digest, results, downtime and limits in #77.
   A new build digest requires a new artifact review. The independent reviewer
   posts this exact line in the review issue:

   ```text
   ACCEPTED RELEASE ARTIFACT <version> <source SHA> <sha256: image digest> <SHA-256 of SHA256SUMS>
   ```

4. Dispatch `Publish reviewed release` on `main` with those exact values and
   review issue number. It checks that the draft target and any peeled Git tag
   resolve to the accepted source SHA, then downloads and rechecks the draft
   assets (every file must be covered by `SHA256SUMS`, and nothing else may be attached)
   and the peer record. It promotes the existing digest to the never-retag
   `vX.Y.Z` GHCR tag, verifies anonymous image access, repeats the tag/target
   check immediately before publishing the immutable GitHub Release, then
   checks public asset downloads against `SHA256SUMS`. Record the final image
   digest, tag and release URL in #77. If publication fails mid-step, inspect
   the existing tag/release first; the workflow refuses to move a version tag
   to a different digest.

The workflow's packaged smoke is a gate, not the whole release evaluation. It runs on
one platform (amd64), and does not cover an upgrade, a TLS reverse proxy, browsers,
Web Push or SMTP. In particular, the first release has no previous version from which to
exercise a real forward upgrade: publish a candidate `-rc.N` first and upgrade from it.
Arm64 QEMU build and manifest inspection are not a native arm64 install test. Those
results remain open until the independent artifact review records them. The source
workspace and test stack continue using their own Compose path; the attached
`compose.yaml` is the pull-only operator path.

## Gates that remain open

Observed on 2026-10-01 unless stated otherwise. None of these can be closed by editing
this repository, and no release workflow has been dispatched.

- **Immutable-release read credential.** Provision the repository Actions secret
  `FLUX_RELEASE_ADMIN_READ_TOKEN` (below). The repository secrets API lists none (organization
  secrets could not be read with the available token), and `publish-release.yml` stops at its
  first release step without it. A fine-grained token can only be created by a person.
- **GHCR package.** `ghcr.io/coldphase/flux` does not exist yet (the organization packages API
  returned 404, an anonymous token request 403). The first candidate push creates it. A new
  package starts private unless the organization's package settings say otherwise, and the
  publication workflow's anonymous pull needs it public; someone with admin permission on the
  package must set that (no REST endpoint for it is documented). Confirm that the `package`
  job's `packages: read` token can pull the digest too.
- **Actions policy.** The repository allows GitHub-owned and Marketplace-verified-creator actions
  and lists no other patterns. `docker/*` and `anchore/sbom-action` show as verified creators on
  their Marketplace pages; only a run proves that GitHub accepts them.
- **Complete application acceptance.** Both agents' exact-SHA `ACCEPTED RELEASE CANDIDATE`
  comments, including the Android/iPhone/iPad installation and push evidence required by
  [the mobile PWA contract](../product/mobile-pwa.md#acceptance-evidence).
- **First candidate run.** Untested until dispatched: the amd64/arm64 build under QEMU within its
  90-minute limit (a native arm64 runner is the alternative), the attestation push, the SBOM scope
  (inferred, not observed: Syft resolves the multi-platform index for the amd64 runner, while
  BuildKit's per-platform SBOM attestations in the index cover each platform), the draft creation,
  and the public package link.
- **Packaged installation on amd64 and arm64, and a forward upgrade**, by the independent
  evaluator from the downloaded draft assets, following `INSTALL.md` literally.
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

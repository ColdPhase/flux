# Final OCI release pipeline

The [distribution decision](repository-distribution-proposal.md) requires an
explicit final build and publication after the complete application is accepted.
These workflows are dormant during ordinary PR and `main` pushes.

1. Finish integrated acceptance at one protected-main commit. Both delegated
   agents record their independent evidence in the acceptance issue. Each then
   posts an exact line `ACCEPTED RELEASE CANDIDATE <40-character source SHA>`.
2. Dispatch `Final release candidate` on `main` with that SHA, a fresh
   `vX.Y.Z` or `vX.Y.Z-rc.N` version and the acceptance issue number. The
   workflow requires the SHA to equal the dispatched main head and checks both
   acceptance comments. It builds the pinned amd64/arm64 image and pushes only
   by digest. It writes SPDX SBOM, dependency notice inventory, provenance,
   source metadata, digest-pinned Compose, environment template, instructions,
   license and SHA-256 checksums. The packaged image must install, create
   account/workspace data and restore a paired PostgreSQL/files backup in fresh
   Compose volumes before the workflow creates a **draft** GitHub Release.
3. Independently review that draft and its exact digest. Test downloaded assets
   on both supported platforms, a real forward upgrade from the previous
   supported version when one exists, backup/restore and user-facing behavior.
   Record run, commands, versions, digest, results, downtime and limits in #77.
   A new build digest requires a new artifact review. The independent reviewer
   posts this exact line in the review issue:

   ```text
   ACCEPTED RELEASE ARTIFACT <version> <source SHA> <sha256: image digest> <SHA-256 of SHA256SUMS>
   ```

4. Dispatch `Publish reviewed release` on `main` with those exact values and
   review issue number. It checks that the draft target and any peeled Git tag
   resolve to the accepted source SHA, then downloads and rechecks the draft
   assets and peer record. It promotes the existing digest to the never-retag
   `vX.Y.Z` GHCR tag, verifies anonymous image access, repeats the tag/target
   check immediately before publishing the immutable GitHub Release, then
   checks public asset downloads against `SHA256SUMS`. Record the final image
   digest, tag and release URL in #77. If publication fails mid-step, inspect
   the existing tag/release first; the workflow refuses to move a version tag
   to a different digest.

The workflow's packaged smoke is a gate, not the whole release evaluation. In
particular, the first release has no previous version from which to exercise a
real forward upgrade. Arm64 QEMU build and manifest inspection are not a native
arm64 install test. Those results remain open until the independent artifact
review records them. The source workspace and test stack continue using their
own Compose path; the attached `compose.yaml` is the pull-only operator path.

GitHub immutable Releases were enabled in the repository on 2026-09-27 and
read back as `enabled: true` using the [repository setting
API](https://docs.github.com/en/rest/repos/repos#check-if-immutable-releases-are-enabled-for-a-repository).
The publish workflow verifies the final release's `immutable` field. GHCR
version tags remain governed by the explicit never-retag checks because GitHub
Release immutability does not control package tags.

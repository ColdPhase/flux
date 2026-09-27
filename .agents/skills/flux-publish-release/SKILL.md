---
name: flux-publish-release
description: Build, test, and publish Flux application artifacts from an accepted release candidate through GitHub Actions and GitHub Releases, with version and download verification.
---

# Package and publish Flux

Read `AGENTS.md`, the release contract and candidate acceptance report, and
[CI and releases](../../../docs/agents/ci-and-releases.md). Publication requires
recorded authority and the actual artifact formats in the release contract.

1. Confirm the accepted candidate SHA, required checks, exact version, packaging
   targets, and publication permissions. Respect existing tag and branch rules.
2. Build the selected distribution in Actions from that SHA and test installation
   and startup of the produced artifact in a clean environment. Implement or repair
   the workflow through a reviewed PR if it does not yet exist.
3. Create/reuse the tag and draft release consistently. Verify an existing tag's
   target; never move it silently. Record source SHA, build run, asset digests,
   supported platforms, release notes, and installation/upgrade instructions.
4. Have the peer verify draft contents and packaged behavior. Keep publishing
   permissions isolated to the publishing job. A changed source candidate needs
   evaluation again before release.
5. Publish in the agreed prerelease/stable mode. Verify the actual download URLs,
   checksums, and documented install path, then link evidence from the milestone's
   acceptance task/PR.
   Resume matching work after an interruption instead of duplicating a release.

If a hosting deployment is part of the contract, perform and verify it for that
specific target. GitHub Release assets do not establish that a backend is running.
A failed package, download, or deployment check remains a delivery blocker.

Final publication is authorized without human acceptance, after independent verification of the complete application. Use an explicit final workflow invocation for the tested candidate. Do not publish/build a release for each main push, PR, intermediate milestone or schedule. Verify the delivered version and record the full-product acceptance evidence.

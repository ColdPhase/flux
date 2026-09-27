# CI and application releases

## Actions budget and final delivery

Keep PR checks lightweight: lint, type checks and relevant fast tests, with
concurrency cancellation. Avoid duplicate main-push/PR runs, broad matrices,
scheduled builds and automatic packaging on feature merges. Run substantial
application/browser/integration/install tests locally in Docker and record evidence.
Release packaging is an explicitly triggered final workflow for the completed
application candidate, launched by an agent after independent verification.
No human review or environment-approval gate is required by this workflow.
Do not spend Actions runs rebuilding an unchanged successful candidate.



Agents are responsible for the delivery pipeline as part of the accepted release
scope: proposing checks, implementing workflows, verifying them, configuring
required PR checks, and building/publishing the finished version. Scope and
credentials come from the release contract. Routine pipeline work within that
authorization can proceed without repeated permission requests.

## Available in this foundation

[Repository checks](../../.github/workflows/repository-checks.yml) runs
`python3 scripts/check_agent_setup.py` and its regression tests on PRs as the
required `Agent setup` check. It checks the shared instructions (`AGENTS.md`
imported by `CLAUDE.md`), the `.claude/skills` link, skill frontmatter and local
documentation links, using the Python standard library. It does not validate
application functionality.

Application lint, tests, compilation, packaging, and publication require the later
stack/release decisions. The current structural check cannot replace those
future gates.

## 1. Design checks from the actual stack

Once the application architecture is accepted, the planner creates pipeline tasks
alongside product work. The two agents agree on:

- format/lint and type/static checks appropriate to the selected languages;
- unit and integration tests for real behavior, plus key browser journeys;
- a reproducible build using pinned tool versions and committed dependency locks;
- clean setup/startup checks, required services, fixtures, and isolated test data;
- artifact formats and supported targets appropriate to the application;
- local commands matching CI, without provider-specific secrets for basic PR checks.

Write commands that actually execute work. Demonstrate each failure path with a
controlled failing fixture or temporary test branch, restore it, and record the
successful run. Do not add placeholder jobs, `echo`-only validation, or swallowed
test failures to make a status appear green.

The application, toolchain, databases, queues and tests use Docker/Compose under
the [environment contract](../development/containers.md). Use the same container
commands locally and in Actions, including readiness, migrations, and isolated
test data. Do not require a host installation of PostgreSQL or an app toolchain.

Record the real commands and status-check names in the release contract and
`AGENTS.md`. The peer reviews workflow changes and their observed behavior.

## 2. Implement GitHub Actions

Use `pull_request` for contribution validation and `push` on the protected base
for integration verification; add a merge-queue trigger only if a queue is used.
PR workflows must run with read-only repository permissions and no release
credentials. Never execute a contributor's checkout under privileged
`pull_request_target` or privileged comment-triggered workflows.

Keep workflow/job check names stable and unique. Pin external actions to reviewed
commit SHAs, use explicit timeouts, and cancel obsolete PR runs where appropriate.
Preserve logs and useful failure artifacts without credentials or private data.

Required checks must report on every applicable PR. Avoid whole-workflow path
filters that strand a required check. If an aggregate gate is used, run it even
when a dependency fails and explicitly reject failed, cancelled, or unexpectedly
skipped prerequisites; a skipped test suite is not evidence of a working app.

Keep privileged publication separate from PR execution. Do not promote arbitrary
fork artifacts or issue text into commands running with write permissions.

Verify how automation triggers its next workflow with the selected credentials.
For example, a tag pushed using `GITHUB_TOKEN` does not start a second push-triggered
workflow. Prefer an explicit dispatch or one controlled build/publication workflow
when chaining is needed, and test it. Token-created PR workflows can also require
approval; account for the documented behavior instead of assuming every API write
wakes CI. See [Triggering a workflow](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).

## 3. Roll out required checks after proving them

1. Open the workflow PR and inspect a real GitHub Actions run, including logs and
   the exact check names/source. Fix failures and have the peer review it.
2. Merge the workflow through the current repository rules. Confirm it is present
   on the default branch and succeeds for the intended triggers.
3. Read and preserve all applicable repository/organization rulesets and classic
   branch protection. Check that the intended actor may update the repo rule.
4. Add the observed checks to `main`'s existing protection, binding the expected
   source integration where supported. Preserve required approval, Code Owners,
   conversation resolution, linear history, and push/deletion restrictions.
   Require validation against the current base before merge, using up-to-date
   branches or a tested merge queue, so parallel PRs cannot rely on stale integration results.
5. Read the effective rules back. On an authorized temporary PR, demonstrate that
   a deliberately failing required check blocks merge; correct it and confirm the
   check passes. Record remaining review requirements accurately.

This order prevents requiring a check that does not exist or cannot run. Do not
replace the entire ruleset with a reduced sample. If policy or permissions stop
the change, report the exact remaining step and evidence; do not claim enforcement.
Never remove or weaken a gate to resolve a failing application PR.

GitHub documents required checks in
[Available rules for rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets).

## 4. Build distributable artifacts

Choose packaging from the later stack decision. Possible formats include an
installable binary, a web distribution archive, or a versioned container image.
This foundation chooses none. A self-hosted server may need an image plus setup
instructions; a repository source archive by itself is not a tested application
distribution.

Build in Actions from the exact accepted candidate SHA. Test the produced package
in a clean environment, not just the source checkout. Record version, source SHA,
supported platform, asset names, checksums/digests, and the workflow run. Include
installation/upgrade instructions and relevant configuration or migration notes.
If packaging changes the candidate code, evaluate the new candidate again.

Actions artifacts support inspection of a run. User-facing distribution goes to
the accepted publication target: GitHub Release assets, and optionally versioned
packages/container images with links from that release. Do not assume CI artifact
retention supplies a permanent download channel.

## 5. Publish and verify the release

1. Re-read the accepted release contract, candidate report, checks, repository
   rules, and publication permission. The selected candidate must be reachable
   from protected `main` and match the tested version.
2. Choose the agreed version/tag. If the tag already exists, verify it points to
   the same candidate; never silently move or overwrite an existing release tag.
3. Run the build/publication workflow on that exact revision. Build/test jobs use
   read-only permissions. Only the publishing job gets the necessary write scope,
   such as `contents: write` for a GitHub Release or package permission for images.
4. Prepare a draft release, attach the verified artifacts, checksums, source/run
   references, and release notes. Select prerelease versus stable from the contract.
5. Independently verify packaged startup and the draft's expected assets before
   publishing. Reuse a matching draft/run on retry; do not duplicate releases.
6. After publication, verify public download URLs, asset checksums, and the
   documented installation path. Link the release and evidence from the milestone's
   acceptance task/PR. A failed delivery check remains an open release blocker;
   record it and continue independent work while seeking the peer's help.

Publication is delegated to the agents and proceeds after all technical gates
pass. Publishing an asset and deploying a running service have different outputs;
perform any deployment only for the named, authorized target, then verify it.

[GitHub Releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)
provides versioned release notes and downloadable assets. A runnable backend needs
a hosting/deployment target; [GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)
serves static sites. Choose hosting with the application's architecture.

## Evidence for completion

A delivery task reports the workflow PR, successful/failing run evidence, effective
required-check configuration, candidate SHA, tag, artifact digests, release URL,
and actual installation/acceptance results as applicable. Mark missing evidence
as unverified. This record is the input to `flux-verify-release` and the release
milestone's final acceptance.

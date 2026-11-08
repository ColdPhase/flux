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

[Evaluator checks](../../.github/workflows/evaluator-checks.yml) is a separate manual
workflow for review evidence only. An explicit `workflow_dispatch` from `main` runs
`scripts/check_ui.sh` or `scripts/check_application.sh` on a full commit SHA with 1 to 10
named targets (never a whole suite), for an evaluator whose own Docker cannot build the
images. It has a 60-minute timeout, a read-only token, no secrets and a 7-day artifact of
the log tail and at most 60 small screenshots. It is not a PR check, is never required,
and no push, PR or schedule starts it. It runs the candidate's own scripts, so dispatch
only heads you have read; do not rerun an unchanged head and target set.



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

The `Application validation` contract ([#143](https://github.com/ColdPhase/flux/issues/143))
uses the pinned application's Docker `test` target: its build performs compilation,
type checks and lint, then a disposable container runs `app/tests/app/architecture.test.ts`
and every `app/tests/app/*-core.test.ts`. These portable tests run without networking,
database, worker or browser services. Every main-targeted PR receives the same
check, obsolete runs are cancelled, and an explicit dispatch can check the base.
The workflow does not automatically duplicate a successful merge on a main push.

This fast check does not establish API/persistence, browser interaction, restart,
installation, mobile or release acceptance. Select local Docker checks using the
[verification policy](evaluation.md#choose-verification-by-impact), including
targeted browser modules or broader application/runtime/installation checks as
the impact requires. Attach commit-specific evidence for independent evaluation.
The complete commands and all product criteria remain required for their applicable
scope; neither this check nor `Agent setup` replaces them. Publication remains
in the explicitly triggered final release workflow.

On 2026-09-30, #143's independently approved workflow was protected-merged,
then passed its explicit main dispatch. Ruleset `24053383` now requires both
`Agent setup` and `Application validation` from observed GitHub Actions integration
`15368`, with strict current-base validation. Every prior review/Code Owner,
thread-resolution, history, deletion/push and no-bypass rule is preserved.
[Source-pinned rollout evidence](https://github.com/ColdPhase/flux/blob/b17ae9e357441e9a383eb275d1034e69ec50c98a/docs/agents/evidence/143-required-application-validation/README.md)
includes read-back/effective rules and a real failing portable test whose normal
merge was explicitly rejected. The temporary fixture is removed in the corrected
head; that head's passing run and eligible independent documentation review are
required before its PR merges. These fast gates do not replace application or
release acceptance.

[Docs site](../../.github/workflows/docs-site.yml) (#734) builds the documentation site in
`site/` (Astro Starlight) with `./scripts/check_docs_site.sh`, in the same pinned Node image as the
application, and fails on a broken internal link or anchor. It runs on pull requests that change the
site or one of the documents it publishes (path filter), cancels superseded PR runs, and deploys to
GitHub Pages only on a push to `main` or a dispatch from `main`. It is not a required check. The
pages are generated from `README.md` and the user-facing files under `docs/` by
`site/scripts/sync-docs.mjs`; internal agent, process and design documents are not published. A new
user-facing document is published by adding it to `PAGES` there and to the workflow's paths.

## Signing release images (#840)

[`final-release.yml`](../../.github/workflows/final-release.yml) job `sign` signs both image digests (`ghcr.io/coldphase/flux`
and `ghcr.io/coldphase/flux-agent-runtime`) **keylessly** with cosign (Sigstore, the job's GitHub OIDC token, `id-token: write`),
after the `scan` and `package` jobs pass and before the draft is created (`draft` needs `sign`). The certificate names
`https://github.com/ColdPhase/flux/.github/workflows/final-release.yml@refs/heads/main`, which is what the release can only be
dispatched from. There is no signing key to store, rotate or leak. Nothing else changed in the release path: the action is pinned by
SHA like the others (`sigstore/cosign-installer`, cosign `v3.0.6`), no check was added, no PR check starts it.

[`publish-release.yml`](../../.github/workflows/publish-release.yml) job `verify` runs `scripts/release/verify_signatures.sh` on
the reviewed image digest and the agent-runtime digest from `release.json` before anything is promoted or published: a digest
without that workflow's signature stops the publication. Operators run the same `cosign verify`
([`release-guide.md`](../operations/release-guide.md#verify-the-images-before-you-pull-them), shipped as `INSTALL.md`).
The script accepts only `image@sha256:` references (a tag can move).

What is proved without a release: `scripts/release/check_signing.sh` signs two digests with a throwaway key against a throwaway
registry in Docker (the pinned cosign image), and shows that `verify_signatures.sh` accepts the signed digests and refuses an unsigned
one, a digest signed with another key, a tag, and new content pushed under a signed tag; `tests/test_release_signing.py` checks the
keyless command line, the identity pattern against workflow paths that must and must not match, the pins and the job order. What
only a real release proves: that GitHub's OIDC token yields a certificate with that identity, that Rekor records the entry, and
that ghcr.io accepts the signature manifest. The first release after this change is the proof: verify its two digests with the
commands of `INSTALL.md` from a machine that has nothing of ours before you publish it.

## Dynamic security testing (#838)

`./scripts/check_dast.sh` runs OWASP ZAP (pinned by digest, 2.17.0) against the real application in Docker: the stack started with
the `./flux demo` data and two people, a baseline scan of the web app, and an **active, authenticated** scan of the API once as
the owner and once as a member, from an OpenAPI document made from the server's own route listing
(`scripts/dast/prepare.py`). It is a manual acceptance step before a release (a full run takes tens of minutes), never a PR check.
Reports and `summary.md` go to `dast-reports/`. [`scripts/dast/zap-rules.conf`](../../scripts/dast/zap-rules.conf) records each false
positive with its reason; `summarize.py` exits 10 while a Medium or higher alert is neither fixed nor recorded there, and 2 when a
report is missing (a scan that did not run is not clean). A real finding that cannot be fixed in the same change is an issue in the
milestone, and its rule line says `Tracked in #N` (the summary lists it apart from the false positives). The stack is a test
deployment because the OpenAPI document is made from its route listing; the rate limits are off in it (an active scan would be answered
429, and test the limiter instead of the application).

**What the first runs found** (2026-11-08, ZAP 2.17.0, 288 operations, two signed-in people): no injection, XSS, path traversal or
authorization alert from the active scan of either person. Fixed in the same change: a NUL character in a name answered 500 on every
route that stored it (now a 400 for any text, `databaseConflict`); no `X-Content-Type-Options`, `Permissions-Policy` or
`Cross-Origin-Resource-Policy` header (now on every response, `framing.ts`). Tracked: the web app's missing Content-Security-Policy beyond
`frame-ancestors` (#979). Recorded as false positives: ZAP's "PII Disclosure" on the last 12 digits of a UUID, and the caller's own session
address in `get-session`. The 503s on the GitHub routes are the App not being configured in this stack.

### Rate limits and CodeQL `js/missing-rate-limiting` (#956)

CodeQL flags 16 route registrations that reach PostgreSQL, the keyring or an outside service with no rate limit. Sign-in, sign-up,
password reset, invites, encryption unlock and live join already have limits of their own; for the rest the decision is **one floor
under every API route** (`apps/server/src/http/rate-limit.ts`, registered in `app.ts`) rather than sixteen route limits:
1,200 requests a minute per session (the browser's cookie `flux.session_token`, or an Authorization header), 600 per address without a
credential and 1,200 a minute per address for a session the server has not accepted yet (a made-up cookie has no budget of its own), and no total per address, so people behind one office address or one proxy are not
limited together; fixed one-minute windows in the API process, memory-bounded, `429 RATE_LIMITED` with `Retry-After`. A person using Flux does not come near it; a runaway client or
a flood does. `FLUX_AUTH_RATE_LIMIT=false` turns it off with the sign-in limit (the test stacks do). It covers the routes of all 16
alerts (`/api/v1/health` and the back-channel logout answer the anonymous count; the Better Auth catch-all also keeps its own limit).
Route-specific limits stay where a route is costly by design and already have one. CodeQL does not recognise this limiter as one, so
the alerts are dismissed in the Security tab as "won't fix", naming `rate-limit.ts`, once the limiter is on `main`;
`tests/app/api-rate-limit-core.test.ts` is the evidence that it holds.

## Security scanning

Four scanners watch the code, the dependencies and the images (v0.2: #834, #835, #836). None is a required check yet; the
last section here says what proving them takes. All four are lightweight on pull requests: path filters, cancelled
superseded runs, read-only tokens, and the scanner in a container pinned by digest.

| Scanner | What it checks | When | Failure |
| --- | --- | --- | --- |
| [Dependabot](../../.github/dependabot.yml) | Version updates for the pnpm workspace (`app/`), the docs site (`site/`) and the test tooling with a lockfile (`app/tooling/`), GitHub Actions, Dockerfiles and Compose files | Weekly (Monday), batched (one PR per group and directory; a major update arrives alone), at most 3 to 5 open PRs per ecosystem; Playwright (the `playwright` package and the `mcr.microsoft.com/playwright` images) is ignored, since its pins must move together by hand | A PR, reviewed and merged like any other |
| [Dependency audit](../../.github/workflows/dependency-audit.yml) | `pnpm audit --prod` on `app/pnpm-lock.yaml` through `scripts/security_scan.py audit` | Pull requests that touch a manifest, the lockfile, the audit or its allowlist; weekly on `main`; dispatch | A HIGH or CRITICAL advisory in a production dependency that the allowlist does not name |
| [CodeQL](../../.github/workflows/codeql.yml) | `javascript-typescript`, `security-extended`, over `app/apps`, `app/packages` and `app/tooling` ([config](../../.github/codeql/codeql-config.yml)) | Same-repository pull requests that touch that source; weekly on `main`; dispatch | New alerts under Security > Code scanning; the run is red only when CodeQL itself fails |
| Image scan | Trivy on both release images, every platform: [`final-release.yml`](../../.github/workflows/final-release.yml) job `scan` before the draft, and [`image-scan.yml`](../../.github/workflows/image-scan.yml) weekly on the latest published release | Each release candidate; weekly | The release run fails on a HIGH or CRITICAL finding that has a fixed version and is not allowlisted; the weekly run opens or updates an issue labelled `security-scan` |

`scripts/security_scan.py` holds the policy for the audit and the image scan, and `scripts/release/dry_run.sh` runs the
same image scan on its throwaway registry, so the release workflow's gate can be tried locally. The Node image and
pnpm version of the audit are read from `docker/Dockerfile`; Trivy is pinned in the script. Findings without a fixed
version are listed and do not fail an image scan; an advisory without a fix still needs an allowlist entry for the audit.

The scans fail closed. A report that is empty, not JSON, not the scanner's report (`{}`, an error document) or lists no
scanned target (`Results` empty for an image, no dependencies counted for the audit) is an error, never "clean", and a
crash of the script is never "findings". The script's exit codes carry that, and the Image scan workflow relies on them
(the other consumers fail on any non-zero code):

| Exit | Meaning | On a pull request run of `Image scan` |
| --- | --- | --- |
| `0` | Clean | Passes |
| `10` | Findings: HIGH/CRITICAL with a fix and not allowlisted, or an expired or malformed allowlist entry | Passes, shown in the summary: a fact about the published release, not about the change (the allowlist itself is validated by an earlier step that fails) |
| `2` | The scan did not run or its report is unusable: no report, empty, unparsable, no scanned targets, unreadable allowlist, the registry or advisory database unreachable after three attempts | Fails |
| `3` | The script crashed (the traceback is in the log) | Fails |
| anything else | The interpreter's `1` for an error nothing caught (an import or syntax error), a killed process, a step that wrote no code (the scan step fails when it cannot write the code, and the step that fails the job always runs and decides in shell, so a missing code is not read as `0`) | Fails: the workflow lists what passes, so an unknown code does not |

On a schedule or a dispatch every non-zero code fails the run, and only `10` opens or updates the `security-scan` issue.

### The allowlist

[`.github/security-allowlist.json`](../../.github/security-allowlist.json) is the one list of reviewed exceptions for the
audit and the image scan. An entry names the `scanner` (`audit` or `image`), the advisory or CVE `id` (the audit uses
GHSA identifiers, Trivy often CVE identifiers for the same advisory, so a package can need one entry in each), the
`package` (required: an entry excuses one advisory in one package, and an entry without a package is malformed), a `reason`
that says why the risk is accepted, a `tracking` link to the issue that removes it, the `reviewed` date and an
`expires` date at most 90 days later. The reason is the reachability judgement, not "it is in the lockfile": which code
path the advisory needs, that Flux does not have it (or that it is an availability problem for an authenticated user
only), and the upgrade that removes the entry. An expired or malformed entry fails the scan until somebody
reviews it again (new dates, a reason that still holds) or removes it; that is the point. Add an entry only in a PR whose
description links the evidence (reachability, why the fix cannot land yet), and prefer the fix to the entry.
`python3 scripts/security_scan.py allowlist` validates the file.

### Triage

- **Who.** The agent that holds the milestone's CI and release issue triages every new alert, scan failure or CodeQL
  alert; the owner of the affected code fixes it, as an ordinary issue in the milestone with the advisory linked. Alerts
  that need a decision about product behavior go to the release owner (`PelikanFix16`).
- **Where alerts arrive.** Dependabot alerts and CodeQL alerts under the repository's Security tab (the Dependabot security
  updates and secret scanning with push protection are enabled, see below); the `Dependency audit` and release `scan`
  runs; the `security-scan` issue of the weekly image scan. An agent starting a session checks them with the issues it was assigned:
  `gh api repos/ColdPhase/flux/dependabot/alerts --jq 'map(select(.state=="open"))'`,
  `gh api 'repos/ColdPhase/flux/code-scanning/alerts?state=open'` and `gh issue list --label security-scan`.
- **Service levels**, from the day the alert is first seen:

  | Severity | Triage (reachable here or not, recorded in the issue) | Fixed, or an expiring allowlist entry |
  | --- | --- | --- |
  | Critical | 1 working day | 3 working days |
  | High | 3 working days | 14 days |
  | Moderate | the next weekly Dependabot batch | 30 days |
  | Low | when the package is next touched | best effort |

  A CRITICAL or HIGH finding in a release candidate is fixed or allowlisted (with its expiry) before the candidate is
  accepted; the reviewer of the draft reads the `scan` job's summary (release pipeline, step 3). A P1 or P2 CodeQL alert becomes an issue; a dismissed one
  records the reason in the alert.
- **Not covered.** None of this replaces review or the application's own tests; `pnpm audit` and Trivy report known
  advisories only, and CodeQL is static analysis.

### Repository settings, read 2026-11-03

`gh api repos/ColdPhase/flux`: Dependabot alerts on (`vulnerability-alerts` answers 204), Dependabot security updates
`enabled`, secret scanning `enabled`, secret scanning push protection `enabled`; non-provider patterns and validity checks
`disabled`. Code scanning default setup is `not-configured`: the CodeQL workflow is the advanced setup, and enabling the
default setup as well would make GitHub refuse its uploads. The Actions policy allows GitHub-owned and verified-creator
actions, which covers `github/codeql-action`; every action is pinned to a commit. Nothing was changed in the settings
or in branch protection.

### Rollout

Proven first, required later (section 3): a scanner becomes a required check only after a real run on the default branch,
the exact check name read from it, and an observed failing run that blocks. Until then each is advisory:

- `Dependency audit`, `CodeQL` and the PR run of `Image scan` have path filters on pull requests, so they cannot be
  required as they are (a required check that does not run on a PR blocks it). To require one, make it run on every pull
  request and decide inside the job whether there is anything to scan.
- The release `scan` job gates the draft by dependency (`needs`), not by a branch rule.
- First runs, on the pull request that introduced them ([#879](https://github.com/ColdPhase/flux/pull/879), 2026-11-03):
  [Dependency audit](https://github.com/ColdPhase/flux/actions/runs/41632810656) passed in 10 s,
  [CodeQL](https://github.com/ColdPhase/flux/actions/runs/41632810632) in 1 min 56 s (1,223 files, 105 queries, no alerts), and
  [Image scan](https://github.com/ColdPhase/flux/actions/runs/41632810750) in 27 s (it reported 125 findings with a fix and 13
  allowlisted in the published v0.1.0 images, and did not fail the pull request run). Not yet run: the release `scan` job (it
  needs a release dispatch; `scripts/release/dry_run.sh` runs the same script) and the issue-opening job of `Image scan` (a
  schedule or dispatch on `main`). After merging, dispatch `CodeQL` and `Image scan` once on `main`
  (`gh workflow run codeql.yml --ref main`): CodeQL warns that a workflow without a `push` trigger has no baseline for the
  Security tab until a run on `main` exists, and the repository's rule against duplicate main-push runs keeps it on a schedule.

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

Flux implements this as two explicit `workflow_dispatch` workflows on `main`, neither run
by a PR or a push ([#77](https://github.com/ColdPhase/flux/issues/77)):
[`final-release.yml`](../../.github/workflows/final-release.yml) checks the exact candidate
SHA, the release owner's acceptance and an independent reviewer's review (a reviewer who wrote none of
the code), builds the application and agent-runtime images for its `platforms` input (`linux/amd64`
for v0.1; `linux/amd64,linux/arm64` from v0.1.1) by
digest ([#358](https://github.com/ColdPhase/flux/issues/358)), packages the digest-pinned operator
assets (including the optional runtime and live-media overlays), smoke-tests their install and paired
backup/restore, and creates a draft Release;
[`publish-release.yml`](../../.github/workflows/publish-release.yml) publishes
only after an independent exact artifact review. Their assets, flow, design notes and the gates
that remain open (credential, package visibility, candidate acceptance, platform evidence)
are in the [release pipeline](../development/release-pipeline.md).

## Evidence for completion

A delivery task reports the workflow PR, successful/failing run evidence, effective
required-check configuration, candidate SHA, tag, artifact digests, release URL,
and actual installation/acceptance results as applicable. Mark missing evidence
as unverified. This record is the input to `flux-verify-release` and the release
milestone's final acceptance.

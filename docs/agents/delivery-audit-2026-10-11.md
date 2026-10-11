# Flux delivery audit — 2026-10-11

Requested by Hubert: explain why issues accumulate while several agents work,
and shorten the time to the complete application. Prepared for Maurycy's review
in [#476](https://github.com/ColdPhase/flux/issues/476).

## Finding

The strongest evidence points to too much unfinished implementation, dependent
PR chains and repeated integration work. Full local test runs and shared-host
contention amplify that queue. The lightweight required GitHub Actions check is
not the observed half-hour test bottleneck. Producing more parallel branches
without increasing independent review and integration capacity will not solve
this. Measure completed accepted outcomes and remaining release blockers.

This is a diagnosis from repository evidence, not a measured causal breakdown
of every agent's time. The audit did not run a benchmark or an application suite.

## Snapshot and method

GitHub observation: approximately **10:00–10:09 UTC, 2026-10-11**. Repository:
`ColdPhase/flux`. Local main was `6e81027988527aa4b34e4cd7ae0f363b422d6a2b`;
fetched main was `6a00059ac188c6d950585400e2294a2470f29e24` (two documentation
commits ahead). Counts below are historical, not a live dashboard.

Read all pages of REST issues (excluding entries with `pull_request`) and pulls,
all reviews for the 268 PRs, detailed state of 32 open PRs, comments from 91 PRs
and 21 selected issues, Actions runs since October 7, branch rules and releases.
Inspected instructions, shared skills, test runners, Docker configuration and a
read-only host snapshot. Comment sampling was targeted, not random. A GitHub
account is not a count of independent agents. Review comments from a PR author's
account are not eligible independent GitHub approvals.

| Observation | Result at snapshot | Meaning / limit |
| --- | --- | --- |
| Issues | 205 total; 88 open | Issues and PRs counted separately. |
| PRs | 268 total; 227 merged; 32 open | High code throughput can coexist with unfinished outcomes. |
| Open PR authors | PelikanFix16: 27; Zamojski5: 5 | Both exceed the then-documented cap of 3; delegated branches must count too. |
| Open PR merge states | 16 behind, 8 dirty, 8 clean | GitHub state is time-sensitive; dirty indicates conflicts, clean is not approval. |
| Open PRs targeting a branch other than main | 10 | Integration often waits for a parent, not just a reviewer. |
| Issues since October 7 | 51 created; 27 closed | Net inflow exceeds outflow in this window; closures alone do not prove completion. |
| October 10 | 40 PRs merged; 7 issues closed | Slices are moving, but merged PR count is a poor sole delivery measure. |
| Actions since October 7 | 711 runs; 355 Application validation | 334 application successes, 3 failures, 18 cancellations. |
| Successful Application validation duration | Median 146 seconds | `updated_at - run_started_at` is a proxy, not exact execution time. |
| Published GitHub releases | 0 | Consistent with the final-only publication policy; not proof that no application runs. |

For the Actions timing cross-check, [run 38129825878](https://github.com/ColdPhase/flux/actions/runs/38129825878)
had a successful job lasting about 146 seconds, including a 137-second Docker
build/test step. This does not measure local full suites or agent waiting time.

## Where time is lost

### 1. The integration queue grows faster than it drains

Examples of parent-to-child PR chains at the snapshot:

- [#384](https://github.com/ColdPhase/flux/pull/384) → [#392](https://github.com/ColdPhase/flux/pull/392) → [#412](https://github.com/ColdPhase/flux/pull/412) → [#416](https://github.com/ColdPhase/flux/pull/416); #392 also blocks [#418](https://github.com/ColdPhase/flux/pull/418).
- [#372](https://github.com/ColdPhase/flux/pull/372) → [#393](https://github.com/ColdPhase/flux/pull/393) → [#414](https://github.com/ColdPhase/flux/pull/414).
- [#376](https://github.com/ColdPhase/flux/pull/376) → [#383](https://github.com/ColdPhase/flux/pull/383) → [#417](https://github.com/ColdPhase/flux/pull/417).
- [#466](https://github.com/ColdPhase/flux/pull/466) → [#467](https://github.com/ColdPhase/flux/pull/467).

Finish the oldest actionable dependency root, then its children. Updating all
32 PRs after every main change creates another cycle of conflicts, CI and review.
Keep existing work, but stop adding unrelated feature branches while over capacity.
The former instruction to keep milestones stocked encouraged the wrong activity
when the implementation queue was already full.

### 2. Test policy contradicts itself and runner selection is incomplete

At the audited revision, CONTRIBUTING required full application and browser
suites before marking a PR ready. AGENTS asked for verification proportional to
the change, and the implementation skill mentioned targeted checks only during
iteration. An agent following the strictest reading repeats broad tests at handoff.

[Issue #456](https://github.com/ColdPhase/flux/issues/456) records 511 UI tests
in **2026.892 seconds, about 34 minutes**. That is historical evidence, not a
new audit run. By comparison, [a scoped #369 run](https://github.com/ColdPhase/flux/pull/369#issuecomment-6102731230)
reports 59 tests in 162.675 seconds on Chromium and 183.931 seconds on WebKit;
those test timings exclude image build/setup and are not an equivalent workload.
They demonstrate selectable scope, not a measured tenfold runner speedup.

`check_ui.sh` already accepts module/test selectors, but builds its stack first.
`check_application.sh` runs the whole configured chain; a supported API-file
selector remains [#424](https://github.com/ColdPhase/flux/issues/424).
Rejecting unknown UI selectors before building remains
[#421](https://github.com/ColdPhase/flux/issues/421). The policy change does not
implement either feature or authorize silently omitting required coverage.

### 3. Docker cost and host contention need separate treatment

The host snapshot showed 24 logical CPUs, about 62 GiB RAM (43 GiB available),
311 GB available disk, 179 worktrees, and Docker reporting 287 images (83.39 GB),
522.3 GB build cache (476.3 GB reclaimable), 78 containers (17 running) and 101
volumes. Docker figures are host-wide, include other projects, and can include
shared storage; do not add them into a supposed Flux-only disk total. They do
not establish that CPU, memory or disk was saturated during the audit.

There is direct historical evidence of overload: [#271](https://github.com/ColdPhase/flux/issues/271#issuecomment-6001867360)
records load around 66 with a CPU load generator and two stacks. Different ports
do not prevent this. Start with one heavy run per host, then measure whether more
concurrency improves completed work. Keep code reading and independent lightweight
work parallel. Never globally prune caches or stop another worker's stack.

The Dockerfile already separates dependency fetching from source copying, and
`./flux dev` already supports bind-mounted iteration. Do not propose those as
missing features. Next measure build/startup/test/cleanup separately; only then
consider a reusable per-worktree test environment with source, schema and fixture
invalidation. Sharing one mutable database across branches would trade time for
unreliable evidence. [Docker's cache guidance](https://docs.docker.com/build/cache/optimize/)
supports preserving reusable layers and arranging inputs by change frequency.

### 4. Shared blockers and review churn consume several queues at once

The WebKit request cancellation problem tracked in
[#471](https://github.com/ColdPhase/flux/issues/471) appears across UI work. Give
the common repair one owner and have dependent PRs link it. Repeating unchanged
full suites in every blocked branch adds little information. A repair still
needs regression verification: [#474's review](https://github.com/ColdPhase/flux/pull/474#pullrequestreview-5481530943)
found a cancellation-related hang in the proposed fix.

[The #468 review](https://github.com/ColdPhase/flux/pull/468#pullrequestreview-5481036784)
also records a migration-number collision with #418. Confirm reservations and
dependency order before parallel schema work; another general coordination
framework is unnecessary for that specific repair.

[PR #475](https://github.com/ColdPhase/flux/pull/475) already addresses review-round
convergence and shared CHANGELOG conflicts. Keep that change separate. During its
review, preserve the ability to report a genuinely missed required criterion:
at the audited head, its rule admits a new blocker on previously reviewed code
only for P1, even though P2 includes failed required criteria. Avoid churn by
bundling findings and reviewing deltas, without treating a discovered requirement
failure as optional merely because it was found late.

Keep handoffs short: outcome/remaining criteria, pushed SHA, selected evidence,
blocker and next actor. Link earlier evidence instead of copying it. A fresh
session should recover changed state rather than repeat all research and testing.

## Changes in this PR and next work

| Priority | Action | Status / owner |
| --- | --- | --- |
| Now | One verification policy for authors and reviewers, including before ready; targeted checks by impact; full integrated release acceptance retained | Instructions and five shared skills updated in this PR; Maurycy reviews. |
| Now | At most two active implementation tasks per identity, including subagents and review waits; drain inherited excess; finish roots first | Operating policy in this PR. No automated admission gate is claimed. |
| Now | Remove queue-filling startup instructions; preserve required issue criteria and reconcile merged slices | Startup/work-loop/planning guidance in this PR. |
| Now | One heavy Flux run per shared host until measured otherwise; preserve cache and isolate task data | Operating guidance in this PR, not a scheduler or Docker code change. |
| Next | Review and finish #424 and #421 with bounded tests of selection and early failure | Existing runner issues; owners must claim under normal workflow. Do not create duplicates. |
| Next | Repair common failing harness cases once; integrate roots and close only fully met outcomes | Existing issue/PR owners and independent peer. |
| After measurement | Reuse per-worktree images/stacks where safe; invalidate on source/dependency/schema/config changes; retain clean release runs | Proposed engineering work only if measurements justify it. |
| Before release | Reconcile the current accepted contract and remaining criteria, then select and test one candidate | Both agents, existing [acceptance issue #249](https://github.com/ColdPhase/flux/issues/249). |

This PR does not implement runner caching, selectors, a scheduler or WIP automation,
does not close product issues, and does not reduce accepted product scope. Current
recorded decisions govern the candidate; older acceptance evidence cannot silently
exclude later requirements. New ideas outside that contract belong in a later
scope decision, not an automatic expansion of an in-progress implementation.

## How to tell whether this helped

Use a short comparison after several working days, using existing GitHub records
and command timings rather than building another dashboard:

- Accepted outcomes finished and remaining release criteria/blockers, not raw PR count.
- Open implementation work per identity, age of the oldest actionable review,
  and time from **ready for review** to merge (creation time includes drafts).
- Number of conflict repairs and repeat review rounds for unchanged code.
- Local build/startup/test/cleanup time for comparable scope, plus repeated full
  runs on the same relevant source and time blocked by shared infrastructure.

The immediate expected result is a smaller queue and fewer unrelated full runs.
No speedup percentage or completion date is established by this audit. Required
checks, eligible independent approval, protected main, real behavior evidence and
complete release acceptance remain the completion conditions.

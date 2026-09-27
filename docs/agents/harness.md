# Harness design

Status: **design, runtime not implemented**. The tracked
[manifest](../../.harness/project.json) records proposed settings. This document
is the implementation contract for the runner; editing the manifest currently
starts no process and changes no GitHub setting.

## Architecture

Use the same runner core on both machines, configured with one worker ID each.
Provider adapters control Codex or Claude; the core owns scheduling, persistence,
delivery, limits, and state transitions. GitHub is the shared coordination store.
An additional model acting as a permanent manager is not required by this design.

| Component | Responsibility |
| --- | --- |
| GitHub adapter | Fetch issues, comments, review threads, checks, rules, and PR state; make idempotent authorized writes. |
| Scheduler | Apply the workflow priorities, dependency readiness, ownership, and one-task WIP limit. |
| Provider adapter | Start/resume/interrupt a session; supply task context and incoming peer messages; collect structured outcomes. |
| Local journal | Durable inbox/outbox, cursors, active run, session ID, attempts, and lease state. |
| Workspace manager | Separate worktrees, current base/head checks, dependency setup, and preservation of interrupted work. |
| Verifier | Run agreed checks and collect evidence tied to a candidate commit. |

The runner is development tooling. Its implementation language is a separate
decision from the Flux application stack. This foundation installs no packages,
SDKs, browser tools, or background services.

## Worker cycle

```text
load the approved config and acquire this worker's singleton lock
check prerequisites and reconcile GitHub with the durable local journal
while the release is active and the authorized run limit is not exhausted:
    receive and validate new events; renew any active lease
    checkpoint safely before switching work
    select the next action using workflow priorities
    if no action is ready: wait with backoff, then reconcile again
    claim the selected activity and re-check ownership
    start or resume the relevant skill through the provider adapter
    collect its outcome and verify claimed external effects
    publish evidence/handoff once and checkpoint delivery state
    release the claim; continue with the next action
on interruption, limit, or failure: preserve progress and report its real state
```

The implementation must keep event delivery and heartbeats alive during a long
model/tool call. Deliver peer messages at a safe boundary; provider-specific
streaming can shorten that delay. GitHub polling does not require asking a model
to decide whether new events exist.

The loop finishes successfully only after the release acceptance report passes
for its candidate commit. A closed client, rate limit, lack of ready tasks, or
an unresolved permission requirement produces a recoverable suspension.

## Provider contract

Both adapters receive the same context: trusted config revision, worker identity,
release/task contract, role, branch/head, relevant messages, checkpoint, available
tools, and permitted actions. They invoke the same committed skills and return:

- `task`, `role`, `run_id`, and provider session reference;
- an outcome: `progress`, `needs-peer`, `waiting`, `blocked`, or `candidate-complete`;
- branch, PR, pushed head, contract revision, and evidence links;
- the next action, unresolved findings, and any operation awaiting confirmation.

These are proposed adapter fields, not an SDK's built-in response schema. The
core validates them against GitHub and check results. A model's completion text
does not itself set release status.

Resume a useful session for incremental fixes. Use a fresh evaluator context for
independent review, and reconstruct from a handoff when a session cannot be
resumed or has lost coherence. Do not impose a context reset after every commit
or a fixed sprint schedule. The GitHub checkpoint remains the portable record.

Codex can be controlled through its
[SDK](https://learn.chatgpt.com/docs/codex-sdk) or
[App Server](https://learn.chatgpt.com/docs/app-server); Claude offers the
[Agent SDK and programmatic CLI](https://code.claude.com/docs/en/headless).
The adapter implementation must verify the installed versions and authentication
mode before selecting exact APIs. Provider permissions continue to apply.

## Configuration and activation

Manifest version `1` describes the intended runtime input. Unknown fields or an
unsupported version must fail validation in the future runner. Validate worker
IDs and GitHub identities as distinct and verify the actual authenticated account.

Execution requires all of the following:

1. A reviewed runner implementation with both provider adapters exercised.
2. `state` changed from `design` to `active` and `loop.enabled` set to `true` in
   an accepted configuration revision.
3. An accepted release issue and milestone matching the configured repository;
   real, reviewed files at `release.spec_path` and `release.architecture_path`.
4. Nonempty, real task and release verification commands, acceptance scenarios,
   and required GitHub checks configured and readable. Empty lists never pass.
5. A positive `limits.max_run_minutes`, plus provider-side spending controls
   appropriate to the selected accounts. Exhaustion saves progress and suspends.
6. Worker credentials, a reproducible workspace, and the protocol labels prepared
   once. One active runner per identity; one active unit of work per worker.

Merge is a separate capability. `merge.enabled` requires the release contract's
permission for peer-agent reviews and merges under the configured accounts, plus
all existing GitHub rules. Publication needs `publishing.enabled`, agreed artifact
formats, and a passing candidate report. Deployment likewise needs `deployment.enabled`, a
named target, and explicit release-contract scope. These capabilities can be
authorized for the release once; they need no repeated prompt for each routine
action within that authorization.

New sessions use the same accepted config/skill revision. Do not silently upgrade
skills or execute new validation commands proposed by an unreviewed task branch.
A reviewed update is rolled out at a checkpoint with its revision recorded.

## Isolation and failure handling

- Each task uses an isolated worktree; evaluation uses the pinned head in a
  separate checkout. Shared services need isolated ports and test data.
- The local singleton lock prevents a second runner in the same deployment.
  Duplicate identity on another machine requires stopping one runner; GitHub
  assignments alone cannot enforce a distributed lock.
- Keep active run state under `local_state_directory`. It is ignored by Git and
  may contain session metadata; shared evidence and pushed commits go to GitHub.
- After a crash, reconcile before retrying any side effect. Resume an existing
  PR and branch rather than creating duplicate work. Preserve uncommitted work
  for inspection; never clean it up blindly.
- A stopped peer leaves requests pending. The other worker can continue
  independent work; it must not approve its own changes to clear the queue.
- Count attempts without new progress, not total useful iterations. At
  `loop.max_attempts_without_progress`, record the evidence and unblock condition,
  suspend that task, and try other eligible work. Repeated identical criticism
  is not progress. Resume when the blocker or relevant inputs change.
- Resolve conflicting plans against the accepted contract and tests. A genuine
  ambiguity is a maintainer decision. Do not weaken tests or criteria to end a loop.

## Implementation increments

These are future harness work packages, not application features or live issues.

1. **Read-only preflight and inbox:** validate the manifest, identity, skill links,
   labels, contracts, and effective GitHub gates; list the next action without
   running a model or mutating GitHub.
2. **Journal and GitHub writes:** durable delivery, deduplication, ownership,
   handoffs, and recovery. Exercise duplicate events, pagination, edited comments,
   stale claims, an API timeout after a successful write, and concurrent starts.
3. **Provider adapters:** prove start, continuation, message delivery, interruption,
   structured results, and checkpoint recovery for each installed client.
4. **One task end to end:** negotiate, implement, independently evaluate, repair,
   and merge through existing rules in a disposable test repository.
5. **Two-worker run:** parallel independent tasks, a shared dependency, a stopped
   peer, a rejected review, and a changed PR head. Prove one writer per branch and
   no self-approval or lost/duplicate task.
6. **Release acceptance:** a deliberately incomplete build must stay unaccepted;
   successful acceptance pins the tested commit and records all required evidence.
7. **CI and publication:** agents implement the workflow rollout in
   [CI and releases](ci-and-releases.md), demonstrate failing checks block merging,
   and verify built artifacts in a draft/prerelease before a stable release.

Only activate an application run after these checks and the application-specific
inputs exist. The current change establishes their contract and shared skills.

# Local milestone runner

Entry point: `python3 scripts/flux_agent.py`. Follow [startup](startup.md).
The implementation uses Python 3.11+ standard-library code and the installed
official Codex/Claude CLIs. It does not choose or install the application stack.

## Architecture

| Component | Implementation and responsibility |
| --- | --- |
| GitHub transport | `scripts/flux_harness/github.py`: explicit repository/host, paginated issues/comments/timelines/reviews/checks, review-thread resolution, comment retry reconciliation |
| Worker loop | `scripts/flux_harness/worker.py`: scope/identity checks, coarse work eligibility, idle polling, blocked-task parking, real-progress detection, limits |
| Provider adapters | `scripts/flux_harness/providers.py`: structured CLI turns, session continuity, process termination and outcome validation |
| Local journal | `scripts/flux_harness/state.py`: SQLite turn checkpoints/outbox, process-lifetime local singleton lock |
| Shared procedures | `AGENTS.md`, `.agents/skills/`, and these guides: task negotiation, scope decisions, branch ownership, independent evaluation, CI and delivery |

The model selects the useful task and performs authorized work with its normal
tools. The runner validates its output format and schedules another cycle;
it does not mechanically judge a product recommendation or replace a reviewer.
Its coarse eligible list is not proof of a task's accepted contract.

## Cycle

1. Validate the committed manifest, repository, CLI surfaces, actual `gh` identity,
   and milestone description digest. Acquire the local worker lock.
2. Reuse/create a detached coordination worktree at the configuration revision.
   Models create separate task worktrees under the worker's local directory.
3. Reconcile the milestone snapshot, including linked PRs, inline review comments,
   resolved-thread state, reviews, checks and status contexts. Persist interrupted
   work and outbox intent; reconcile comments before retrying writes.
4. When useful work exists, pass the brief, snapshot, shared procedures, prior
   checkpoint and parked tasks to one provider turn. Continue useful sessions
   for unchanged work; new peer events or changed roles use fresh context.
5. Refresh the inbox while a turn runs. Workers read it at safe checkpoints.
   This adapter does not inject live messages into an in-flight model call;
   the next cycle receives new events at the next boundary.
6. Save the outcome and observe GitHub/local changes. Park only a blocked task;
   select other ready work immediately. A changed issue, related PR or dependency
   state makes parked work eligible again.
7. When nothing is actionable, poll without model calls or status comments.
   Stop on request, scope/identity failure, provider failure, configured limits,
   or a closed milestone; preserve work for a new invocation.

`candidate-complete` requests independent acceptance. The runner never closes a
milestone or publishes from that claim. Final evidence and founder decisions
remain required. It reports a closed milestone as `milestone-closed`, without
claiming that application tests passed.

## Configuration version 2

The manifest selects one milestone and phase. `planning` permits agreed
discovery/proposals without fabricating production tests. `release` requires
real specification/architecture files and nonempty task, integrated release,
and required-status-check lists. Unknown fields and invalid paths fail
validation. Planning cannot enable publication or deployment.

The current planning configuration enables an **explicit local `run` command**.
Nothing starts on pull, merge, or Actions. The brief is linked from milestone 1;
its description is pinned by SHA-256. Review a changed scope and configuration
together; do not automatically refresh the digest to bypass a refusal. The brief
is versioned with the control checkout.

Merge/publication/deployment switches govern shared procedures. The runner is
not a proxy intercepting every shell command an agent may execute. GitHub
protections, provider permission systems, and independent evaluation enforce
their own boundaries. A prompt or switch is not an external security boundary.

## Recovery and boundaries

- Use one machine/run per GitHub identity. The local lock does not enforce a
  distributed lease. Assignment is cooperative ownership; a stopped peer does
  not automatically transfer branch ownership.
- SQLite commits turn/message intent before execution. `message` reconciles
  stable IDs, including a successful POST whose response was lost. Arbitrary
  model-issued `gh` writes are not exactly once; search before creating/retrying
  issues or PRs and reconcile any uncertain operation.
- Task claims/handoffs are worker protocol records, not daemon-renewed remote
  leases. Confirm the previous writer stopped and inspect work before reassignment.
- API failures back off, then suspend. Provider login/permission/credit failure
  may prevent all work. A normal task blocker leaves other tasks available.
- Publish useful shared checkpoints. Private logs/session IDs cannot let the
  peer recover; logs may contain task data and stay in ignored local state.
- Isolate task worktrees, Compose projects, ports, test data and volumes.
  Never remove unknown worktrees or volumes as automatic recovery.
- Keep the control checkout fixed during a run. Roll out reviewed instructions
  at a checkpoint in a clean checkout.

## Verification

Repository CI exercises offline failure/recovery and provider fixtures. Live
preflight checks the available GitHub account and CLI surfaces. Record the real
two-account trial separately: concurrent tasks, negotiation, rejected review,
changed PR head, stopped peer/resume, and acceptance. Fixtures do not establish
that trial or application release readiness.

Provider references checked during implementation:
[Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
and [Claude programmatic use](https://code.claude.com/docs/en/headless).

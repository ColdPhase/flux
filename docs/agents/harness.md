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

`candidate-complete` requests peer verification; it does not close the product.
Agents may close verified milestones and create new ones. The goal is the full
application. Final completion requires two authenticated acceptance records
covering foundation areas 8.1–8.16 at the same candidate, closed required work,
and successful live application checks on the current protected base head.
This coordination check does not replace the peers testing real behavior.

## Configuration version 3

The manifest includes initial milestones and product-scope discovery. A trusted
creator plus the exact `flux-milestone:v1` marker admits a subsequent milestone.
Descriptions remain task evidence; they cannot expand the founder's product
scope or override the shared instructions. In fixed mode (discovery disabled),
the description digest is still enforced. No automatic rewriting of the local
control config occurs during a run.

`planning` supports decisions/research, `implementation` permits application
bootstrap and build-out while real checks are developed, and `release` requires
existing specification/architecture and nonempty validation/check lists. The
initial implementation authority does not certify future application behavior.
Agents must establish real tests and verified artifacts before publishing.

The founder delegates decision acceptance, peer review, protected merges and
final release delivery. Global capability switches describe authority; they are
not an external proxy for arbitrary shell commands. Existing GitHub protections,
provider permissions and independent evidence still apply.

Models/effort are optional CLI overrides saved per worker. Codex uses its config
override, Claude uses `--effort`. Every turn records its selection/argv locally.
Changing selection keeps task work; unpinned CLI defaults are identified honestly.
No overall run cap is configured; per-turn deadlines and optional overall caps
remain supported. Idle polling does not invoke a model.

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

## Recovery implementation

`recovery.py` inventories local task worktrees and reconciles authenticated owner
claims, including those newer than the last completed checkpoint. The next prompt
receives the interrupted log path and saved changes; the agent resumes the same
artifact. `stop --after-turn` drains at the next checkpoint. Immediate stop keeps
files and the active turn but cannot promise a final pushed handoff.

`roadmap.py` discovers milestones, combines issue/PR snapshots across the roadmap
and checks the final peer acceptance records. New scopes do not require a human
to select the next milestone or edit the manifest.

# Workflow

## 1. Enter through a milestone

Use one GitHub milestone with a description linking a reviewed
[milestone brief](templates/milestone.md). There is no mandatory parent issue.
Planning briefs name research/proposal outcomes and evidence; release briefs
link accepted specification/architecture decisions, observable acceptance
criteria, and permitted automation/delivery scope.

The founder has accepted the product direction and [delegated](../product/autonomy.md)
product/technical/design choices and delivery to the agents. They create further
milestones as needed and independently review decisions. Do not wait for founder
approval. Milestone descriptions carry the product scope marker in the protocol;
the runner discovers them automatically.

Planning and implementation may overlap. Start each coding task once its specific
architecture/interface decisions are agreed; do not wait for all market research
or for the planning milestone to close. The full foundation supplies the goal.

## 2. Agree on a task contract

Include CI and delivery work in release decomposition. After stack selection,
agents create tasks for real validation commands, GitHub Actions, verified
required PR checks, and packaging/publication. Follow
[CI and releases](ci-and-releases.md); successful feature PRs alone do not finish
the delivery work.

Create an implementation issue using the [task form](../../.github/ISSUE_TEMPLATE/task.yml).
It records:

- the milestone and reviewed brief, and the user outcome it serves;
- one implementation owner and a different evaluator;
- scope and exclusions;
- acceptance criteria with stable IDs such as `AC-1` and `AC-2`;
- verification scenarios, including relevant failure and permission cases;
- dependencies and shared interfaces that must be agreed first.

The coordinator or builder proposes a concise contract; the owner can adopt it
by reference and the independent evaluator accepts it or names material gaps. Acceptance references that proposal's comment ID and revision.
Resolve meaningful dependencies and agree on observable criteria, then build.
Routine reversible details can be reviewed in the implementation PR. Do not
rewrite an unchanged proposal for ceremony or keep refining wording after the
outcome is testable. Repeated disagreement becomes a concrete task blocker;
continue other work. No founder acceptance is needed.

Changing the proposal after acceptance invalidates that acceptance. Publish a new
revision and get it accepted. Keep the accepted proposal immutable; the issue
description may summarize it and must link the current revision.

Agents may split a task, with child issues linked to the original and the same
release. A split must retain every acceptance criterion and make dependencies
explicit. The parent completes only when its full outcome is verified.

## 3. Select work

Each worker handles one active unit at a time, in this order:

1. A maintainer stop/correction or a failure that invalidates current work.
2. A peer's pending contract decision or review that this worker can unblock.
3. Requested changes, failed checks, or an interrupted task owned by this worker.
4. A ready task assigned to this worker with satisfied dependencies.
5. Integrated release verification when the milestone is otherwise complete.

Finish the current safe checkpoint before changing tasks. Never leave an active
implementation branch half-owned while editing a peer's branch. When there is
no actionable work, the runner waits for a message, dependency, or check result.
An empty queue is not evidence that the milestone passed.

### A blocker affects one task

Try reasonable alternatives and seek the peer's help with a concrete question,
reproduction and evidence. Record attempts, remaining criteria, dependencies and
the unblock condition in the issue. Park that task and continue ready
implementation, review, research or integration work. The runner keeps parked
tasks separate from global waiting and reconsiders them when relevant state changes.

Revisit parked issues after a peer reply, dependency change, and before milestone
acceptance. Do not silently close, omit, or move required work to a later milestone.
Only an accepted scope decision can defer an outcome. When all work is blocked,
leave clear records and wait without model/status traffic. Persistent provider
authentication or infrastructure failure may suspend the whole run.

## 4. Implement and hand off

Use a branch/worktree from current `main` for the task. Agree on interfaces before
dependent work; serialization is appropriate when both tasks modify the same
prototype file, schema, lockfile, or shared contract.

Open a draft PR once useful work can be inspected. Link its issue. Add `Closes`
only when the PR is intended to fulfill the issue's entire agreed outcome.
Build and verify in coherent increments; record progress after meaningful
checkpoints and before a session ends.

After a restart, inspect the recovery record and actual issue/branch/PR before
creating new work. Preserve local changes and continue the existing artifact.

At handoff, push the current commit, publish the [handoff](templates/handoff.md),
release the active claim, and request the peer's evaluation. Unavailable checks
stay explicit. A task with missing implementation stays a draft.

## 5. Evaluate, repair, and merge

The peer evaluates the pinned PR head in an isolated checkout using
[Evaluation](evaluation.md). Findings name the failed criterion, reproduction,
expected behavior, and evidence. The author fixes them on their own branch;
the peer evaluates the new head again.

The evaluator submits a GitHub review when eligible and authorized. Comments
alone are not approving reviews. Merge requires the current branch rules,
required checks, resolved conversations, and independent evidence for the current
head. Agent merge actions also require the release's recorded permission and
the manifest's merge switch; otherwise report `waiting-for-merge`.

After a successful merge, reconcile the linked issue. GitHub closing a linked
issue is a tracking event. The harness must still verify the resolving PR and
evidence before counting the outcome toward the release.

## Task states

These labels summarize task state; they do not provide authority on their own.
Exactly one state label applies to an admitted, open implementation task.

| Label | Meaning | Next action |
| --- | --- | --- |
| `agent:planning` | Contract proposed or incomplete. | Peer negotiates acceptance. |
| `agent:ready` | Contract accepted; waiting for its owner. | Start when dependencies pass. |
| `agent:working` | Owner is actively implementing. | Checkpoint or hand off. |
| `agent:review` | A specific PR head awaits independent evaluation. | Peer evaluates. |
| `agent:verified` | Current head passed evaluation; merge may still be pending. | Check merge gates. |
| `agent:blocked` | A recorded external dependency or decision prevents progress. | Act on the named unblock condition. |

Failed evaluation returns the task to `agent:ready` for its owner, with findings.
Any new code invalidates `agent:verified`. A closed issue with a declined or
duplicate outcome does not count as an implemented feature. Reopening requires
reassessment of the contract, prior evidence, and remaining work.

Labels are a view of the protocol state; ownership and evidence must be checked
as well. The optional Projects board remains a human-readable overview. Its
existing Todo/In Progress/Done automations do not decide agent readiness.

## 6. Verify the version

Evaluate the merged application at one candidate commit using the release
contract. Include a clean installation, configured release checks, and real user
journeys across features. Report gaps as in-scope tasks and continue the loop.

The release is accepted only when every required criterion has evidence at the
candidate commit and blocking findings are resolved. If delivery is part of the
contract, verify that same version in the named deployment target. A later merge
requires the affected acceptance checks again; never ship a different commit
under an old acceptance report.

Publish the report in an acceptance task/PR within the milestone and link it from
its records. Waiting for a peer, exceeding a limit,
or exhausting actionable work produces a waiting/blocked report, never success.

## 7. Publish the accepted version

When publication is in scope, follow [CI and releases](ci-and-releases.md).
Create the version tag at the accepted candidate, build and test the distributable
artifacts, publish them through GitHub Releases, and verify that users can download
and start them as documented. Keep the milestone open until these required
delivery checks pass. Record application deployment separately when included.

## 8. Continue to the complete product

An intermediate milestone closing does not finish the project. Maintain the
foundation coverage matrix, create the next useful milestones/issues, and keep
implementing. The independent agents verify the final integrated application,
trigger its one final release pipeline, check delivered artifacts and post the
full-product acceptance records. There is no human approval step.

---
name: flux-work-loop
description: Continue authorized Flux milestone work through issues, peer messages, PR reviews, and durable handoffs, parking individual blockers while progressing independent tasks.
---

# Continue the Flux work loop

Read `AGENTS.md`, `.harness/project.json`, and
[the workflow](../../../docs/agents/workflow.md). For event delivery or claims,
read [the GitHub protocol](../../../docs/agents/github-protocol.md).

1. Establish the authenticated worker, milestone/brief, phase, config revision,
   and checkpoint. Follow [startup](../../../docs/agents/startup.md). A planning
   milestone creates proposals; it cannot silently authorize a production release.
   There is no parent issue. The coordinator creates initial bounded tasks if
   the milestone is empty; both workers can create further agreed in-scope work.
2. Reconcile the task, branch, PR, current head, pending peer requests, and claims.
   Reuse existing work. A message or label alone is not proof of current state.
3. Select work in workflow priority order: maintainer corrections, actionable peer
   decisions/review, own fixes/resumption, ready assigned tasks, release verification.
   Hold at most one active unit; checkpoint before switching.
4. Use the relevant shared skill: `flux-plan-task`, `flux-implement-task`,
   `flux-review-task`, `flux-research-product`, `flux-design-ui`, `flux-review-visual`,
   `flux-maintain-ci`, `flux-verify-release`, or `flux-publish-release`.
   Keep the task's owner and independent evaluator distinct.
5. Return the real outcome and next action, with task/PR, contract revision,
   pushed head, evidence, and a recovery checkpoint. Publish an authorized
   GitHub handoff once, then release the claim you own.

6. For a blocker, attempt a proportionate alternative, document attempts and the
   unblock condition in the issue, and ask the peer for specific help. Park only
   this task, return its number with `blocked`, and continue other useful work.
   Revisit parked issues when evidence changes and before milestone acceptance.

The runner schedules the next turn and delivers messages. While operating inside
an authorized continuing session, follow the same selection cycle. If nothing
is actionable, wait for the relevant event; do not generate status comments or
create extra scope to keep busy. Do not add a nested `/goal` inside a runner turn.

Completion requires the milestone's independent acceptance evidence and any
agreed release/publication/deployment checks. An empty queue or exhausted run limit is a waiting/suspended
outcome. Preserve state; never manufacture a successful release result.

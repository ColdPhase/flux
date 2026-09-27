---
name: flux-work-loop
description: Select and continue authorized Flux release work from GitHub issues, peer messages, PR reviews, and durable handoffs. Use when operating a release worker or resuming its collaboration cycle.
---

# Continue the Flux work loop

Read `AGENTS.md`, `.harness/project.json`, and
[the workflow](../../../docs/agents/workflow.md). For event delivery or claims,
read [the GitHub protocol](../../../docs/agents/github-protocol.md).

1. Establish the authenticated worker, accepted release, config revision, and
   current checkpoint. Autonomous execution needs the activation conditions in
   [the harness design](../../../docs/agents/harness.md). With design-only config,
   report missing inputs; an explicitly requested local setup task can still proceed.
2. Reconcile the task, branch, PR, current head, pending peer requests, and claims.
   Reuse existing work. A message or label alone is not proof of current state.
3. Select work in workflow priority order: maintainer corrections, actionable peer
   decisions/review, own fixes/resumption, ready assigned tasks, release verification.
   Hold at most one active unit; checkpoint before switching.
4. Use the relevant shared skill: `flux-plan-task`, `flux-implement-task`,
   `flux-review-task`, `flux-maintain-ci`, `flux-verify-release`, or
   `flux-publish-release`. Keep the task's owner and independent evaluator distinct.
5. Return the real outcome and next action, with task/PR, contract revision,
   pushed head, evidence, and a recovery checkpoint. Publish an authorized
   GitHub handoff once, then release the claim you own.

The runner schedules the next turn and delivers messages. While operating inside
an authorized continuing session, follow the same selection cycle. If nothing
is actionable, wait for the relevant event; do not generate status comments or
create extra scope to keep busy. A blocked task can leave other tasks available.

Completion requires the integrated release report and any agreed publication or
deployment checks. An empty queue or exhausted run limit is a waiting/suspended
outcome. Preserve state; never manufacture a successful release result.

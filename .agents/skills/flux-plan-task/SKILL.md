---
name: flux-plan-task
description: Draft and negotiate a bounded Flux implementation or delivery task from an accepted release outcome, with ownership, dependencies, and verifiable acceptance criteria.
---

# Plan a Flux task

Read `AGENTS.md`, [the workflow](../../../docs/agents/workflow.md), and the
release contract. Use the [task form](../../../.github/ISSUE_TEMPLATE/task.yml)
as the record shape. If product scope or the stack is still undecided, draft
the missing decision locally instead of treating prototype behavior as approval.

- Check existing issues and PRs for the outcome. Extend or resume matching work
  rather than creating a duplicate.
- Describe a user-observable outcome or concrete engineering deliverable, scope
  exclusions, and criteria with stable `AC-*` IDs. Include how each is verified.
- Name one implementation owner and a different evaluator. Identify dependencies
  and shared interfaces; the task may become ready only after its blockers clear.
- Include CI, required-check rollout, packaging, and publication tasks when needed
  by the release. Follow [CI and releases](../../../docs/agents/ci-and-releases.md).
- Keep implementation choices flexible within the accepted architecture. Split
  work when it has independently verifiable outcomes; preserve all parent criteria.
- Publish the proposal only when GitHub writes are within the current request or
  accepted release authority. Ask the peer to accept the exact contract revision
  or name a specific gap. Otherwise return the draft for review.
- Record the accepted proposal comment and revision. A later criteria change
  requires a new agreement; it must not erase an already discovered failure.

Return the task link or local draft, owner/evaluator, criteria, dependencies,
contract status, and next action. Routine decomposition inside an accepted release
does not need a separate maintainer decision; scope expansion does.

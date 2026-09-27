---
name: flux-plan-task
description: Draft and negotiate a bounded Flux research, design, implementation or delivery task from an accepted milestone outcome, with ownership, dependencies and verifiable criteria.
---

# Plan a Flux task

Read `AGENTS.md`, [the workflow](../../../docs/agents/workflow.md), and the
milestone brief. Use the [task form](../../../.github/ISSUE_TEMPLATE/task.yml)
as the record shape and place the issue in that milestone. If scope or the stack
is open, create an appropriate research/decision task within the agreed planning
scope, decide with the peer and implement under the [delegation](../../../docs/product/autonomy.md).
Do not wait for a founder.

- Check existing issues and PRs for the outcome. Extend or resume matching work
  rather than creating a duplicate.
- Keep the body short: outcome (user-observable or a concrete engineering
  deliverable), 3–5 acceptance criteria with stable `AC-*` IDs and how each is
  verified, owner (the single assignee) and evaluator (the other agent).
- Identify dependencies and shared interfaces; the task becomes ready only after
  its blockers clear.
- Record relevant foundation sections, persona, research need, and whether the
  result is a proposal or implementation. Application environments use Docker;
  include reproducible container validation and separate task data where relevant.
- Include CI, required-check rollout, packaging, and publication tasks when needed
  by the release. Follow [CI and releases](../../../docs/agents/ci-and-releases.md).
- Keep implementation choices flexible within the accepted architecture. Split
  work when it has independently verifiable outcomes; preserve all parent criteria.
- Publish the issue when GitHub writes are within the current request or the
  milestone scope; otherwise return the draft. The evaluator accepts it or names
  concrete gaps once; adjust the body and start. No versioned negotiation.
- A later criteria change is an edit to the body with a one-line note; it must
  not erase an already discovered failure.

Return the task link or local draft, owner/evaluator, criteria, dependencies,
contract status, and next action. Routine decomposition inside an accepted release
does not need a maintainer decision. Agents create further milestones within the
full product foundation without human acceptance.

A coordinator may propose work for the peer, who can adopt it by reference. Do
not rewrite unchanged contracts for ceremony. Resolve material criteria/interfaces
and produce the artifact. Routine reversible details can be reviewed in the PR.
Create coding tasks as soon as their own dependencies are agreed; do not wait
for unrelated research or the closing of a planning milestone.

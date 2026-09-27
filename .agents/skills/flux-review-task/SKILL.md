---
name: flux-review-task
description: Independently evaluate a Flux task or PR against its accepted contract, test actual behavior, and return commit-specific evidence and actionable findings.
---

# Evaluate a Flux task

Read `AGENTS.md`, [Evaluation](../../../docs/agents/evaluation.md), the accepted
contract, and all unresolved prior findings. Follow
[the protocol](../../../docs/agents/github-protocol.md) for review ownership.

- Confirm you are the independent evaluator. Pin the current contract and PR head
  in an isolated checkout; the issue assignee remains the implementation owner.
- Review the code and real integration points. Reproduce the required scenarios,
  including relevant failure/access cases. Use live UI/API/persistence checks for
  functional changes; use structural/link checks for documentation-only work.
  Use the supported Docker environment. Visual assessment uses
  `flux-review-visual` with a fresh neutral brief; separately test behavior.
- Record each criterion as pass, fail, or unverified, with evidence at this head.
  Inspect CI and unresolved review threads. Pending or unavailable required checks
  stay unverified.
- Submit the result as a GitHub PR review (approve / request changes), shaped by
  [the evaluation report](../../../docs/agents/templates/evaluation.md) and kept short.
  Findings need expected/observed behavior and reproduction steps. Separate optional
  improvements from blocking failures. On re-review, check only the delta and each
  earlier open finding.
- Return fixes to the implementation owner. You may reproduce a bug and prepare
  a patch on your own branch. Editing the peer's branch requires an explicit
  handoff, verified current head and one writer. If you edit code, identify that
  as implementation and obtain eligible independent evaluation of the changed
  head. A PR author cannot approve their own PR; when both agents authored a
  head, split the repair into a separate reviewed PR or use another eligible
  independent evaluator.
- Submit the appropriate GitHub review only when authorized and eligible. A passing
  report does not bypass required Code Owner approval, checks, or conversation rules.

Hand back the next action in the review itself. If the head or contract
changed during evaluation, report that the new version still needs verification.

Peer review and eligible GitHub approvals are authorized. When the current head passes review and required checks, merge using the normal protected path; do not wait for a human approval.

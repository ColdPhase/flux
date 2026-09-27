---
name: flux-work-loop
description: Continue Flux milestone work in a /goal session through issues, PR reviews and short GitHub handoffs, parking individual blockers while progressing independent tasks.
---

# Continue the Flux work loop

Read `AGENTS.md`, [the workflow](../../../docs/agents/workflow.md) and
[the GitHub protocol](../../../docs/agents/github-protocol.md). Sessions are
started as described in [startup](../../../docs/agents/startup.md).

1. Confirm your identity (`gh auth status`) and the current milestones. Agents own
   decisions and final delivery under the [delegation](../../../docs/product/autonomy.md);
   no founder acceptance is required. After a restart use `flux-resume-work` first.
2. Pick work in workflow order: founder direction; peer review requests and fixes
   to your own PRs; your in-progress issues; new ready work in milestone order.
   Keep at most 2 open implementation PRs.
   At start/resume, after a reviewable push, before new work/merge, and at safe
   boundaries in long work (about every 5–10 minutes), make a targeted check of
   new issue comments, review requests, PR heads/checks and unresolved threads.
3. Use the relevant skill: `flux-plan-task`, `flux-implement-task`,
   `flux-review-task`, `flux-research-product`, `flux-design-ui`, `flux-review-visual`,
   `flux-maintain-ci`, `flux-verify-release` or `flux-publish-release`.
   The owner and the evaluator of a change are different agents.
4. Comment on GitHub only on state changes: claim, blocking question, handoff
   (actual PR state + branch/full pushed SHA + checks/remaining work + next actor),
   review result, blocker, merge/partial issue closeout, release.
5. For a blocker, try an alternative, record attempts and the unblock condition
   once in the issue, ask the peer a concrete question, and do other ready work.
   Revisit it when evidence changes and before milestone acceptance.

If only peer input is missing and nothing else is ready, re-check GitHub about
every 10 minutes (a sleep/poll or the tool's scheduling feature). Do not
busy-loop with model calls, post waiting comments or invent scope to stay busy.
On a usage limit, wait and continue; it is not completion.

The coordinator (`codex-hubert`) keeps milestones stocked with the next small
ready issues. Maintain coverage of foundation areas 8.1–8.16 and continue until
the integrated product is delivered and both final acceptance reports are posted.
Keep PR Actions light and package only the final product.

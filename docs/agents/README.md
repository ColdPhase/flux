# Agent collaboration

Two local workers, Codex/Hubert and Claude/Maurycy, share the product foundation,
skills, and GitHub milestone. [Start here](startup.md) to check your account and
run the worker. The loop is development tooling; the Flux application is still
an exploratory HTML prototype.

```mermaid
flowchart TD
    V[Founder vision and accepted decisions] --> M[Milestone and reviewed brief]
    M --> I[Agent-created issues]
    I <--> C[Codex worker]
    I <--> A[Claude worker]
    C --> P[Task worktrees and PRs]
    A --> P
    P --> E[Independent review and CI]
    E -->|Corrections| I
    I -->|Blocked task| B[Record attempts and ask peer]
    B --> N[Continue independent work]
    N --> I
    E --> F[Integrated milestone acceptance]
```

The [delegation](../product/autonomy.md) authorizes decisions and the complete
application. Planning and implementation milestones overlap, and agents create
further milestones. No human acceptance is required. Workers create useful issues, keep one active task each, negotiate
criteria, implement agreed work, and evaluate the other's changes. Roles can
alternate; there is no fixed provider-to-frontend/backend assignment.

## Read as needed

1. [Product direction](../product/README.md) and [decision register](../product/decisions.md).
2. [Startup](startup.md): each person's commands, stop/resume, `/goal` comparison.
3. [Workflow](workflow.md): milestone scope, tasks, blockers, acceptance.
4. [GitHub protocol](github-protocol.md): identity, comments, ownership and retries.
5. [Harness](harness.md): implementation and verification boundaries.
6. [Evaluation](evaluation.md), [design](../design/README.md), and [containers](../development/containers.md).
7. [CI and releases](ci-and-releases.md): agents prove validation, required checks,
   packaging and publication within accepted scope.

## Shared entry points

[AGENTS.md](../../AGENTS.md) is shared; [CLAUDE.md](../../CLAUDE.md) imports it.
`.claude/skills` links to [.agents/skills](../../.agents/skills/). Restore symlinks
if your Git environment does not preserve them; do not maintain separate copies.

| Skill | Use |
| --- | --- |
| `flux-resume-work` | Recover an interrupted task and continue its existing artifact. |
| `flux-work-loop` | Continue milestone work and revisit parked tasks. |
| `flux-plan-task` | Agree on a bounded task and its criteria. |
| `flux-research-product` | Research product/architecture decisions with dated evidence. |
| `flux-design-ui` | Explore or refine compact, readable working UI. |
| `flux-review-visual` | Independently assess screenshots with a neutral brief. |
| `flux-implement-task` | Implement and hand off a pinned PR head. |
| `flux-review-task` | Independently test results and report findings. |
| `flux-verify-release` | Verify the integrated release against accepted outcomes. |
| `flux-maintain-ci` | Build and prove Actions validation and PR gates. |
| `flux-publish-release` | Package and publish the accepted application revision. |

Records: [milestone brief](templates/milestone.md),
[release details](templates/release-contract.md), [handoff](templates/handoff.md),
[evaluation](templates/evaluation.md), [task form](../../.github/ISSUE_TEMPLATE/task.yml).

## References

[Anthropic's harness article](https://www.anthropic.com/engineering/harness-design-long-running-apps)
informed independent evaluation and durable handoffs.
[Open Mercato's shared skills](https://github.com/open-mercato/skills/tree/e886001ab1dea2123af79e52dcd175c36878dab1)
informed reusable procedures. Flux's runner and skills are its own implementation
for two maintainers and the founder's current vision.

# Start, pause and resume the agents in /goal mode

The founder has [delegated decisions and delivery](../product/autonomy.md) to the
agents. Each founder starts one interactive agent session in `/goal` mode. The
two agents collaborate through GitHub issues and PRs until the complete Flux
application in [the milestones](../product/milestones/) is delivered. There is
no human acceptance step and no separate runner process.

| Person | Agent identity | GitHub login | Tool | Role |
| --- | --- | --- | --- | --- |
| Maurycy | `claude-maurycy` | `Zamojski5` | Claude Code | Builder and evaluator |
| Hubert | `codex-hubert` | `PelikanFix16` | Codex | Builder, evaluator and coordinator |

## Before starting

- Use a clone of `ColdPhase/flux` with Git, GitHub CLI and Docker/Compose. Log in
  to GitHub (`gh auth status`) as the identity in the table and to the agent tool.
- Run exactly **one** session per identity. Never start a second session, a second
  machine or a background loop for the same identity; two writers on one identity
  break ownership and independent review.
- Work happens in per-task worktrees/branches. Do not reclone over saved work.

## Start

Open the tool in the repository root and enter the prompt for your identity.

Maurycy (Claude Code):

```text
/goal You are claude-maurycy (GitHub Zamojski5) building Flux with codex-hubert (PelikanFix16). Follow AGENTS.md, docs/agents/workflow.md and docs/product/playbook-the-5.md. First reconcile your open issues, branches and PRs. Then loop: review and fix existing PRs first, then continue your assigned issues, then take ready milestone work. Ship working code in small PRs with tests run in Docker; get independent review before merge. Talk to Hubert on GitHub only on state changes. On usage limits wait and continue. Keep going until the complete Flux application in docs/product/milestones is delivered.
```

Hubert (Codex):

```text
/goal You are codex-hubert (GitHub PelikanFix16) building Flux with claude-maurycy (Zamojski5). Follow AGENTS.md, docs/agents/workflow.md and docs/product/playbook-the-5.md. First reconcile your open issues, branches and PRs. Then loop: review and fix existing PRs first, then continue your assigned issues, then take ready milestone work. Ship working code in small PRs with tests run in Docker; get independent review before merge. Talk to Maurycy on GitHub only on state changes. On usage limits wait and continue. Keep going until the complete Flux application in docs/product/milestones is delivered. You are the coordinator: keep the milestones stocked with the next small ready issues.
```

The sessions need not start at the same time. Each agent works independently.

## Usage limits

A usage or rate limit is a pause, not completion. Wait for the limit to reset and
continue the same goal. Do not declare the goal finished, close issues or merge
unreviewed work because a limit is near.

## Waiting for the peer

When the next step depends on the peer (a review, an answer, a merge), do other
ready work meanwhile: another assigned issue, a review, tests or docs for the
milestone. If nothing else is ready, re-check GitHub about every 10 minutes, for
example with a `sleep 600` followed by `gh` queries, or the tool's own scheduling
feature. Never busy-loop with model calls just to wait, and do not post "still
waiting" comments.

## Pause

Stop the session (interrupt it or close the tool). All shared state lives in
GitHub (issues, assignees, branches, PRs, reviews) and in the local worktrees.
Before a planned pause, push work in progress to the task branch when practical;
uncommitted files stay only on that machine. Pausing does not release ownership.
For a long absence, unassign yourself with a short handoff comment instead.

## Resume

Start `/goal` again with the same prompt. The agent first reconciles its own state
before new work (see `flux-resume-work`):

1. Open issues assigned to its GitHub login and their comments since the pause.
2. Its local worktrees, branches and uncommitted changes; preserve them.
3. Its open PRs: review results, failing checks, unresolved threads.
4. Review requests addressed to it.

Continue the existing branch/PR rather than recreating work.

## Milestones and completion

The roadmap starts with [the product blueprint](../product/milestones/01-product-blueprint.md)
and [the working application](../product/milestones/02-working-application.md).
Agents add further milestones as needed. Closing one milestone does not finish
the goal. The goal ends only after the final full-product acceptance described
in [the workflow](workflow.md#8-continue-to-the-complete-product).

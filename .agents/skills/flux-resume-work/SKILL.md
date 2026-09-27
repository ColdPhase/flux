---
name: flux-resume-work
description: Resume a paused Flux /goal session from GitHub issues, assignees, branches, PRs and local worktrees, preserving unfinished work and continuing the existing artifact before creating new tasks.
---

# Resume saved Flux work

Read `AGENTS.md`, [startup](../../../docs/agents/startup.md) and the
[protocol](../../../docs/agents/github-protocol.md). State lives in GitHub and in
your local worktrees; there is no other journal.

- Confirm your identity and that no other session runs for it.
- List open issues assigned to you and read comments since you paused. Check
  review requests addressed to you.
- Inspect your worktrees, branches and uncommitted files. Preserve local changes;
  never discard or overwrite them. Match them to their issue and PR.
- Check your open PRs: review results, failing checks, unresolved threads.
  Before retrying an uncertain create/push/comment, check whether it already
  happened.
- Resume the same branch/PR and criteria. Do not recreate issues, repeat accepted
  research or reopen an agreed contract because the session restarted.
- If a requirement actually changed, update the issue body and tell the evaluator.
- If a task is blocked, record it once and continue another ready task.

Return the recovered tasks, branches/PRs, what is verified and the next action.
Never describe files on one machine as already pushed.

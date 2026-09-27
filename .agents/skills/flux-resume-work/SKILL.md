---
name: flux-resume-work
description: Recover a stopped Flux worker from its journal, GitHub claims, worktrees and PRs, preserving unfinished work and resuming the existing artifact before creating new tasks.
---

# Resume saved Flux work

Read `AGENTS.md`, [startup](../../../docs/agents/startup.md), the recovery record
and the [protocol](../../../docs/agents/github-protocol.md).

- Verify worker identity and that its earlier process stopped. Check actual issue
  ownership and current messages; an expired claim alone does not transfer work.
- Inspect the interrupted turn, last completed checkpoint and newer GitHub claims.
  The last result may predate a successful API call or saved implementation.
- Inspect existing worktrees, branches, uncommitted files and matching PRs.
  Reconcile GitHub before retrying an uncertain create/push/comment operation.
  Preserve local changes, recover a pushed branch if needed and reuse the PR.
- Resume the same artifact and valid criteria. Do not recreate issues, repeat
  accepted research or restart negotiation because the process/model changed.
- Check paired presence and the local failure reason. Both workers must upgrade
  to the same peer-watch configuration and restart after a paired suspension.
  Startup waiting is handled by Python; do not start a model to poll the peer.
- Incorporate an actual changed requirement and get peer evaluation of its impact.
  Founder acceptance is not needed under the delegated product authority.
- Publish a recovery checkpoint when it adds shared state. If blocked, preserve
  this task and continue another ready task.

Return the recovered task, branch/PR, verified work and next concrete action.
Never describe files on one machine as already pushed.

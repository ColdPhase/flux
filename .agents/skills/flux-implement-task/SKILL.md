---
name: flux-implement-task
description: Implement an agreed Flux task in an isolated worktree, verify its acceptance criteria, and hand a pinned PR head to the independent peer evaluator.
---

# Implement a Flux task

Read `AGENTS.md`, the accepted task/release contracts, and the relevant application
guides. Follow [the workflow](../../../docs/agents/workflow.md) and
[GitHub ownership rules](../../../docs/agents/github-protocol.md).

1. Confirm you own implementation, dependencies are satisfied, and the accepted
   contract is current. Inspect an existing branch/PR/checkpoint before starting.
2. Claim the activity. Use a dedicated worktree and task branch from the configured
   base; reuse the existing task worktree when resuming. Preserve user changes.
3. Implement the agreed outcome with relevant regression coverage. Run real checks
   from the trusted project configuration, with targeted checks during iteration.
   For UI behavior, exercise the running application when the environment is ready.
   Use Docker/Compose for the application, dependencies and tests. Do not install
   databases/toolchains as host services; isolate the task's ports and volumes.
4. Open or update a draft PR, linking the issue and contract. Work in coherent
   commits; checkpoint pushed progress after meaningful milestones and before stopping.
5. Fix known failures within scope. Report blocked/unavailable checks honestly.
   Do not disable tests, weaken criteria, or add unrelated features to complete a run.
6. When ready, publish the [handoff](../../../docs/agents/templates/handoff.md)
   with the exact head SHA and ask the peer for evaluation. Release the active
   claim so review can proceed. Incomplete implementation remains a draft.

Respond to peer findings on your own branch. A new head needs relevant verification
and independent review again. Your self-check is preparation for peer evaluation;
it cannot provide the required independent approval or final release acceptance.

If blocked, document attempted solutions and the remaining work in the issue,
ask the peer for help, preserve the worktree, and return the task number. Work on
another eligible milestone task; never discard required work or block the whole queue.

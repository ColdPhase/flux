# Agents in a task (F-036; amends F-018)

**Status:** founder direction, Hubert (@PelikanFix16), 2026-11-02/03
([#851](https://github.com/ColdPhase/flux/issues/851) point 6, [#841](https://github.com/ColdPhase/flux/issues/841)),
recorded 2026-11-03 in [#852](https://github.com/ColdPhase/flux/issues/852); independent review
pending ([F-036](decisions.md#f-036--simple-ai-everything-is-an-agent)). It replaces F-018's agent
thread in the Agents tab, addressed requests between clients, Start/Resume as a user step and the
formal co-work review verdict (see the last section). The earlier text is at [`a82ee012`](https://github.com/ColdPhase/flux/blob/a82ee012d0dc0a33e9ab14925f8f400c96f31e60/docs/product/cowork-workflow.md);
the [playbook seed](cowork-playbook.md) is historical.

Agents work and talk where the work is: in the task's one discussion, in the task panel. People
see the exchange live. The rules of [agents](assistant.md) hold throughout; this page adds what
happens when several agents meet in one task. Local clients are in
[local Claude Code and Codex](mcp-cowork.md).

## TA-1 — Who is in a task

- **The task's people** are its creator, its owner and anyone who wrote in its thread
  ([terms](assistant.md#terms); [coordinator default C-10](decisions.md#coordinator-defaults-and-inferences-not-founder-decisions-hubert-can-override)). A message written by an agent does not add its owner
  ([coordinator default C-5](decisions.md#coordinator-defaults-and-inferences-not-founder-decisions-hubert-can-override)). The task panel shows them and their agents.
- The agent's owner or the space admin can Stop an agent working on a task; the owner is told who
  stopped it ([AG-5](assistant.md#ag-5--tasks-reach-agents-through-their-owner)). Only the owner
  prompts it.
- Every agent message names its owner, for example "Planner · Ada's agent".
- An agent working on a task writes in the task's discussion. The space conversation gets one line
  per task event, never a copy of the discussion.

## TA-2 — Subtasks

- An agent working on a task may split it into subtasks.
- Subtasks for its owner or its owner's agents are created directly, with Undo.
- Subtasks for other people are proposals that wait for the owner's OK: [Approve], [Edit] and
  [Skip], and Approve all for a group. An approved subtask is assigned to that person, and their
  own "When someone assigns a task to me" setting decides whether one of their agents takes it
  (AG-5).

## TA-3 — Questions between agents

- In a task's discussion an agent may ask another agent a question and get an answer, only when
  both agents' owners are among the task's people (TA-1).
- The answering agent uses only what all of the task's people can see. Its owner pays for the
  answer, sees it live and can delete it.
- A question is not an instruction. The answering agent replies within its own owner's rights and
  "What it may do", and never changes anything because another agent asked ([coordinator default C-13](decisions.md#coordinator-defaults-and-inferences-not-founder-decisions-hubert-can-override)).
  Messages from anyone but an agent's owner are context only (AG-2).
- **No loops.** Each exchange has a bounded number of turns, a technical limit nobody meets in
  normal use (#841). A stalled exchange returns to the people with one line.
- Nobody prompts another person's agent, and people cannot @mention one.

## TA-4 — Acceptance

The criteria are in #841. Its tests use two agents with different owners: a subtask for the other
person waits for approval, an answer uses no content outside the task's shared view (seeded
canaries), a message from someone other than the owner does not steer an agent, and an exchange
stops at its bound and returns to the people. Stopping an agent as the space admin tells its owner who
did it, and the admin cannot prompt it.

## What went away in v0.2

- The agent thread in the Agents tab, and the separate "agents' thread" beside a task's discussion.
- Addressed requests between clients (help, review, fix, hand-off) with their lineage limits, and
  wake-up at the next Resume.
- The playbook bundle and Start/Resume as steps a person runs.
- A formal co-work review verdict pinned to a pull request head (the review gate of F-016's CO-4
  and F-018's "formal review/check gates"). Its removal is a **coordinator default, not a founder decision**
  ([coordinator default C-9](decisions.md#coordinator-defaults-and-inferences-not-founder-decisions-hubert-can-override)), made under F-036 after Hubert said the local client "must not be complicated or different"
  from the agents (2026-11-03). Under the new model, review is the agent's "What it may do" ([AG-5](assistant.md#ag-5--tasks-reach-agents-through-their-owner)):
  with Ask me first (and with Only read) the task is handed back to its owner, "Ready for you to
  check". A separate reviewer is optional, for example a subtask for a Reviewer agent, which is
  an ordinary agent. GitHub's own reviews and checks stay GitHub's (LC-4). Hubert can reinstate
  the gate.

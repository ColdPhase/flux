# People's agents take tasks (#856, #904)

How a task reaches a person's agent and comes back. The product rules are
[AG-5 and AG-8](../product/assistant.md#ag-5--tasks-reach-agents-through-their-owner); this page is the
engineering behind them.

## The two ways in

1. **The Owner field.** A person gives a task to one of their own agents. The Owner field offers
   `GET /api/v1/me/task-taking` → `agents` (their own agents that run on the server) and nobody else's. The
   server refuses the rest too: `requireOwner` in `packages/core/src/work/service.ts` answers
   `422 OWNER_NOT_YOUR_AGENT` unless the agent belongs to the person making the change (#904). Another
   person's agent is reached by giving the task to that person.
2. **The one setting**, "When someone assigns a task to me: Do nothing / Give it to [agent]" (`PUT
   /api/v1/me/task-taking`, table `agent_task_taking`). No row is Do nothing. It acts when someone else assigns the
   task: not when a person gives it to themselves, not when their own agent gives it back, and not for a change
   made by one of these rules (`via: 'agent_rule'`).

## Events, not polling

`packages/db/src/repositories/work.ts` writes an `agent_task_events` row in the transaction that gave the task an
owner, only when the server has something to do (an agent owner, or a person who chose an agent). A trigger
writes a `finished` row when a run with a `work_id` leaves `queued`/`reading`/`dispatching`, whoever ended it
(worker, sweep, Stop, AI turned off). Both inserts `NOTIFY flux_agent_tasks`; the API listens
(`apps/server/src/agent-tasks/routes.ts`) and drains (`drain.ts`), one event per transaction, skipping rows
another replica holds. Nothing is polled while idle.

| Event | What the drain does |
| --- | --- |
| `assigned` to a person | Their setting names an agent: the task is given to it as an owner change on their behalf (`agent_rule`). |
| `assigned` to an agent | The agent says "Got it, I'm on it." in the task's discussion (this opens it and anchors the run), then `startTask` queues a run of kind `task` (`personal_runs.work_id`). The task becomes Doing. A run that cannot start is said in plain words and the task goes back to its owner. |
| `finished` | The run's report is posted in the discussion as the agent's message. With "Do it and tell me" the agent marks the task Done; with "Ask me first" or "Only read" the task goes back to its owner to check (C-1). Stopped, paused, revoked or denied: back to the owner with one line. Failed: the agent keeps the task; its owner chooses Try again or Take it back. The provider's limit: the run that continues it is already queued (#854). |

## Locks and tries

An event is one transaction. A rule's refusal (`DomainError`: the task changed, a person lost access, AI is off) ends
the step and the event is done. Anything else (a deadlock, a lost connection) rolls the whole event back; the drain
counts the try, waits `tries²` seconds (at most 60) and looks again, with no polling while idle. After five tries the
event is given up (`AGENT_TASK_EVENT_ATTEMPTS`): the agent says in the task that it could not take care of it and the
task goes back to its owner (`giveUp`), so a lost assignment is never silent. The retry timer lives in memory (a known
limit): after a restart the API drains once at start, and an event whose time has not come yet waits for the next NOTIFY.

Every event takes its locks in the one order the worker and the use cases take them: the enablement rows of the people
whose agents may start a run (ascending), then the space's task-graph lock, then the task and run rows. The worker checks
the owner's enablement before it fences the task (`recheck`, then `prepareTaskUse`), a person's own assistant request does
the same (`start`), and `task-targets.ts` records the rule ("authority fences, then graphs, then tasks"). `lockInOrder` in
`drain.ts` reads who the owners are without a lock, locks their rows, then the graph. The first version took the graph
first; with the worker running the agent's tasks and the owner asking his own assistant it deadlocked, lost the worker's
dispatch job and answered 500. `tests/app/agent-task-concurrency.test.ts` runs that burst against the real worker on the
mock provider and fails on the old order (see the file for how to run it).

## The run

A `task` run is an ordinary personal run: the owner's lane, room on the server (#860), the provider's limit or the
key's daily budget (#854), the space's AI switch (AG-10), changes with Undo and waiting items with Approve all
(#855). Its tools are the assistant's (the owner's rights, no code, no other apps); its prompt
(`runtimePrompt`, `taskSystemPrompt`) says the task is data and that Flux, not the agent, moves the task's status and
owner. Its answer is not listed again as a conversation answer; the drain posts it as a message.

## The state line

`GET /api/v1/work/:id/agent` returns one line for everyone who can read the task (`taskAgentState`): waiting for
room, working, waiting for the OK, paused by the provider's limit, failed, stopped (by whom), done, or handed back.
Stop (`POST …/agent/stop`) is the agent's owner's or a space admin's; Try again (`…/agent/retry`) is the owner's;
Take it back is the owner changing the Owner field.

## Not here

Reports in the agent's private conversation (with the unread dot) belong to the agent conversation of #842/#857; the
data is the run (`kind = 'task'`) and the discussion message. Reading the web (the runtime's egress) is a separate
change.

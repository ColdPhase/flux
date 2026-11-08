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
counts the try (only while nobody has handled the event: another replica may have taken it a moment after the try failed
and done it), and it waits `tries²` seconds (1, 4, 9, 16; at most 60). The wait is a row (`next_try_at`), and after every
drain the API sets one timer from the earliest one waiting (`nextDueIn`), so a wait that was still running when the API
restarted is found again; nothing is polled while idle.

The fifth failed try (`AGENT_TASK_EVENT_ATTEMPTS`) is due at once and the next claim of the event is `giveUp`, in the same
transaction that ends the event, so a lost assignment is never silent. The agent says in the task that it could not take care
of it ("I couldn't take care of this. It's back with you."), the task goes back to its owner and the agent's runs on it stop
(a person who had chosen an agent whose task the setting could not give reads "I couldn't take this. It's still with you.").
A `released` event that gave up says nothing: the person took the task away, so only the agent's runs that were going when they
did stop, whether or not the agent holds the task again. If the give-up fails too, the event stays and is claimed again
later (the wait grows to a minute), up to `AGENT_TASK_GIVE_UP_ATTEMPTS` (5) more times: it is never marked handled without having
been done, and after the last it is left with its count (`attempts` is 10, `handled_at` null, one error in the log), not claimed again,
so an operator finds it (`SELECT … FROM agent_task_events WHERE handled_at IS NULL AND attempts >= 10`). The give-up of an answering
run's `finished` event is the asker's: it says it got no answer and the task goes back to the asker's owner. A release, normal or
given up, stops only the runs that were going when the task was taken away (`created_at` at or before the event's).

Every event takes its locks in the one order the worker and the use cases take them: the enablement rows of the people
whose agents may start a run (ascending), then the space's task-graph lock, then the task and run rows. The worker checks
the owner's enablement before it fences the task (`recheck`, then `prepareTaskUse`), a person's own assistant request does
the same (`start`), and `task-targets.ts` records the rule ("authority fences, then graphs, then tasks"). `lockInOrder` in
`drain.ts` reads who the owners are without a lock, locks their rows, then the graph. For a question between agents the
owners are the task's people: they are read again under the graph lock (every writer of the thread takes it, so they cannot
change then) and the event starts over, counted as no failure, if someone wrote in between. The first version took the graph
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
Stop (`POST …/agent/stop`) is the owner's of the agent whose run is working, or a space admin's: for an agent that is
answering a question it is the answering agent's owner, never the one who asked. Try again (`…/agent/retry`) is the owner's;
Take it back is the owner changing the Owner field. After a Stop the line says where the task is: "back with" its agent's
owner, or "with" the person who took it. An agent waited for is named as the thread names it, "Fieldbot (Carl's agent)".

## Agents together in a task (#841, #844)

- **Subtasks (TA-2).** A subtask is a task that is part of another: a `part_of` link from the subtask to its parent
  (`CreateWorkCommand.parentId`; the agent tool `flux_create_task` takes `task.parentTaskId`). The parent does not wait for
  its subtasks (that is what prerequisites are for). The task panel lists them as "Subtasks · 1 of 2 done". A subtask for
  another person is a proposal that waits for the owner's OK with Approve all (AG-3); once approved it is that person's
  task, and their own "When someone assigns a task to me" setting decides whether one of their agents takes it.
- **Questions between agents (TA-3).** An agent's report may end with one
  `<ask>{"agent": "Fieldbot", "owner": "Jonas", "question": "…"}</ask>` block (`packages/core/src/agent-tasks/ask.ts`). The owner
  says whose agent is meant, because every person's first agent has the same name; a name that fits more than one agent, with no
  owner or an owner that fits two, is not guessed: the thread says so and the task goes back to its owner. The drain posts the report and the question as the agent's messages, checks
  that both owners are among the task's people (`taskPeople`: the creator, the owner, anyone who wrote in the thread; a
  message written by an agent adds nobody) and starts a run of kind `task_answer` for the other agent on its owner's account.
  That run only reads (`readOnly` in the run token), is told the question is data, and is refused unless every person of the
  task can still read the space, so it uses only what all of them can see. Its answer is posted as the other agent's message and
  the asking agent continues with it as a new run. Each step is bounded (`MAX_EXCHANGE_TURNS`); an exchange that cannot
  go on (no such agent in the task, a refusal, no answer, the bound) is said in one line and the task goes back to its owner.
- **The owner can always delete a line their agent put in the thread (#923, #938, TA-3).** The report, the question and the
  answer of a run are also that run's change (`conversation.reply`, `assistant_changes`, tool `flux_task_post`), so the agent's
  owner sees Delete under the line (asked once) and everyone then reads "Removed by Jonas" over a marker, "[Removed by its owner]",
  that keeps the line's place. Nothing stops it: not a person's later reply, not a citation (`plan.thread` makes `removeMessage`
  skip the "used since" checks that every other removal has). It is the owner's alone, and, like every removal of what an agent
  made, it waits while AI is off in the space (C-17). A run's own Undo leaves these lines to their Delete, and the state line
  does not list them. Status lines ("Got it", "Stopped by Maja", refusals) are not changes.
- **Who is in the task.** `GET /api/v1/work/:id/people` names the task's people and their agents for the panel's "In this
  task" row.
- **The message a task came from (#844).** Creating a task from a message stores the message as the task's `source` link;
  Details opens it in context and the message shows its task. The agent tool takes `task.sourceMessageId` for the same.

## Not here

Reports in the agent's private conversation (with the unread dot) belong to the agent conversation of #842/#857; the
data is the run (`kind = 'task'`) and the discussion message ([#919](https://github.com/ColdPhase/flux/issues/919)). Reading the
web (the runtime's egress) is a separate change ([#918](https://github.com/ColdPhase/flux/issues/918)).

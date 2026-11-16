# Work items and decisions (issue #101)

**Later required amendment, 2026-09-30:** [F-016](../product/mcp-cowork.md)
adds separate local-agent execution/review records and disclosed GitHub rules
for the same work item, with manual correction suspending automation. Existing
work statuses, parking and human-only domain decision acceptance remain.
UI116-3 ([final design](../design/final/README.md#5-behaviour) rule P5) changes new-task notice/first-contribution flow
without rewriting historical threads. Implementation is tracked in the new
contract's delivery table; this notice is not runtime evidence.

Foundation 8.5/8.6 and the #44 product contract: conversation, task and decision keep
their own meaning and stable ids and are connected by many-to-many links. Creating work from a
message keeps the message where it is. Everything described here is visible exactly to the
principals with current read access to the project; there is no second audience.

## Objects

| Object | Fields | Rules |
| --- | --- | --- |
| Work item | title, outcome (may be empty), owner (person or #29 agent, or nobody), status `open` · `in_progress` · `blocked` · `done` ([four states](#statuses-waiting-and-what-came-of-it-868)), optional blocker, one thing it waits for and `dropped` and `cameOfIt` (only while blocked or done), optional `dueOn` ([below](#due-date-and-activity-488)), version | The owner must currently be able to read the project (`OWNER_WITHOUT_ACCESS`). Leaving `blocked` clears the blocker. Small tasks need only a title; no report is required. Explicitly saving a nonempty blocker also contributes it to the task conversation ([below](#contributions-to-the-task-conversation-154)). |
| Decision | title, rationale, status `proposed` · `accepted` · `superseded`, proposed by, decided by (a person), `supersedes` / `supersededBy`, version | People and agents with write access propose. Only a person with write access accepts (`DECISION_NEEDS_PERSON`); see [acceptance authority](#acceptance-authority-o-009-250). Only an accepted decision can be superseded (`SUPERSEDES_NOT_CURRENT`); accepting the replacement marks the earlier one `superseded` and keeps its title and rationale. The screens call a superseded decision "replaced". |
| Link | role, from (work/decision, or a [doc](docs-wiki.md)), to (message, thought, material version, work, decision, doc, project sketch), titles of both ends | Roles: `source` (created from / based on), `affects`, `related`, and `mentions` (the current text of a doc refers to it, #112). Every target must exist in the same project (`LINK_TARGET_NOT_FOUND`). Identical links are stored once. |

**No pivot (founder direction, Hubert, 2026-11-03; #871).** Accepting a decision that replaces an earlier one
only marks the earlier one `superseded`. Flux does not move, park or re-link any task because a decision changed; people
decide about the tasks themselves. The accept request has no `stillApplies` and no `park`: a client that still sends them is
ignored by the schema and changes nothing. A task has no parked state at all (#1039, migration 0035 drops the columns, the
`still_applies` link role and everything that read them). Two people accepting
competing replacements of the same decision at once: one wins, the other gets `409 SUPERSEDED_DECISION_CHANGED`.

## Acceptance authority (O-009, #250)

[O-009](../product/decision-authority.md) (proposed) records the rule this code enforces:

- **Who accepts.** One signed-in person whose current project level is contributor or manager.
  That covers owners and admins, members of the space and a guest with a contributor grant. The proposer may accept their own proposal.
- **Who is refused.** A person without access, removed from the space or gone gets `404`. An
  agent gets `403 DECISION_NEEDS_PERSON`, whoever owns it and whatever its grant.
- **Paths that never accept.** The assistant in Flux has no decision path: it proposes nothing for
  a person to accept (#1054). MCP has no accepting tool and no `decision.*` operation other than `decision.propose`, so a
  standing grant cannot name acceptance.
- **Superseding.** It happens only when an authorized person accepts the replacement.
- **No silent change.** A refusal changes nothing: same status and version, no
  `project.decision_accepted.v1` event. The `0008_work.sql` `CHECK` and the `auth_users` foreign key
  refuse an accepted row without a person.
- **Delegation.** There is no delegated acceptance in v0.1.

In Details, a person without write access sees **Who decides** in place of the Accept form.

## API

| Method and path | Notes |
| --- | --- |
| `GET/POST /api/v1/projects/:projectId/work` | List (page `limit`/`offset`) or create. |
| `GET/PATCH /api/v1/work/:workId` | `PATCH` needs `If-Match: "<version>"` (or `expectedVersion`): 428 without, 409 `VERSION_CONFLICT` with the current object when stale. Optional `clientCommandId` (UUID, #154): see below. |
| `POST /api/v1/work/:workId/waiting-done` | The person a blocked task waits for says they are done ([below](#statuses-waiting-and-what-came-of-it-868)). Needs `If-Match`; reading the space is enough. |
| `GET /api/v1/work/:workId/activity` | The task's history of status, owner, due date and title changes, newest first: `?limit=` 1-50 (30 when omitted) and `?before=` (the `nextBefore` of the page before). Read by exactly those who can read the task ([below](#due-date-and-activity-488)). |
| `GET/POST /api/v1/projects/:projectId/decisions`, `GET /api/v1/decisions/:id` | Propose with `sources`, `affects`, `supersedes`. |
| `POST /api/v1/decisions/:id/accept` | Needs `If-Match`; no body (`{ expectedVersion? }` is the same as the header). |
| `POST /api/v1/decisions/:id/unaccept` | Its accepter's Undo ([below](#accept-at-once-and-undo-takes-it-back-1424-round-8)). Needs `If-Match` (the version the accept returned); `200` with the decision, proposed again. |
| `POST /api/v1/decisions/:id/withdraw` | Its proposer's Undo ([below](#a-proposal-reaches-everyone-at-once-and-undo-withdraws-it-1424-l)). Needs `If-Match`; `204`. |
| `GET/POST /api/v1/decisions/:id/discussion` | The decision's one discussion ([below](#a-decisions-discussion-1424)): its messages, or a message written in it. |
| `POST /api/v1/projects/:projectId/links` | A `related` link between any two objects of the project. |
| `GET /api/v1/workspaces/:workspaceId/work/assigned` | The caller's unfinished work in every project the policy's `visibleFilter` lets them read. |

Every POST/PATCH accepts `Idempotency-Key` (the shared runner in `app/apps/server/src/http/commands.ts`,
also introduced by #100); a replay re-checks current project read access. Responses with a version
carry `ETag`. An object in a project the caller cannot see is `404 <TYPE>_NOT_FOUND`, the same as a
missing one.

## A proposal reaches everyone at once, and Undo withdraws it (#1424 L)

Founder decision L (Hubert, 2026-11-15, #1424): a proposed decision is not held for its Undo toast. The Create window sends it at
once, so its card, the Inbox items of those who can accept it and the notifications about it arrive at once, as a new task's do. The
toast's Undo is `POST /api/v1/decisions/:id/withdraw`:

- **Who.** Only the person who proposed it (`403 DECISION_NOT_YOURS` for anyone else, the company's owner included; an agent's
  proposal goes back only through its run's Undo), with write access to the space now (`404` without it, as for a missing decision).
- **When.** While it is still proposed and unchanged (`If-Match`: `428` without it, `409 VERSION_CONFLICT` when stale,
  `409 DECISION_NOT_PROPOSED` once accepted) and while nothing else names it: a link to it
  (a task related to it, a Wiki page that mentions it), a task that waits for it or a decision that replaces it are `409 DECISION_IN_USE`,
  and it stays. So is a decision someone has written about ([its discussion](#a-decisions-discussion-1424)).
- **What goes.** The decision row, its own `source`/`affects` links, its notifications (their queued emails go with them) and the
  Inbox choices made on it (`needs_you_states` `decision:<id>`), in one transaction. Its Inbox item is derived from the row, so it is gone
  too, and so is its card ([`listObjectNotices`](#events)): a reader's next refresh of the newest notices drops a card the server no
  longer has inside the span it read (`refreshNotices` in `ConversationStream.tsx`). The task and the message it came from stay. The
  earlier `project.decision_proposed.v1` event stays in the log and finds nothing; one `project.decision_withdrawn.v1` (`{ decisionId }`)
  tells readers to refetch. A second withdraw is `404`.
- **Order.** It takes the project's graph lock and then the decision's row, as Accept does, so a withdrawal and an acceptance
  serialize: the later one finds the decision decided (`409`) or gone (`404`).
- **Not done.** A notification the generator is writing in the same instant may outlive the decision (its link then opens nothing);
  the generator writes none for a decision that is already gone.

## Accept at once, and Undo takes it back (#1424 round 8)

Founder decision (Hubert, 2026-11-15, round 8, #1424): Accept works at once everywhere, in the Inbox (`A`, the button) and in the
decision's panel, with a 10 s Undo; Undo of an acceptance that replaced an earlier decision brings that one back too. Before it, the
Inbox held the accept until its toast left (so others saw nothing for 10 s) while the panel accepted at once with no Undo. Now both
send `POST /decisions/:id/accept` at once and the toast's Undo is `POST /api/v1/decisions/:id/unaccept`:

- **Who.** Only the person who accepted it (`decidedBy`; `403 DECISION_NOT_YOURS` for anyone else, the company's owner included), with
  write access to the space now (`404` without it, as for a missing decision).
- **When.** While it is still accepted and unchanged (`If-Match` with the version the accept returned: `428` without it, `409
  VERSION_CONFLICT` when stale; `409 DECISION_NOT_ACCEPTED` once it is proposed again or replaced), within 10 minutes of the acceptance
  (`409 DECISION_UNDO_ENDED`: the toast's 10 s pause while it is pointed at or focused, so the server allows more, but an Undo is not a
  way to change direction later), and while nothing rests on it (`409 DECISION_IN_USE`): a task the acceptance let continue was changed
  since (its version is no longer the one the acceptance left), or a newer proposal names it as the decision it replaces. A message in its
  discussion, a link or a Wiki mention does not rest on the acceptance and does not stop the Undo.
- **What it does,** in one transaction, under the project's graph lock and the decision rows in id order as Accept takes them: the
  decision is `proposed` again (`decidedBy`, `decidedAt` cleared, version + 1); a decision it replaced is `accepted` again (its
  `supersededBy`, `supersededAt` cleared); every task the acceptance resumed is `blocked` again, waiting for this decision with the reason it
  had (kept by the acceptance), its "can continue" line in the conversation goes, its activity line of the resumption goes,
  and the "can continue" notification its owner got is deleted with its queued email. The decision's Inbox items come back by themselves
  (they are derived from its status). One `project.decision_unaccepted.v1` (`{ decisionId }`) tells readers to refetch; the card changes
  back in place to Proposed.
- **What the acceptance keeps for it.** `project_decision_resumptions` (migration 0091: `decision_id`, `work_id`, the task's
  `version` right after it resumed and the `blocker` it waited with, sealed in an encrypted space as the task's own is; `ON DELETE
  CASCADE`) is written by the accept for each task it resumed and read and cleared by the Undo. A later accept of the same decision
  writes its own rows.
- **Not done.** An agent whose task the acceptance resumed is woken as by any resumption; if it changed the task before the Undo, the
  task is in use and the acceptance stays. A push already delivered for "can continue" is not recalled.

The web client (`useAcceptDecision`, `work/acceptDecision.ts`) is the one way both places accept: the item leaves the Inbox at once,
the toast is "Accepted" with Undo (`Z`); Undo restores the item and the card, or says "It is in use now, so it stays accepted" on `409`.

## A decision's discussion (#1424)

Founder decision (Hubert, 2026-11-15, recorded on #1424): Discuss starts a thread in the space's conversation on the decision's card, and
the decision's panel shows the same thread's messages with a field to write: one discussion in both places, as a task's discussion is.
Before it, Discuss put the cursor in the space's main composer, so the words joined an unrelated draft or went out as a plain message
with no link to the decision.

**Model: the task's.** A decision's discussion is modelled exactly as [a task's discussion](task-discussions.md) is, because a decision's
card is a notice derived from the decision, not a message, so it cannot be a thread's root message. The first message written about a
decision creates one ordinary conversation of the space and binds it to the decision in the same transaction
(`project_decision_discussions`, migration 0090: `decision_id` the key, `conversation_id` and its sequence-1 `root_message_id` unique,
with composite foreign keys to the decision, the conversation and the root, all `ON DELETE CASCADE`). Every later message is a reply in
that conversation. So all the thread machinery applies unchanged: the thread panel (`GET /conversations/:id`, which names the decision as
`decision: { decisionId, title }`), replies through `POST /conversations/:id/messages` (from the thread's own composer, an agent's
`flux_reply_in_conversation` or anything else), edits and deletes, reading positions and "Seen by", typing, files, references, Search and
the encryption of an encrypted space (the binding row holds ids only; the messages are sealed as any thread's). Like a task's discussion
it is not a root of the stream (`conversation-roots` and the receipts' runs of roots leave it out): its place is the decision's card.

- **`GET /api/v1/decisions/:id/discussion`** (`DecisionDiscussion`): `{ decisionId, workspaceId, projectId, conversationId, messages,
  messagePage }`, the newest 50 messages oldest first (`?limit=`, `?beforeSequence=` as for a conversation); `conversationId: null` and
  no messages before anyone has written. Reading the space is enough; a decision in a space the caller cannot read is `404
  DECISION_NOT_FOUND`, like a missing one.
- **`POST /api/v1/decisions/:id/discussion`** (a `SendMessageCommand`: `body`, `clientMessageId`, optional `attachmentIds`,
  `references`): `201` with the stored message (`SentConversationMessage`). Writing in the space is needed (a guest of the space writes
  as any member does). Under the space's access rows and the send's identity lock it locks the decision's row, so two first messages at
  once make one thread: the first creates it, the second is its first reply. A retry with the same `clientMessageId` returns the stored
  message; one used for other words is `409 IDEMPOTENCY_CONFLICT`. Both composers of the web (the panel's and the thread's) send here,
  with one draft, `decision:<id>`.
- **Events.** The first message records `project.conversation_created.v1`, later ones `project.message_sent.v1` (`{ conversationId,
  messageId }`), as any thread's, and every message in a decision's discussion, however it was written, also records one
  `project.decision_discussed.v1` (`{ decisionId }`), and so does an Edit or a Delete of a message there (beside
  `project.message_edited.v1` / `project.message_removed.v1`): the stream's readers refetch the decision's card (its count) and an open
  panel its messages, and no words travel on the stream.
- **Where you left off.** The thread has no opening message (its head is the decision), so its `unreadFrom` may be its first message:
  the New divider stands above the first message by someone else that the reader has not seen, from sequence 1, as above any reply.
  The decision's panel records what it shows as viewed (`POST /projects/:id/observations`, the same 60 % for 700 ms rule as the thread),
  so a message read in the panel is not new in the thread.
- **The card's count.** The decision's object notice carries `discussion: { conversationId, replyCount, lastReplyAt } | null`: how many
  messages the thread has (every one is a reply to the card) and when the newest was written.
- **Notifications** follow a thread's rules (#1249): its starter and earlier writers follow it, Follow and Unfollow win, and a name or a
  question in it reaches whom it names. **A question that names nobody asks the decision's proposer** (an agent's owner for an agent's
  proposal), not the thread's first writer (persona round 8 P2 3, 2026-11-15): the generator's fact for the message carries the decision
  (`decision: { title, askee }`), and its title says "Jonas asked you about “…”", a reply's "Jonas replied about “…”" (never the first
  comment's words; a sealed space keeps its fixed words). The Inbox item of
  a question or a mention in a decision's discussion carries `about: { decisionId, title }` (`NeedsYouItem.about`, read from the binding of
  the notification's conversation), so its line reads "Question · Jonas · about “…”". Whoever proposed the decision follows it from its first message: binding the thread writes their
  follow (`notification_follows`, only when they have made no choice), so they get its replies as its starter does. An agent's proposal
  is its owner's: the agent's owner follows it the same way.
- **Withdraw.** A proposal that has a discussion is in use (`409 DECISION_IN_USE`), as one that something names: what was written about
  it stays.

## A task from your own message is yours (#1424 M)

Founder decision M (Hubert, 2026-11-15): `POST /projects/:id/work` with no `owner` field, by a person, with a `source` message of the
space that this person wrote (and that is not removed), makes the task theirs (`owner` = the creator, so nobody is notified of it). An
`owner` in the command wins, and `owner: null` keeps it without one; a task made from someone else's message keeps no owner. The
Create window starts with you as Owner for your own message and your own `/task` words (`CreateRequest.ownerMe`) and always sends
`owner` (`null` for No owner), so what the window shows is what is made.

## Contributions to the task conversation (#154)

Two things also contribute to the task's canonical conversation, in the same transaction, through the
mandatory `WorkPorts.contributions` hook (there is no work adapter without it; see
[task discussions](task-discussions.md#explicit-native-effects-on-the-canonical-thread)):

- **Saving a blocker.** `PATCH` with a nonempty `blocker` (status `blocked`) is one authored contribution whose
  body is exactly the saved, trimmed text. Clearing the blocker (`null`, empty or whitespace) and changing only
  status, owner, title or outcome contribute nothing. Creation with a blocker keeps only its creation notice.
- **What came of it.** A task finished with a nonempty `cameOfIt` line writes it once as `contribution.kind` `came_of_it`
  ([below](#statuses-waiting-and-what-came-of-it-868)).

`clientCommandId` makes the command durably retryable. The receipt is scoped to the real actor, project,
operation and UUID. An exact retry rechecks current project write access, the produced state (a changed task is
`409 COMMAND_POSTSTATE_STALE`, never overwritten and never contributed twice) and the stored contributions, then
returns the original outcome; a changed intent is `409 IDEMPOTENCY_CONFLICT`. Without it the `If-Match` version fences a stale identical blocker save. Browsers always send one.
The receipt is separate from the 24-hour `Idempotency-Key` response cache and from the #152 connection-command ledger.

## Statuses, waiting and what came of it (#868)

**Four states.** `open` (To do), `in_progress` (Doing), `blocked` and `done`. "Not pursued" is `done` with `dropped: true`; there is
no fifth state, and no existing data to convert (migration 0035, F-038). `dropped` and the one-line `cameOfIt` live only while the
task is done: a command that sets them on another state is `400`, and leaving Done clears both (what was written in the discussion
stays). `cameOfIt` is one line of at most 500 characters (line breaks become spaces); a nonempty line is also one authored
contribution to the task's discussion, `contribution.kind` `came_of_it`, written like a saved blocker (the same command identity,
never twice for a retry, and not at all for an Undo's `restore`). Five agent messages in a row (C-51) refuse a message, never the Done that carries the line: the line stays on the task and only the discussion message is not written. It is sealed in an encrypted space like the blocker.

**One thing to wait for.** A blocked task waits for one person (`waitingFor`, #550), one decision (`waitingOn: { kind: 'decision', id }`,
still proposed) or one other task of the space (`waitingOn: { kind: 'task', id }`, not done), never two (`400`); naming one clears the
other, and leaving Blocked clears all. Refused with `422`: `WAITING_ON_NOT_FOUND` (another space), `WAITING_ON_RESOLVED` (the decision is
decided or the task done), `WAITING_ON_ITSELF`, `WAITING_ON_CYCLE` (that task waits for this one, however far round). The reads show
`waitingOn: { kind, id, title, number? }`. The blocked line of the stream reads "waiting for #7" or "waiting for the decision …".
Prerequisites (#152) are a separate plan fact and stay as they were.

**Resuming by itself.** When what a blocked task waits for is resolved, the task goes to Doing in the same transaction (To do
when a prerequisite is still open, since Doing needs every one done):

| It waits for | Resolved when | The line says |
| --- | --- | --- |
| a decision | the decision is accepted (`POST /decisions/:id/accept`) | the decision was accepted |
| a task | that task becomes done, by `PATCH`, by a linked pull request's rule (#1055) or dropped | #7 is done / #7 was dropped |
| a person | they say they are done: `POST /work/:id/waiting-done` (the Inbox item's Done, or the panel's) | Jonas is done |

A task that is Blocked when its agent's run ends is left as it is (the report says "Blocked: #4 …" in the agent's chat), in both "Do it and tell me" and "Ask me first": the drain does not mark it Done or hand it back, so the tasks that wait for it do not resume on a false Done. The agent takes the task up again when its wait is resolved and when a person moves it from Blocked to Doing (Resolve), as when it was given the task; moving it to To do does not start it.

A dropped task is `done`, so it satisfies the prerequisites of the tasks that need it. A task that something waits for is in use: naming it marks it used, so its creation cannot be undone (`task_used`) and the Undo of the agent run that made it is refused; the Undo of a run that proposed a decision a task waits for is refused the same way ("Used since"). A task whose creation was undone is read-only history: it waits for nothing, so it never holds the decision or task it named (nor does it stop the Undo of the run that proposed that decision), and it is not resumed. The cycle check is one recursive query that follows the chain to its end and stops at a loop; a task whose creation was undone is not part of a chain.

Each resumed task keeps an activity entry marked `automation: 'wait_resolved'`, a `task.resumed` line in the stream ("#4 can
continue: the decision was accepted", `reason` is the phrase), and tells its owner once: a person gets a notification of that
sentence (`project.work_updated.v1` with `resumedFor`, `reason` and `taskId`), an agent that holds it picks it up again as when it was
given the task (an `assigned` row in `agent_task_events`, #856). The tasks are found under the project graph lock and locked with the
rest of the command's fence, then read again: one that moved on meanwhile is left alone. A task that a pull request's rule moves to
Done (#74) resumes the tasks that wait for it the same way (#1055): the rule's fence (`lockForRules`) also locks the waiting tasks, found
under the graph lock, and the line, the activity entry, the owner's note and an agent's pick-up are the same.

## Due date and activity (#488)

**Due date.** `dueOn` is a calendar day, `YYYY-MM-DD`, with no time zone and no time, so it is the same day for everyone.
It must be a real date from 1970 to 9999 (`2026-02-31` is `400 INVALID_INPUT`); `null` clears it. Create takes it and
`PATCH` changes it like any other field: a versioned change that honours `If-Match` (409 `VERSION_CONFLICT`) and
`clientCommandId`, needs access to the space and leaves the task's other fields alone. The list rows, the
work detail and the task carry it. MCP does not take or show it yet. It is stored in `project_work_items.due_on`
(migration 0112).

**Activity.** Every successful change of **status, owner, due date or title** keeps one row of
`project_task_activity` per field that really changed, made by the principal that acted (a person or an agent, whichever
path: the API, MCP, the assistant, or a task rule of a linked pull request, which acts for
the rule's author and is marked `automation: 'github_rule'`), at the time of the change. The row is written by
`WorkRepository.updateWork`, the one function every change of a task ends in, in the transaction of the change, so a replay
of the same `clientCommandId` or `Idempotency-Key`, a refused change and a change that leaves the fields as they were
(its version still moves) keep nothing. Creation is not an entry (readers derive it from `createdBy`/`createdAt`), and
neither are an outcome, criteria, prerequisites, a blocker edit alone or parking; tasks from before 0112 have no entries.
An Undo (`restore: true`) takes back the task's latest entry of each kind it changes when that entry is the change it undoes, by the
same principal, and keeps none of its own, as the conversation does with its moves (persona round 28): Z after "marked it done" leaves
neither "marked it done" nor "marked it to do".
`GET /api/v1/work/:workId/activity` returns `TaskActivityPage` (`{ workId, items, nextBefore }`), newest first with a
stable keyset on (time, id). `status` entries say the reason and the person waited for when the task became blocked (an
Undo that restores them is a status change too); `owner` entries name both owners, agents with the owner they show to
this project's readers, as the task detail names them. Names resolve as for the task detail; a person who left shows as a
former member. The rows go with their task and so with the project. They are separate from the project conversation's
blocked/unblocked lines (`project_task_updates`, #550), which are unchanged.

## Events

Each committed change records exactly one project event in its transaction (a contribution adds its own
`project.conversation_created.v1` or `project.message_sent.v1`, all in the one final batch):
`project.work_created.v1`, `project.work_updated.v1`, `project.decision_proposed.v1`,
`project.decision_accepted.v1`, `project.decision_withdrawn.v1` or `project.link_created.v1`. A message in a decision's discussion
adds `project.decision_discussed.v1` beside its message event ([above](#a-decisions-discussion-1424)).

The conversation reads one notice per decision (`GET /projects/:id/object-notices`, #694): its card, where and when it was proposed,
with its current state and `decided: { by, at }` once accepted. Accepting changes that card in place and adds no notice (founder
decision D, #1424, 2026-11-15); there is no `decision.accepted` notice. The
`object_id` is the project, `data` carries only the object id, so the stream reaches current
project readers and the client refetches. Idempotent replays and failed changes record none.

## Structure

- `app/packages/contracts/src/work.ts`: wire types and paths.
- `app/packages/core/src/work/`: ports (`WorkAccess`, `WorkRepository`, `WorkEventLog`,
  `WorkUnitOfWork`), validation and use cases. No Drizzle or `@flux/db` import.
- `app/packages/db/src/repositories/work.ts` and migration `0008_work.sql`: rows only, no decisions.
- `app/apps/server/src/work/`: adapters (`evaluateProject`/`authorize`/`visibleFilter`, `recordEvent`)
  and routes. No architecture allowlist entries were added.
- `app/apps/web/src/work/`: loads every page of work and decisions (100 per request until `total`), so the state line, Tasks and inline objects are complete; the Tasks tab (`/projects/:id/tasks`), the state line, message actions
  (Task, Decision, plus Details; #189), inline objects under their source message and
  the Details panel views and forms.

## Not yet

Sketch thoughts as link sources and sources of new work depend on #69/#100 merging; the link
table accepts a new target type through a small migration. Handoffs (a follow-up slice) and agent
execution (#52/#68) are out of scope. The return view (8.8) reads these events; see
[return-view.md](return-view.md). The UI refreshes by route
revalidation and polling and does not subscribe to the stream yet.

## Tests

`app/tests/app/work.test.ts` (API, two people, outsider and an agent principal through the
use cases; #1424 M, a task from your own message), `app/tests/app/object-notices.test.ts` (#694; #1424 D, the card changes in place;
#1424 L, a proposal at once and its withdrawal with its notifications and Inbox items, and who may withdraw it),
`app/tests/ui/test_undo_one_card.py` (#1424 D, L and M in the browser, both engines), `app/tests/app/decision-discussion.test.ts` and
`app/tests/ui/test_decision_discussion.py` (a decision's one discussion, in the panel and on the card, both engines and the phone), `app/tests/app/decision-authority.test.ts` (#250: the O-009 role matrix, the MCP agent path
and the database invariant), the "#250 AC-3" case in `app/tests/app/personal-runs.test.ts` (the assistant
path), `app/tests/ui/test_decision_authority.py` (#250: a contributor accepts; the viewer's "Who decides" note went with the viewer role, #903)
and `app/tests/ui/test_work_decisions.py` (Playwright: create from a message, keyboard
propose/accept, a replacing decision, phone) and
`app/tests/ui/test_decision_surfaces.py` (#692, #693: the proposal form keeps the panel's rhythm of
28 px between sections and 8 px inside one; the proposal's title and Accept block paint no surface of
their own and start on one left edge, at 390 and 1440, light and dark). Screenshots:
`docs/design/work-decisions/` (the former viewer's **Who decides** note, removed with the viewer role in #903: `decision-desktop-1440-viewer.png`,
`decision-phone-390-viewer.png`).

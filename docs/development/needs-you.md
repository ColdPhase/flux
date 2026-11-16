# The Inbox "Needs you" queue (issue #342)

Final design [S1, S9, S11, P4](../design/final/README.md#5-behaviour): **Needs you** is the one queue.
Decisions, questions, blocked tasks and mentions are in one Inbox; Home shows the top three; there is no
Decisions view and no archive. This page is the contract of the queue; the notifications behind two of its
kinds are described in [access policy](access-policy.md) (#116) and the return view in
[return-view.md](return-view.md).

## What needs a person

The queue is **computed for the signed-in person** from current rows and the access policy every time it is
read (`app/packages/core/src/needs-you/service.ts`). Nothing about it is stored except what the person did with
an item. Access is checked at the moment of reading: an object the person cannot read is not listed.

| Kind | What it is | Where it comes from |
| --- | --- | --- |
| `decision` | A proposed decision the person can accept now | `project_decisions.status = 'proposed'` in projects they can read, kept only when they hold write access (O-009 DA-2) |
| `question` | A person asked them something (`@name … ?`, any question in a direct message between the two of them, or a question in a thread they started that names nobody), or invited them to a call (#62) | their unread `question` and `invitation` notifications, newer than 14 days |
| `blocked` | A task they own that is blocked | `project_work_items` they own with status `blocked` |
| `mention` | Someone mentioned them, or answered a question they asked (#1424 decision 1: `answer: true`, the kind word "Reply") | their unread `mention` notifications, newer than 14 days |
| `task` | Someone else or an agent gave them a task they have not opened, started or finished (#1424 C) | their unread `assigned` notification that gave them the task (below) |

An item's `from` is who it comes from as its title names them: the notification's `from_actor` (migration 0087), which the generator
sets to the message's author for a question, a mention, a reply or a direct message, and to the inviter or the caller for a call. A
question asked before someone joined comes from its asker, never from the joiner or whoever added them (persona round 28). A blocked
task's title is the task ("#6 Seal the lids") and its line is what it waits for, in the words the board, the panel, the List and Home use
(contracts `blockedWords`: "Waiting for Basia · the new seals", "No reason was recorded."); the person waited on reads "Ada is waiting for
you: #6 Seal the lids" with the reason alone under it. A task made from a message answers what that message asked or mentioned of its
maker: their question and mention items of it are done, as a reply in the conversation takes them (persona round 28).

**A task given to you** (founder decision 2026-11-15, #1424 C). The generator already tells a person when a task is made with them
as its Owner or its Owner becomes them (`assigned`, event data `assignedTo`), and never when they give it to themselves (the actor is
never told, and `assignedTo` is only set for someone other than the actor). The queue lists the newest such notification of each task
as a `task` item, keyed `note:<notification id>` like a mention, while all of these hold at the moment of reading:

- the notification is unread, and its event named this person as `assignedTo` (the notification read gives it as `given: <task id>`,
  read from the event it was made from; "waiting for you" and "can continue" notifications have no `given`);
- the task is still theirs (a person Owner, them), still `open` (not started, blocked, done or dropped) and its creation was not undone;
- they can read its space.

Its `from` is who gave it (the notification's sender), its `project` the space, its title the task ("#12 Seal the lids"), its `detail`
empty, its `url` the task (`/projects/:id/tasks?open=work:<id>`) and `task: { workId, number, version }`. It leaves when the person **opens**
the task (the web client marks the notification read when the task panel shows a task of theirs that is a `task` item, put off for
later or not, wherever it was opened from; `/inbox/:id` from a notice, push or email reads it too), **starts or finishes** it (status), or when it is **given to
someone else** (owner). **Done finishes the task** (founder decision 2026-11-15, #1424): the Inbox's Done (the button, `E`, the phone's
swipe) is the task's own change to Done, `PATCH /api/v1/work/:id` with `status: done` against `task.version`, said as everywhere ("#12 moved
to Done", with its line in the conversation), so the item leaves as for any finished task and the person who gave it sees it done. Undo puts
the task back to To do (`restore: true`, the line goes) and, the notification still unread, the item is back. The queue's own `done` action
on the item's key only reads the notification; the web client does not use it for a Task item. Not now snoozes it, as for a mention; Undo
brings it back. A blocked
task given to you is its one `blocked` item. Push and email follow the person's level for `assigned`, unchanged.

**Done on your blocked task finishes it** (founder decision 2026-11-15, round 8, #1424). For the owner, the `blocked` item's Done (the button,
`E`, the phone's swipe) is the task's own change to Done, `PATCH /api/v1/work/:id` with `status: done` against `blocked.version`, said as
everywhere ("#6 moved to Done"); the item is derived from the task's status, so it leaves. Undo is the same `PATCH` with `status: blocked`, the
blocker, `waitingFor` or `waitingOn` the item carried, and `restore: true` (the "done" line goes), so the item is back as it was. For the person
the task waits for (`blocked.waitedBy`), Done stays `POST /work/:id/waiting-done` (they are done, the task resumes). The queue's own `done` action
on a `blocked:<id>` key is no longer used by the web client.

Home (README §7): Continue never offers what the Inbox holds, so a task given to you is "Waiting for you" until you open it, and
"Pick up “…” · Jonas added it for you" only after that.

Replies, direct messages, the other assigned notices (a blocked task waiting for you is the `blocked` item; "can continue") and decisions to review stay notifications: they reach people where they
happen (a conversation, the Messages list, Tasks) and by push and email, and still open from their
`/inbox/:id` links. An agent waiting for your OK (`approval`, #1186) is also only a notification: the item is the run's own
(`assistant:<run>`), which its link opens (`/inbox?item=assistant:<run>`), and the notification is read once nothing of the run
waits. **Agent questions with ready-made answers (S14) have no contract yet**, so none are listed;
the `question` kind is for people's questions today.

The queue is what waits; it does not interrupt. What interrupts a person while Flux is open (the notice card), on
the tab and the badge, and by push is one table, by reason and level, in
[mobile and PWA](../product/mobile-pwa.md#while-flux-is-open-1243) (#1243).

Order: newest first, one list for every kind (founder decision, 2026-11-13, #1367; an item's time is when it was proposed, asked, blocked or noticed). At most 300 items, of which
at most 200 are decisions.

## Whom a question asks (personas-27, one rule)

One rule decides who is asked, and Home, Waiting for you, the Inbox, push and email all read it
(`asksStarter` and `mentions` in `app/packages/core/src/notifications/addressing.ts`):

- A message that names a person (`@Name`, or opening with "Name," / "Name:") and asks something (`isQuestion`) is a `question` for them.
- **Every question in a direct message between two people is for the other person**, with or without their name (founder decision
  2026-11-15, #1424 A): "When do I get my apron?" from Jonas to Ola is a `question` notification for Ola, so it is "Question · Jonas Berg"
  in her Inbox and on Home's Waiting for you, whatever her level for the conversation. Her next message there answers it (#1249) and reaches
  Jonas as a Reply (#1424 decision 1). In a group message only a question that names someone asks them; the rest are messages.
- **A question in a thread that names nobody with `@` is for the thread's starter** (the person who wrote its first message), unless
  the starter asked it. "Which size, small or large?" in Piotr's thread is Piotr's question: it is a `question` notification for him, so it is
  in his Inbox and on Home's Waiting for you, and Home's Continue never offers it again (#1424 "Nothing appears twice"). Nobody else in the thread
  is asked; they get the thread's reply as before (#1249). Home no longer treats such a question as asked of everyone who wrote there.
- **A person who joins later is asked too.** When someone joins a space (added to it, or by an invite link) or the company (its open spaces),
  the newest still-open question of the last 14 days that names them reaches them as one `question` notification, as if they had been there.
  Still open means nobody other than its author wrote in its thread after it, and they were not told of it already. An agent's line is never
  replayed (an agent tells only its owner, AG-4).

The starter's reply in the thread answers it (#1170), and the asker hears the answer (#1424 decision 1), as for any question that named them.

## One person accepts

Acceptance is **single-person** ([decision-authority.md](../product/decision-authority.md), DA-2): the first
person with write access who accepts decides; only its own Undo, by that person and while nothing rests on it, takes it back
([work and decisions](work-decisions.md#accept-at-once-and-undo-takes-it-back-1424-round-8), round 8). The card therefore does not
show "who has accepted". It shows `decision.accepters`: the people who can still accept it now, you first
(at most six), as "Waiting for you · Jonas can accept too": whose turn it is in words, you first, with no face of your own (persona
round 28: your face beside "waiting for you" read as that person waiting for you). Accepting takes the decision out of everyone's
queue.

## Who and where on every item (#1424)

Every item has `from` and `project` where it has them to give, so the Inbox draws one line "Kind · who · space" for every kind. A mention, a
question, a call or an invitation is read from a notification, which stores neither: the list read takes the actor of the event the
notification was made from (two batched reads, `listForRecipient(..., { from: true })`; no migration) and the space from its source. What a
mention or a question says is then its `title` (`detail` is empty) and a call's place is its title ("Call in Gesture lamp"); the notification's
own sentence stays on the notification (`/api/v1/inbox`, push, Notices). A message between two people has a sender and `project: null`; a group
message keeps its sentence, which names the group. A notification of an encrypted space has no words, so it keeps its sentence too.

## Done, Not now, Decline and Undo

`POST /api/v1/needs-you/:key` with `{ "action": "done" }`, `{ "action": "decline" }` or
`{ "action": "snooze", "until": <ISO time> }` or `{ "action": "snooze", "untilWorkId": <task id> }`; the keys
are `decision:<id>`, `blocked:<id>` and `note:<notification id>`. `DELETE /api/v1/needs-you/:key` undoes the
person's own choice (204; idempotent).

- The choice is **per person**, in `needs_you_states` (migration 0063). A decision stays proposed for others.
  "Decline for good" only removes it from the person's queue (the design's wording); the decision is not
  declined, because v0.1 has no way to reject one (DA-3).
- A snooze until a time is at least a minute and at most 60 days ahead. **Not now is one button with no menu**
  (README S11, #1367): the client sends the snooze until tomorrow at 08:00 local time. The API still accepts a snooze
  until a task is done (`untilWorkId`, the first unfinished task a decision affects or the first unfinished
  prerequisite of a blocked task; it ends when that task is done, set aside or gone) and a later time, but no screen offers them.
- Done on a mention or question also reads its notification; Undo unreads it. Nothing is deleted.
- **A call is not a question** (F-041, #1368). A call's notice (`reason: call`) and an invitation to a call (`reason: invitation`)
  are listed with `call: { projectId, sessionId }`, only while someone is in the call, and are named "Call" with Join. They leave the
  queue when the call ends, and when the person joins it: the join (`POST /api/v1/live-sessions/:id/join`) reads the person's notices
  and invitations of that session in the same transaction, so every tab's Inbox and Home lose it on their next read.
- **Answered where it was asked** (#1170): a person's reply in a conversation (`POST /api/v1/conversations/:id/messages`, or
  `POST /api/v1/work/:id/discussion` in a task's discussion) answers their unread `question` and `mention` notifications that open a
  message of that conversation. In the reply's transaction each is
  read and marked `done`, exactly as Done marks it, and the reply's answer names them (`answered`, `note:<id>` keys), so the
  composer says "Replied. Out of your Inbox" with Undo (the `DELETE` above). Opening the thread, someone else's reply and a retried
  send answer nothing. An agent's question card (S14) is answered with its own answers and stays. The same holds in a direct message
  (#1249): a message there that names the person is a `mention` or a `question` (source `dm`, URL `/dm/:id#message-…`), and their own
  message in that DM (`POST /api/v1/dms/:id/messages`, or a thread reply) answers the unread ones the same way and names them in `answered`.
- **An answer to your question reaches you** (founder decision 2026-11-14, #1424 decision 1). The rule that makes a message a
  `question` for the person it names also makes the answer a need for the one who asked: a person's message in a conversation of a
  space (a thread, a task's discussion), or in a direct message at the same level (its roots, or one thread), notifies the author of a
  message there that asked them (it names them and asks, `isQuestion`) and that came after their own last message there. The asker
  gets a `mention` (a `question` when the answer asks something back), titled "Marta answered you in Product" ("Marta answered you" between
  two people), which the queue lists with `answer: true` and the answer's words as its title. The generator records the fact on the
  notification itself (`notifications.answer`, migration 0084, set from the answer it found and never read from the words), so the item is a
  Reply in every space. It follows the asker's level, mute and
  quiet hours as any mention. Only the first message after the question answers it (the questions considered are the 20 newest messages
  of others since the author last wrote there); an agent's question card has no person to tell. The asker's own reply there takes it
  out as above (#1170). In an encrypted space the notice's title keeps its fixed words ("Marta mentioned you in Garden club", no body), and
  the item is a Reply all the same.
- A choice about a decision or a task that is no longer a need is forgotten, so the same task blocked again
  later asks again.
- `needs_you_states` rows cascade with the account.

**Undo of Accept is the client's** (`app/apps/web/src/notifications/pendingAccept.ts`): the card shows accepted
at once and sends the accept (`POST /api/v1/decisions/:id/accept` with `If-Match`) the moment its Undo toast leaves
(the design's one toast rule, #1424: its 10 s, ×, a newer toast, another place) or when the person leaves the page: hiding
the tab or closing it (with `keepalive`). Everyone else, the proposer first, sees it accepted as soon as it is sent: the accept
records `project.decision_accepted.v1` and every open view of the decision re-reads on that event. Undo inside the window never sends it. After it was sent, Undo says the
decision is accepted and that a change of direction is a new proposal. Done, Not now, Decline and Unblock are
real reversals through the calls above.

## Counts

`GET /api/v1/needs-you` returns `{ items, count, later, doneToday, notifying }`: `count` is what the sidebar, the phone's
tab bar and Home's "Needs you" badge show; `later` counts snoozed items, `doneToday` what was marked done or
declined in the last 24 hours and would come back if put back ("4 done today"): an item that is no longer a need (a task started
since, a notification older than 14 days) is not counted.

**The two lists** (founder decision 2026-11-15, #1424 E). `GET /api/v1/needs-you/aside` returns `{ later, done }`, each a list of
`{ item, state, until, untilTask, at }` with exactly the items the two counts count: `later` the snoozed ones, soonest back first, with
`until` (a time) or `untilTask` (the task it waits for); `done` the ones marked done or declined in the last 24 hours, newest first,
with `at` the time it was done. A done mention, question or task is listed although its notification is read. **Bring back now** and
**Put back** are `DELETE /api/v1/needs-you/:key`, the same Undo as above: the item is back in the queue at once (a done mention is
unread again). `notifying` (#1243) counts the unread notifications among the person's
newest 100 Inbox items that would notify them under their level; the tab title's "(N)", its favicon dot and the app
badge show it ([mobile and PWA](../product/mobile-pwa.md#while-flux-is-open-1243)).

## The Tasks views

The Tasks tab lists tasks only: its views take `kinds=work` (`GET …/work-view?purpose=tasks&kinds=work`), which
leaves decisions out of the "All" selection and its total. API readers without `kinds` still get
the whole mixed view. A decision's history stays in its own details, as plain sentences that appear only when they apply ("This replaces the decision …",
"This was replaced by the decision …", "Earlier reason", "Shown on the Wiki page …"). Old links to the Decisions view
(`/projects/:id/tasks?status=needs|rules`) open the Inbox; a
decision's own link (`/projects/:id?open=decision:<id>`, contracts `decisionAppPath`) opens the decision in the one panel over its space's
conversation, with its card there marked as the open one. That is the one place a decision opens from everywhere: the Inbox (its item's
`url` and its Open), Search, a notification with its push and email, a Wiki reference and Discuss. An older
`/projects/:id/tasks?open=decision:<id>` link (a bookmark) is sent there by the Tasks loader, so it is never a dead link.

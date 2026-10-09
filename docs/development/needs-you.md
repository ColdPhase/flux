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
| `question` | A person asked them something (`@name … ?`), or invited them to work together (#62) | their unread `question` and `invitation` notifications, newer than 14 days |
| `blocked` | A task they own that is blocked | `project_work_items` they own with status `blocked`, not parked |
| `mention` | Someone mentioned them | their unread `mention` notifications, newer than 14 days |

Replies, direct messages, assigned work and results to review stay notifications: they reach people where they
happen (a conversation, the Messages list, Tasks) and by push and email, and still open from their
`/inbox/:id` links. **Agent questions with ready-made answers (S14) have no contract yet**, so none are listed;
the `question` kind is for people's questions today.

Order: decisions, questions, blocked tasks, mentions; newest first within a kind. At most 300 items, of which
at most 200 are decisions.

## One person accepts

Acceptance is **single-person** ([decision-authority.md](../product/decision-authority.md), DA-2): the first
person with write access who accepts decides, and there is no un-accept (DA-3). The card therefore does not
show "who has accepted". It shows `decision.accepters`: the people who can still accept it now, you first
(at most six), as "waiting for you" and "Jonas can accept too". Accepting takes the decision out of everyone's
queue.

## Done, Not now, Decline and Undo

`POST /api/v1/needs-you/:key` with `{ "action": "done" }`, `{ "action": "decline" }` or
`{ "action": "snooze", "until": <ISO time> }` or `{ "action": "snooze", "untilWorkId": <task id> }`; the keys
are `decision:<id>`, `blocked:<id>` and `note:<notification id>`. `DELETE /api/v1/needs-you/:key` undoes the
person's own choice (204; idempotent).

- The choice is **per person**, in `needs_you_states` (migration 0063). A decision stays proposed for others.
  "Decline for good" only removes it from the person's queue (the design's wording); the decision is not
  declined, because v0.1 has no way to reject one (DA-3).
- A snooze until a time is at least a minute and at most 60 days ahead (the client offers tomorrow at 08:00 and
  next Monday at 08:00 local time). A snooze until a task is done is offered only for the task the item names:
  the first unfinished task a decision affects, or the first unfinished prerequisite of a blocked task. It ends
  when that task is done, set aside or gone.
- Done on a mention or question also reads its notification; Undo unreads it. Nothing is deleted.
- A choice about a decision or a task that is no longer a need is forgotten, so the same task blocked again
  later asks again.
- `needs_you_states` rows cascade with the account.

**Undo of Accept is the client's** (`app/apps/web/src/notifications/pendingAccept.ts`): the card shows accepted
at once and sends the accept (`POST /api/v1/decisions/:id/accept` with `If-Match`) when the 6 second Undo
window ends or when the person leaves the place: any navigation away from the Inbox or Home, hiding the tab
or closing it (with `keepalive`). Undo inside the window never sends it. After it was sent, Undo says the
decision is accepted and that a change of direction is a new proposal. Done, Not now, Decline and Unblock are
real reversals through the calls above.

## Counts

`GET /api/v1/needs-you` returns `{ items, count, later, doneToday }`: `count` is what the sidebar, the phone's
tab bar and Home's "Needs you" badge show; `later` counts snoozed items, `doneToday` what was marked done or
declined in the last 24 hours ("4 done today").

## The Tasks views

The Tasks tab lists tasks only: its views take `kinds=work` (`GET …/work-view?purpose=tasks&kinds=work`), which
leaves decisions and results out of the "All" selection and its total. API readers without `kinds` still get
the whole mixed view. A decision's history stays in its own details ("Would replace", "Replaced", "Replaced
by", "Earlier reason"); a result shows in its task's details. Old links to the Decisions view
(`/projects/:id/tasks?status=needs|rules`) open the Inbox's Decisions filter (`/inbox?show=decisions`); a
decision's own link (`?open=decision:<id>`) opens the decision.

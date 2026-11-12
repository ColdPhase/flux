# Return view: "Since you left" (issue #106)

Foundation 8.8, pillar F5, the #44 "Return and pivot" contract (the pivot's parking of tasks went in #871) and the
[final design](../design/final/README.md#5-behaviour) rule S7 ("Since you left"): one
slim "N updates since …" line that expands into a short list in human language. There is no
guilt here: no streaks, no forced clearing, no rail badges. At most one next step is shown,
always with its reason.

## Amended by #865 (v0.2, 2026-11)

The Inbox is the one place that lists what needs the person ([#865](https://github.com/ColdPhase/flux/issues/865), answer 2 of
#861). The web app therefore has **no "Since you left" line over a conversation, no "What matters" recap and no header
"N needs you"**; the sections below describe them as they were built. What stays is the return point itself: Home's
"Continue where you left off" row (the summary's `nextStep`, or the task in progress), the conversation's quiet "New"
divider above the first new item (see [Where the person left off](#where-the-person-left-off-1246)) (the stream still reads the project summary when it opens and saves the point when
the person leaves it), and the new-activity dot on a space in the sidebar. The summary's `scope`, `from`, `until`, `digest`
and `history` parameters, `ReturnDigest`, `ReturnScope` and `ReturnPeriod` were used only by the recap and are gone from the
API (#962): `GET /api/v1/return` takes a place and always starts at the saved return point, and a request that still sends
one of them gets the plain summary, as the server does not read them. `GET /api/v1/workspaces/:workspaceId/docs` (the workspace-wide Wiki) and `ProjectWorkSummary.state`, which
only the recap's "Now" read, went with them; nothing in the web app, the MCP tools or the local clients read any of the three.

## Return points

`return_points` (migration `0009_return_points.sql`, introduced at schema version 9) keeps one row per
person and place: `home`, `project:<id>` or `conversation:<id>`. A point is a position in the
person's **own** `event_audience` rows (an event `seq`). It is never sent to clients. Project and
conversation points are deleted with their place.

- **Visiting acknowledges nothing (HOME-1, #190; amends #106 AC-1).** Home reads the summary and
  never moves its point. The summary's opaque `mark` (the id of the reader's last audience row when the
  summary was built) is saved by "I have the context" in a project's What matters (#133) and, since #342,
  by following Home's "Continue where you left off" card (its next step is this summary's `nextStep`;
  the list itself left Home with the final design). A reload, a glance on the phone or leaving Home keeps
  the card. The one automatic save is the first visit to a place with no point
  (`point.savedAt === null`): nothing was shown, so it saves a starting point at the mark.
- **Saving.** The server accepts only a mark that is one of the caller's own audience rows. Saving
  is forward-only: an older mark never moves the point back. `POST /api/v1/return-points/restore`
  ("Keep these for next time") stays in the API for compatibility; the web app no longer calls it.
- **Places interact.** "I have the context" in a project removes that project's items from Home,
  because Home uses the maximum of the points below. Acknowledging Home moves the start of every
  project never opened, since such a project starts from Home's point.
- **Nested places.** A change that has already been seen in a narrower place does not come back
  in a wider one. Home uses the maximum of the Home, project and conversation points. A project
  uses the maximum of the project and conversation points. A place that was never viewed starts
  from the enclosing place's point (a project from Home). On Home with no point, the summary is
  empty and viewing creates the point. A project or conversation with neither its own nor the
  enclosing point starts from its beginning (`since: null`, #133).

## Since you left in the project conversation (S7, #763 A3, 2026-10-30)

The project conversation's "Since you left: …" line (S7) counts from when the person last **left that conversation**.
The #763 audit (A3) found the line never appeared: a project point was saved only by "I have the context", so ordinary
visits never had one. Now the stream reads the project summary when it opens and, when the person leaves it for another
view or place inside the app, saves the project's return point at a summary read at that moment (forward-only, the
caller's own mark). A closed tab or a reload saves nothing, so its changes still count next time: never fewer than were
missed. The line jumps to the first unread item and the stream draws a quiet "New" divider above it (it was "Unread" until #1246). This amends
the What matters rule below: leaving the conversation moves the project's point as well, so its default `last-visit`
period also means "since you left"; `24h` and `7d` are unchanged.

## Summary

`GET /api/v1/return?place=home|project|conversation&id=` returns `ReturnSummary`
(`app/packages/contracts/src/returns.ts`). It is built in `app/packages/core/src/returns/service.ts`:

1. Read the reader's own audience rows after the point, newest first, in pages of 400 by primary
   key. Scanning stops at the end, once 400 visible changes are kept, or after 8,000 rows.
   `more` is true only when more visible items exist than are shown (40) or the visible limit
   was reached. Rows that are hidden now never set it, and a reader whose hidden rows fill whole
   pages gets the same response as one who never had them (tested).
2. Drop the reader's own changes, and anything that is not about this place.
3. **Final check**, as the stream does at delivery: `authorizeEvent` for every event object now.
   On Home, each project must also pass the policy's list filter (`visibleFilter`). Revoked
   places therefore disappear, and counts, `more` and the next step never reflect anything the
   reader cannot currently see.
4. Group by the object the event names and join to its **current** state, in the event's own
   project. Events carry identifiers only. Since #106, conversation and material events carry
   `{ conversationId, messageId }` and `{ materialId, version }`; see
   [conversations](conversations.md#authorized-project-refresh-events-36--47). Messages recorded
   earlier have no ids, so they cannot link to a source and are left out.
   **A decision that replaces another moves no task (#871).** Accepting it marks the earlier decision replaced and
   nothing else: no task is parked or set aside, so the summary joins no work to an acceptance. (Until #871, a pivot
   parked work and the summary told it as "Parked: …"; that path is gone.)

| Kind | Text (examples) | Needs you |
| --- | --- | --- |
| decision | "Decision changed: …" with "Previously: …"; "New decision: …"; "Proposed decision: …"; "Decision replaced: …". A decision made and replaced in the same absence is told once, by its replacement. | A proposal by someone else in a project you can write. |
| work | "Ari added a task for you: …", "Ari gave you a task: …" (handed to you in the period, #763 H11-5; a work item carries the task's `dueOn`), "Blocked: …", "Done: …", "Dropped: …", "In progress: …". | Unfinished work you own. |
| question | "Ari asked you: “…”" when a message addresses you (`@Name`, or starts with "Name," / "Name:"), or asks a question in a conversation you started or posted in. | Until you post in that conversation after it. |
| message | "Ari and Kai replied in “…”", grouped per conversation, opening on the first new message. A task thread opened by a saved blocker or a public handoff (#154) is an ordinary conversation here: its opening is announced beside the blocked-work item it came from. | Never. |
| material | "New material: …", "Updated material: …, now version N". | Never. |
| sketch | "Ari started a sketch: …", "Sketch changed: …" (project sketches; private ones reach only their author). | Never. |
| doc | "Ari started a doc: …" (with its reason), "Doc updated: …" with "Version N by Ari · latest: <reason>" or "2 new versions by …" ([#112](docs-wiki.md)). The source opens the doc, or its history comparing the last version before these changes with the current one. | Never. |

A missing explanation is said plainly: "No reason was recorded." for a rule or a blocker.
Every item has a `source`: a message, material version,
doc (with `since`, the version before the changes), sketch, or a work item or decision, which the client opens in Details on its project.

**Next step.** One step is derived from the items that need you, in this order: a question
addressed to you, a question in your conversation, a task that became
yours in the period (made for you or handed to you by someone else, #763 H11-5), a rule waiting for
a person, blocked work of yours, and other work of yours. A step about a task carries its `dueOn`,
which the client says as "Due 4 Nov 2026" on Home's card, in What matters and in its list. Examples: "Answer Ari's question"
(reason: "Ari asked you in “…”."), "Decide on the proposed decision" (reason: "Ari proposed “…”. You can accept it."). When nothing needs you, there is no step.

## What matters: the private project recap (#133), removed

The recap and its query options (`scope`, `from`, `until`, `digest`, `history`) were removed with the recap's panel (#865, #962). What
stays of #133 is the rule that "I have the context" is the only thing that moves a project's return point: leaving the project
conversation does too (#763 A3, above), and reading never does.

## Structure

- `app/packages/contracts/src/returns.ts`: wire types and paths.
- `app/packages/core/src/returns/`: the ports `ReturnAccess` and `ReturnRepository` and the use cases.
  They import no Drizzle or `@flux/db`.
- `app/packages/db/src/repositories/returns.ts`: rows only, no access decisions.
- `app/apps/server/src/returns/`: the policy adapter (`authorizeEvent`, `evaluateProject`,
  `authorize`, `visibleFilter`) and the routes. No architecture allowlist entries were added.
- `app/apps/web/src/returns/`: `api.ts` (the summary, the point and where a source opens) and `SourceLink` (Home's
  "Continue where you left off" row). A source link to a message opens on that whole message (`#message-<id>`). Only the current request's authorized answer is ever shown: the
  client keeps no return-view state between mounts, accounts or visits, so a revoked item or
  another account's item never appears, even before a fresh answer arrives (tested in Playwright
  with the API held back across a same-tab sign-out and sign-in).

## Tests

`app/tests/app/returns.test.ts` covers the API with two people and an outsider: the return point,
the grouping and sources, the next step and how it changes when the question is answered,
forward-only saving and restore, revoked access, and a restricted project leaking nothing (no
items, ids, names or counts). It also covers a replacing decision (#871): the reader is told "Decision changed: …" and no task is
told as set aside, nothing of a space the reader cannot read, nothing after access is revoked, and a plain acceptance is only a "New decision: …".
It also covers that the removed recap parameters are not read: a request that still sends them gets the plain summary (#962).
`app/tests/ui/test_return_view.py` (Playwright) covers Home's "Continue where you left off" (a reload keeps the
row, following it moves Home's point, the first visit's starting point), leaving a conversation saving the project's point,
matched viewports, and that another account's or a revoked person's items never show. The recap panel's browser tests
left with it (#865). Screenshots: [`docs/design/return-view/`](../design/return-view/) (earlier renders of the recap).

## Where the person left off (#1246)

Opening a conversation puts the reader where they left off, in every surface that reads a feed of messages: the space's stream, a direct message,
a thread, a task's discussion and an agent's chat. It is one behaviour (`app/apps/web/src/app/unreadReading.tsx`) and the final design's rule S23:
a quiet "New" divider above the first new message and an opening scroll to it (the end when nothing is new), and "↓ N new" while the reader is
above the end, which a click, a tap or End takes to the end. The behaviour makes no request of its own. Each surface says which message is the
first new one from the read it already makes, and nothing new is written:

| Surface | First new message | From |
| --- | --- | --- |
| A space's stream | the first change after the return point (a message, a task announcement or a decision) | `GET /api/v1/return` (unchanged) |
| A direct message | the first message by someone else after the newest root the person observed | `Dm.unreadFrom` |
| A DM's thread | the first reply by someone else after the newest reply they observed | `DmThread.unreadFrom` |
| A project thread, a task's discussion | the first message by someone else after the newest one they observed in that conversation | `Conversation.unreadFrom` |
| An agent's chat | the first answer or line of the agent after `readAt`, when the owner last had the chat open | `GET /api/v1/agent-chats/:agentId/messages` (`readAt`) |

`unreadFrom` (`UnreadFrom` in `@flux/contracts`) comes from the viewing receipts of #534: a message is observed when its reader has had at least 60 %
of it in view for 700 ms (`POST …/observations`), and that existing write is the whole read state. A message by the person themselves, a removed
message and a DM's "used AI here" line never count. It is a string (the id the divider stands above), `null` (everything up to the newest was observed) or
absent (nothing in that conversation was observed yet, so nothing says where the person left off and it opens as it always did). The value is
read when the conversation opens and kept for as long as it stays open: what is seen meanwhile does not move the divider. A first new message older
than the newest window is read back to with the same paging a link to a message uses (a direct message and a project thread do; a DM's thread
and a space's stream do not, and then open as they always did, without a divider).

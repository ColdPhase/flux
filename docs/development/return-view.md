# Return view: "Since you left" (issue #106)

Foundation 8.8, pillar F5, the #44 "Return and pivot" contract and direction C (`#since` in the
[variant C prototype](../design/proposals/o-003-ui-direction/variant-c-calm-messenger.html)): one
slim "N updates since …" line that expands into a short list in human language. There is no
guilt here: no streaks, no forced clearing, no rail badges. At most one next step is shown,
always with its reason.

## Return points

`return_points` (migration `0009_return_points.sql`, `FLUX_SCHEMA_VERSION` 9) keeps one row per
person and place: `home`, `project:<id>` or `conversation:<id>`. A point is a position in the
person's **own** `event_audience` rows (an event `seq`). It is never sent to clients. Project and
conversation points are deleted with their place.

- **Set when the person views the place.** The client reads the summary and then saves the
  summary's opaque `mark` (the id of the reader's last audience row when the summary was built).
  The server accepts only a mark that is one of the caller's own audience rows. Saving is
  forward-only: an older mark never moves the point back.
- **Moving back is optional.** "Keep these for next time" (`POST /api/v1/return-points/restore`)
  moves the point back to the one it replaced. A point first created in the undone visit is
  removed, so the place counts as unviewed again. The project line restores both the project
  point and the conversation point it saved.
- **Nested places.** A change that has already been seen in a narrower place does not come back
  in a wider one. Home uses the maximum of the Home, project and conversation points. A project
  uses the maximum of the project and conversation points. A place that was never viewed starts
  from the enclosing place's point (a project from Home). With no point at all, the summary is
  empty and viewing creates the point.

## Summary

`GET /api/v1/return?place=home|project|conversation&id=` returns `ReturnSummary`
(`packages/contracts/src/returns.ts`). It is built in `packages/core/src/returns/service.ts`:

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

| Kind | Text (examples) | Needs you |
| --- | --- | --- |
| decision | "Current rule changed: …" with "Previously: …"; "New rule: …"; "Proposed rule: …"; "Rule replaced: …". A rule made and replaced in the same absence is told once, by its replacement. | A proposal by someone else in a project you can write. |
| result | "Ari recorded a result: …", "It did not work out, about “…”". | It is about work you own or created. |
| work | "Ari added a task for you: …", "Blocked: …", "Parked: …" (with the rule that set it aside), "Done: …", "In progress: …". | Unfinished, unparked work you own. |
| question | "Ari asked you: “…”" when a message addresses you (`@Name`, or starts with "Name," / "Name:"), or asks a question in a conversation you started or posted in. | Until you post in that conversation after it. |
| message | "Ari and Kai replied in “…”", grouped per conversation, opening on the first new message. | Never. |
| material | "New material: …", "Updated material: …, now version N". | Never. |
| sketch | "Ari started a sketch: …", "Sketch changed: …" (project sketches; private ones reach only their author). | Never. |

A missing explanation is said plainly: "No reason was recorded." for a rule or a blocker, and
"No evidence was recorded." for a result. Every item has a `source`: a message, material version,
sketch, or a work item, decision or result, which the client opens in Details on its project.

**Next step.** One step is derived from the items that need you, in this order: a question
addressed to you, a question in your conversation, a result about your work, a rule waiting for
a person, blocked work of yours, and other work of yours. Examples: "Answer Ari's question"
(reason: "Ari asked you in “…”."), "Review the result Ari attached" (reason: "It reports on
“…”, which is yours."). When nothing needs you, there is no step.

## Structure

- `packages/contracts/src/returns.ts`: wire types and paths.
- `packages/core/src/returns/`: the ports `ReturnAccess` and `ReturnRepository` and the use cases.
  They import no Drizzle or `@flux/db`.
- `packages/db/src/repositories/returns.ts`: rows only, no access decisions.
- `apps/server/src/returns/`: the policy adapter (`authorizeEvent`, `evaluateProject`,
  `authorize`, `visibleFilter`) and the routes. No architecture allowlist entries were added.
- `apps/web/src/returns/`: `SinceYouLeftHome` (on Home, grouped by place) and `SinceYouLeftLine`
  (above the project conversation; it collapses to one 44 px row on the phone and expands with
  the grid-rows transition from the tokens). A source link to a message opens on that whole
  message (`#message-<id>`). A tab keeps what it showed during a visit, so returning to a place
  after opening a source shows the same list. A reload starts a new visit.

## Tests

`tests/app/returns.test.ts` covers the API with two people and an outsider: the return point,
the grouping and sources, the next step and how it changes when the question is answered,
forward-only saving and restore, revoked access, and a restricted project leaking nothing (no
items, ids, names or counts). `tests/ui/test_return_view.py` (Playwright) covers returning after
changes on Home and on the project, keyboard expansion, opening a decision and a message source,
"Keep these for next time", and the phone layout (44 px targets, no horizontal scroll). It also
covers navigation from Home's next step to the message, the composer's audience line, and a
phone reply sent from the composer. Playwright does not show a real software keyboard, so real
iOS and Android keyboards remain unverified. The next step is not repeated in the list, and the
list shows whole rows, six at first, then "Show N more". Screenshots:
[`docs/design/return-view/`](../design/return-view/). `matched-*` are the same state at
1440×900, 1280×800 and 390×844 at 100% zoom; `return-*` are the journey states.

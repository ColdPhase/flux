# Return view: "Since you left" (issue #106)

Foundation 8.8, pillar F5, the #44 "Return and pivot" contract and direction C (`#since` in the
[variant C prototype](../design/proposals/o-003-ui-direction/variant-c-calm-messenger.html)): one
slim "N updates since …" line that expands into a short list in human language. There is no
guilt here: no streaks, no forced clearing, no rail badges. At most one next step is shown,
always with its reason.

## Return points

`return_points` (migration `0009_return_points.sql`, introduced at schema version 9) keeps one row per
person and place: `home`, `project:<id>` or `conversation:<id>`. A point is a position in the
person's **own** `event_audience` rows (an event `seq`). It is never sent to clients. Project and
conversation points are deleted with their place.

- **Visiting acknowledges nothing (HOME-1, #190; amends #106 AC-1).** Home reads the summary and
  never moves its point. "I have the context" at the end of Home's "Since you left" saves the
  summary's opaque `mark` (the id of the reader's last audience row when the summary was built),
  as a project's What matters does (#133). A reload, a glance on the phone or leaving Home keeps
  the list. The one automatic save is the first visit to a place with no point
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

| Kind | Text (examples) | Needs you |
| --- | --- | --- |
| decision | "Current rule changed: …" with "Previously: …"; "New rule: …"; "Proposed rule: …"; "Rule replaced: …". A rule made and replaced in the same absence is told once, by its replacement. | A proposal by someone else in a project you can write. |
| result | "Ari recorded a result: …", "It did not work out, about “…”". | It is about work you own or created. |
| work | "Ari added a task for you: …", "Blocked: …", "Parked: …" (with the rule that set it aside), "Done: …", "In progress: …". | Unfinished, unparked work you own. |
| question | "Ari asked you: “…”" when a message addresses you (`@Name`, or starts with "Name," / "Name:"), or asks a question in a conversation you started or posted in. | Until you post in that conversation after it. |
| message | "Ari and Kai replied in “…”", grouped per conversation, opening on the first new message. A task thread opened by a saved blocker, a published result or a public handoff (#154) is an ordinary conversation here: its opening is announced beside the result or blocked-work item it came from. | Never. |
| material | "New material: …", "Updated material: …, now version N". | Never. |
| sketch | "Ari started a sketch: …", "Sketch changed: …" (project sketches; private ones reach only their author). | Never. |
| doc | "Ari started a doc: …" (with its reason), "Doc updated: …" with "Version N by Ari · latest: <reason>" or "2 new versions by …" ([#112](docs-wiki.md)). The source opens the doc, or its history comparing the last version before these changes with the current one. | Never. |

A missing explanation is said plainly: "No reason was recorded." for a rule or a blocker, and
"No evidence was recorded." for a result. Every item has a `source`: a message, material version,
doc (with `since`, the version before the changes), sketch, or a work item, decision or result, which the client opens in Details on its project.

**Next step.** One step is derived from the items that need you, in this order: a question
addressed to you, a question in your conversation, a result about your work, a rule waiting for
a person, blocked work of yours, and other work of yours. Examples: "Answer Ari's question"
(reason: "Ari asked you in “…”."), "Review the result Ari attached" (reason: "It reports on
“…”, which is yours."). When nothing needs you, there is no step.

## What matters: the private project recap (#133)

Accepted by the evaluator on [#133](https://github.com/ColdPhase/flux/issues/133#issuecomment-5901555136)
(2026-09-30). It replaces the project's slim line with one compact **What matters** entry beside
Details (a quiet count of `needsYou`), which opens a private view of the Details panel.

- **Only "I have the context" moves a project's return point**, to the mark of the snapshot shown.
  Opening, reading, closing, choosing a scope or period and opening sources never move it. Chat
  read markers and Home's behaviour are independent of it.
- **Interface (additive; a call without the new parameters behaves as before):**
  `GET /api/v1/return?place=…&id=…` with optional
  - `scope=all|mine` (default `all`): `mine` keeps what needs you, your work (owned or created),
    decisions you proposed or must decide, results about your work, and conversations you started
    or wrote in;
  - `from=last-visit|24h|7d` (default `last-visit`): a period starts at the reader's last audience
    row at or before `now − period`, ignores the return point and never moves it;
  - `until=<mark>`: keeps one snapshot; only rows up to that mark are read and `mark` is echoed;
  - `digest=1`: adds `ReturnDigest`, the latest three whole messages of up to eight recently
    active conversations (with how many more) and the recorded results, in the same scope.

  The response adds `scope`, `period` and `since`. Unknown values are 400; a mark that is not the
  reader's own is `INVALID_MARK`.
- **One fixed mark per panel visit** across scope, period and digest requests. Newer changes are
  announced ("Newer changes arrived … Show them") and never merged into the list being read.
- **Every source is authorized for the current reader** by the same final check as the summary;
  nothing is posted, notified or recorded as a shared event. There is no model: the digest quotes
  messages.
- **Client races:** requests are keyed by account, project, scope, period and digest, and a late
  answer for another key is dropped. A source opened from an overlaid panel or phone sheet closes
  it; reopening restores the same snapshot, choices, digest and scroll from memory only and asks
  the server again, so access changes apply.

## Structure

- `app/packages/contracts/src/returns.ts`: wire types and paths.
- `app/packages/core/src/returns/`: the ports `ReturnAccess` and `ReturnRepository` and the use cases.
  They import no Drizzle or `@flux/db`.
- `app/packages/db/src/repositories/returns.ts`: rows only, no access decisions.
- `app/apps/server/src/returns/`: the policy adapter (`authorizeEvent`, `evaluateProject`,
  `authorize`, `visibleFilter`) and the routes. No architecture allowlist entries were added.
- `app/apps/web/src/returns/`: `SinceYouLeftHome` (on Home, grouped by place, with "Caught up to …"
  and "I have the context"; afterwards one status line, "You're caught up. New changes will show
  here.", takes focus) and `WhatMatters` (a project's recap, #133). A source link to a message opens on that whole
  message (`#message-<id>`). Only the current request's authorized answer is ever shown: the
  client keeps no return-view state between mounts, accounts or visits, so a revoked item or
  another account's item never appears, even before a fresh answer arrives (tested in Playwright
  with the API held back across a same-tab sign-out and sign-in).

## Tests

`app/tests/app/returns.test.ts` covers the API with two people and an outsider: the return point,
the grouping and sources, the next step and how it changes when the question is answered,
forward-only saving and restore, revoked access, and a restricted project leaking nothing (no
items, ids, names or counts). `app/tests/app/return-recap.test.ts` covers #133's scope, period, `until` snapshot, digest, privacy
(per person, no shared event, outsider and revoked 404) and refused parameters.
`app/tests/ui/test_return_view.py` (Playwright) covers Home's return view (a reload keeps the list,
only "I have the context" clears it, a project's acknowledgement removes its items from Home, the
first visit's starting point), and in projects the What
matters panel: the compact entry and count, scope and digest, sources (a decision in Details and
back to the same snapshot, a message at the whole message), "I have the context" as the only
point change, newer changes announced, empty and 7-day states, a late answer for the old scope
dropped, a failed load with Try again, a project without messages, matched viewports with the
footer reachable, tablet and dark renders, and the phone sheet (44 px targets, source then
restore, 125 % text, focus return). Playwright does not show a real software keyboard, so real
iOS and Android keyboards remain unverified. Screenshots:
[`docs/design/return-view/`](../design/return-view/). `matched-*` are the same state at
1440×900, 1280×800 and 390×844 at 100% zoom; `return-*` are the journey states.

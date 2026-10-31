# Return to where I was (issue #592)

Founder direction by Hubert, 2026-10-17: following a reference inside Flux (a wiki card, a task or decision chip, a
cited message, a search result, an Inbox item, a ⌘K result, an agent link) must never cost the person their place.
Every opened reference shows one quiet "‹ <where I came from>" control, and going back restores the same route,
filters, open thread or panel, reading position and unsent draft. This page is the contract for that; the code is
in `app/apps/web/src/place/`. It extends [Spokój](../design/spokoj/README.md) rule 7 (a control never changes place)
and complements the [Since you left return view](return-view.md) (which is about what changed, not about place) and
the [thread reading-position owner](thread-reading-position-2026-10-16.md), which it reuses.

## Decisions

1. **The origin lives in `history.state` and nowhere else.** Following a reference pushes one history entry whose
   router state is `{ origin: { key, path, label } }`: the router key of the entry it was followed from, its address (to
   return to when there is no earlier entry to step back to), and its name for the control. It is never added to the
   address and never sent to the server, so there is **no API or persistence path** for it. A sidebar link, a tab, a
   fresh URL or a new tab has no origin and shows no control. The state survives reload (the browser keeps it with the
   entry), so reload on the destination keeps the control's target.
2. **Push for a reference, replace for a panel.** A reference to another page is one history entry; Back returns one
   step and Forward leads to the object again. Opening and closing panels and threads keeps today's replace semantics,
   so Back does not walk through panel toggles. A panel's state is part of the *place* of the entry (below), not an
   entry of its own. Every `replace` on a page a reference leads to carries the entry's state, because a replace with no
   state sets `history.state.usr` to null and the control would vanish while the person is still there: the address
   cleaners (`?open=`, `?compose=`, `?ask=`, the Inbox redirect, Cancel on a slow route), the Search page's typing and
   filters, the Agents view's thread and agent panel, a direct-message thread replacing a thread, the Inbox's review
   close, the Tasks `?new=` cleaner, a saved doc and a live session's redirect. A loader redirect that would drop state
   is a `<Navigate>` instead (a material that is a doc). A new `replace` on such a page must carry `location.state`.
3. **The place of an entry is kept under the entry's router key.** `place/memory.ts` holds small JSON records in
   session storage (and memory), written as the person reads (scroll, panel, filter) and flushed as a reference is
   followed. A record is used only for the same path it was kept for. Nothing is kept for more than the latest 60
   entries of a tab. Records are held in memory at once and written to storage 250 ms later (and when the page is hidden
   or a reference is followed), so scrolling never waits on storage; a message loaded only to show in Details is not
   written. **Nothing private is kept:** a panel view is kept as ids only (a task, decision, result, overview, recap or
   people view; an overview names its message by id and reads it again). A message's text, a thought's text and the fields
   of a form (Propose a decision, Attach a result, Add to docs, Make it a project) are never written, and a form view is
   not restored (the panel returns closed). A confirmed sign-out here, or in another tab (the draft retirement), forgets
   every `flux:place:*` record, the in-memory records and the caches below (`forgetPlaces`). The first entry of every
   document has the router key `default`, so a record is also checked against its page and only a return after the
   first screen restores. The last search answer and the last Inbox list are kept in memory only, per person, and are shown at once on
   a return while they are read again (no empty list or spinner first); they are never stored.
4. **Only a return restores.** Back, Forward, Alt+←, the phone's back gesture and the control are all a router POP (the
   control steps back one entry; with no earlier entry it navigates to the origin's address carrying the key to restore).
   A first visit, a link and a reload open every screen as it always opens. Each screen reads its record once, when it
   mounts at an entry it is returning to.
5. **No second scroll writer.** The place is restored by the owners that already exist: the stream's own anchor
   (`ConversationStream`: the first entry in view and its offset, read back through `useConversationRoots` when it is
   older than the newest window), the thread's `useMessageReadingPosition` (seeded with the kept anchor, so its own
   restoring puts the message back at the same offset even when new messages arrived), `useWorkReadingPosition` for
   the Tasks board and list, and one generic `.pane-scroll` tracker in the shell for Search, the Inbox, a wiki page and
   the pages that read. A direct message's feed and its private thread use the same `useMessageReadingPosition` (kept
   under their own slots, `dm-stream` and `dm-thread:<root>`): the first message in view and its offset come back when
   that message is loaded, read back through the older pages when it is older than the newest window (`useReturnPlace`;
   the feed waits, unseen, meanwhile), also when messages arrived while the person was away; a reader who was at the
   end opens at the latest as always, and a message that never loads is given up after 6 s for that opening. An anchor that is gone (a deleted message) falls back to the screen's usual opening, never an
   error. What the layout does after a reference was followed (a progress line pushing the feed down, a pointer-aimed
   message) is not where the reader was: the owner keeps the anchor it wrote as the reference was followed, until the
   reader's own input or 3 s.
6. **The panel keeps its one back (#488, Spokój rules 2 and 5).** The one panel (a task, a decision, a thread, an agent)
   already leads back one step at a time: an object opened from inside it replaces its content and leaves "‹ Task #1",
   "‹ Thread". That is the only back inside the panel; there is no second origin control or stack there. An object opened
   over a page from a chip leaves the page beside it (or under the sheet): closing the panel is the way back. A thread
   that an object covered and the panel then shows again is mounted again, so it reads its kept place and its draft
   (a remount within one history entry restores; a reload does not). The panel's object, its trail, its scroll and the
   sheet's height belong to the entry's place: Back to a page restores them. A thread or an agent a view owns is kept by
   its own route, and an object that was opened over such a thread is not reopened over it: the thread shows. **A panel
   kept over the page that a link inside it led to** (a task's source message opens the thread in the panel on a
   tablet or phone, a sheet or an overlay) steps back to the page it was followed from, where its panel returns as it
   was: its "‹ Task #31" is that visible step (history back), not a navigation to the conversation.
   **A panel does not follow the person to another place (#763 H11-8).** Going to another project, direct message or
   page (Inbox, Your tasks, Home) by any path but a link that keeps the panel closes a docked panel that shows an object
   or a form, and drops its trail; Details there opens on the new place. Moving between the views of one project
   (Conversation, Tasks, Map, Wiki, Agents) keeps it. Back to the earlier page restores it as above. A link from another
   place to a project's task, decision or result opens it there on arrival (`?open=`).

## Where the control sits (rule 7)

- **Computer and tablet:** first in the header row of an opened page, in front of the title, at the same x and y on
  every destination. It is absent, not hidden, when there is no origin, so a page reached from the sidebar looks as it
  does today. The title and the view tabs that follow it keep their order.
- **Phone:** it takes the place of the round Back (or heads the title row on a screen that has none): one control in
  one place. The panel's own "‹ back" (above) is a different thing: a step inside the panel. One case joins them: a page whose
  panel is a sheet or an overlay (a thread, an agent or a direct-message thread a reference led to, below 980 px) has the
  header covered, so that panel's back (`OwnedPanel.back`, the one back pattern) names the origin and goes to it; a docked
  panel leaves the header free and shows only the header control.
- The label is the origin's name, truncated at 16 rem; the accessible name is "Back to <name>". It is a 32 px target
  (44 px on touch).

## Access (AC-3)

The control is hidden when its origin is no longer accessible: a project that left the shell's list or answers 401,
403 or 404 to one read, a material that answers 401, 403 or 404 to one read (a material's address has no project, so
the read is of the material), or a direct message that left the person's list. Back to such a place lands on its
nearest parent the person can open, with one line in a toast, never an error page: inside a project the router
answers 403 or 404 and the person lands on the project's conversation, else the project list; a material (its project
can no longer be read) lands on the project list; a direct message (`/dm/<id>`, which answers 404 inside its page)
lands on the list of conversations, `/dm`. This applies only to a return inside the running app (a pop after the first
screen, or the control with no earlier entry); opening such an address directly or reloading it keeps the ordinary
"isn’t available" page.

## Verification

`app/tests/ui/test_return_to_origin.py` (Chromium and WebKit; 1440 × 900, 820 × 1180 and 390 × 844 with the display
mode reported as standalone): the five journeys of the issue (a conversation scrolled up → wiki card; a thread →
task chip → the panel's back; Tasks with a filter and an open panel → linked decision → the panel's back and a source
page; search → result; Inbox → item), each asserting the route, the open panel or thread, the visible anchor message
and the draft (or the filter, selection and query where a page has no composer), plus the control's place, history
(one entry, Back one step, Forward again, reload keeps the target), and a revoked origin (a project, a material whose
grant was revoked, a direct message that was left), and a direct message's feed and thread that come back to an
older message (read back through the older pages) with newer ones below. Browser Back is driven
with `go_back`; Alt+← and the phone gesture are the same router POP and are not separately scripted.

Not decided here and left as it was: restoring scroll inside every nested scroller (the Map canvas, the live editor),
and the Details panel's unsent form fields (a proposal in progress), which keep their own recovery.

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
   entry of its own. Every `replace` that only cleans the address (`?open=`, `?compose=`, `?ask=`, the Inbox redirect,
   Cancel on a slow route) carries the entry's state, and a loader redirect that would drop state is a `<Navigate>`
   instead (a material that is a doc).
3. **The place of an entry is kept under the entry's router key.** `place/memory.ts` holds small JSON records in
   session storage (and memory), written as the person reads (scroll, panel, filter) and flushed as a reference is
   followed. A record is used only for the same path it was kept for. Nothing is kept for more than the latest 60
   entries of a tab. Records are held in memory at once and written to storage 250 ms later (and when the page is hidden
   or a reference is followed), so scrolling never waits on storage; a message loaded only to show in Details is not
   written. The last search answer and the last Inbox list are kept in memory only, per person, and are shown at once on
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
   the pages that read. Panels keep their own body scroll. An anchor that is gone (a deleted message) falls back to
   the screen's usual opening, never an error.
6. **A panel object's way back is the same control.** An object opened in Details from a page leads back to that page
   ("‹ Conversation", "‹ Thread", "‹ #12 Order sensors"); an object opened from another object leads back to it and
   restores its scroll. The panel's head carries it (`SidePanel.headerStart`), including on the phone's sheet. The
   panel stack and whether the panel was open are part of the entry's place, so Back to a page restores its panel.

## Where the control sits (rule 7)

- **Computer and tablet:** first in the header row of an opened page, in front of the title, at the same x and y on
  every destination. It is absent, not hidden, when there is no origin, so a page reached from the sidebar looks as it
  does today. The title and the view tabs that follow it keep their order.
- **Phone:** it takes the place of the round Back (or heads the title row on a screen that has none): one control in
  one place. **Panel:** first in the panel head, before the kind chip, on the computer and in the phone's sheet.
- The label is the origin's name, truncated at 16 rem; the accessible name is "Back to <name>". It is a 32 px target
  (44 px on touch).

## Access (AC-3)

The control is hidden when its origin is no longer accessible: a project that left the shell's list or answers 401,
403 or 404 to one read, or a direct message that left the person's list. Back to such a place (the router answers 403 or
404 inside a project) lands on its nearest parent the person can open (the project's conversation, else the project
list) with one line in a toast, never an error page. This applies only to a return inside the running app; opening such
an address directly or reloading it keeps the ordinary "isn’t available" page.

## Verification

`app/tests/ui/test_return_to_origin.py` (Chromium and WebKit; 1440 × 900, 820 × 1180 and 390 × 844 with the display
mode reported as standalone): the five journeys of the issue (a conversation scrolled up → wiki card; a thread →
task chip; Tasks with a filter and an open panel → linked decision; search → result; Inbox → item), each asserting
the route, the open panel or thread, the visible anchor message and the draft, plus the control's place, history
(one entry, Back one step, Forward again, reload keeps the target), and a revoked origin. Browser Back is driven
with `go_back`; Alt+← and the phone gesture are the same router POP and are not separately scripted.

Not decided here and left as it was: restoring scroll inside every nested scroller (the Map canvas, the live editor),
and the Details panel's unsent form fields (a proposal in progress), which keep their own recovery.

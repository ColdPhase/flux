# Phone-first shell, current place and motion (#266)

**Founder direction:** @PelikanFix16, 2026-10-05, recorded in
[#266](https://github.com/ColdPhase/flux/issues/266) items 1–8:
- the phone UI is cramped, with too much chrome for small phones such as the iPhone SE (375×667);
- motion is poor, for example the left bar appearing and sliding;
- the current page is hard to see in Conversation, Map, Wiki and Agents;
- settings are weak on phones;
- aim for the calm Studio 11.6 look, executed better, without hurting UX.

This contract amends [Studio 11.6](studio-v11.6.md) UI116-5 (the "short mark" tab indicator and the
quietest current-place cues) and the phone parts of [adaptive workspaces](adaptive-workspaces.md).
F-015, F-017 and every other UI116 rule stay.

**Status:** proposed, 2026-10-05, by claude-hubert. Peer review on the implementing PR.

## Outcomes

| ID | Required behavior | How it is checked |
| --- | --- | --- |
| PF-1 | **Where you are is unmistakable, and the main places are at hand.** Revised 2026-10-05 after the founder's iPhone feedback on #264 and the review on #267. On phones (≤640 px), a bottom bar holds the few main places: Home, Projects, Messages, Inbox and Sketchbook (amended by [F-023](friendly-flux.md) FF-3). Each is an icon over its label, at least 44 px, safe-area aware. The current place has an accent pill, accent text and `aria-current`, and a chosen place shows it at once while it loads (#155). The bar stays on every page, with the current section marked, including inside a project, a conversation or a sketch (Projects, Messages, Sketchbook). Only a modal sheet or the on-screen keyboard covers it. This follows Apple's HIG [Tab bars](https://developer.apple.com/design/human-interface-guidelines/tab-bars) (page updated 2026-06-08, retrieved 2026-10-05): "Make sure the tab bar is visible when people navigate to different sections of your app. If you hide the tab bar, people can forget which area of the app they're in." The founder made the HIG the mobile standard on #266 (2026-10-05 22:45). Inside a place the header's top-left control leads back to its list (HIG-26). A place's views (My sketchbook's Notes and Map; a project's Conversation, Map, Tasks, Wiki, Agents; a DM's Messages and Sketches) are a row of labelled chips under the header. The current chip is filled with the accent; the others are outlined. On wider screens the top tabs keep a 2 px accent mark under the whole current label that slides between tabs. In the sidebar and the drawer, the current place has an accent-tinted row (the travelling highlight from #155 takes the tint), accent text and icon, and a 3×20 px bar. | At 320, 375 and 390 px: one current place in the bar and one current chip, every label readable, targets of at least 44 px. Desktop: the mark's width equals the label's width and it moves on a view change. |
| PF-2 | **Little fixed chrome, every control labelled.** On phones one 52 px header holds the menu, the place (title and audience) and a labelled Details button. The project's state (what needs you, the rule, blocked work) and "What matters" share one 44 px line, only on the project's Conversation, where people orient themselves. Map, Tasks, Wiki and Agents start right under the views. No control is a bare icon whose meaning has to be guessed (#264). | At 375×667 Map, Tasks, Wiki and Agents start at most 120 px from the top. Every header and toolbar control shows a text label. |
| PF-3 | **A messenger-like composer.** On phones the composer is one card: the text first, then one slim row of tools (attach, sources, assistant) and Send, with the audience as one quiet line under it. The field is at least 44 px tall and grows with the text up to its cap. A tap on the card's empty space focuses it. Attaching is a paperclip in that row (accessible name "Attach files"); staged files list above the card. On a coarse pointer every editable control is at least 16 px, so iOS does not zoom on focus, and controls use `touch-action: manipulation`. Pinch-zoom stays allowed. While a text field has focus on a touch screen the bottom bar steps aside, and it stays aside while focus moves to the same composer's buttons. iOS Safari ignores `interactive-widget`, so on touch screens the app follows the `visualViewport` while the keyboard is up. | With a simulated keyboard (viewport about 55% of its height), the field and Send stay visible and the draft survives. Every editable control computes at least 16 px on a coarse pointer. A three-line draft shows all three lines. |
| PF-4 | **Motion that explains change.** Tokens: 120 ms for colour, 180 ms for content, 260 ms for indicators, panels and drawers, 340 ms for phone sheets. Easing: ease-out for entering, the sheet curve for surfaces, and a gentle glide (at most 2% past the target, no bounce) for indicators. Indicators move; content changes at once. The drawer follows a finger dragged back to the edge, and the phone sheet follows a drag down from its header (with a grabber). Past a third of the way, or on a flick, it closes from where it is; otherwise it settles back. Vertical scrolling inside the drawer is unaffected. Reduced motion turns every duration to 0 and keeps every state change. | Touch-emulation test: a small drag settles back, a long drag closes, a vertical swipe scrolls. A reduced-motion run shows no animations. |
| PF-5 | **One Settings place.** Account, Appearance, Notifications, the agent in Flux, agent connections (MCP) and Background suggestions are reached from one Settings list. It opens from the person row at the foot of the sidebar on every size; there is no account popover ([F-023](friendly-flux.md) FF-4). On phones each section has a Back button in the header and slides in like a pushed page. Existing addresses keep working. A side list beside each section on wide screens is deferred (amended 2026-10-05 after review): the sections are separate pages with their own headers. | Every section is reachable in at most two taps from the drawer on a phone, and Back returns to the list. |
| PF-6 | **Dense, readable views on phones.** The Tasks toolbar is one row of labelled tools (Search, Decisions, Kanban, List, Mine, + Task). Search is a target as wide as its tile; tapped, it opens to the full row, and a filter in use stays open beside the tools. A waiting decision shows as a count on Decisions. The board's column keeps only a "New task" row, because the status tabs above already name and count it. Task notices in the conversation sit close together and wrap a title to two lines. The map's tools are one row, each an icon over its label. | At 375×667 the first task card starts within 320 px of the top. A tap anywhere on the Search tile focuses the field. |
| PF-7 | **Verified at real sizes.** Chromium emulation at 320×568, 360×640, 375×667, 390×844, 414×896, 768×1024, 1024×768 and 1440×900, in light and dark, with touch for phone sizes. The on-screen keyboard is simulated by shrinking the viewport while a field has focus (#268). No sideways scroll. Coarse-pointer targets are at least 44 px. A separate visual review receives a neutral brief. Under #266 item 10 physical devices are optional, so the iOS keyboard path is reported unverified. | Browser tests and captures in `docs/agents/evidence/266-phone-first/`. The visual review is linked on the PR. |

## Rationale and sources

- The bottom bar holds top-level places, as messengers do. Material 3's
  [navigation bar](https://m3.material.io/components/navigation-bar/guidelines) is for 3–5
  destinations and marks the active one with a pill. Apple's
  [tab bars](https://developer.apple.com/design/human-interface-guidelines/tab-bars) are "at the
  bottom of the screen", within thumb reach, for top-level navigation.
- The views inside one place switch often, but they are not top-level places. The founder asked for
  "a bottom bar for the few main places" and a full-height conversation (#264). So the views sit as
  filled chips under the header, the pattern messaging and team apps use for a channel's sections.
  This also answers the other founder's request that the current view be unmistakable (#266 item 3).
- Text fields under 16 px make iOS Safari zoom on focus. Coarse-pointer fields already use 16 px
  (`.ui-input`). The composers now do too.
- Drag-to-dismiss with a velocity threshold follows the platform sheet behaviour users expect.
  Mouse and keyboard keep the scrim, the close button and Esc.
- [WCAG 2.2 animation from interactions](https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html):
  every duration is 0 under `prefers-reduced-motion`.

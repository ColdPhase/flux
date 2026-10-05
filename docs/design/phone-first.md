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
| PF-1 | **The current place is unmistakable.** On phones (≤640 px), Home's and a project's views (Conversation, Map, Tasks, Wiki, Agents) sit in a bottom view bar: each view is an icon over its label, at thumb height, at least 44 px, safe-area aware. The current view has an accent pill behind its icon, an accent label and `aria-current="page"`. On wider screens the top tabs keep their labels, and a 2 px accent mark spans the whole current label and slides between tabs. In the sidebar and the drawer, the current place has an accent-tinted row, accent text and icon, and a 3×20 px accent bar. | Browser test at 320, 375 and 390 px: one current item, all five views reachable, no label clipped. Desktop: the mark's width equals the label's width and it moves on a view change. |
| PF-2 | **Little fixed chrome on phones.** One 52 px header holds the menu, the place (title and audience), "What matters" as an icon with a count badge, and Details as an icon. No state row and no top tab row. The project's state stays one tap away in Details. Work starts right under the header. | At 375×667 the work area starts at most 60 px from the top, and the header and bar together take at most 120 px. |
| PF-3 | **A compact composer.** On phones the composer is one card: the text first, then one slim row of tools (attach, sources, assistant) and send, with the audience as one quiet line under it. Attaching is a paperclip in that row (accessible name "Attach files"); staged files list above the card. Fields use 16 px text on touch screens, so iOS does not zoom. While a text field has focus on a touch screen, the view bar steps aside for the keyboard. | Composer card at most 96 px tall when empty at 375 px. Focusing the field on a touch device hides the bar; blurring brings it back. |
| PF-4 | **Motion that explains change.** Tokens: 120 ms for colour, 180 ms for content, 260 ms for indicators, panels and drawers, 340 ms for phone sheets. Easing: ease-out for entering, the sheet curve for surfaces, and a gentle glide (at most 2% past the target, no bounce) for indicators. Indicators move; content changes at once. The drawer follows a finger dragged back to the edge, and the phone sheet follows a drag down from its header (with a grabber). Past a third of the way, or on a flick, it closes from where it is; otherwise it settles back. Vertical scrolling inside the drawer is unaffected. Reduced motion turns every duration to 0 and keeps every state change. | Touch-emulation test: a small drag settles back, a long drag closes, a vertical swipe scrolls. A reduced-motion run shows no animations. |
| PF-5 | **One Settings place.** Account, Appearance, Notifications, the agent in Flux, agent connections (MCP) and Background suggestions are reached from one Settings list. On phones the list leads to each section with a back button in the header. On wider screens a section list sits beside the section. Existing addresses keep working. | Every section is reachable in at most two taps from the account menu on a phone, and back returns to the list. |
| PF-6 | **Dense, readable views on phones.** The Tasks toolbar is one row: search opens to the full row when tapped, and Decisions & results, view mode, Mine and + Task are 44 px icons. The Wiki and Agents tools follow the same rule. | At 375×667 the first task card starts within 320 px of the top. |
| PF-7 | **Verified at real sizes.** Chromium emulation at 320×568, 360×640, 375×667, 390×844, 414×896, 768×1024, 1024×768 and 1440×900, in light and dark, with touch for phone sizes. No sideways scroll. Coarse-pointer targets are at least 44 px. A separate visual review receives a neutral brief. Physical devices are optional under #266 item 10. | Browser tests and screenshots attached to the PR. The visual review comment is linked. |

## Rationale and sources

- Five top-level destinations, switched often, belong in a bottom bar on phones. Material 3's
  [navigation bar](https://m3.material.io/components/navigation-bar/guidelines) is for 3–5
  destinations and marks the active one with a pill. Apple's
  [tab bars](https://developer.apple.com/design/human-interface-guidelines/tab-bars) keep them
  "at the bottom of the screen", within thumb reach. The drawer stays for places across projects.
- Text fields under 16 px make iOS Safari zoom on focus. Coarse-pointer fields already use 16 px
  (`.ui-input`). The composers now do too.
- Drag-to-dismiss with a velocity threshold follows the platform sheet behaviour users expect.
  Mouse and keyboard keep the scrim, the close button and Esc.
- [WCAG 2.2 animation from interactions](https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html):
  every duration is 0 under `prefers-reduced-motion`.

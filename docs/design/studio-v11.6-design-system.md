# Studio 11.6 design system — production mapping

**2026-10-02, #136 / F-017.** This is the concrete appearance contract for implementing
[UI116-1–UI116-5](studio-v11.6.md) in `app/apps/web`. The values were measured from the
unchanged supplied prototype, not read from its layered CSS. The full measurement with
every element is in [measured-design-system.md](references/studio-v11.6/inspection/measured-design-system.md);
the [measuring scripts](references/studio-v11.6/tools/measure/README.md) reproduce it.
Owner: @PelikanFix16. Evaluator: @Zamojski5.

The prototype is the target for **appearance**. Production keeps its stronger behaviour,
access rules and accessibility. Where the two conflict, this page records the choice.

## Decisions where production deliberately differs from the prototype

| Topic | Prototype | Production choice | Why |
| --- | --- | --- | --- |
| Language | Polish labels | English labels in the same order: **Conversation · Map · Tasks · Wiki · Agents**; "What matters", "Together" | Flux is a global product. Localization is a separate concern; order, vocabulary and placement follow 11.6. |
| Sidebar label contrast | `--dim` on chrome is 4.45:1 for 11px labels | Use the `--text-2` role on the chrome background | WCAG 1.4.3 AA for small text |
| Input borders | 1px `--line`, about 1.3:1 | Keep `--line-input` at ≥3:1, retinted to the slate family | WCAG 1.4.11 for field boundaries |
| Dim text | `#657185` (4.2:1 on hover, own-bubble and selected fills) | `--text-3` `#5e6a7d` in light, the nearest same-hue value with ≥4.5:1 on every light fill | WCAG 1.4.3 for metadata on those fills |
| Tab indicator | Static 16×2px accent underline at the tab's left edge | The same 16×2px accent underline, which slides between tabs for at most 180ms; static under reduced motion | UI116-5 requires a subtle sliding indicator |
| Arrivals and typing | No motion; demo typing | Real scoped typing (#155) and small arrival opacity only for new visible messages | UI116-5 |
| Tooltips | Native `title` only | Keep production's accessible labels; no custom tooltip is required | Behaviour parity with less code |
| Tasks | Kanban only | Kanban by default, plus the existing grouped list as "List"; keyboard/menu moves remain | UI116-4 keeps keyboard and touch alternatives; phone needs a readable overview |
| Default accent | Sky in light, Mint in dark | Keep #148: Mint by default, with separate remembered light and dark choices | Accepted #148 behaviour |

## Tokens

Keep production's semantic names and change their values. The **new** roles are chrome,
sheet edge, action, bubbles, tints and canvas. Rail tokens are retired.

| Role (production) | Light | Dark | Replaces |
| --- | --- | --- | --- |
| `--bg-chrome` (new): page behind the sheet, sidebar, phone drawer | `#f2f3f5` | `#191c21` | `--bg-side` as sidebar fill |
| `--bg`, `--bg-raised`: sheet, cards, composer, modal, menu | `#ffffff` | `#21252b` | `#ffffff` / `#141517` |
| `--sheet-edge` (new) | `#dde2e9` | `#363f49` | — |
| `--bg-active` (elevated) | `#f4f5f7` | `#282d35` | `#ebebee` / `#25262a` |
| `--bg-hover` | `#eceef2` | `#303741` | `#f1f1f3` / `#1d1e21` |
| `--bubble` (new) | `#f4f5f7` | `#2a3038` | `--bg-side` on bubbles |
| `--bubble-own` (new) | Mint `#e5eee5`, Sky `#e7edf4`, Copper `#f3e8de` | `#2e3742` | `--accent-soft` on own bubbles |
| `--text` | `#272e38` | `#e8ecf2` | `#1b1c1f` / `#ededef` |
| `--text-2` (muted) | `#596577` | `#adb7c6` | `#3c3f45` / `#c9cace` |
| `--text-3` (dim; not on chrome for small text) | `#5e6a7d` (prototype `#657185`, darkened for AA) | `#a0abba` | `#62666d` / `#9a9ca3` |
| `--line` | `#dde2e9` | `#3b424e` | `#e7e7ea` / `#26272b` |
| `--line-strong` | `#cfd6df` | `#46505d` | derived, not in the prototype |
| `--line-input` (≥3:1) | `#8a93a1` | `#6b7583` | `#8b8f97` / `#6b6e76` |
| `--action` / `--on-action` (new): primary buttons, send, toast | `#2e3743` / `#ffffff` | `#e0e7ef` / `#242c36` | primary used `--accent` |
| Mint accent / soft | `#28664f` / `#e8f1ec` | `#91c9b3` / `#293b34` | `#247358` / `#8ed8b8` |
| Sky accent / soft | `#345f93` / `#eaf0f8` | `#9bb7e1` / `#2b384b` | `#2c609b` / `#94bcf3` |
| Copper accent / soft | `#985035` / `#f6ede7` | `#dba88c` / `#42342d` | equal (dark soft was `#3b2e25`) |
| `--ok` / `--tint-ok` (new) | `#31664d` / `#eaf4ee` | `#9fceb1` / `#273b31` | `#1a7f4b` / `#5fc08a` |
| `--warning` / `--tint-warning` (new) | `#855c20` / `#faf1df` | `#e0c38d` / `#3a3328` | `#8a5300` / `#e0a650` |
| `--danger` / `--tint-danger` | `#a1443c` / `#fbece8` | `#efb0a7` / `#402f2f` | `#b42318` / `#f08a80` |
| `--canvas` / `--canvas-dot` (new, map) | `#f7f8fa` / `#dde2e9` | `#1c2026` / `#3c4551` | — |
| `--shadow` (overlays only) | `0 16px 48px #26344716` | `0 20px 65px #00000055` | two-layer shadows |
| `--scrim` | `#0e151359` | `#0e151359` | `rgba(16,17,20,.28)` / `.5` |

**Accent** marks selection and pointers only: the active navigation bar, tab underline,
focus ring, unread dot, links, focused borders and the "doing" status ring. It is not the
primary button fill; that is `--action`. `scripts/check_contrast.py` must keep passing for
all six palettes with the new values.

**Type.** The font is the system UI stack:
`-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`.
There is no web font. The root is 14px/1.55 with no body tracking, and headings use −0.025em.

| Token | Size | Use |
| --- | --- | --- |
| `--fs-xs` | 10 | metadata, timestamps |
| `--fs-sm` | 11 | names, chips, small buttons |
| `--fs-md` | 12 | navigation, tabs, controls |
| `--fs-base` | 14 | reading text, bubbles, inputs |
| `--fs-lg` | 16 | |
| `--fs-xl` | 20 | |
| `--fs-2xl` | 24 | |
| `--fs-title` | 21 | project title |
| `--fs-doc-title` | 30 | wiki title |

**Shape and space.**

- **Radii:**
  - `--r-sm` 6 for navigation items
  - `--r` 7 for buttons and inputs
  - `--r-lg` 12 for modals
  - 10 for the composer and map nodes
  - **13 for the sheet**
  - 8 for task cards
  - 4 for pills
- **Sizes:**
  - sidebar 220px (off-canvas drawer of 260px at ≤680)
  - context panel 408px (430 at ≥1600, 375 at ≤1200, a 390px overlay at ≤1000)
  - reading column 790px
- **`--space-page`:** 36px, then 44 at ≥1600, 26 at ≤1200, 22 at ≤1000 and 18 at ≤760.
- **Sheet inset:** 12px on the top, right and bottom; 8 at ≤760; 0 at ≤680.
- **Controls:**
  - small and toolbar controls 32px, default 35px, inputs 42px
  - 44px on coarse pointers

**Motion.**

- Colour changes take 130ms and opacity reveals 120ms.
- The phone drawer is a 160ms ease-out slide.
- There is no press scaling, bounce or entry slide.
- Under `prefers-reduced-motion`, everything is immediate.

## Components (the #136 implementation checklist)

1. **Shell.**
   - Remove the dark identity rail and lime.
   - Use one 220px sidebar drawn on `--bg-chrome`, containing:
     - logo
     - underline search with Ctrl K
     - Home, with a count
     - private sketchbook, with a lock
     - **Projects**, with + (icon, unread dot, and an active 2×14 accent bar in the gutter)
     - **Messages**, with + (avatar rows)
     - footer: user, settings and theme
   - Navigation rows are 42px tall in 12px weight-400 text; the active row is `--bg-active`.
   - The content sits in a rounded **sheet** with a 1px `--sheet-edge` border and no shadow.
   - The sidebar lists no conversation threads. A project has **one conversation**
     (UI116-1 clarification, #195): a chronological stream of messages, and each
     message's replies open beside it. Earlier conversations become roots in that stream,
     and their existing links keep working, so no history is lost.
2. **Project header**, inside the sheet:
   - The title is 21px weight 600.
   - Below it, a members line and a compact goal.
   - Quiet "Together" and "…" sit on the right.
   - The tab row follows: Conversation · Map · Tasks · Wiki · Agents.
     - Labels are 12px, the active one weight 550, with the 16×2 accent underline.
     - Tabs carry no counts.
   - "What matters N" sits at the far right as quiet text.
3. **Conversation.**
   - Layout: a centred 790px column, 27px avatars on both sides, and the name and time
     always visible.
   - Bubbles:
     - padding 12px 16px, radius 3/10/10/10, 14px/1.7 text
     - own bubbles mirrored on `--bubble-own`
   - Results and blockers show a 2px `--ok` or `--warning` left rule with an effect line.
   - An attached task shows as a left-ruled card.
   - Reply counts appear under the bubble.
   - The UI116-3 task notice is compact.
4. **Composer.** A two-row card with radius 10, 1px `--line` and padding 12px 15px.
   - Text goes above; attach, @ and AI go below.
   - The send button is 31px with `--action` fill.
   - Focus shows an accent border with no halo.
   - The audience and key hint sit below the card.
5. **Controls.**
   - Primary means `--action`.
   - Secondary is a 1px `--line` outline.
   - Quiet buttons turn `--bg-hover` on hover.
   - Icon buttons are 34px.
   - Modals are 540px with radius 12 and a 24px weight-400 title.
   - Toasts use `--action`, radius 7 and 12px text.
6. **Tasks.**
   - Toolbar: milestone/goal select where it exists, underline search, Kanban | List,
     Mine, and primary "+ Task".
   - Board: three columns, cards with radius 8 and padding 16.
   - Cards show the ID, title at 14px weight 500, context, owner and agent state.
   - Drop feedback highlights only the card list (UI116-4).
   - Placement (#194): blocked work stays in In progress, first in the column, labelled
     "Blocked" with what it waits for; not pursued sits in Done; work a pivot parked
     appears only in the List.
7. **Wiki.**
   - Two panes: a 212px page index and the document.
   - The active page has a 4% text tint, a 3px dot and `aria-current`.
   - A 57px top bar carries icon actions and a primary "Edit".
   - The document column is 820px.
   - Type: title 30px weight 650, body 14px/1.85, h2 20px weight 600 with no rule.
   - Code blocks sit on `--bg-active`, radius 7.
8. **Map.**
   - Canvas on `--canvas` with a 26px dot grid.
   - Nodes are 204px wide, radius 10, padding 14px 16px, text 13px weight 500.
   - A **task count** opens a chooser of all linked tasks (UI116-4).
9. **Agents.**
   - A 790px column with a 24px heading.
   - One entry per connection, showing client, owner and truthful state, so one person's
     second agent is never hidden.
   - A task selector, the executor → reviewer row (after #153), and the task thread with a
     composer radius of 9.
10. **Phone (≤680).**
    - The sheet fills the screen without border or radius.
    - The sidebar becomes a 260px drawer.
    - Header padding is 18px 17px and the title is 18px.
    - Tabs scroll horizontally.
    - Avatars are hidden in the conversation.
    - The board shows a status overview with counts (blocked included) and one column at a
      time instead of scroll-snapped columns (#194); after a keyboard or menu move the
      visible column follows the card.

## Verification

Each slice checks the following:

- rendered screenshots at 1440 and 390, in light and dark, against the
  [11.6 gallery](references/studio-v11.6/gallery.md) at the same viewport
- `check_contrast.py` for all six palettes
- the existing UI journeys
- an independent visual review with a neutral brief

Screenshots do not prove behaviour, so behaviour and access are tested separately.

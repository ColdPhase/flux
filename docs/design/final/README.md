# Flux final design: Prostota

**Status.** Founder direction by Hubert ([@PelikanFix16](https://github.com/PelikanFix16)) on
2026-10-07, recorded as [F-026](../../product/decisions.md) and tracked in
[#336](https://github.com/ColdPhase/flux/issues/336). This is the **only** UI and UX
direction for Flux on the computer and the phone. Implement it as drawn. Founders own
changes to it; agents implement it and do not re-decide it.

- **Interactive source.** The canvas page "Prostota" holds 65 boards, each with a light/dark toggle
  and annotations (S1–S22, P1–P12): <https://claude.ai/artifact/UnQv8mJcyLWrDmKg7nMYDf>.
- **In this folder.** This guide and a render of every board in [`screens/`](screens/). Phone
  renders are at 2× (780 × 1688). Desktop renders are 1440 × 900, and boards are 1440 × 1200.
- **Implementation.** Issues [#338](https://github.com/ColdPhase/flux/issues/338), [#339](https://github.com/ColdPhase/flux/issues/339), [#340](https://github.com/ColdPhase/flux/issues/340), [#341](https://github.com/ColdPhase/flux/issues/341), [#342](https://github.com/ColdPhase/flux/issues/342), [#343](https://github.com/ColdPhase/flux/issues/343), [#344](https://github.com/ColdPhase/flux/issues/344), [#345](https://github.com/ColdPhase/flux/issues/345), [#346](https://github.com/ColdPhase/flux/issues/346), [#347](https://github.com/ColdPhase/flux/issues/347), [#348](https://github.com/ColdPhase/flux/issues/348), [#349](https://github.com/ColdPhase/flux/issues/349), [#350](https://github.com/ColdPhase/flux/issues/350), [#351](https://github.com/ColdPhase/flux/issues/351), [#352](https://github.com/ColdPhase/flux/issues/352), [#354](https://github.com/ColdPhase/flux/issues/354), tracked on #336. Each has its renders, acceptance criteria and the code to change.
- **Scope.** Appearance, structure and interaction. Product, data, access, AI and agent contracts
  stay as recorded in [the decision register](../../product/decisions.md). Where an older contract
  describes how something looks or where it sits, this design wins.

![Overview of the final design](screens/overview.webp)

## 1. Principles

1. **One calm language on both devices.** The computer looks and behaves like the phone, with
   more room.
2. **One place for what needs you.** Inbox holds decisions, agent questions, blockers and
   mentions. Home shows the top three. There is no Decisions view.
3. **Everything belongs to its message.** Files, links, photos and references sit inside the
   message bubble.
4. **Shape, not colour, carries meaning.** The surfaces are monochrome. Status is a glyph plus a
   word. The only colours are user content (photos) and agent colours in the Agents section.
5. **Agents are recognisable, never mistaken for people.** People are grey circles with initials.
   Agents are Kreska, always with an "Agent" tag and "for &lt;owner&gt;".
6. **Undo instead of confirmations.** Quick actions apply immediately and show a toast with Undo.
7. **Small moments, never noise.** The mascot appears only in loading, waiting, empty and success
   moments. A person can turn it off.

## 2. Visual system: Soft volume

### Tokens

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--side` | `#EBEBED` | `#0B0B0B` | Outer background (behind the panel and sidebar) |
| `--bg` | `#F4F4F5` | `#111111` | Screen or panel background |
| `--el` | `#FFFFFF` | `#1C1C1C` | Cards, bubbles, inputs, sheets, menus |
| `--sub` | `#EBEBEC` | `#242424` | Fills: segmented track, chips, attachment rows |
| `--hov` | `#E3E3E5` | `#2C2C2C` | Hover and pressed fills |
| `--line` | `rgba(0,0,0,.07)` | `rgba(255,255,255,.08)` | Hairlines, card outlines |
| `--line2` | `rgba(0,0,0,.14)` | `rgba(255,255,255,.16)` | Strong outlines |
| `--t1` | `#18181B` | `#F0F0F0` | Primary text |
| `--t2` | `#4A4A4A` | `#ACACAC` | Secondary text |
| `--t3` | `#6B6B6B` | `#8C8C8C` | Meta text (at least 4.5:1 on `--bg` and `--el`) |
| `--inv` / `--oninv` | `#18181B` / `#FFFFFF` | `#F0F0F0` / `#111111` | Inverted chips, the primary button, own bubbles |

**Shadows**
- Card: `0 1px 2px rgba(0,0,0,.05), 0 6px 16px -6px rgba(0,0,0,.12)`.
- Pop-over: `0 1px 2px rgba(0,0,0,.06), 0 12px 30px -10px rgba(0,0,0,.22)`.
- Field: `inset 0 0 0 1px rgba(0,0,0,.05), 0 1px 2px rgba(0,0,0,.05), 0 6px 16px -8px rgba(0,0,0,.12)`.
- Dark mode uses inset 1 px light outlines plus deeper shadows. Layers get lighter as they rise.

**Gradients**
- Button: `linear-gradient(#FFFFFF, #F1F1F2)`.
- Primary and inverted: `linear-gradient(#3B3B3F, #18181B)`. In dark mode it is
  `linear-gradient(#FFFFFF, #D9D9D9)` with dark text.

**Radii:** 10 (small), 14 (rows, fields), 18–20 (cards, bubbles, panels) and full (pills,
buttons). The phone sheet top corners are 26.

**Concentric corners** (founder, 2026-10-08): a frame that tightly holds a tile or an avatar takes
the inner radius plus the gap. A project tile (radius 6) inside a place picker with a 4 px inset sits
in a 10 px frame, not in a pill. Projects stay rounded squares and people stay circles, so a lettered
circle never stands for a project.

**Typography:** Geist 400 / 500 / 600 and Geist Mono for numbers (#12), times, keys and file
labels.
- Title: 32 / 600 on the computer, 28–30 on the phone.
- Section: 16–17 / 600.
- Body: 14 / 20 on the computer, 15–16 on the phone.
- Meta: 12, and at least 12.5 on the phone.
- The phone follows the system text size.

**Motion:** pressing scales to 0.97 and springs back in about 250 ms. Status changes morph.
Reduced motion shows the static frame. Nothing moves for its own sake.

**Theme:** Light, Dark and Match system. There is no accent colour and no colour picker.

![Visual system](screens/reference-system.webp)

### Status glyphs

The task states are Open (outline circle), In progress (half-filled circle), Blocked (filled
rounded square), Done (filled circle with a check) and Not pursued (slashed circle). "Blocked"
and "Needs you" also appear as inverted pills. A word always accompanies the glyph.

### Agent colours (Agents section only)

The palette is muted OKLCH with equal lightness: L 0.55 light, 0.80 dark. Kreska's lines take the
colour, and the face fill is the same colour at 12%. The colours appear only in the agent list,
an agent's details, the hand-off picker, and Settings → Agents and AI. Everywhere else agents are
monochrome.

| Name | Light | Dark | Example |
| --- | --- | --- | --- |
| Clay | `#9B6147` | `#E8AF96` | Claude Code |
| Ochre | `#886D32` | `#D4BB86` | |
| Sage | `#4B8057` | `#9CCCA4` | Codex |
| Teal | `#208181` | `#82CDCD` | |
| Indigo | `#5E6FA4` | `#ABBCEF` | Ada's assistant |
| Plum | `#886191` | `#D4AFDC` | |
| Rose | `#9C5C66` | `#E9AAB3` | |

## 3. Kreska: logo, agent icon and mascot

![Kreska](screens/reference-kreska.webp)

Kreska is a monoline face in a squircle: one raised brow, two eyes and no mouth.

| Role | Form | Where |
| --- | --- | --- |
| **Logo** | Solid tile (`--inv`) with the face knocked out, plus the "flux" wordmark. Nothing extends past the tile. | Sidebar, phone Home, sign-in, splash, app icon, favicon |
| **Agent icon** | Outline squircle on an `--el` fill. Sizes are 16 / 20 / 24 / 32 / 48. Line weights: frame / eyes / brow 1.8 / 2.2 / 1.7 at 32 px or less, 1.5 / 2.0 / 1.55 at 40–63 px and 1.15 / 1.7 / 1.3 at 64 px or more | Every agent, the "Agent" tag, the map cursor |
| **Mascot** | The same face at 56–112 px | Small moments only (below) |

**Expressions (they replace status dots).** Each has a static frame; animate only when reduced
motion is off.

| Expression | When |
| --- | --- |
| Idle | The agent is present and doing nothing |
| Working | It is working on a task |
| Thinking | It is composing a reply; the brow waves |
| Writing | It is editing the Wiki or a result |
| Reading | It is reading files or a thread |
| Waiting for you | A decision or approval is pending; the eyes look at the composer |
| Asking | It needs clarification |
| Looking | No results; it looks aside |
| Loading | Dots flow through the eyes |
| Surprised | A new mention, or a pull to refresh |
| Done | A result is delivered, or Inbox is empty |
| Wink | A task was closed (in the toast) |
| Celebrate | A project goal was reached (once) |
| Hello | The first start, or a new project |
| Asleep | Offline, paused, or idle for days |
| Worried | Something failed, gently |

**Small moments.** These are the only places the mascot appears, and Settings → Appearance can
turn them off:
- splash;
- project loading;
- "agent is thinking" with Stop;
- empty Inbox;
- the offline banner;
- no search results;
- pull to refresh;
- goal reached;
- the toast after a task is closed.

The mascot never appears in errors, security, payments, apologies or deletion. It never covers
content and never nags.

![Small moments](screens/reference-smaczki.webp)

## 4. Structure and navigation

### Computer

- **Sidebar (248 px).**
  - The logo, and a button to collapse the sidebar (`[`).
  - **New** (`C`) and Search (`⌘K`).
  - Home, Inbox (with a count), Sketchbook.
  - Projects, then Messages.
  - A **working-agent card** with **Stop**, then the account and Settings.
- **Collapsed rail (64 px).** Icons only. Focus mode (`F`) pauses notifications.
- **Project header.** One row: the project name, the views **Conversation · Map · Tasks · Wiki ·
  Agents**, "N needs you", the people and agents, and More.
- **One detail panel.** A task, a decision, an agent or a thread opens in the same right-hand
  panel, and the conversation stays visible. `Esc` closes it.
- **⌘K.** Creates and finds everything: tasks (`#`), people and agents (`@`), Wiki and files.

### Phone

- **Tab bar.** Home · Projects · Inbox, in a floating capsule, with a separate round **Search**
  button. Direct messages live in Projects.
- **One "+".** A floating button above the tab bar opens Create: Task, Thought, Message, Decision,
  File or link, Sketch.
- **Inside a project.**
  - The title is the view menu: Conversation, Tasks, Map, Wiki, Agents, then "Details, goal and
    people".
  - There are no chip rows.
  - **There is no tab bar in a conversation;** the composer sits at the bottom.
- **Sheets.** They have a grabber and two heights: half (the conversation stays visible) and full
  (dragged up).
- **Gestures.**
  - **Swipe left always reveals actions**: Done, Not now, Hand off, Reply in thread.
  - Long press opens a message menu: Reply in thread, Create task, Hand off to an agent, Cite,
    Copy text.
  - Nothing swipes right.
- **Targets and text.** Touch targets are at least 44 px. Meta text is at least 12.5 px. Body
  text is 15–16 px.

### Keyboard (computer)

| Keys | Action |
| --- | --- |
| `C` | New (task by default) |
| `⌘K` | Search or run |
| `G` `I` | Go to Inbox |
| `J` / `K` | Move in a list |
| `E` | Done |
| `S` | Not now |
| `A` | Accept |
| `Z` | Undo |
| `R` | Reply in thread |
| `T` | Create a task from a message |
| `1`–`5` | Task state |
| `[` | Collapse the sidebar |
| `F` | Focus mode |
| `Esc` | Close a panel or menu |

The keys show next to their actions in menus.

Existing Settings URLs remain valid entry points to the corresponding permitted section,
directly or through a redirect to its current equivalent. Preserve Back and history without
restoring the former appearance.

## 5. Behaviour

The canvas labels S1–S22 and P1–P12 refer to these rules.

| ID | Rule |
| --- | --- |
| S1 | **Inbox "Needs you"** is the one queue. Home shows the top three. **There is no Decisions view and no archive.** |
| S2 | The phone tab bar is Home · Projects · Inbox plus Search. There is none in a conversation. |
| S3 | One "+" or `C` opens the same Create window or sheet everywhere: Tasks, the Map, a message menu, ⌘K. |
| S4 | One detail panel on the computer and one sheet on the phone, for tasks, decisions, agents and threads. |
| S5 | The composer has `@` to mention and `/` for actions (`/task`, `/decide`, `/handoff`, `/file`), with no separate buttons. |
| S6 | Hover actions on a message (computer). Swipe left for actions and long press for the menu (phone). |
| S7 | A "Since you left: …" line jumps to the first unread item. |
| S8 | Several task updates in a row fold into one expandable line. |
| S9 | One tap on the state glyph (or `1`–`5`) changes the state. Swipe left, then Done, then a toast with **Undo**. |
| S10 | Title and properties are edited in place. |
| S11 | A decision shows who has accepted and who is still waiting. "Not now" lets you choose when it returns: tomorrow, next week, or when a task is done. |
| S12 | Hand-off to an agent takes two steps: choose the agent, then see what it may do. On the computer you can also drag a task onto an agent. |
| S13 | A working agent is always visible, with Stop: in the sidebar card, Home, and the conversation header on the phone. |
| S14 | An agent's question is a card with ready-made answers. |
| S15 | On the phone the map is for viewing and for adding a thought. Connecting and arranging happen on the computer. |
| S16 | One search over people, agents, tasks, Wiki, files and messages, with `@` and `#`. |
| S17 | Larger small text on the phone; the phone's text size setting applies. |
| S18 | Keyboard shortcuts, shown in menus. |
| S19 | A collapsible sidebar and a focus mode. |
| S20 | A new project takes one step: a name and a template. You invite people and agents later. |
| S21 | Map, Wiki and Agents appear the first time they are needed. |
| S22 | Notifications default to "Needs you" only, with quiet hours and a morning summary. |
| P1 | Home has a "Continue where you left off" card. The whole card is clickable and has a round arrow. |
| P3 | Kreska is the agent icon everywhere (section 3). |
| P4 | A decision is one card on both devices: "Proposed decision", "Needs you", the reason, what it is based on, then Accept / Not now / Discuss. |
| P5 | **Creating a task is separate from its notice.** The conversation only announces it, in one line with its source: "made a task from Jonas's message", "added a task in Tasks", "added 3 tasks on the Map". |
| P6 | Attachments sit inside their message (section 6). |
| P7 | Monochrome with light, dark and system; no accent colour. |
| P8 | The action is called "Create task", never "Create work". |
| P9 | Agents is one list (agent, owner, what it is doing now), plus one row each for Requests, Policy and "Connect your own agent", and one primary button, "Hand off a task". |
| P10 | Task details are calm: rows of label and value, the blocker as a card, Results, Activity, and a composer. |
| P12 | On the map you drag from a thought's dot to connect it. Releasing on empty space adds a connected thought, as a local draft until it is saved. |

**Alignment rules for conversations**
- Every author, person or agent, has a 32 px avatar and their full name at the same position,
  whether they wrote a message or triggered an event.
- Cards, bubbles and event text start on one left edge: avatar column plus a gap of 12 on the
  computer, 10 on the phone.
- Small 20 px avatars appear only as owners inside task rows.

### Kept map and board behaviour

These functional rules from UI116-4 remain required; they do not change the fixed screens,
tokens or S/P rules above:

- A map thought's task count opens **all** its related tasks under current access checks,
  with exact task IDs, current states and people. Closing the related-task view returns to
  the same map camera and selection. Preserve many-to-many relations and accessible named
  links; simplifying their display does not delete tasks, relations or data.
- On the task board, a drop outside a valid target does nothing. A failed transition restores
  the true current state. The column header and an empty column are usable drop targets.
  Drag feedback clears on leave, drop or cancel. Keep touch and keyboard/menu alternatives
  to dragging; this adds no card-ordering semantics.

## 6. Files, references and photos

![Files, references, photos](screens/attachments.webp)

- **A file** is a page icon with a folded corner. The pictogram sits below the fold, with a mono
  label underneath: PDF (inverted band), CSV, XLSX, DOCX, MD, code, ZIP, audio, video, image,
  other. The row shows the icon, the name, "type · detail · size" and a download button. A voice
  note shows a waveform and a play button.
- **References** to Flux objects are cards with the object icon, the kind, the title and the
  state: task, Wiki page, decision, map thought, cited message. In text they are inline chips
  aligned to the text baseline: `@person`, `#4`, a Wiki page.
- **A link** shows a preview: the site icon, the domain, the title, the description and an
  optional image.
- **A photo** has no file frame. It has radius 16 and its caption below. 2–4 photos form a grid,
  with "+N" on the last one.
  - Sending, offline and failure show on the photo itself: progress in %, "sends when you're
    back", Retry.
  - Before sending, thumbnails with × sit in the composer.
  - On the phone the picker numbers your choices in send order. The full-screen viewer is always
    dark, with Reply, Create task, Save and Share.

## 7. Screens

Every screen is also on the canvas, where it can be toggled light or dark.

### Computer

| | |
| --- | --- |
| ![Home](screens/desktop-home.webp) Home | ![Inbox](screens/desktop-inbox.webp) Inbox "Needs you" |
| ![Empty Inbox](screens/desktop-inboxempty.webp) Empty Inbox | ![Conversation](screens/desktop-conversation.webp) Conversation with `/` actions |
| ![Thread](screens/desktop-thread.webp) Thread in the panel | ![Task from conversation](screens/desktop-panel.webp) Task in the panel, agent thinking |
| ![Task notice](screens/desktop-tasknotice.webp) Task notices with source | ![Blocker and result](screens/desktop-blockerresult.webp) Blocker and result |
| ![Files and photos](screens/desktop-attachments.webp) Files and photos | ![Tasks](screens/desktop-tasks.webp) Tasks |
| ![New task](screens/desktop-createtask.webp) New task (`C`) | ![Map](screens/desktop-map.webp) Map |
| ![Wiki](screens/desktop-wiki.webp) Wiki | ![Agents](screens/desktop-agents.webp) Agents |
| ![Hand-off](screens/desktop-handoff.webp) Hand-off to an agent | ![Command menu](screens/desktop-palette.webp) ⌘K |
| ![Focus](screens/desktop-focus.webp) Focus mode | ![New project](screens/desktop-newproject.webp) New project |
| ![Notifications](screens/desktop-settings.webp) Settings · Notifications | ![Appearance](screens/desktop-appearance.webp) Settings · Appearance, Agents and AI |
| ![Sign in](screens/desktop-signin.webp) Sign in | ![Dark](screens/desktop-conversation-dark.webp) Conversation, dark |

### Phone

| | | | |
| --- | --- | --- | --- |
| ![](screens/phone-home.webp) Home | ![](screens/phone-inbox.webp) Inbox | ![](screens/phone-projects.webp) Projects and messages | ![](screens/phone-search.webp) Search |
| ![](screens/phone-create.webp) "+" Create | ![](screens/phone-conversation.webp) Conversation | ![](screens/phone-messagemenu.webp) Message menu | ![](screens/phone-thread.webp) Thread |
| ![](screens/phone-tasksheet.webp) Task, half sheet | ![](screens/phone-taskfull.webp) Task, full sheet | ![](screens/phone-tasks.webp) Tasks | ![](screens/phone-createtask.webp) New task |
| ![](screens/phone-tasknotice.webp) Task notices | ![](screens/phone-handoff.webp) Hand-off | ![](screens/phone-map.webp) Map | ![](screens/phone-wiki.webp) Wiki |
| ![](screens/phone-agents.webp) Agents | ![](screens/phone-agentdetail.webp) Agent | ![](screens/phone-blockerresult.webp) Blocker and result | ![](screens/phone-viewsmenu.webp) View menu |
| ![](screens/phone-photopick.webp) Photo picker | ![](screens/phone-photosent.webp) Photos in a conversation | ![](screens/phone-photoview.webp) Photo viewer | ![](screens/phone-newproject.webp) New project |
| ![](screens/phone-settings.webp) Notifications | ![](screens/phone-appearance.webp) Appearance, Agents and AI | ![](screens/phone-signin.webp) Sign in | ![](screens/phone-conversation-dark.webp) Conversation, dark |

### Small moments on the phone

| | | | |
| --- | --- | --- | --- |
| ![](screens/phone-splash.webp) Splash | ![](screens/phone-loading.webp) Loading | ![](screens/phone-agentthinking.webp) Agent thinking | ![](screens/phone-inboxempty.webp) Empty Inbox |
| ![](screens/phone-offline.webp) Offline | ![](screens/phone-noresults.webp) No results | ![](screens/phone-pullrefresh.webp) Pull to refresh | ![](screens/phone-goal.webp) Goal reached |

### Research behind the design

| | |
| --- | --- |
| ![How other products show agents](screens/reference-resagents.webp) How other products show agents | ![Interface trends](screens/reference-restrends.webp) Interface trends |

## 8. Remove from the application

- The Decisions view and its archive (S1).
- Accent colour families and the theme colour picker.
- Gradient orbs and robot glyphs for agents; corner status dots. Kreska replaces them.
- Chip rows and stacked toolbars inside a project on the phone; "+" in the phone task header (the
  one "+" replaces it).
- Separate "Ask an agent" and "Cite" buttons in the composer (S5).
- The "Create work" wording (P8).
- Rightward swipes.
- Connecting and arranging map thoughts on the phone (S15).

## 9. Accepting an implementation

- **Render matching.** Compare against the renders above at 1440 × 900 and 390 × 844, in light and
  dark, with demo data. Pass a neutral visual review.
- **The running application.** Exercise it in Chromium and WebKit emulation:
  - keyboard paths (section 4);
  - touch targets of at least 44 px;
  - contrast of at least 4.5:1 for text and 3:1 for icons;
  - reduced motion, with every expression readable as a static frame;
  - the Kreska setting turns off every small moment.
- **Agent marking.** An agent is never shown with a circle avatar or without the "Agent" tag.
- **Colour.** Outside the Agents section and user photos, no colour appears.
- **Functional contracts.** The existing contracts still hold: audiences, permissions, PWA and push
  ([F-010](../../product/decisions.md)), adaptive layouts ([F-015](../adaptive-workspaces.md)),
  co-work and AI modes.

# Flux design direction (O-003)

**Status:** proposed for acceptance in [#15](https://github.com/ColdPhase/flux/issues/15) / PR #33, 2026-09-27. Both founders chose this direction: variant C ([`variant-c-calm-messenger.html`](proposals/o-003-ui-direction/variant-c-calm-messenger.html)). It uses the structure and visible surfaces of `flux-ux-v8.html`, made better in a calm style. Product intent is set in [#44](https://github.com/ColdPhase/flux/issues/44). Variants A and B were rejected as overwhelming. The identity is the **rail** (founder decision, 2026-09-27; see [Identity](#identity)).

**References:**
- Slack and Discord for structure;
- Linear for restraint and speed;
- Apple Notes and Messages for minimalism;
- `flux-ux-v8.html` as the baseline for discoverability and ergonomics, so Flux is never worse than it.

## Principles

1. **One focus at a time.** The conversation or current surface is the centre. Details (a decision, work, sources, agents, permissions) open **on demand** in a side panel on desktop or a sheet on the phone. They are never all shown at once.
2. **Human language first.** Write "New decision: exclude items guests can't open", not "D-2 accepted". Internal IDs appear only in details, muted.
3. **Connected, visible surfaces.** Each project offers **Conversation · Tasks · Map · Docs** as quiet text tabs. One compact current-state line (rule · work · result) links into the details. Flux is a creative workspace, not just a messenger or a task dashboard.
4. **Maps are for thinking.** A map is a sketch of thoughts with many-to-many links, not a pipeline or a board: an idea links to several options, one experiment tests several thoughts, a result points to the next option. A visible **+** beside the selected thought adds a connected thought in one action, then edits it inline. Thoughts are dragged (the canvas never moves with them), multi-selected, connected, turned into an experiment, and every change says what happened and can be undone. The keyboard does the same (arrow keys move, Enter edits, Space selects several, + adds, Ctrl/⌘ Z undoes), and **List** shows the same thoughts and links in reading order. Selecting a thought never opens a panel; **Open** does, on request.
5. **Every place shows its audience.** A DM says "only Kai and you"; a project names its members. Selected DM messages can start a sketch that stays in the DM. Making a project from it previews the exact people ("Jo, Kai — only you two") and content, and states what stays private.
6. **Calm difficult states.** A missing source, restricted access, a stopped agent or a failed send is shown as one quiet line with an icon and an action (Fix link, Request access, Resume, Retry). At most one soft tint. States never rely on colour alone.
7. **Quiet, personal agents.** An agent appears as a line in the feed ("Review agent is reading the result…") or as a small presence. Its grant, payer and authorizing person are visible in its detail view. Nothing happens silently. Assistants follow [#57](https://github.com/ColdPhase/flux/issues/57) and the personal-AI design in [PR #64](https://github.com/ColdPhase/flux/pull/64): the ✦ in the composer always means *your* assistant, with the audience and payer shown before asking; an answer reads "Your assistant · asked by you"; someone else's output reads "Kai's assistant drafted this — proposal · Waiting for Kai", with no Retry or Accept for readers; without a connection, ✦ explains "Kai's can't be used for you" and offers **Connect your AI**, and human work is unchanged.
8. **No guilt.** No streaks, rankings, forced inbox clearing or urgency theatre. Returning shows what changed and the next step.

## Layout

- **Desktop:** a 60 px dark **rail** with the Flux mark, Home, Direct messages, geometric project monograms and "New project", and a lime marker beside the current place. No workspace selector. Next to it a 232 px light sidebar lists what is inside the current place: Jump to, **Capture** (private until shared) and the open project's conversations, or the direct messages. Then a reading column of about 700 px; a header with the project monogram, title, current-state line (or the audience line in a DM), view tabs and a labelled **Details** button; a 384 px details panel that is closed by default.
- **Return anchor:** the feed opens on the day line of the result that needs you and always at a whole message or line, never mid-message. Under the result, one quiet evidence line names the decision it follows and its source ("Based on Current rule: … · Source: Permission test output"); each part opens its panel view.
- **At 1180 px and below,** the rail and sidebar become one drawer. **At 980 px and below,** the details panel overlays the content. An open drawer or overlaid panel is modal: everything outside it is inert, the skip link included, and Tab and Shift+Tab cycle inside it. Esc returns focus to the control that opened it.
- **Map:** the sketch canvas fills the wide pane (up to 1040 px) with a toolbar above it (**+ Thought · Connect · Experiment · Undo**, then the latest change) and Map/List on the right. Thoughts are 184 px cards with a kind, a title and their source. On the phone the thoughts sit in two staggered columns, link labels show only for the selected thought, and dragging starts on a selected thought so the page still scrolls.
- **Phone:** a single column like Messages; every primary target is at least 44 × 44 px. The header shows the topic and **Details**. The current-state line collapses to one 44 px row. The result shows its rule and source cue ("Rule: … · Source: …") in the first screen. The sidebar is a drawer and details are a full-screen sheet. The composer is pinned and respects safe areas and the keyboard. The feed opens where the reader left off, and the "not sent" pill jumps to the kept draft.

## Tokens

The source of truth is the `:root` block of the variant C prototype. Production code copies it into `apps/web` shared tokens (#40) and keeps it in sync.

| Group | Light | Dark |
| --- | --- | --- |
| Surfaces | `--bg` #FFFFFF, `--bg-side` #F7F7F8, `--bg-hover` #F1F1F3, `--bg-active` #EBEBEE | #141517, #101113, #1D1E21, #25262A |
| Text | `--text` #1B1C1F, `--text-2` #3C3F45, `--text-3` #62666D (≥ 5.1:1) | #EDEDEF, #C9CACE, #9A9CA3 |
| Lines | `--line` #E7E7EA, `--line-strong` #D5D6DA | #26272B, #34353A |
| Accent (the only one; identity **rail**, default) | `--accent` #5159C8 (5.8:1 with white), `--accent-hover` #454CB5, `--accent-soft` #EEEFFB, `--on-accent` #FFF | #8B90F0, #9EA3F5, #1F2140, #101113 |
| Rail (identity **rail**, default) | `--rail-bg` #111310, `--rail-fg` #A9AFA0, `--rail-active` #252C1D, `--lime` #D3EA8A (mark, current marker, badges), `--rail-w` 60 px | `--rail-bg` #0B0C0A |
| Accent (identity **accent**, alternative) | `--accent` #4B6624 (6.5:1 with white), `--accent-hover` #3F5A1D, `--accent-soft` #EEF3E3 | #B5CF73 (10.6:1 on `--bg`), #C2DA84, #1E2616, #101113 |
| Sketch links | `--edge` #A6A9B0; links of the selected thought use `--accent` | #5A5D64 |
| Project monograms | `--pm-1…4` tints with `--pm-N-t` letters (≥ 7.8:1): olive, violet, teal, sand; shapes square, circle, leaf, cut corner | dark tints with light letters |
| Status | `--danger` #B42318, `--warning` #8A5300, `--ok` #1A7F4B | #F08A80, #E0A650, #5FC08A |

The accent marks only "needs you" and the primary action. The current rule uses the rule icon, not a green dot, so it never reads as the green accent.

- **Type:** Inter, falling back to the system UI font. Body text is 15 px, rising to 16 px on touch devices; metadata is at least 12 px.
- **Radii:** 6, 8 and 12 px.
- **Controls:** 32 px on desktop and at least 44 × 44 px on coarse pointers. The only smaller targets are inline references inside a sentence or evidence line (`.ref`, at least 24 × 24 px under the WCAG 2.5.8 inline exception).
- **Separators:** 1 px lines instead of boxes.

**Motion:**
- `--dur-1` 120 ms for feedback, `--dur-2` 180 ms for content changes, `--dur-3` 280 ms for panels and sheets, and a 24 ms stagger.
- The easings are `--ease-out`, `--ease-in` and the overshoot-free `--ease-sheet`.
- Only transform, opacity and grid-row height animate. All durations drop to 0 under `prefers-reduced-motion`.

## Identity

**Decision (founder, Maurycy, 2026-09-27): the Flux identity is the rail.** It is the default (`data-identity="rail"` on `<html>`). The prototype keeps `?identity=accent` as the documented alternative for comparison.

- **rail (default).** A 60 px dark rail on the far left, v8's `#111310`, holds the Flux mark, Home, Direct messages, the geometric project monograms and "New project". A lime marker bar grows beside the current place and lime badges count what needs you, as in Discord's server rail. The light sidebar narrows to 232 px and shows what is inside the current place. On narrow screens the rail travels inside the drawer. The accent is indigo.
- **accent (alternative).** v8's olive green is the only accent; the Flux mark and a lowercase "flux" wordmark head the sidebar, and the mark opens the "You were away" and "Today" divider lines.

**Why the rail:** it is v8's most recognisable element and makes the places (Home, DMs, each project with its own audience) visible at once, which #44's independent project audiences need. Accepted trade-offs: on the phone the rail is inside the drawer, so the phone's first screen carries the identity only through the indigo accent and the monogram; the lime rail marker sits next to an indigo accent, so lime stays on the rail only.

## Components

Button (primary uses the accent; quiet is text only), IconButton, Rail button and project monogram, evidence line (`.basis` with inline references), Input and Composer, Tabs with a sliding indicator, Chip (an attachment or reference), SidePanel with directional view transitions, Sheet, Drawer (both modal when overlaid, with contained focus), Toast, Pill, a state line, and Empty and Error states.

Added for #44 and #57: **Sketch** (thought card, link with an optional label, the floating **+**, the toolbar with a live status line, Map/List), **message selection** (a check per message and a bottom bar, "Start sketch from these messages"), **audience preview** (the people, what goes in, what stays private), **ask mode** in the composer (an accent chip "Your assistant ×", audience and payer), **assistant answer** (Fact / Interpretation / Proposal) and **proposal** (the only framed object an assistant adds).

Press feedback scales to 0.98. The focus ring fades in, is always visible and follows the accent colour. Tooltips appear after 450 ms and only on devices that can hover.

## Evidence and limits

The audits for [evidence.md](proposals/o-003-ui-direction/evidence.md) run in Docker Playwright: overflow, contrast (light and, for C, dark), 12 px text, 44 × 44 px targets with exceptions named by selector, 200% zoom, the software keyboard, focus rings and reduced motion. They cover all variants and 67 opened states of C in both identities, including the Map sketch, the DM → sketch → project scenario and the assistant states. `tools/interactions.py` runs 243 checks in both identities, including modal focus containment and direct manipulation of the sketch.

Not yet covered:
- screen readers;
- non-text contrast (borders, icons, sketch links);
- frame rate on real devices;
- real touch dragging on devices, and real iOS and Android keyboards and install (#20).

The prototype is static, so production behavior is verified in the application tasks that implement it (#40, #36 and later).

## Reuse

Every UI task builds on #40's tokens and components. A task links this document, keeps the principles above, and shows its screens to the founders early. A change to a principle or token updates this file in the same PR.

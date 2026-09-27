# Flux design direction (O-003)

**Status:** proposed for acceptance in [#15](https://github.com/ColdPhase/flux/issues/15) / PR #33, 2026-09-27. Both founders chose this direction: variant C ([`variant-c-calm-messenger.html`](proposals/o-003-ui-direction/variant-c-calm-messenger.html)). It uses the structure and visible surfaces of `flux-ux-v8.html`, made better in a calm style. Product intent is set in [#44](https://github.com/ColdPhase/flux/issues/44). Variants A and B were rejected as overwhelming.

**References:**
- Slack and Discord for structure;
- Linear for restraint and speed;
- Apple Notes and Messages for minimalism;
- `flux-ux-v8.html` as the baseline for discoverability and ergonomics, so Flux is never worse than it.

## Principles

1. **One focus at a time.** The conversation or current surface is the centre. Details (a decision, work, sources, agents, permissions) open **on demand** in a side panel on desktop or a sheet on the phone. They are never all shown at once.
2. **Human language first.** Write "New decision: exclude items guests can't open", not "D-2 accepted". Internal IDs appear only in details, muted.
3. **Connected, visible surfaces.** Each project offers **Conversation · Tasks · Map · Docs** as quiet text tabs. One compact current-state line (rule · work · result) links into the details. Flux is a creative workspace, not just a messenger or a task dashboard. Map and sketches invite thinking, with a visible "+ New thought".
4. **Calm difficult states.** A missing source, restricted access, a stopped agent or a failed send is shown as one quiet line with an icon and an action (Fix link, Request access, Resume, Retry). At most one soft tint. States never rely on colour alone.
5. **Quiet agents.** An agent appears as a line in the feed ("Review agent is reading the result…") or as a small presence. Its grant, payer and authorizing person are visible in its detail view. Nothing happens silently.
6. **No guilt.** No streaks, rankings, forced inbox clearing or urgency theatre. Returning shows what changed and the next step.

## Layout

- **Desktop:** a 244 px sidebar (Home/return view, Projects, Direct messages, quick capture, user); a reading column of about 700 px; a header with the title, the view tabs and a labelled **Details** button; a 384 px details panel that is closed by default.
- **At 1180 px and below,** the sidebar becomes a drawer. **At 980 px and below,** the details panel overlays the content.
- **Phone:** a single column like Messages. The header shows the topic and **Details**. The current-state line collapses to one 44 px row. The sidebar is a drawer and details are a full-screen sheet. The composer is pinned and respects safe areas and the keyboard. The feed opens where the reader left off, and the "not sent" pill jumps to the kept draft.

## Tokens

The source of truth is the `:root` block of the variant C prototype. Production code copies it into `apps/web` shared tokens (#40) and keeps it in sync.

| Group | Light | Dark |
| --- | --- | --- |
| Surfaces | `--bg` #FFFFFF, `--bg-side` #F7F7F8, `--bg-hover` #F1F1F3, `--bg-active` #EBEBEE | #141517, #101113, #1D1E21, #25262A |
| Text | `--text` #1B1C1F, `--text-2` #3C3F45, `--text-3` #62666D (≥ 5.1:1) | #EDEDEF, #C9CACE, #9A9CA3 |
| Lines | `--line` #E7E7EA, `--line-strong` #D5D6DA | #26272B, #34353A |
| Accent (the only one) | `--accent` #5159C8, `--accent-soft` #EEEFFB, `--on-accent` #FFF | #8B90F0, #1F2140, #101113 |
| Status | `--danger` #B42318, `--warning` #8A5300, `--ok` #1A7F4B | #F08A80, #E0A650, #5FC08A |

The accent marks only "needs you" and the primary action.

- **Type:** Inter, falling back to the system UI font. Body text is 15 px, rising to 16 px on touch devices; metadata is at least 12 px.
- **Radii:** 6, 8 and 12 px.
- **Controls:** 32 px on desktop and 44 px on coarse pointers.
- **Separators:** 1 px lines instead of boxes.

**Motion:**
- `--dur-1` 120 ms for feedback, `--dur-2` 180 ms for content changes, `--dur-3` 280 ms for panels and sheets, and a 24 ms stagger.
- The easings are `--ease-out`, `--ease-in` and the overshoot-free `--ease-sheet`.
- Only transform, opacity and grid-row height animate. All durations drop to 0 under `prefers-reduced-motion`.

## Components

Button (primary uses the accent; quiet is text only), IconButton, Input and Composer, Tabs with a sliding indicator, Chip (an attachment or reference), SidePanel with directional view transitions, Sheet, Drawer, Toast, Pill, a state line, and Empty and Error states.

Press feedback scales to 0.98. The focus ring fades in, is always visible and follows the accent colour. Tooltips appear after 450 ms and only on devices that can hover.

## Evidence and limits

The audits for [evidence.md](proposals/o-003-ui-direction/evidence.md) run in Docker Playwright: overflow, contrast, 12 px text, 44 px targets, 200% zoom, the software keyboard, focus rings and reduced motion. They cover all variants and 18 opened states of C, and there is a separate 53-step interaction script.

Not yet covered:
- screen readers;
- dark-theme contrast;
- frame rate on real devices;
- real iOS and Android keyboards and install (#20).

The prototype is static, so production behavior is verified in the application tasks that implement it (#40, #36 and later).

## Reuse

Every UI task builds on #40's tokens and components. A task links this document, keeps the principles above, and shows its screens to the founders early. A change to a principle or token updates this file in the same PR.

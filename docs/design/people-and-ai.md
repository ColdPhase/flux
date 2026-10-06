# People and AI, visibly together (F-025)

- **Status:** proposed, 2026-10-06, by claude-maurycy (Zamojski5). Evaluator: claude-hubert.
  Acceptance is by independent peer review on the PR that adds this page.
- **Founder direction** (Maurycy, 2026-10-06, relayed from chat, typing errors corrected): "tylko
  bardziej bym chciał tak elevenlabsowo … żeby było widać, że to jest połączenie ludzi i AI, że AI
  ma jakiś swój wyróżnik, że widać, że oni pracują, coś robią". In English: more ElevenLabs-like,
  so it is visible that this is people and AI together, that AI has its own mark, and that they are
  visibly working. Shown the result (v5), he said: "podoba mi się teraz to UI najnowsze" ("I like
  the newest UI now").
- **Evidence:**
  - The renders, the earlier directions (v2–v4) and what ElevenLabs does (observed 2026-10-06) are
    in [#302](https://github.com/ColdPhase/flux/pull/302): `docs/design/research/2026-10-06-calm-renders/`
    and section 11 of the calm research note.
  - v3 put the desktop 11.6 look onto the phone; the founder rejected it as heavy.
- **Keeps:**
  - the 11.6 structure (one project conversation, views, places);
  - PF-1, PF-3 to PF-7;
  - the [HIG checklist](apple-hig-mobile.md);
  - UI116-2 and UI116-5;
  - every access rule.
- **Amends, once accepted:** the 11.6 colour roles, the #148 accent families and PF-2's label
  rule, as listed under [Amendments](#amendments).

## The idea

Flux is where people and their agents work together. The interface shows that at a glance:

- **People are calm and neutral.**
- **Each agent has a face of its own:** an orb.
- **You can see an agent working**, and only when it really is.

## PA-1. Monochrome surfaces

Chrome is warm white and near-black. There is no accent colour in navigation, selection or
buttons. One primary action per screen uses the action colour.

| Role | Light | Dark |
| --- | --- | --- |
| Page | `#fcfbfa` | `#141414` |
| Raised (cards, sheets, composer) | `#ffffff` | `#1c1b1a` |
| Quiet fill (search, segmented track, current place) | `#f4f2ef` | `#242322` |
| Bubble (people and agents) | `#f2f0ed` | `#262524` |
| Text | `#151515` | `#f2f0ed` |
| Secondary text | `#6b6660` | `#a39e97` |
| Hairline | `#e9e6e2` | `#2e2d2b` |
| Action (primary pill, Send, own bubble) / on action | `#111111` / `#ffffff` | `#f2f0ed` / `#141414` |

Other colour roles:

- **Current place, tab or segment:** a quiet fill plus a heavier weight, never colour alone.
- **Unread:** a dot in the text colour.
- **Links:** text colour, underlined.
- **Focus:** a 2 px ring in the text colour with a 2 px offset.
- **Status:** the 11.6 `--ok`, `--warning` and `--danger` stay, for status text and marks only.

**Acceptance:**

- `scripts/check_contrast.py` checks both themes: text ≥ 4.5:1, and secondary text and
  boundaries ≥ 3:1 where WCAG requires it.
- A UI test finds no accent-family colour in chrome.

## PA-2. One orb per agent connection

An agent's avatar is an **orb**: a sphere filled with a soft multi-stop gradient and a fixed grain.
It is drawn with CSS gradients and one shared static noise texture, with no WebGL.

- **Palettes:** there are eight (copper, lagoon, violet, rose, sun, sea, moss, slate). Each
  connection keeps one palette.
- **Choosing a palette:**
  - The owner chooses it in Settings → "Your agents' colour". This replaces #148's accent
    choice, so the setting survives with a new meaning.
  - Without a choice, the palette comes from a stable hash of the connection ID.
  - The built-in assistant is violet.
  - Within one project, two working connections never share a palette while another palette
    is free.
- **Where the orb appears:** wherever an agent appears, including messages, the header, Agents,
  a task's executor or reviewer, notifications and the projects list.
- **Never colour alone:** an agent's message header always shows the orb **plus the name and an
  "AI" badge**.
- **People never get an orb.** A person is neutral initials on the quiet fill.

**Acceptance:**

- A unit test shows palette assignment is stable across reloads and accounts.
- A UI test shows every agent-authored entry has an orb, a name and an AI badge, and no
  person's entry has an orb.

## PA-3. Visible work, only when it is real

- **While a connection's run is executing**, as the server reports it (UI116-5's "authenticated
  active execution/review"), its orb turns slowly (one turn in about 9 s), and its one-line status
  shimmers.
- **When it is queued, waiting for consent, waiting for review or offline**, the orb is still and
  the status is plain text, for example "Waiting for your consent" or "Offline".
- **The status text is the run's reported activity:** the task title, a file name or a step,
  with the elapsed time from server timestamps. It never shows generated thoughts or a progress
  percent (UI116-2).
- **Motion stops:**
  - when the page is hidden, the orb is off screen, or a modal covers it (#155);
  - completely under reduced motion. Every state still reads correctly from the text.

**Acceptance:**

- A UI test with an executing fixture run shows the live state.
- Stopping the run makes it still within one stream event.
- A reduced-motion run shows no animation.
- A negative control: forcing the live class on a queued run fails the test.

## PA-4. Messages

- **Bubble colours:**
  - Your own messages use the action colour with inverse text.
  - Other people's messages use the bubble colour.
  - An agent's messages use the bubble colour, with its orb and the AI badge.
- **A run started from this conversation or task** shows one work card in the stream: orb, name,
  owner, status (PA-3) and a link to its task. It updates in place and ends as the run's result
  or blocker.
- **Shape and labels:**
  - Bubble radius 20.
  - The name sits above the first message in a run.
  - Days are separated by a date.
  - There are no IDs on messages.

## PA-5. The header names both groups

A project or DM header shows the title, then "N people · M AI" with up to four faces and orbs.
Tapping it opens Details, with members and connections. The count comes from current access,
not from history.

## PA-6. Agents

There is one card per connection, never one per owner, so a second agent is not hidden
(UI116-2).

- **Each card shows:** the orb, the name, owner and client, the PA-3 state, and the current task
  with its elapsed time.
- **A consent request** offers the screen's one primary action, "Allow", and a secondary "Deny".
- **A filter** above the cards: Working · Waiting · All, with counts.

## PA-7. Composer

The composer is one pill: attach (+), the field, ask the assistant (its orb), and Send (the
action colour). PF-3's quiet audience line stays under the pill; the v5 renders leave it out.

## PA-8. One identity on every size

PA-1 to PA-7 apply to phone, tablet and desktop.

- **Desktop keeps its own layout:** the sidebar, the sheet, panels and compact sizes. Only colour
  roles, avatars, messages and work states change.
- **Why:** the founder wants the phone to stay consistent with Flux, and one identity avoids two
  products.

## Amendments

| Contract | Today | With F-025 |
| --- | --- | --- |
| F-017, [11.6 design system](studio-v11.6-design-system.md) tokens | Mint accent for selection, links, focus and unread; slate `--action`; mint-tinted own bubble | PA-1 roles. The token names stay; their values and uses change. |
| #148, [theme accents](theme-accents.md) | The person picks Mint, Sky or Copper for the chrome | The choice becomes the colour of the person's own agents (PA-2). Light/dark stays. |
| PF-2, [phone-first](phone-first.md) | "No control is a bare icon" | Navigation keeps words. Actions may be symbols with accessible names, which is principle 3 of #302 and HIG-26. |
| D1 (#302) | Open | Unchanged. The v5 renders leave out the tab bar inside a conversation, but F-025 does not decide D1. |

## Delivery slices

These become issues once F-025 is accepted. The owner is in brackets: Mz is claude-maurycy,
H is claude-hubert.

1. **PA-1 tokens for both themes**, people's initials, and contrast checks. [Mz]
2. **The orb component**, palettes, assignment and the agents' colour setting (PA-2). [Mz]
3. **Truthful working state** from the server's run activity to orb and status (PA-3). [H, who
   owns the agent runtime]
4. **Messages, work card, header and composer** (PA-4, PA-5, PA-7). [Mz]
5. **The Agents view and consent card** (PA-6). [H, who owns UI116-2]
6. **The projects list's live orb, notifications, and desktop parity** (PA-8). [Mz]

## Revisit when

- People in a first-use test cannot tell agents from people.
- The orb or shimmer costs more than a frame on a low-end Android phone.
- A contrast check fails in either theme.

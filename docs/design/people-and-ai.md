# People and AI on the phone (F-025)

- **Status:** proposed, 2026-10-06, by claude-maurycy (Zamojski5). Evaluator: claude-hubert.
  Acceptance is by independent peer review on the PR that adds this page.
- **Scope:** the **phone layout only** (≤ 640 px, the PF-1 breakpoint). Tablet and desktop keep
  Studio 11.6 unchanged: tokens, mint/sky/copper accents, layout. This is a new appearance for
  **the features Flux already has**. It adds no feature, permission or data.
- **Founder direction** (Maurycy, 2026-10-06, relayed from chat, typing errors corrected):
  - "tylko bardziej bym chciał tak elevenlabsowo … żeby było widać, że to jest połączenie ludzi i
    AI, że AI ma jakiś swój wyróżnik, że widać, że oni pracują, coś robią". In English: more
    ElevenLabs-like, so it is visible that this is people and AI together, that AI has its own
    mark, and that they are visibly working.
  - On v5: "podoba mi się teraz to UI najnowsze" ("I like the newest UI now").
  - On scope: "desktopu wyglądu nie zmieniamy, tylko mobile miał być taki, z funkcjonalnościami,
    które mamy" ("we don't change the desktop's look; only mobile should look like this, with the
    features we have").
- **Evidence:** the renders, the earlier directions (v2–v4) and what ElevenLabs does (observed
  2026-10-06) are on [#302](https://github.com/ColdPhase/flux/pull/302), in
  `docs/design/research/2026-10-06-calm-renders/` and section 11 of the calm research note. The
  renders are illustrations. Where they show something Flux does not have (a consent request on
  Agents, an "N min" work card, a per-agent colour setting), this contract does **not** adopt it.
- **Keeps:**
  - the 11.6 structure: one project conversation, the views, the places;
  - PF-1 and PF-3 to PF-7;
  - the [HIG checklist](apple-hig-mobile.md);
  - UI116-2 and UI116-5;
  - every access rule.
- **Amends, once accepted, on phones only:** the 11.6 colour roles and PF-2's label rule; see
  [Amendments](#amendments).

## The idea

On the phone, Flux shows at a glance that people and their agents work together:

- people are calm and neutral;
- each agent has a face of its own, an orb;
- you see an agent working, and only when it really is.

## PA-1. Monochrome surfaces on phones

On phones, chrome is warm white and near-black, with no accent colour in navigation, selection or
buttons. One primary action per screen uses the action colour. The values apply under the phone
media query only. The token names stay the same, so components need no forks.

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

- **Selection:** a current place, tab or segment uses the quiet fill and a heavier weight, never
  colour alone.
- **Unread:** a dot in the text colour.
- **Links:** text colour, underlined.
- **Focus:** a 2 px ring in the text colour with a 2 px offset.
- **Status colours:** the 11.6 `--ok`, `--warning` and `--danger` stay for status text and marks.
- **The person's #148 accent** still applies on tablet and desktop. On phones the chrome ignores it.

**Acceptance:**

- `scripts/check_contrast.py` checks the phone palette in both themes: text at least 4.5:1, and
  secondary text and boundaries at least 3:1 where WCAG requires it.
- A UI test at 390 px finds no accent colour in chrome. At 1440 px the 11.6 accent is unchanged.

## PA-2. One orb per agent

Wherever an agent appears on a phone, its avatar is an **orb**: a sphere with a soft multi-stop
gradient and a fixed grain. It is drawn with CSS gradients and one shared static noise texture,
with no WebGL.

- **Which agents:** the person's assistant (the agent in Flux) and every agent connection (MCP).
- **Where it shows:** messages, the header, Agents, a task's executor or reviewer, the projects
  list and notifications.
- **Colour:** eight palettes. A connection's palette comes from a stable hash of its ID; the
  built-in assistant is violet. There is no new setting.
- **Never colour alone:** an agent's message header shows the orb **plus the name and an "AI"
  badge**.
- **People never get an orb.** A person is shown as neutral initials on the quiet fill.

**Acceptance:**

- A unit test shows palette assignment is stable.
- A UI test at 390 px shows that every agent-authored entry has an orb, a name and an AI badge,
  and that no person's entry has an orb.

## PA-3. Visible work, from states Flux already has

An orb turns slowly (one turn in about 9 s) and its status line shimmers only for states that
UI116-5 counts as active execution, mapped from today's data:

| Who | Moving (orb turns, line shimmers) | Still (plain text) |
| --- | --- | --- |
| The person's assistant (`AssistantRun`) | `reading`, `dispatching`, with today's `workingText` | `queued` ("getting ready"), stopping, and every ended state with today's `endedText` |
| An agent connection (Agents view, `ProjectAgents`) | It holds a live co-work claim on a task, once #261's claims are on `main`; the line is today's "Last: … · time" | `session_open` without a claim, `offline`, `unavailable`, configured |

- **Status text:** existing text only. Nothing is invented: no thoughts, no percent, no timer the
  server does not report (UI116-2).
- **When motion stops:** when the page is hidden, the orb is off screen, or a modal covers it
  (#155). Under reduced motion there is no motion at all, and every state reads correctly from its
  text.

**Acceptance:**

- A UI test with a fixture run in `reading` shows the moving state.
- The test changes the run to an ended state and expects stillness within one stream event.
- A reduced-motion run shows no animation.
- Negative control: forcing the moving state on a `queued` run fails the test.

## PA-4. Messages on phones

- **Bubble colours:**
  - your own messages use the action colour with inverse text;
  - other people's messages use the bubble colour;
  - an agent's messages use the bubble colour, with its orb and the AI badge.
- **The assistant's working line** (PA-3) sits in the stream where it is today.
- **Shape and headings:** bubble radius 20. The name sits above the first message of a run, and a
  date separates days. Messages show no IDs.
- **Unchanged:** results, blockers, task notices, replies and files keep their current content.
  They are restyled to PA-1 (soft cards, no coloured side rules) and keep their status colours.

## PA-5. The phone header names both groups

The header shows the title, then "N people · M AI", using up to four faces and orbs. Both counts
come from the project's current members and agent connections. Tapping it opens the existing
Details.

## PA-6. Agents on phones

The existing Agents view (UI116-2: one card per connection, so a second agent is never hidden)
is restyled. Each card shows the orb, the name, the owner and client, and the PA-3 state with
today's text. Nothing new is added.

## PA-7. Composer on phones

The existing composer becomes one pill: attach (+), the field, ask the assistant (its orb, where
the assistant is available today), and Send in the action colour. PF-3's quiet audience line stays
under the pill; the v5 renders leave it out.

## Amendments

These apply to phones only.

| Contract | Today | With F-025 on phones (≤ 640 px) |
| --- | --- | --- |
| F-017, [11.6 design system](studio-v11.6-design-system.md) tokens | Mint accent for selection, links, focus and unread; slate `--action`; mint-tinted own bubble | PA-1 values under the phone query; tablet and desktop unchanged |
| #148, [theme accents](theme-accents.md) | The chosen accent colours the chrome on every size | It still does on tablet and desktop; phone chrome is monochrome |
| PF-2, [phone-first](phone-first.md) | "No control is a bare icon" | Navigation keeps words; actions may be symbols with accessible names, as in principle 3 of #302 and HIG-26 |
| D1 (#302) | Open | Unchanged. The v5 renders leave out the tab bar inside a conversation, but F-025 does not decide D1 |

## Delivery slices

These become issues once F-025 is accepted. The owner is in brackets: Mz is claude-maurycy, H is
claude-hubert.

1. **Tokens:** PA-1 phone tokens in both themes, people's initials, and the contrast checks. [Mz]
2. **Orb:** the orb component, its palettes and their assignment (PA-2). [Mz]
3. **Working state:** PA-3 on the assistant's run states, and on connections' claims after #261.
   [H, who owns the agent runtime]
4. **Conversation:** messages, header and composer on phones (PA-4, PA-5, PA-7). [Mz]
5. **Agents and lists:** the Agents view, the projects list and notifications on phones (PA-6,
   PA-2). [H for Agents, Mz for the lists]

## Revisit when

- People in a first-use test cannot tell agents from people.
- The orb or the shimmer costs more than a frame on a low-end Android phone.
- A contrast check fails in either theme.
- The founders want the same look on tablet or desktop.

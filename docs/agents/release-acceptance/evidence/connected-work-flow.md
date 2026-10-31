# Connected work flow: simulated study

**Date:** 2026-10-31. **Build:** `main` at `f2eec199f`, source stack in Docker (its own Compose
project, port 38300, blank `FLUX_VAPID_*`). **Run by:** claude-hubert (Claude Opus 5.5).
**Mandate:** founder request (Hubert, 2026-10-31, [#249]): before the release, test how work moves
across Flux's surfaces and how easily people find information. The study looks for cognitive
dissonance and checks whether people understand the connections and the flow. It uses the method
of [H-11](h-11-returning-user.md): a simulation with think-aloud, measured actions and a sealed key.
**Criteria touched:** foundation F2 (one connected place for talk, thinking, decisions and work),
F5, 8.8, and the Prostota rules "same function never moves between views" and "one word per object"
([`docs/design/final/README.md`](../../../design/final/README.md)).

## Verdict

**22 of 24 task outcomes pass. Moving a message onto the map fails on the phone (2 of 2 phone
attempts).**

Seven new findings are rated P2 and ten are rated P3. There are no P1 findings.

The connections that exist work well:

- In a thread, a message shows the decision that came from it.
- A decision shows "Based on", "Replaced" and "In the Wiki".
- A task shows "Came from" and its activity.
- The Wiki history names the agent's version.

Every participant traced the idea and named the reason for the decision with its numbers.

Some links work in one direction only, so the flow breaks there:

- A map thought shows its source message but cannot open it.
- A message does not show that it became a thought.
- A newcomer's "What matters" is empty.
- The Wiki editor shows raw `flux:` IDs.
- The phone cannot put a message on the map.

The vocabulary changes from surface to surface: map/sketch, Wiki/doc/page, task/work and
decision/rule.

| Task | P1 desktop | P2 phone | P3 desktop → phone |
| --- | --- | --- | --- |
| T1 Trace an idea from the chat to the map, the Wiki and its tasks, and back to the message | pass · 10 actions · 0 wrong turns | pass · 8 actions · 1 dead end | pass · 9 actions · 3 wrong turns |
| T2 Why SMS and not QR, and where did that come from? | pass · 2 actions | pass · 0 actions (known from T1) | pass · 2 actions |
| T3 A vaguely remembered fact (the locker quote) | pass · search · 1 wrong turn | pass · search · 1 wrong turn | pass · search (phone) · 1 wrong turn |
| T4a Put a message on the map | pass · 4 actions | **fail**: no way on the phone; the thought was typed in by hand without a source | **fail**: gave up on the phone |
| T4b Add a decision to the Wiki | pass · 9 actions · 2 wrong turns | pass · ~14 actions · 3 wrong turns | pass via `/decide` · 6 actions |
| T4c Hand a task to the agent | pass (Ask Sam) · 4 actions | pass · a toast blocked Next once | pass · 4 actions |
| T4d What did the agent change? | pass · 4 of 4 changes · 1 wrong turn | pass · 3 of 4 | pass · 3 of 4, "a doc" unnamed |
| T5 Check a result against the task's criteria, and who changed what | pass | pass | pass |

Pass thresholds were written before the sessions. They are in the sealed task file; their wording
is in "Tasks and thresholds" below.

## Method

**Scenario.** Each participant worked in a separate copy ("world") of the same project. Every world
had its own accounts. The worlds were seeded only through the public API and real MCP calls, as the
people and the agent would have done the work:

- MCP calls used an OAuth/PKCE bearer and standing grants for `conversation.reply`, `work.update`,
  `result.record` and `doc.update`.
- The worlds were backdated with one SQL pass over every `timestamptz` column, piecewise by recorded
  marks, as in H-11.

The project content:

- **Workspace and projects.** Workspace "Lindenhof Community Kitchen". Project "Meal box pickup";
  "Volunteer rota" is noise.
- **People.**
  - Ola Wójcik, owner.
  - Sam Becker, admin.
  - Nadia Haddad, member.
  - The agent "Sam's Claude Code".
  - Lena Fischer, the participant, joined on 31 Oct as a contributor and knows nothing of the
    project.
- **13 Oct, brainstorm.** Ola asks in the conversation how people should pick up meal boxes. Seven
  replies follow:
  - QR code (Sam);
  - a 4-digit SMS code (Nadia), the traced idea;
  - lockers (Ola);
  - a locker quote from Kowalczyk Metal (Sam), the vague fact;
  - Saturday 10–13 (Nadia);
  - allergen labels (Ola);
  - an unrelated noise message.
- **14 Oct, map.** Sam makes the project map "Pickup ideas". Six thoughts quote the messages as
  their source, and one more thought adds a fallback. All are connected to a centre thought.
- **15–19 Oct, decisions.**
  - D1 "QR code" is accepted.
  - On 17 Oct, Nadia tests QR at the door ("X of Y regulars had no email on their phone").
  - D2 "4-digit SMS code" replaces D1. Its reason gives the numbers, and its sources are Nadia's two
    messages.
  - D3 "Saturday 10:00–13:00" is accepted.
  - D4 "Lockers" is proposed and left open.
- **20 Oct, Wiki.** Ola publishes "How pickup works". It has decision cards for D2 and D3, links to
  the map and to two thoughts, and a "Still open" section.
- **21–24 Oct, tasks.**
  - #1 "Write the SMS text" is made from the SMS thought, with three done-when criteria. Nadia
    records a positive result that finishes it.
  - #2 "Print allergen labels" is made from the allergen thought and is in progress.
  - #3 "Send the pickup codes through the SMS gateway" is made from the SMS thought. Its three
    criteria include "Warns the coordinator when the gateway is down".
  - #4 is done; it is noise.
- **26–29 Oct, agent.** Sam hands #3 to his agent. Through MCP, the agent:
  - posts a plan in the agents' thread;
  - marks #3 in progress;
  - records the positive result "Gateway sends pickup codes", which finishes #3. Its evidence ends
    with "Not tested: what happens when the gateway is down";
  - edits the Wiki page, adding a "Sending codes" section with the reason "Added how codes are sent".
- **30 Oct.** The first Saturday pilot is reported, and Ola replies "Great. Let's keep the name
  list as the fallback."

**Sealed key.** Each world drew its own values at random:

- the locker price and number of doors;
- the door-test numbers in the reason for D2;
- the SMS length.

The values went only to the key file and were checked after the sessions. The author saw world 1's
draw when it was seeded; worlds 2 and 3 were sealed.

**Participants.** One agent played all three participants in sequence; no sub-agents were used.
Each participant got only this brief: "You are Lena Fischer. You joined the Lindenhof Community
Kitchen workspace today as a volunteer coordinator. Nobody briefed you. Use only what Flux shows."
Each worked only from Playwright screenshots and the page's accessibility tree, through a
persistent driver:

- desktop: Chromium, 1440×900;
- phone: WebKit, 390×844, touch, with a long press for message menus.

Every step was logged with its time and a think-aloud note.

| Participant | Profile | Device |
| --- | --- | --- |
| P1 | Methodical; browses the project tabs first | Desktop |
| P2 | Impatient; searches first and taps what is visible | Phone |
| P3 | Skimmer; looks for one summary first | Desktop for T1–T2, phone for T3–T5 |

**Tasks and thresholds** (sealed before the sessions):

- **T1.** "People keep talking about a pickup code by SMS. Find where it started, where it sits on
  the map, on the Wiki, which tasks it became, and get back to the original message." Pass: the
  source message, the map thought, the Wiki page, at least one task, and a return to the source from
  a downstream object.
- **T2.** "Why did the team choose SMS over QR, and where did that come from?" Pass: the drawn
  numbers, Nadia's door test as the source, and the knowledge that QR was replaced.
- **T3.** "Someone got a price for hallway lockers, about two thousand euros. What exactly, and from
  whom?" Pass: the exact price, the number of doors, and Sam or Kowalczyk Metal as the source.
- **T4.** Without docs:
  - (a) put Ola's reply on the map, with its source;
  - (b) add the decision "Keep the name list as the pickup fallback" to "How pickup works";
  - (c) hand #2 to Sam's agent;
  - (d) say what the agent changed. Pass: at least 3 of its 4 changes.
- **T5.** "Is #3 really done? Check its result against its criteria, and who changed what." Pass:
  name criterion 3 as unmet or untested, and say that the agent finished the task after Sam handed
  it over.

**Measures.** For every task:

- UI actions;
- wrong turns: an action that does not move toward the answer;
- dead ends: no way forward from where the participant is;
- dissonance: a moment where the UI contradicts what it said before or what the participant
  expected;
- whether links between objects were visible and understood;
- the words each surface uses for the same object.

Wall time is given only as an indication. It includes the model's thinking time: P1 4 min 3 s
(33 commands), P2 4 min 41 s (27), P3 3 min 7 s (19).

## Results per participant

**P1 (desktop).**

- **T1.**
  - The project opened on the conversation. The brainstorm thread showed decision chips under the
    QR, SMS, lockers and Saturday messages ([thread](connected-work-flow/p1-03-thread.png)).
    Nothing showed that six of these messages are also thoughts on a map.
  - Sam's reply "Put all of these on a map in the project, 'Pickup ideas'" is plain text. P1 used
    the Map tab instead.
  - The map is clear ([map](connected-work-flow/p1-04-map.png)):
    - each thought says "From a message by Nadia · 13 Oct, 09:41";
    - the SMS thought shows "#1 Done" and "2 tasks";
    - "2 tasks" lists #1 and #3.
  - Selecting a thought offered no way to its source, its decision or the Wiki.
  - P1 found the decision card on the Wiki and opened it ([decision
    panel](connected-work-flow/p1-08-decision-from-wiki.png)). The panel shows "Based on" (Nadia's
    two messages), "Replaced", the related tasks and results, and "In the Wiki".
  - "Based on" opened the thread at Nadia's message. P1: "This panel is the map of everything; I
    wish the thought on the map had it."
- **T2.** The panel already gave "5 of 8 regulars had no email…". Opening the replaced QR decision
  showed "Replaced by" with the earlier reason. Confidence 5/5.
- **T3.**
  - "locker price" gave "No results" (wrong turn).
  - "locker" found Sam's message: "2,150 EUR for 16 doors". P1 had also glimpsed the message in the
    brainstorm thread in T1, so this answer is not independent.
- **T4a.**
  - The message menu has "Add to map".
  - It opened the only map with a draft prefilled and the source kept.
  - The new thought was placed at the top left, half under the breadcrumb and over the QR thought
    ([placement](connected-work-flow/p1-15-thought-saved.png)).
- **T4b.**
  - P1 started at the page and pressed Edit (wrong turn). The editor shows raw Markdown with
    `flux:decision/<uuid>` and `flux:thought/<uuid>` ([editor](connected-work-flow/p1-16-wiki-edit.png)).
    The Link picker cannot create a decision (wrong turn).
  - P1 went back to the message: More → Propose a decision → Propose.
  - The decision panel said "Needs you … waiting for you", so P1 accepted her own proposal. Then
    "Add to a Wiki page" → "Add the card".
  - The card went to the end of the page, under "Still open".
- **T4c.** Task panel → Hand off → Sam's Claude Code. Step 2 said "Ask Sam first … Flux will ask Sam
  in the thread of #2", and P1 chose Ask Sam. It was clear.
- **T4d.**
  - The Agents tab → the agent showed "Recent: Edited a doc · 29 Oct" with no link and no other
    actions ([agent](connected-work-flow/p1-30-agent-details.png)). This was a wrong turn.
  - #3's activity lists "Sam handed it off", "marked it in progress", the result and "marked it
    done".
  - Wiki History shows "Added how codes are sent · v2 · Sam's Claude Code · agent" with a rendered
    diff.
- **T5.**
  - #3's panel shows the three "Done when" criteria and "Flux does not check them off".
  - The result panel shows the evidence, "Not tested: what happens when the gateway is down"
    ([result](connected-work-flow/p1-32-result.png)). The result panel does not show the
    criteria, so P1 compared them across two panels.
  - The board card shows "Done · 1 result" with no hint.

**P2 (phone).**

- **T1.**
  - P2 searched "SMS code" and got the decision, the thought, #3, #1 and the result
    ([search](connected-work-flow/p2-02-search-sms.png)). The snippet of the Wiki page shows
    `Pickup ideas](flux:sketch/f4dd…)`.
  - P2 opened Nadia's message, then its decision chip, then "How pickup works", then "Pickup ideas"
    on the map.
  - P2 tapped the SMS thought and its actions to find the source (dead end: Edit, Create task, Cite,
    Remove). "2 tasks" listed #1 and #3.
- **T2.** "3 of 5 regulars …" was read from the decision sheet in T1.
- **T3.** "lockers euro" found nothing (wrong turn); "lockers" found "2,150 EUR for 12
  doors" in world 2. P2: "Search is the way here."
- **T4a. Fail.**
  - The view menu → Conversation reopened the brainstorm thread sheet, not the stream (wrong turn).
  - The long-press menu offers Reply in thread, Create task, Hand off to an agent, Cite and Copy
    text. It has no "Add to map" ([menu](connected-work-flow/p2-14-message-actions.png)).
  - P2 retyped the text as a new thought on the map. It is saved "From you", with no source.
- **T4b.**
  - Edit showed raw Markdown (wrong turn).
  - The project pages have no Create.
  - Back walked the browser history through earlier sheets: 5 taps never reached Home (dead end).
  - Home → Create → Decision opened a different decision form than on the desktop. It has a
    "Replaces" combobox and the line "The message stays where it is and links here" although no
    message was involved.
  - Propose → Accept → Add to a Wiki page.
- **T4c.**
  - On Hand off step 1, the toast "Added to 'How pickup works' · Open" from T4b sat over the footer
    and hid Next ([toast](connected-work-flow/p2-27-toast-covers-next.png)). A tap there would hit
    Open and leave the dialog.
  - P2 dismissed the toast, then Next → Ask Sam.
- **T4d and T5.**
  - #3's sheet opens at half height, with the criteria below the fold.
  - The result says "Not tested: … gateway is down".
  - The activity gives the hand-off and the agent's changes. P2 did not see the agents' thread plan
    (3 of 4).

**P3 (desktop, then phone).**

- **T1.**
  - More → "What matters" showed "Since 31 Oct, 23:32 · Nothing new since your last visit". "Look
    at the last 7 days" said "Nothing new in this period"
    ([what matters](connected-work-flow/p3-03-last-7-days.png)). In fact 24–30 Oct held the agent's
    result, a Wiki edit, task changes and the pilot. Two wrong turns.
  - Project details "Now" lists #2, the latest result, the proposed D4 and only one current rule
    (Saturday), though the SMS rule is also current.
  - Search → the thought opened the map with it selected.
  - Clicking "From a message by Nadia" on the thought did nothing. The map's List view hides that
    line for the selected thought (dead end).
  - P3 got back to the message through search.
- **T2.** The Wiki card's reason gave "5 of 8 …". The card names "17 Oct · Ola Wójcik" (who
  decided), not Nadia (where it came from); one click to "Based on" settled it.
- **T3 (phone).** "price" found nothing (wrong turn); "locker" found "1,620 EUR for 12 doors" from
  Sam.
- **T4a (phone). Fail.** The long-press menu had no map action. "Cite" only quotes the message in
  the reply box. P3: "I'd do this on a computer."
- **T4b (phone).**
  - `/` in the reply box lists `/decide`. Choosing it only inserts the text "/decide". After typing
    a title and Send, the decision form opens with the thread's first message as its source.
  - Propose → Accept → Add the card.
  - The card again landed under "Still open"
    ([card](connected-work-flow/p3-15-card-under-still-open.png)).
- **T4c.** Agents → Hand off a task → Ask Sam.
- **T4d.** The agent sheet showed only "Edited a doc". P3 named the result, #3 done and "a doc" (3
  of 4, with low confidence about which doc).
- **T5.** Result → "Reports on" → the task → "Done when": criterion 3 is untested.

**Correctness check after the sessions.**

- The answers to T2 and T3 match each world's sealed draw: 5/8 and 2,150/16 in world 1, 3/5 and
  2,150/12 in world 2, 5/8 and 1,620/12 in world 3.
- The database holds the following.
  - Thoughts:
    - world 1: a thought with `source_project_message_id` set;
    - world 2: a thought with no source;
    - world 3: no new thought.
  - In each world:
    - an accepted "Keep the name list as the pickup fallback" decision;
    - a v3 of "How pickup works" with its card;
    - the "@Sam Becker can your Sam's Claude Code take #2" message in #2's discussion.
- No participant made a false statement.

## Findings

Findings already filed on [#763] are referenced, not repeated:

- F: Map/Sketch/Sketchbook words;
- A10: "Work:" names;
- E: the decision-card placement proposal;
- FT-4: no Propose a decision on the phone;
- H11-4: "quiet" projects;
- H11-9: twin decision notices.

**CW-1 (P2): On the phone, a message cannot be put on the map, so the chat-to-map step breaks on
touch.**

- Seen in 2 of 2 phone sessions (T4a fail).
- Cause: `app/apps/web/src/work/messageActions.tsx:102` adds "Add to map" only `!touch`. The slash
  menu has `/task`, `/decide` and `/handoff`, but no map action.
- The workarounds lose the source: retyping the message, or Copy text and then Paste on the map.
- Fix direction (Prostota S6, same function in every view): add "Add to map" to the long-press menu
  with the same prefilled draft and source. Optionally add `/map` to the slash menu.

**CW-2 (P2): Links between a message and its thought go one way only.**

- A thought shows "From a message by Nadia · 13 Oct, 09:41", but that line is not a link. The
  thought's actions have no "Open source" (desktop map, desktop List, phone actions sheet).
- The source message shows chips for the decisions made from it, but not for the thought, even
  right after "Add to map".
- In T1, 3 of 3 participants tried to go from the thought to the message and had to detour through
  a decision's "Based on" or through search.
- Fix direction: make the source line a link to `…/conversations/<id>#message-<id>`, as "Based on"
  does. Show the "On the map: <thought>" chip on the source message, as for decisions.

**CW-3 (P2): A newcomer's "What matters" is empty, including "the last 7 days".**

- Lena joined on 31 Oct. "What matters" said "Nothing new since your last visit", then "Nothing new
  in this period", although 24–30 Oct held 10 changes.
- Cause: the summary reads the reader's own audience feed (`packages/core/src/returns/service.ts`,
  `audienceAfter(recipient, …)`), which starts when the person gets access. The period button only
  moves the start inside that feed.
- The result is that the one "catch me up" surface tells a new member there is nothing, and the
  "last 7 days" label is false.
- Fix direction:
  - With no return point and no feed before the grant, compose the first view from what the person
    can read now: the current rules with their reasons, open tasks, the latest results and recent
    Wiki versions.
  - Label it "Before you joined".
  - Never say "Nothing new in this period" when the project has visible changes in it.

**CW-4 (P2): The Wiki editor and search snippets show raw references.**

- Edit shows `[Pickup with a 4-digit SMS code](flux:decision/0dd1f82e-…)` and
  `flux:thought/<uuid>` as source text. On the phone, these fill the screen.
- The decision cards that the reader just saw become ID lines, so a person cannot tell how to add
  one.
- Search snippets of a Wiki page include `Pickup ideas](flux:sketch/f4dd…)`.
- Fix direction: in Write mode, render `flux:` references as the same chips and cards (or open in
  Both on the desktop), and strip link syntax from snippets.

**CW-5 (P2): A toast with an action stays until dismissed and covers sheet footers on the phone.**

- "Added to 'How pickup works' · Open" stayed for more than 3 minutes across pages on the desktop.
- On the phone, it covered Next and Cancel in Hand off step 1. A tap there hits Open and leaves the
  dialog.
- Fix direction: auto-dismiss action toasts too (Undo keeps its window). Lift or hide toasts while a
  sheet with a footer is open.

**CW-6 (P2): Checking a result against its criteria needs two panels, and nothing flags a gap.**

- #3 is "Done" with a "Positive" result, and the board shows "Done · 1 result".
- Only the evidence text says "Not tested: what happens when the gateway is down".
- The task panel shows the criteria, and the result panel does not. All 3 participants passed, but
  only by reading the evidence word by word and switching panels; a skimmer could miss it.
- Fix direction:
  - The result panel lists the done-when criteria of the task it reports on, under the evidence.
  - The task shows the latest result's evidence next to "Done when".
  - "Flux does not check them off" can stay.

**CW-7 (P2): The wording of one object changes from surface to surface.**

| Object | Words seen |
| --- | --- |
| Map | "Map" tab · "Sketches" breadcrumb · "Sketch: Pickup ideas" · "Rename sketch" · "Remove from sketch" · "Sketchbook" (sidebar) · "Sketch" (link picker) · "Thought in 'Pickup ideas'" (search) — known as #763 F |
| Wiki page | "Wiki" · "page" · "doc" ("Edited a doc", "Started the doc", "Back to doc", "Doc · published", "Find a doc, decision…") |
| Task | "Task" · "Work" (link picker) · "work: …" ("Other relationships on this page") · "4 task updates · Ola added 2 tasks on the Map" (they are not on the map) |
| Decision | "Decision" · "Current rule" · "Earlier rule" · "Proposed decision" · "Replaced" |
| Result | "Positive" · "Positive result" · "Result · it worked" (search) |

- Each word is clear on its own, but a newcomer who meets 2–4 names for one object cannot tell
  whether they are different things. P1 asked whether "rule" and "decision" differ.
- Fix direction: one noun per object, as in the Prostota vocabulary:
  - map and thought;
  - Wiki page;
  - task;
  - decision, with the status words accepted, replaced and proposed;
  - result.
- The decision panel's "Other relationships on this page" should read "Tasks" and "Results".

**CW-8 (P3): The agent's "Recent" shows only its latest action, with no link.**

- Agents → Sam's Claude Code shows "Recent: Edited a doc · 29 Oct, 16:48". It does not name which
  doc, and it does not list the result, the two status changes or the plan.
- Fix direction: list the last actions with their objects as links, such as "Recorded result
  Gateway sends pickup codes · #3", "Marked #3 done" and "Edited How pickup works (v2)".

**CW-9 (P3): "Add to a Wiki page" puts the card at the end, under whatever heading is last.**

- Here the last heading was "Still open", so an accepted decision sat under "Still open"
  (2 of 2 sessions that checked).
- #763 E proposed a heading picker. The shipped flow has none.
- Fix direction: offer the page's headings, with "End of page" as the default, as #763 E3
  describes.

**CW-10 (P3): A person can accept their own proposal at once.**

- On her first day, Lena proposed and accepted a rule alone ("Decided: Lena Fischer"). The panel
  said "Needs you … waiting for you".
- Home also offers one-tap Accept to a newcomer for D4 (lockers), with no context.
- If this is intended, say so: "You proposed this. Accept it yourself, or wait for Ola or Sam?"

**CW-11 (P3): Phone navigation.**

- The project views are ordered Conversation, Tasks, Map, Wiki, Agents. The desktop order is
  Conversation, Map, Tasks, Wiki, Agents.
- "Conversation" reopens the last thread sheet instead of the stream.
- Back walks the browser history through earlier sheets. 5 taps did not reach Home, and the
  project pages have no Home or Create.

**CW-12 (P3): A thought made with "Add to map" is placed at the top left of the map**, half under
the breadcrumb and overlapping an existing thought. Fix direction: place it in free space in view
and scroll to it.

**CW-13 (P3): Search.**

- Enter on any query selects "New task '<query>'" first, so a missed search plus Enter makes a
  junk task.
- Queries need exact word stems: "locker price", "lockers euro" and "price" found nothing.
- On the desktop, "Search" opens "Jump to" without the All/Tasks/Wiki chips and the scope that
  the phone has (#763, search).

**CW-14 (P3): The Wiki's thought links open the map without selecting the thought.** They go to
`/map/<sketch>`, while a task's "Came from" goes to `#thought-<id>`. "Links in this page" omits the
two decision cards.

**CW-15 (P3): Project details "Now" shows one current rule** (the latest), although two are
current.

**CW-16 (P3): A Wiki decision card names who decided and when, but not where the decision came
from.** The reader needs one click to "Based on".

**CW-17 (P3): On the phone, the decision form from Home → Create says "The message stays where it
is and links here"** with no message, and it differs from the desktop Create form.

## What works (keep)

- **Decision panel.** It shows "Based on" messages with links, "Replaced" or "Replaced by" with the
  earlier reason, the related tasks and results, and "In the Wiki". It answered T2 for everyone in
  at most 2 actions.
- **Thread decision chips.** A chip under each source message, such as "Pickup with a 4-digit SMS
  code · accepted 17 Oct", made the chat-to-decision link visible.
- **Map.** Each thought shows its source line, its task chips and "2 tasks"; the task list opens in
  place.
- **Task panel.**
  - "Came from" links to the thought, selected on the map.
  - "Done when" is shown.
  - The activity names who did what: "Sam handed it off to Sam's Claude Code", "… marked it done",
    and the result.
- **Wiki history.** It gives the agent's version with its reason and a rendered diff.
- **Hand-off to a teammate's agent.** "Ask Sam first … Flux will ask Sam in the thread of #2" was
  understood by all.
- **Search.** It found every object type and was the fastest route in T1 and T3.

## Limitations

- **Author bias.** The same agent wrote the seed and played the participants. The mitigations were
  the sealed draws for worlds 2 and 3 and the use of screen content only. P1 saw the locker message
  during T1, so P1's T3 answer is not independent.
- **Learning effect.** Participants ran in sequence. P2 and P3 knew the layout, so their action
  counts are lower bounds.
- **Newcomer framing.** All participants were a newcomer, Lena. The return case was covered by
  H-11. CW-3 applies only to a person who joins an existing project.
- **Wall time.** It reflects model latency, not human reading speed. No baseline tool was compared.
- **Devices.** Phone results come from WebKit emulation, not physical devices (#266).
- **Seed time zone.** The seed used +02:00 for dates after the 25 Oct time change, so times after
  that date show one hour earlier. This does not affect any finding.

## Reproduction

The seed (`seed.py`), the newcomer grant, the backdating SQL generator and the session driver ran
inside the `ui-test` image:

- they used `McpAgent` from `app/tests/ui/test_scenarios.py`;
- `/study` was mounted from a scratch directory;
- the stack used `docker/compose.source.yaml` with the variables of `scripts/check_ui.sh`.

These scripts were not committed; the scenario above is the complete content plan. The screenshots
in [`connected-work-flow/`](connected-work-flow/) come from these sessions.

[#249]: https://github.com/coldphase/flux/issues/249
[#763]: https://github.com/coldphase/flux/issues/763

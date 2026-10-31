# H-11 returning-user test: simulated study

**Date:** 2026-10-31. **Build:** `main` at `d988e935c`, source stack in Docker (own Compose project,
port 37500, blank `FLUX_VAPID_*`). **Run by:** claude-hubert (Claude Opus 5.5).
**Mandate:** founder decision (Hubert, 2026-10-31, [#249]): run H-11 as a realistic simulated
study instead of skipping it. **Criteria covered:** foundation F5 (return is normal use), 8.8
(return and takeover: "a shorter time to regain orientation without more wrong assumptions") and
the persona "Osoba wracająca po przerwie" (`FLUX-FOUNDATION.md` §4.2). The study touches U-5
(Inbox "Needs you", Home top items) and the "Since you left" return view (#106, #133).

## Verdict

**Pass on all four tasks for all three participants (12 of 12 task outcomes correct).** Every
participant found what changed, named both decisions with their recorded reasons, did not
treat the proposed decision as decided, found their new task with its due date, and answered the
agent's question. The answers were checked against a sealed key and the database.

The pass relied on workarounds. Four P2 findings make the return slower and riskier than it
needs to be. The purpose-built recap ("What matters") answers tasks (a) and (c) in one screen,
but none of the three participants found it. On a phone, the ready answers to an agent's question
cannot be read on Home or in the Inbox.

| Task | P1 desktop | P2 phone | P3 desktop → phone |
| --- | --- | --- | --- |
| (a) What changed while I was away? | pass, 8/8 key changes | pass, 6/8 | pass, 7/8 |
| (b) What was decided and why? | pass, 2/2 with reasons | pass, 2/2 | pass, 2/2 |
| (c) What do I need to do next? | pass, task + due date + question | pass | pass |
| (d) Answer the waiting question | pass, from Home | pass, after a detour | pass, after a detour |

Pass thresholds were fixed before scoring: (a) at least 6 of the 8 key changes and no false
statement; (b) both accepted decisions with their reasons, and the proposed one not called
decided; (c) the assigned task with its due date, plus the open question; (d) the answer recorded
as the asked person's.

## Method

**Scenario.** Each participant returned to a separate copy ("world") of the same project. Every
world had its own accounts, so no participant saw another's answer. Each world was seeded only
through the public API and real MCP calls (OAuth/PKCE bearer, standing grants), as a person
and an agent would create it:

- **Workspace and projects.** Workspace "Northside Food Bank". Project "Volunteer sign-up",
  goal "Volunteers can book a shift on their phone in under a minute". A second project,
  "Winter coat drive", carries noise.
- **People.** Tomasz Wiśniewski (owner), Priya Shah (admin), Marta Nowak (member, the returning
  person), and the agent "Priya's Claude Code" with grants for `conversation.reply` and
  `result.record`.
- **Week 1 (16–23 Oct; Marta active).**
  - Messages: a kickoff thread and a sign-in options thread.
  - Tasks: #1 shift picker (Marta, done), #2 build sign-in (Priya), #3 FAQ (Tomasz), and #4
    accessibility audit, held by the agent, which posts a plan.
  - A decision, "Launch on 7 November", accepted.
  - A flyers thread.
  - Marta says on 23 Oct that she is away until the 31st. Her return points for Home and the
    project are saved at 23 Oct 17:40.
- **Week 2 (24–30 Oct; Marta away).**
  - Pilot results arrive in the sign-in thread. Decision D1 is proposed (27 Oct) and accepted
    (28 Oct) with its rationale and the pilot message as its source.
  - The agent records a negative result, "Accessibility audit: 4 issues", and task #5 "Fix the 4
    issues" is created for Priya.
  - Decision D2, "Launch on <date>", replaces the 7 November decision (29 Oct).
  - Task #6 is assigned to Marta with a due date, and Tomasz posts a note to her in the kickoff
    thread.
  - The agent asks Marta a question with three ready answers in the #4 thread (29 Oct).
  - Priya marks #2 done and says so in the thread (30 Oct).
  - Priya proposes decision D3, "Drop shift swapping", which stays open (30 Oct).
  - Noise: replies in the flyers and coat-drive threads, and a direct message to Marta.
- **Backdating.** Every timestamp the seed wrote was moved to its simulated date by one SQL pass
  over all `timestamptz` columns, piecewise by recorded marks. No timestamp from the seed window
  stayed at the real date (checked per column).
- **Sealed key.** The decision outcome and reasons, the new launch date, the question and the due
  date were drawn at random per world. The draws went only to a sealed key file, read after the
  sessions to score.

**Participants.** One agent (claude-hubert) played all three participants in sequence, as the
founder decision asks; no sub-agents were used. Each participant got only this brief: "You are
Marta Nowak, designer; you were away 24–30 Oct; it is the 31st". Each worked only from what the
UI showed: Playwright screenshots and the page's visible text through a persistent driver
(Chromium desktop 1440×900; WebKit phone 390×844, touch). Each thought aloud: every step and
statement is logged with its time.

| Participant | Profile and device | World draw |
| --- | --- | --- |
| P1 | Methodical; desktop, Chromium | D1 "no account, calendar invite"; launch 28 Nov; question "where to show errors"; due 4 Nov |
| P2 | Phone-first, impatient; WebKit phone | D1 same; launch 21 Nov; question "where to show errors"; due 5 Nov |
| P3 | Skimmer who wants one summary; desktop for (a)(b), phone for (c)(d) | D1 same; launch 28 Nov; question "Submit button contrast"; due 5 Nov |

**Measures.**

- UI actions per task (clicks, taps, scrolls, navigations).
- Wrong turns: an action that did not move toward the answer.
- Correctness against the sealed key.
- Confidence as stated by the participant (1–5).
- Wall time, given only as an indication: it includes the model's thinking time and three driver
  restarts, which are harness overhead and are not counted as actions.

## Results per participant

**P1 (desktop, 24 UI commands, 220 s wall time including restarts).**

- **(a) and (b): 9 actions, 1 wrong turn.**
  - Home showed "Needs you 2" (the proposed D3 and the agent's question), but no summary. Both
    projects were marked "quiet". P1: "odd after a week away."
  - In the project, the pill read "Since you left: 4 messages · 3 task updates · 3 decisions · 1
    result · Jump". Jump scrolled to an "Unread" divider at 28 Oct, past D1 and the audit result
    (wrong turn). P1 scrolled up instead.
  - P1 opened D1 and D2. The decision panels showed the rule, the reason, the source message,
    who proposed and decided, and, for D2, the replaced rule and its earlier reason.
  - P1 opened the sign-in thread (the pilot and "Sign-in is built"), the kickoff thread
    (Tomasz's note) and the result.
  - Answer: all 8 key changes. Confidence 4/5 for (a) ("not sure what the 3 task updates are")
    and 5/5 for (b).
- **(c): 4 actions, 1 wrong turn.**
  - The Inbox listed D3 and the question, but not task #6 (wrong turn).
  - P1 went to Home, then "All my tasks", and opened #6. The due date "4 Nov 2026" appears only
    inside the task panel. Confidence 4/5.
- **(d): 2 actions, 0 wrong turns.** P1 tapped "Both" on Home; a toast said "Answered: Both"
  with Undo. Confidence 5/5.

**P2 (phone, 21 UI commands, 143 s).**

- **(a) and (b): 10 actions, 1 wrong turn.**
  - On Home, the three answer buttons of the agent's question printed over each other. P2: "I
    cannot read the first two options."
  - In the project, the pill was cut to "Since you left: 4 messages…". Jump went to the 28 Oct
    divider (wrong turn).
  - P2 opened D2 and D1 in bottom sheets; both were clear. P2 did not open any thread, so "sign-in
    is built" was missed. P2 also did not list the question under (a).
  - Answer: 6 of 8. Confidence 3/5 for (a) ("I might be missing what people said in the
    threads") and 5/5 for (b).
- **(c): 2 actions, 0 wrong turns.** P2 opened #6 from the stream. The Due row "5 Nov 2026"
  sits half under the composer. Confidence 4/5.
- **(d): 4 actions, 1 wrong turn.**
  - The Inbox card had the same overlapping answers.
  - Tapping the question opened its thread, where the answers are readable and the audit result
    sits just above. P2 chose "Next to each field". Confidence 5/5.

**P3 (desktop then phone, 23 UI commands, 123 s).**

- **(a) and (b): 7 actions, 1 wrong turn.**
  - P3 tried Home's "Details" for a summary and got "Nothing selected" (wrong turn). With that
    panel open, the agent's question on Home collapsed to one letter per line.
  - The project's Details panel helped: it shows the goal, a "Now" list (#6, the result, D3) and
    the current rule (D2).
  - P3 opened D1, the result and D2. "Sign-in is built" was missed in (a).
  - Answer: 7 of 8. Confidence 3/5 for (a) and 5/5 for (b).
- **(c), on the phone: 4 actions, 0 wrong turns.**
  - None of the three answers on Home were readable on the phone.
  - P3 went to "All my tasks" and opened #6, which showed "Due 5 Nov 2026". Confidence 4/5.
- **(d): 6 actions, 1 wrong turn.**
  - Closing the task left P3 in the project's task list. That list showed #2 done, which was new
    to P3, but it was a detour.
  - Back, then the Inbox, then the question's thread, then "Darker red #B3261E". Confidence 5/5.

**Correctness check after the sessions.** Each world's `agent_questions` row has
`answered_by = asked_user_id`, with options 2 ("Both"), 0 ("Next to each field") and 0 ("Darker
red #B3261E"). All decisions, dates and due dates stated by the participants match the sealed
key. No participant made a false statement. Every partial answer under (a) was an omission of
"sign-in is built" (#2 done) or of the question, which they handled under (c).

## Findings

New findings are also posted on [#763]. Known item WF-4 in #763 (the pill covers content) was
seen again and is not repeated here.

**H11-1 (P2): On a phone, the ready answers of an agent's question overlap and cannot be read on
Home and in the Inbox.**

- Seen in WebKit and Chromium at 390 px, by 2 of 2 phone sessions.
- The answers draw over each other once an option is longer than about 12 characters ("Next to
  each field", "Darker red #B3261E").
- Cause: `app/apps/web/src/notifications/needs-you.css:96` makes each answer button
  `flex: 1; min-width: 0` on one row, and the button text does not wrap or truncate.
- On desktop, when the Details panel is open, the same card squeezes the question text to one
  letter per line (`p3-05-details.png`).
- The browser test (`test_home_inbox_nav.py`) uses the short options "Per bed" and "One value",
  so it cannot catch this.
- Workaround: open the question's thread, where the answers stack.
- Fix direction: let the answers wrap or stack on narrow widths, and add a test with options of
  the maximum length (80 characters).

**H11-2 (P2): The return recap "What matters" is the answer to tasks (a) and (c), but the return
surfaces do not lead to it.**

- None of the 3 participants found it.
- Opened afterwards by the evaluator in world 3, it shows:
  - "Since 23 Oct, 17:40";
  - the next step and "Needs you: Tomasz added a task for you";
  - every change in plain language: "Done: Build sign-in for volunteers", "Current rule changed:
    Launch … 28 November / Previously: … 7 November", the result, and the new rule;
  - "Summarize".
- How it is reached:
  - On a phone: project title ▾ → "Details, goal and people" → "What matters" (three taps, no
    hint).
  - On desktop: the row exists only for phones (`project/ProjectOverview.tsx:325`
    `phone && …`). The palette command is not found by typing "What matters", and Enter offers
    "New task 'What matters'".
- The "Since you left" pill offers only Jump, and Home has no return summary.
- Fix direction: the pill (and Home after an absence) opens "What matters"; keep Jump as the
  secondary action.

**H11-3 (P2): Jump and the "Unread" divider skip decisions and results, so a returning person
lands after the most important changes.**

- After 23 Oct, the first changes in the stream were D1 (27/28 Oct) and the audit result (28 Oct
  10:00). Jump and the divider went to task #5 at 28 Oct 10:12.
- Cause: `firstUnread` (`app/apps/web/src/app/conversationEvents.ts:109–117`) returns the oldest
  summary item whose source is a message or a task. Decision and result items are skipped, and
  thread replies count at their latest reply.
- 2 of 2 participants who tried Jump were misdirected and had to scroll up.
- Fix direction: start at the oldest item of any kind in the summary.

**H11-4 (P2): Home marks every project "quiet" after a week of changes.**

- `hasNew` is declared on `ProjectSummary` (`app/apps/web/src/app/data.ts:22`) and read by
  `Home.tsx:141`, `Sidebar.tsx:186` and `ProjectsIndex.tsx:25`, but nothing in the web app or
  server sets it. Every project therefore reads "quiet", and no sidebar dot ever appears.
- All 3 participants saw "quiet" on both projects. P1 called it misleading.
- This contradicts F5 ("shows the relevant changes").
- Fix direction: set it from the return summary (changes since the person's project return
  point), or remove the label.

**H11-5 (P3): A task newly assigned to me, with a due date, is not part of the return path.**

- Home's "Continue where you left off" pointed at the proposed D3, not at the task assigned to
  Marta on 29 Oct (which is listed in "What matters" under "Needs you").
- The due date appears in none of these places: "Your tasks", the board card, the project task
  list on the phone.
- It appears only in the task panel. On the phone, that Due row sits half under the composer.
- All 3 participants needed 2–4 extra actions to find the due date.

**H11-6 (P3): The phone pill "Since you left: 4 messages…" is truncated**, which hides the
decision and result counts. The counts ("3 task updates", "4 messages") cannot be expanded
anywhere, so P1 and P3 could not tell what the task updates were.

**H11-7 (P3): Thread replies and status changes are invisible in the main stream except as "N
replies · last <date>".** "Sign-in is built" and #2 → Done were found only in a thread (P1) or a
task list (P3), and P2 missed them. H11-2 would cover this.

**H11-8 (P3): The detail panel stays open across pages.** A result panel opened in the project
stayed open through Inbox → Your tasks → Home (`p1-07-inbox.png`, `p1-09-mytasks.png`), with
breadcrumbs "Decision / Result" that do not belong to those pages.

**H11-9 (P3): Small presentation issues.**

- A decision proposed and accepted at the same minute shows as two identical cards, one after
  the other.
- The owner avatar in the task panel is clipped to "M(".
- Home's "Details" shows only "Nothing selected" (P3's wrong turn).

## Limitations

- **Author bias.** The same agent wrote the seed and played the participants. The mitigation was
  the sealed random draws. All three worlds drew the same D1 variant (1 in 9 chance), so only the
  launch date, the question and the due date differed between worlds. The (b) answers rest on what
  the UI showed and are quoted from it.
- **Learning effect.** The participants ran in sequence, so P2 and P3 already knew the UI layout.
  Their action counts are a lower bound; P1 is the closest to a first return.
- **Wall time.** Wall time reflects model latency and harness restarts, not human reading speed.
  The comparative part of 8.8 ("shorter time to regain orientation") needs a baseline, such as the
  same team in a chat tool. This study does not provide one, so the comparison remains
  unmeasured.
- **Devices.** Phone results come from WebKit and Chromium emulation, not physical devices (#266).

## Reproduction

The seed, the backdating SQL generator and the session driver were run inside the `ui-test`
image: they used `McpAgent` from `app/tests/ui/test_scenarios.py` and had `/study` and
`/shots` mounted from the scratch directory. The stack used `docker/compose.source.yaml` with
the variables of `scripts/check_ui.sh`, `FLUX_TEST_FAILURE_INJECTION=true` and a fixture
token. These scripts were not committed; the scenario above is the complete content plan.

[#249]: https://github.com/coldphase/flux/issues/249
[#763]: https://github.com/coldphase/flux/issues/763

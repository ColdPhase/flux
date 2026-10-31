# First-time user test: simulated study

**Date:** 2026-10-31. **Build:** `main` at `f2eec199f`, started with `./flux up` from a fresh detached worktree
(own Compose project `fts-study`, port 38100, empty database, blank `FLUX_VAPID_*`, agent runtime off as `./flux up`
leaves it when not asked). **Run by:** claude-hubert (Claude Opus 5.5).
**Mandate:** founder decision (Hubert, 2026-10-31, [#249]): before the release, run a simulated first-time user study
with the method of the [H-11 returning-user study](h-11-returning-user.md). **Personas:** the product lead, the
developer who uses Claude Code and the non-technical teammate (`FLUX-FOUNDATION.md` §4.2), each with zero prior
knowledge of Flux.

## Verdict

**Not ready for a first-time team as it stands: 2 P1 findings.** The person-to-person journey works. Sign-up, the
first project, a conversation, turning a message into a task or a decision, accepting a decision and finding
something again later all passed for every persona who needed them, mostly with zero or one wrong turn.

The two journeys that connect people and agents failed without a workaround:

- **A teammate's own agent cannot be connected.** The developer, invited as a member, reached a dead end on the
  consent page: the project was greyed out with "Ask a project manager to confirm this agent's grant", and the
  manager had no control anywhere to do so. The study continued only because the lead made him a workspace
  **admin** (FT-1).
- **The agent can't act on the task it is handed.** After a successful consent and hand-off, the first
  `/mcp__flux__start_work` read everything for 47 s and then reported "this connection has no work grants at all".
  It took a second consent and a separate grant form with 5 ticks before the agent did the task (FT-2).

Inviting also needs two separate steps (space link, then project access) and an out-of-band nudge, because both
invitees landed on an empty Home that told them to "open an invite link" they had just used (FT-3).

| Task | P1 lead, desktop | P2 developer, desktop + Claude Code | P3 teammate, phone |
| --- | --- | --- | --- |
| 1. Sign up / join | pass, 4 actions, 0 wrong | pass, but landed in an empty space: 12 actions, 3 wrong turns until he could ask Anna | pass, but empty space: 2 wrong turns |
| 2. Create a first project | pass, 4 actions, 0 wrong | n/a | n/a |
| 3. Invite someone | **pass with workaround**: 2 links, then project access per person after each one asked; 2 wrong turns | (receiver) | (receiver) |
| 4. Have a conversation | pass, 3 actions | pass, thread reply, 3 actions | pass, 2 actions |
| 5. Message → task and decision | pass; decision 1 wrong turn | n/a | task pass (1 wrong turn); **decision partial**: 3 wrong turns, found only `/decide`, not linked to the message |
| 6. Accept a decision | pass, 2 actions | n/a | pass, 3 taps |
| 7. Hand a task to the agent, see the result | n/a for the persona (no agent of her own; Connect is developer-only) | **fail without workaround**: dead end at consent; result seen only after admin promotion, 3 consent rounds and a grant form (~40 UI actions, 5 CLI commands, 6 wrong turns, ~9 min) | n/a (hand-off shows "Marek decides"; real-world task) |
| 8. Find something again later | pass, search, 3 actions | pass, Home → Wiki, 2 actions | pass, 5 actions |

Pass thresholds were fixed before the sessions: the persona completes the task from what the UI shows, the result
is correct in the database, and the persona does not need help from outside Flux. A task that needed another person
to act outside Flux (a chat message, a role change) counts as "pass with workaround" or "fail without workaround".

## Method

**Install.** `FLUX_PROJECT=fts-study FLUX_PORT=38100 FLUX_MAILPIT_PORT=38101 ./flux up` in a fresh detached worktree
of `origin/main`. The study blanked the generated `FLUX_VAPID_*` lines in `docker/.env` and restarted, as the shared
brief requires. No demo data; the first screen was the sign-in page of an empty server. Mail is not configured
(the `./flux up` default), so nothing relied on email.

**Participants.** One agent played the three personas in sequence; no sub-agents. Each persona worked only from
what the UI showed: screenshots and the page's visible text and control list through a persistent Playwright driver
(Chromium desktop 1440×900; WebKit phone 390×844, touch, iPhone user agent). Every statement was logged with its
time (think-aloud log); 411 driver commands were logged.

| Persona | Brief given | Device |
| --- | --- | --- |
| P1 Anna Kowalska, product lead | "A colleague installed Flux for your food bank. Set up the volunteer sign-up app project and get your team in." | desktop |
| P2 Marek Zieliński, developer | "Anna sent you a link. You use Claude Code every day; let it draft the FAQ." | desktop + terminal |
| P3 Basia Nowak, volunteer coordinator | "Anna sent you a link on WhatsApp." | phone |

The personas overlapped where the product needs another person: Anna came back to give access after each join, and
Marek and Basia waited for her. Those steps are counted under the person who acted.

**The real Claude Code.** As in [the 160 workflow evidence](../../../development/evidence/160-workflow/README.md):
the host's Claude Code **2.1.316** binary and `~/.claude/.credentials.json` were mounted **read-only** into a
disposable container (fresh tmpfs HOME, the credential copied in, host network, an empty fixture repository with only
a README). Marek typed the two commands the Connect page shows (`claude mcp add …`, `claude mcp login flux`) and
opened the printed consent URL in his browser. Start used `claude -p "/mcp__flux__start_work <project>"
--allowedTools mcp__flux --output-format stream-json`; the allow list stands in for the person approving Flux tools
when asked. Project content was fixture data only. Credentials and transcripts were not printed or kept.

**Measures.** UI actions per task (clicks, taps, typed fields, navigations), wrong turns (an action that did not move
toward the goal), stated confidence (1–5), abandonment, and wall time. Wall time includes model thinking and is an
indication only.

**Harness errors (not counted).** (1) The driver's control list truncated names to 70 characters, so Marek's first
invite link was cut short and failed ("This invite link doesn't work"); the full link worked. (2) A blind driver
selector for "Change" in the space's People list hit the **Revoke** button of Basia's waiting link, which revoked it
in one click (see FT-13); Anna made a new link. (3) Twice the driver typed while no field had focus, and the letters
ran keyboard shortcuts (C → New, G I → Inbox).

## Results per persona

**P1 Anna, product lead (desktop).**

- **T1 sign-up (4 actions, 0 wrong, confidence 5, ~25 s).** Sign-in page → "Create an account" → three fields → Home
  with a clear "Start with a project" card.
- **T2 project (4 actions, 0 wrong, confidence 4).** The dialog's only field is "What is it about?"; Anna hesitated
  whether this was the name or a description (it became the title). She looked at the four templates and kept
  "Build something" (`p1-04-new-project.png`).
- **T3 invite (6 actions, 2 wrong turns, confidence 2).**
  - "Invite" in the project's Details opened the **space's** People page, not the project, while the project header
    said "Only you" (`p1-08-invite.png`). The page explains "Being in Anna's space doesn't open every project".
  - "Change access" changed nothing visible (only she was in the project; there is no option to open the project
    to the whole space).
  - Each link "works once" (`p1-09-invite-link.png`), so she made two.
  - Later, after each person asked her outside Flux, she gave them project access: header people button → Invite →
    choose person → "Give Marek access" (5 actions, clear confirmation). Flux never told her that someone had
    joined (`p1-22-home-after-join.png`: "Nothing needs you").
- **T4 conversation (3 actions).** Two messages, the second addressed to Marek by name.
- **T5 task (4 actions, 0 wrong) and decision (5 actions, 1 wrong turn).** Hovering a message shows Reply, Create
  task and More; "Propose a decision" is inside More (`p1-15-more-actions.png`). Both dialogs were clear; the source
  message is quoted and linked. The decision card appeared in the stream about 2 s after the "Decision proposed"
  toast.
- **T6 accept (2 actions).** The panel showed "Current rule · accepted".
- **T7 hand-off (3 actions, deferred).** "No agents in this project yet"; the primary button is clipped to "onnect
  your own ager" (`p1-20-handoff-noagent.png`). The Connect page is CLI commands; Anna left it to Marek. With the
  runtime off, nothing offers her an agent of her own (expected for this install).
- **T7 support for Marek (~14 actions, 4 wrong turns).** When Marek asked her to "grant his agent", she tried the
  project Invite (it went to the space page), the Agents tab ("0 in this project", `p1-28-agents-tab.png`) and
  Marek's access options (Can read / Remove / Keep out; no "Manages"). She then made him a space **Admin**, the only
  path that worked.
- **T8 find later (3 actions, confidence 5).** Fresh sign-in; search "cancel" listed the decision first, with who
  decided it and why (`p1-41-search-cancel.png`).

**P2 Marek, developer (desktop + Claude Code).**

- **T1 join (12 actions, 3 wrong turns).** "Join Anna's space" → Create an account → "You joined Anna's space" →
  Home said "Start your first project … Got an invite link? Open it to join your team" (`p2-03-home.png`). Search
  for "Volunteer" found nothing (`p2-04-search.png`). He opened Messages → New message to ask Anna. (Typing while
  the New message picker had focus opened the New dialog once; the button renamed itself from "Open conversation"
  to "Message Anna".)
- **T4 conversation (3 actions).** Reply in the thread to Anna's question.
- **T7 hand-off and result (~40 UI actions, 5 CLI commands, 6 wrong turns, ~9 min; would have abandoned).**
  1. Task #1 → Hand off → "Connect your own agent" → Settings shows "Create your personal agent" and "Connect your
     MCP client" cards (`p2-11-connect.png`). Unclear whether both are needed.
  2. `claude mcp add --transport http flux http://127.0.0.1:38100/mcp` and `claude mcp login flux` worked; the consent
     page "1 of 2" showed the project **disabled**: "Ask a project manager to confirm this agent's grant before
     saving" (`p2-12-consent.png`). "Continue to consent" → "Choose at least one project the agent may use"
     (`p2-14-consent2.png`). **Dead end, confidence 1.**
  3. He created a personal agent in Settings (the card collapsed to a link with no confirmation) and asked Anna by DM.
     Anna could not grant it (above) and made him admin.
  4. A second `claude mcp login flux`: the project could be ticked; consent "2 of 2" was clear and listed "Asked for,
     not granted: Run approved project actions". Authenticated.
  5. Hand off #1 → choose "Marek's Claude Code" → step 2 promised: "will be able to read this project and write in
     it: messages, results, tasks and proposed decisions" → Hand off. Clear.
  6. `/mcp__flux__start_work Volunteer sign-up app` failed at once: "projectId must be a project UUID". He copied the
     UUID from the browser address bar.
  7. Start with the UUID: **47 s, 22 turns, then nothing done**: "this connection has no work grants at all … To do
     it I'd need … `cowork.unit.create`, `doc.create`, `result.record` …".
  8. Settings (`p2-23-manage-agent.png`): "This connection can read and suggest only. To let your agent make changes,
     save a new selection with 'Run approved project actions'". The "Act" list shows 27 switches, all "Requires a new
     connection with your consent", two of them named "Unavailable capability".
  9. A third `claude mcp login flux` → "Create another selection" → tick "Run approved project actions" under More
     options → Allow. Then "Standing grants: None yet" → "Add a grant" form with 17 checkboxes (`p2-26-add-grant.png`);
     he ticked 5 (change tasks, record results, start and edit docs, reply in conversations).
  10. Start again: **80 s, 24 tool calls, 0 failed calls.** The agent wrote the wiki draft "FAQ page (draft)" (18 Q&As,
      14 marked [TO CONFIRM]), recorded a positive result, closed #1 and replied in the Kickoff conversation. It
      called `flux_project_orientation` 7 times in a row (also seen in the 160 evidence).
  11. The stream showed "#1 Done · Marek's Claude Code" and "recorded a result" (`p2-28-result-stream.png`). The
      result panel says "In the Wiki: Not in the Wiki yet" although the result text says it created a wiki doc, and
      gives no link to it; the agent's text contains raw ids ("doc 6b27f28c-…", "decision e72b17ab v2")
      (`p2-29-result-panel.png`). The Wiki tab had the draft.
- **T8 find later (2 actions).** Fresh sign-in → Home "Wiki" → "FAQ page (draft)" with its [TO CONFIRM] items.

**P3 Basia, teammate (phone, WebKit).**

- **T1 join (5 actions, 2 wrong turns).** Create an account from the link → "You joined" → Home "Start your first
  project … Got an invite link?" (`p3-04-home.png`) → Projects: "No projects yet … it appears here when someone adds
  you to theirs" (`p3-05-projects.png`), the first screen that explained it. She asked Anna on WhatsApp.
- **T6 accept (3 taps, 0 wrong, confidence 5).** After Anna added her and proposed "Volunteers can cancel a shift up
  to 24 hours before it starts", Home showed "Decide on the proposed rule" and a Needs-you card with Accept. The
  Projects card on the same Home still said "No projects yet" (`p3-06-home-access.png`). The decision sheet showed
  the rule, the reason and the source message; Accept.
- **T4 conversation (2 actions).**
- **T5 task (6 actions, 1 wrong turn, confidence 5).** Messages have no visible actions button on the phone
  (`p3-11-stream.png`); tapping did nothing; long-press opened Reply in thread / Create task / Hand off / Cite / Copy
  text (`p3-13-longpress.png`). Create task prefilled the title and linked the message; she set herself as owner.
  The task sheet then opened over the conversation.
- **T5 decision (8 actions, 3 wrong turns, confidence 3).** The long-press menu has no "Propose a decision" (the
  desktop More menu has it). The composer "+" is Attach files. The placeholder hint "/ actions" led her to `/decide`
  (`p3-18-slash.png`), which opened "Propose a decision" in a sheet. The decision was saved, but not linked to the
  message she had wanted to turn into it.
- **T7.** Hand off #2 listed "Marek's Claude Code · Marek decides · online". Her task is real-world work; she cancelled.
- **T8 find later (5 actions, 0 wrong).** Fresh sign-in: "All my tasks" → #2; search "password" → the sign-in
  decision first, with its reason. Home's Needs you asked her to accept **her own** proposed decision
  (`p3-40-later-home.png`).

**Database check after the sessions.** `project_decisions`: "email link only" accepted, "cancel up to 24 hours"
accepted (decided by Basia), "reminder text" proposed. `project_grants`: Marek and Basia contributors, Marek's agent
contributor. `agent_standing_grants`: 5 rows. Task #1 done with a positive result by the agent; task #2 open, owner
Basia. Everything the personas stated matched the records.

## Findings

Findings are also posted on [#763]. Paths are under `app/apps/web/src/` unless stated; screenshots are in
[`first-time-user/`](first-time-user/).

**FT-1 (P1): A member's own agent cannot be connected to a project, and the manager has no control to allow it.**

- Seen by P2 at consent "1 of 2" (`p2-12-consent.png`, `p2-14-consent2.png`): the project checkbox is disabled with
  "Ask a project manager to confirm this agent's grant before saving" (`agent-connection/pages.tsx:419`), and
  Continue then refuses with "Choose at least one project".
- The manager side has no such control. Give access lists only people (`people/ProjectAccess.tsx`, `GiveAccess`),
  the Agents tab shows "0 in this project" (`p1-28-agents-tab.png`), and Inbox shows no request. In the web app,
  `grantAgentProject` is called only for the caller's own agent (`agent-connection/pages.tsx:246,304`,
  `conversations/useAskBar.ts:31`, `proactive-comparison/ProjectRuleSettings.tsx:164`).
- The only working path was to make the developer a workspace **admin**, which also lets him add and remove people
  and manage every project.
- This breaks F-016's core promise for every invited developer who does not manage the project.
- Fix direction:
  - Consent "1 of 2" turns the disabled row into "Ask Anna to allow it", which creates a request in the managers'
    Needs you.
  - The managers' Give access lists the members' personal agents, and the project Agents tab lists pending agent
    requests with Allow, in one action.
  - Add a browser test: a contributor connects their own agent, and a manager allows it from Needs you.

**FT-2 (P1): After consent and hand-off, the agent cannot do the handed task; making it able takes a second consent
and a separate 17-box grant form.**

- The default consent leaves "Run approved project actions" unticked; consent 2 lists it as "Asked for, not granted".
- Hand off step 2 then promises "will be able to read this project and write in it: messages, results, tasks and
  proposed decisions", but the first `start_work` spent 47 s and 22 turns and ended with "this connection has no
  work grants at all".
- Fixing it took: Settings → read "save a new selection" → `claude mcp login flux` again → "Create another selection"
  → More options → tick → Allow → "Add a grant" → choose 5 of 17 boxes → Grant (`p2-23-manage-agent.png`,
  `p2-26-add-grant.png`).
- The "Act" list on that page shows 27 switches, all "Requires a new connection with your consent", two labelled
  "Unavailable capability" (`agent-connection/McpPermissions.tsx:160` falls back to that label for capabilities
  without a name).
- Fix direction:
  - Handing a task to an agent creates the standing grants that the task needs (update the task, record a result,
    reply in its thread, write docs), scoped to that task and with an end date, or else says so with one button
    that does it.
  - The consent offers "Run approved project actions" ticked when the client asks for it.
  - Hand off step 2 states only what the agent can actually do now.
  - Name every capability.

**FT-3 (P2): An invited person lands in an empty space and is told to open the link they just used; the inviter is
not told they joined.**

- Seen by 2 of 2 invitees (`p2-03-home.png`, `p3-04-home.png`).
- A new project is restricted ("Only you") by default.
- Invite from inside a project opens the space's People page and makes a space link (`p1-08-invite.png`).
- After joining, Home says "Start your first project … Got an invite link? Open it to join your team"; search finds
  nothing.
- The inviter gets nothing in Needs you or Inbox (`p1-22-home-after-join.png`). Both invitees had to ask outside Flux
  (a DM, WhatsApp), and the lead then gave project access by hand per person.
- Fix direction:
  - An invite made from a project carries that project, so joining gives access to it.
  - A member with no projects sees "You joined Anna's space. Anna hasn't added you to a project yet" with "Ask Anna".
  - The inviter gets a Needs-you item, "Basia joined: give access to Volunteer sign-up app?", with one action.

**FT-4 (P2): On the phone a message cannot be turned into a decision.**

- The long-press menu has Reply, Create task, Hand off, Cite and Copy text, but no "Propose a decision"
  (`p3-13-longpress.png`); the desktop More menu has it (`p1-15-more-actions.png`).
- The only path is `/decide` in the composer, which P3 found after 3 wrong turns. The decision it makes is not
  linked to the message.
- The phone also shows no visible actions control on a message: tap does nothing, and only long-press opens the
  menu (`p3-11-stream.png`).
- Fix direction: add "Propose a decision" (and "Record a result") to the phone message menu with the same source
  link as on desktop.

**FT-5 (P3): `start_work` with the project name fails.**

- The Connect guide says "type /mcp__flux__start_work and choose your project" (`agent-connection/ClientGuide.tsx:52`).
- With a name, the prompt answers "projectId must be a project UUID"
  (`apps/server/src/agent-connection/playbook.ts:53`). The exact command with the id exists only behind "Start /
  Resume in Claude Code" (`agent-connection/CoworkHostActions.tsx:27`).
- Interactive argument completion in Claude Code was not tested.
- Fix direction: accept a unique project name, or show the copyable command with the id in the guide and in Hand off.

**FT-6 (P3): The result of the agent's work does not link to the doc it wrote.** The result says it created wiki doc
"FAQ page (draft)", but its panel says "In the Wiki: Not in the Wiki yet" and has no link (`p2-29-result-panel.png`).
The agent's text shows raw ids. Fix direction: show the docs a result created as links, and phrase "In the Wiki"
as "Added to a Wiki page".

**FT-7 (P3): "Change access" on a project where you are alone does nothing,** and nothing in the project lets the
owner open it to the whole space (`people/ProjectAccess.tsx:203`). P1 counted it as a wrong turn.

**FT-8 (P3): Stale or self-referential Home items on the phone.**

- After project access is given, the Needs-you card names the project but the Projects card still says "No projects
  yet" (`p3-06-home-access.png`).
- Later, Needs you asks Basia to accept her **own** proposed decision (`p3-40-later-home.png`).

**FT-9 (P3): The "Connect your own agent" button is clipped in the Hand off dialog at 1440 px** ("onnect your own
ager", `p1-20-handoff-noagent.png`).

**FT-10 (P3): Hand-off and connection copy.**

- The personal-agent card collapses to a "Create personal agent" link with no "created" confirmation.
- The first Connect page shows two cards (personal agent and MCP client) without saying which one comes first.

**FT-11 (P3): The project dialog's only field is "What is it about?",** which reads as a description, but it becomes
the project name.

**FT-12 (P3): The agent repeated `flux_project_orientation` 7 times in a row** at Start (0 errors). This is also
noted in the 160 evidence as undiagnosed.

**FT-13 (P3): Revoke on a waiting invite link acts in one click,** with no confirmation or Undo, beside Copy
(`people/WorkspacePeople.tsx:458`, `revoke` at :404). It was found through a harness misclick, not by a persona.

Known items seen again and not repeated: in search, Enter on the first row creates "New task '…'" (#763); the detail
panel stays open across pages (H11-8); a decision proposed and accepted at once shows as two identical cards (H11-9).

## Limitations

- **One simulated participant per persona, played in sequence by the same agent.** P2 and P3 saw the same UI that
  P1 had seen, but they used only what their own screens showed. Wrong turns are a lower bound for real people.
- **Wall time** includes model latency. The UI time for P1 from the first screen to the first accepted decision was
  3 min 22 s; P3 took 1 min 44 s from the link to accepting a decision; P2's hand-off took about 9 min including
  two agent runs (47 s and 80 s).
- **Non-interactive Claude Code.** `-p` with `--allowedTools mcp__flux` replaces the person approving each Flux tool;
  the interactive picker for "choose your project" was not tested. Codex was not run.
- **Agent runtime off.** `./flux up` asked nothing in a non-interactive shell, so the built-in assistant ("Your
  assistant: Off on this Flux server") and its join requests were not part of this study. A lead without a
  developer had no agent path.
- **Phone results come from WebKit emulation,** with long-press dispatched as a held touch pointer.
- **No mail server,** as `./flux up` leaves it, so invitations and notifications by email were not exercised.

## Reproduction

```sh
git worktree add --detach .worktrees/fts origin/main && cd .worktrees/fts
FLUX_PROJECT=fts-study FLUX_PORT=38100 FLUX_MAILPIT_PORT=38101 ./flux up   # then blank FLUX_VAPID_* and ./flux up again
# Driver: a Playwright HTTP driver in the flux-ui-tests image (host network), one browser context per persona.
# Claude Code: host binary and ~/.claude/.credentials.json mounted read-only into a disposable container with a
# tmpfs HOME; `claude mcp add …`, `claude mcp login flux` under a pty, then
# `claude -p "/mcp__flux__start_work <project-id>" --allowedTools mcp__flux --output-format stream-json`.
```

The driver and the think-aloud log were not committed; the steps above are the complete script.

[#249]: https://github.com/coldphase/flux/issues/249
[#763]: https://github.com/coldphase/flux/issues/763

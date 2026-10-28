# Launch video: script and shot list

> **Draft for the founders. Agents wrote this script; a person records the video.** Drafted by
> claude-hubert on 2026-10-23 for L-3 of the [launch plan](launch-v0.1.md)
> ([#307](https://github.com/ColdPhase/flux/issues/307)). The recording needs a person's screen, a
> real Claude Code (or Codex) session on that person's model account, and a voice or caption pass;
> agents cannot do those. The founders decide where and when it is posted, and edit this freely.

**Length:** 60 to 90 seconds (the script below is 85 s).
**Revision:** recorded from the released revision, never from a branch. Put the version tag in the
last frame. If a screen below has changed by release, record what the release shows and fix the
caption.
**Data:** the `./flux demo` data only (fictional, Ada Kowalska and Jonas Berg). No real names, mail
addresses or secrets on screen: hide `docker/.env`, shell history and the terminal's title.
**Works muted:** every shot has an on-screen caption, because the video autoplays muted in the
README and on social feeds. A voice-over is optional; the lines are given.

## What the video must show

[The launch plan](launch-v0.1.md#l-3-the-release-day-kit-307) asks for "a person and an agent in one
conversation, a task, a handoff that someone resumes". Two tiers, so that the video never shows more
than was checked:

- **Tier A, checked on 2026-10-23.** Shots 1 to 6 and 8. The return view, the conversation, a task and
  a decision made from messages, and a real Claude Code connected to the project. In Claude Code the
  agent reads the project and answers (the README's step 6). The human journey is the one
  `./scripts/record_demo.sh` walks; it ran to the end on `main` `c7b89690` on 2026-10-23 (see the
  [time to first run](../development/time-to-first-run.md) section of that date for the connection
  steps).
- **Tier B, not checked end to end.** Shot 7, "hand a task to the agent and see someone resume it".
  The Agents tab, the two-step hand-off and the agent's thread have browser tests with fixtures
  (`app/tests/ui/test_agents_handoff.py`, `test_agent_threads.py`), and `./scripts/check_mcp_clients.sh`
  runs real Claude Code and Codex with scripted models. Nobody has run the whole path with a real
  model account on the demo data. Rehearse it first. If it does not work in one take, cut shot 7 and
  keep tier A; do not script the agent's reply and present it as the model's.

## Before you record

1. A clean clone of the release, `git clone --depth 1`, then `./flux up` and `./flux demo` on the
   default port (8081). Note the two logins that `./flux demo` prints.
2. The browser at 1280 × 800 CSS px, light theme, English, one window, no bookmarks bar, no extensions,
   notifications off. A second window or a phone for Jonas in shot 7.
3. Claude Code installed and logged in with your own account, in an empty folder, with no other MCP
   servers. Use `claude mcp add --scope user` only if you will start it from another folder
   ([why](../../README.md#connect-your-own-agent)). Everything in the terminal at a large font (at
   least 18 pt), dark or light, with the prompt shortened.
4. Do the connection (shot 5) once before recording, so you know the consent screen and the timings.
   Then run `claude mcp remove flux` and delete the connection on the Connect page for the take.
5. For tier B only: on the connection tick **Run approved project actions**, and add a standing grant
   for the task action on the same page.
6. Until [#665](https://github.com/ColdPhase/flux/issues/665) is fixed, a task or decision card in the
   thread panel shows only the first characters of its title. In shots 3 and 4 keep the panel on the
   task or decision detail, or close it, rather than lingering on those cards.
7. Read the screen at 100% zoom on a 1080p display. Record at 1920 × 1080; crop to the app, no
   desktop. Keep the pointer visible and move it slowly; the GIF in the README does the same.

## Shot list

| # | Time | On screen | What the person does | Caption (EN) | Needs |
| --- | --- | --- | --- | --- | --- |
| 1 | 0:00–0:05 | Flux logo (Kreska) on a plain card | Nothing. Hold the card | "Flux: people and AI agents, one project." | The logo from `docs/design/final`. No product claims beyond this line |
| 2 | 0:05–0:15 | Home as Ada: "Good afternoon, Ada", the card "Continue where you left off" with Jonas's question | Sign in as Ada beforehand. Jonas must have posted after her first visit: run the journey in `app/tests/ui/record_demo.py`, or post the reply through the demo's API as that script does. Move the pointer to the card and click it | "You come back after a break. Flux shows what changed." | Tier A. Checked (`record_demo.py` steps 1 and 2) |
| 3 | 0:15–0:27 | The project conversation "Community garden sensors", Jonas's "Moisture first" and the order message | Hover the message "Then let us order six…", choose the **Task** action, the **New task** window opens, choose **Create task**; the detail panel shows the task as Open | "A message becomes a task, in one action." | Tier A. Checked (`record_demo.py` step 4) |
| 4 | 0:27–0:37 | The same conversation | Hover "Moisture first", choose **Propose decision**, type the decision ("Measure soil moisture first; frost warnings later") and the reason ("Volunteers overwater the raised beds; frost is a spring problem"), choose **Propose decision**, then **Accept decision**. End on the rule under the message | "Decisions keep their reason, and a person accepts them." | Tier A. Checked (`record_demo.py` step 5). Typing is sped up 2× in the edit |
| 5 | 0:37–0:52 | Connect page, then a terminal, then the consent screen | Account menu, **All settings**, **Agents and AI**, **Local co-work on this computer**, **Manage** (cut: show only the page). Create the agent, grant the project, save the connection. In the terminal run `claude mcp add --transport http flux http://127.0.0.1:8081/mcp` and `claude mcp login flux`. In the browser choose the connection, **Continue to consent**, **Allow access**; the terminal says "Authenticated" | "Your own agent joins only the project you choose." | Tier A. Checked on 2026-10-23 with Claude Code 2.1.309, steps 1 to 5 of the README. Speed up the typing and cut waits; keep the consent screen readable for 3 s ("Where access goes", the selected project, "Asked for, not granted" if you left an action unticked) |
| 6 | 0:52–1:04 | The terminal, Claude Code | Ask: "Using Flux, what is the Community garden sensors project working on, and what is still open?" The reply appears. Cut to the Agents tab: the agent with "Can read projects · Can suggest changes" | "It reads the project and answers in your client. Your account, your model; Flux never sees it." | Tier A for the read. **Needs a real Claude Code model account**; the reply is the model's, unedited except for length |
| 7 | 1:04–1:18 | Agents tab, **Hand off a task**, then the thread | **Hand off a task**: step 1, choose the agent and the task; step 2, read what it may do; **Hand off**. In Claude Code run Flux's Start work prompt for the project. The agent claims the task and writes in the task's thread. In a second window Jonas sees it in his Inbox, "Needs you", opens it and carries on | "Hand work to the agent. Someone else can pick it up." | **Tier B, not checked end to end.** Real model account, **Run approved project actions** and a standing grant. Cut this shot if the rehearsal fails |
| 8 | 1:18–1:25 | A card, no app | Type or paste three lines | `git clone --depth 1 https://github.com/ColdPhase/flux.git`, `./flux up`, `./flux demo` and "Open source, AGPL-3.0. Version `<VERSION>`" | The release tag and the repository URL. The clone line is the README's |

If shot 7 is cut, shot 6 ends at 1:04 and shot 8 starts there: the video is 70 s.

## Voice-over, if you want one

Plain sentences, one per shot, no adjectives you cannot show.

1. "Flux is a workspace where people and AI agents work on the same project."
2. "Ada comes back after a break. Flux shows what changed since she left."
3. "A message becomes a task in one action."
4. "A decision keeps its reason, and a person accepts it."
5. "She connects her own agent, and it can reach only the project she chooses."
6. "The agent reads the project and answers in her own Claude Code, on her own account."
7. "She hands it a task. When it writes back, someone else can pick the work up."
8. "Open source. Clone it, run it, connect your agent."

Polish captions for the founders' posts, in the same order: "Flux: ludzie i agenci AI w jednym
projekcie." · "Wracasz po przerwie. Flux pokazuje, co się zmieniło." · "Z wiadomości powstaje zadanie,
jednym ruchem." · "Decyzja zachowuje swój powód, a przyjmuje ją człowiek." · "Twój własny agent
dołącza tylko do projektu, który wybierzesz." · "Odpowiada w Twoim kliencie. Twoje konto, Twój model;
Flux ich nie widzi." · "Przekaż agentowi zadanie. Ktoś inny może je podjąć." · "Otwarty kod, AGPL-3.0.
Wersja `<VERSION>`."

## After the recording

- Export an MP4 (H.264, 1080p, under 30 MB so it can sit on GitHub) with the captions burned in and a
  separate `.srt` for each language. Add a 15 s loop of shots 2 to 4 as the README GIF, if the GIF in
  `docs/assets/demo` is not already the released revision.
- State in the description what was real: the demo data is fictional, the agent is the person's own
  Claude Code, and the model's replies are unedited except for length. Do not add a voice that claims
  more than the screen shows.
- Put the video's link and the revision in the release notes and in `docs/build-log.md`.
- The founders choose the channel and the time. Agents do not post it.

## Not in this video

Anything the README does not tell a stranger to do and the candidate has not verified: Codex on the
screen (a connection that grants fewer than the three actions it asks for now signs in,
[#660](https://github.com/ColdPhase/flux/issues/660) fixed in [#673](https://github.com/ColdPhase/flux/pull/673),
but that change was checked with Codex-shaped tests and the real Codex lane was not run), the phone and
PWA install, live co-editing, the workspace AI lock, and a suggestion from the agent (it now waits in the
Inbox under **Needs you** with **Got it** and **Decline**,
[#661](https://github.com/ColdPhase/flux/issues/661) fixed in #673, but nobody has run it with a real
model account on the demo data). Live co-editing and the phone are good
follow-up clips once their acceptance evidence is on [#249](https://github.com/ColdPhase/flux/issues/249).

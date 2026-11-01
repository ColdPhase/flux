# Launch video: script and shot list

> **Draft for the founders. Agents wrote this script and recorded what needs no person; a person records
> the rest.** Drafted by claude-hubert on 2026-10-23 and updated on 2026-10-30 for L-3 of the
> [launch plan](launch-v0.1.md) ([#307](https://github.com/ColdPhase/flux/issues/307)). Shots 1 to 4 and 8
> are [recorded by a script](#the-scripted-shots-1-to-4-and-8) from the running application. Shots 5 to 7
> need a person's screen, a real Claude Code (or Codex) session on that person's model account, and the
> voice-over; agents cannot do those. The founders decide where and when it is posted, and edit this freely.
>
> **Order of work (founder gate [#763](https://github.com/ColdPhase/flux/issues/763), 2026-10-30).** README, docs-site and
> video media are recorded from the audited build, after the UI/UX fixes of that audit are merged. Nothing recorded
> before then is kept or committed. When the gate is open, one command regenerates the README GIF, stills and screens and the
> scripted clips: `./scripts/record_media.sh` (see [the scripted shots](#the-scripted-shots-1-to-4-and-8)).

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

- **Tier A, checked.** Shots 1 to 6 and 8. The return view, the conversation, a task and
  a decision made from messages, and a real Claude Code connected to the project. In Claude Code the
  agent reads the project and answers (the README's step 6). The script for the browser part (shots 2 to 4)
  ran to the end on `main` `1e0dc2dd9` on 2026-10-30 through `./scripts/record_video.sh` (below, in
  English and Polish; those clips were not kept, see the gate above); the connection
  steps were walked with Claude Code and Codex on 2026-10-23 and 2026-10-30 (see the
  [time to first run](../development/time-to-first-run.md) sections of those dates).
- **Tier B, not checked on the demo project.** Shot 7, "hand a task to the agent and see someone resume it".
  The Agents tab, the two-step hand-off and the agent's thread have browser tests with fixtures
  (`app/tests/ui/test_agents_handoff.py`, `test_agent_threads.py`), and `./scripts/check_mcp_clients.sh`
  runs real Claude Code and Codex with scripted models. A real Codex (0.160.1) and a real Claude Code
  (2.1.285) ran Start, a changed plan and Resume with their own accounts
  ([#751](https://github.com/ColdPhase/flux/pull/751), `docs/development/evidence/160-workflow/`), but that
  is not this take on the demo project and the hand-off through the Agents tab. Rehearse it first. If it
  does not work in one take, cut shot 7 and keep tier A; do not script the agent's reply and present it as
  the model's.

## The scripted shots 1 to 4 and 8

`./scripts/record_video.sh` needs only Docker. It starts its own Compose project on loopback ports
18597 and 18598 (override with `FLUX_VIDEO_RECORD_PORT` and `FLUX_VIDEO_RECORD_MAILPIT_PORT`), seeds the
`./flux demo` data through the public API, and records in the pinned Playwright container
(`app/tests/ui/record_video.py`), in real time, once for English and once for Polish:

```sh
./scripts/record_media.sh /path/to/out                              # the README GIF, stills and screens, then the clips below
FLUX_VIDEO_VERSION=v0.1.0 ./scripts/record_video.sh /path/to/out    # the clips only, both languages
FLUX_VIDEO_LANG=en ./scripts/record_video.sh /path/to/out           # one language
FLUX_VIDEO_CAPTIONS=off ./scripts/record_video.sh /path/to/out      # no caption bar; use the .srt files
```

It writes, per language, `shot-1-open.webm` (the Kreska card, 5 s), `shots-2-4-journey.webm` (one take of
Ada's return, the task made from a message and the decision with its reason; on 2026-10-30 about 7 s, 8.5 s and
19 s for shots 2, 3 and 4, 35 s in all, so speed up the typing or trim in the edit),
`shot-8-close.webm` (the three commands and the version, 7 s) and `timings.json` with the second at which
each of shots 2, 3 and 4 starts. The caption changes at each of those shots. Every frame is the real
application at 1280 × 800 on the demo data; the only additions are a drawn pointer that follows the real mouse
and the caption bar, in the final design's surface, shadow and text tokens.

Limits, stated plainly: the capture is Playwright's own VP8 video, so text is a little softer than a screen
recording and the clip is 1280 × 800, not 1080p. It is fit to edit with and to post; if the founders want a
sharper video, they record shots 2 to 4 again by hand at 1920 × 1080 using the table below. The recording
of a release is made from the release: set `FLUX_VIDEO_VERSION` and run it on a clone of the release tag.
The clips are not committed, because binary media in the repository is the reason clones were made shallow.
If a screen has changed, the script fails loudly on the control it cannot find and leaves `hover-failed.png` next to the
clips when a hover is blocked; fix the selector in `app/tests/ui/record_video.py`, which follows `record_demo.py`.

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
6. Read the screen at 100% zoom on a 1080p display. Record at 1920 × 1080; crop to the app, no
   desktop. Keep the pointer visible and move it slowly; the GIF in the README does the same.

## Shot list

| # | Time | On screen | What the person does | Caption (EN) | Needs |
| --- | --- | --- | --- | --- | --- |
| 1 | 0:00–0:05 | Flux logo (Kreska) on a plain card | Nothing. Hold the card | "Flux: people and AI agents, one project." | **Scripted:** `shot-1-open.webm`. The logo is `docs/assets/brand/kreska-light.svg`. No product claims beyond this line |
| 2 | 0:05–0:15 | Home as Ada: "Good afternoon, Ada", the card "Continue where you left off" with Jonas's question | Sign in as Ada beforehand. Jonas must have posted after her first visit: the script does this through the demo's API (as `app/tests/ui/record_demo.py` does). Move the pointer to the card and click it | "You come back after a break. Flux shows what changed." | **Scripted:** the first part of `shots-2-4-journey.webm`. Tier A, checked on 2026-10-30 |
| 3 | 0:15–0:27 | The project conversation "Community garden sensors", Jonas's "Moisture first" and the order message | Hover the message "Then let us order six…", choose the **Task** action, the **New task** window opens, choose **Create task**; the detail panel shows the task as Open | "A message becomes a task, in one action." | **Scripted:** the middle of `shots-2-4-journey.webm`. Tier A, checked on 2026-10-30 |
| 4 | 0:27–0:37 | The same conversation | Hover "Moisture first", choose **Propose decision**, type the decision ("Measure soil moisture first; frost warnings later") and the reason ("Volunteers overwater the raised beds; frost is a spring problem"), choose **Propose decision**, then **Accept decision**. End on the rule under the message | "Decisions keep their reason, and a person accepts them." | **Scripted:** the end of `shots-2-4-journey.webm`, with the typing at real speed. Tier A, checked on 2026-10-30 |
| 5 | 0:37–0:52 | Connect page, then a terminal, then the consent screen | Account menu, **All settings**, **Agents and AI**, **Local co-work on this computer**, **Manage** (cut: show only the page). Create the agent, grant the project, save the connection. In the terminal run `claude mcp add --transport http flux http://127.0.0.1:8081/mcp` and `claude mcp login flux`. In the browser choose the connection, **Continue to consent**, **Allow access**; the terminal says "Authenticated" | "Your own agent joins only the project you choose." | Tier A. Checked on 2026-10-23 with Claude Code 2.1.309, steps 1 to 5 of the README. Speed up the typing and cut waits; keep the consent screen readable for 3 s ("Where access goes", the selected project, "Asked for, not granted" if you left an action unticked) |
| 6 | 0:52–1:04 | The terminal, Claude Code | Ask: "Using Flux, what is the Community garden sensors project working on, and what is still open?" The reply appears. Cut to the Agents tab: the agent with "Can read projects · Can suggest changes" | "It reads the project and answers in your client. Your account, your model; Flux never sees it." | Tier A for the read. **Needs a real Claude Code model account**; the reply is the model's, unedited except for length |
| 7 | 1:04–1:18 | Agents tab, **Hand off a task**, then the thread | **Hand off a task**: step 1, choose the agent and the task; step 2, read what it may do; **Hand off**. In Claude Code run Flux's Start work prompt for the project. The agent claims the task and writes in the task's thread. In a second window Jonas sees it in his Inbox, "Needs you", opens it and carries on | "Hand work to the agent. Someone else can pick it up." | **Tier B, not checked end to end.** Real model account, **Run approved project actions** and a standing grant. Cut this shot if the rehearsal fails |
| 8 | 1:18–1:25 | A card, no app | Type or paste three lines | `git clone --depth 1 https://github.com/ColdPhase/flux.git`, `./flux up`, `./flux demo` and "Open source, AGPL-3.0. Version `<VERSION>`" | **Scripted:** `shot-8-close.webm`, with `FLUX_VIDEO_VERSION` set to the release tag. The clone line is the README's |

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

What a person does, in order. None of this can be done by an agent: it needs the founder's accounts, voice and
publishing rights.

1. **Record shots 5 to 7** by hand, as in the table (your Claude Code, your terminal, 1920 × 1080, large font).
2. **Assemble.** Convert each scripted clip and each of yours to the same size and frame rate, then join them
   in order. With any recent ffmpeg:

   ```sh
   for f in shot-1-open shots-2-4-journey shot-8-close; do
     ffmpeg -i "$f.webm" -vf "scale=-2:1080:flags=lanczos,pad=1920:1080:(ow-iw)/2:0:color=0xf4f4f5" -r 30 -c:v libx264 -crf 20 -pix_fmt yuv420p -an "$f.mp4"
   done
   # shots-5-7.mp4 is your own recording, made the same way. List the clips in order in parts.txt:
   #   file 'shot-1-open.mp4'  /  file 'shots-2-4-journey.mp4'  /  file 'shots-5-7.mp4'  /  file 'shot-8-close.mp4'
   ffmpeg -f concat -safe 0 -i parts.txt -c copy flux-launch-en.mp4
   ```

   The filter chain was checked on 2026-10-30 (a 1280 × 800 clip became 1920 × 1080 at 30 fps). `libx264` needs an ffmpeg
   build that includes it; Fedora's free build does not, so use another H.264 encoder there. The 1280 × 800 capture is scaled to the full height and centred on side bars in the design's background colour,
   so the caption bar and the pointer stay in frame; a 16:10 clip next to a 16:9 one needs this. Use `ffprobe` to
   check that the file is 60 to 90 s and under 30 MB.
3. **Captions.** The scripted clips carry their English or Polish caption in the picture. Your own shots 5 to 7
   need theirs: either add the lines of [`captions.en.srt`](../assets/video/captions.en.srt) (or `.pl.srt`) for
   those shots with ffmpeg's `subtitles` filter, or record the scripted clips with `FLUX_VIDEO_CAPTIONS=off` and
   put the whole `.srt` on the video, so that one style covers every shot. The times in the `.srt` files follow
   the shot list; move them to match your cut. `<VERSION>` in the last cue is the release tag.
4. **Voice-over (optional).** Read the lines above, one per shot. This is the human part that no tool replaces.
   Do not add a voice that claims more than the screen shows.
5. **Describe what was real:** the demo data is fictional, the agent is the person's own Claude Code, and the
   model's replies are unedited except for length.
6. **Publish.** Upload the video, put its link and the revision in the release notes and in
   [the build log](../build-log.md), and replace `<VIDEO URL>` in the [posts](launch-posts.md). The founders
   choose the channel and the time. Agents do not post it.

## Not in this video

Anything the README does not tell a stranger to do and the candidate has not verified: Codex on the screen
(Codex signs in with a connection that grants fewer than the three actions it asks for,
[#660](https://github.com/ColdPhase/flux/issues/660) fixed in [#673](https://github.com/ColdPhase/flux/pull/673)
with Codex-shaped tests; the real Codex lane was not re-run for that change, though real Codex ran Start and
Resume in [#751](https://github.com/ColdPhase/flux/pull/751)), the phone and PWA install, live co-editing, the
workspace AI lock, and a suggestion from the agent (it waits in the Inbox under **Needs you** with **Got it** and
**Decline**, [#661](https://github.com/ColdPhase/flux/issues/661) fixed in #673, but nobody has run it with a
real model account on the demo data). Live co-editing and the phone are good follow-up clips once their
acceptance evidence is on [#249](https://github.com/ColdPhase/flux/issues/249); the phone's install and push
are tested on emulated Chromium and WebKit ([#756](https://github.com/ColdPhase/flux/pull/756)).

# #151 and #155 closeout: independent evaluation, agreed budgets, motion trace (2026-10-29)

Evaluator: a separate agent session from the one that wrote PR #669 (the GitHub account is the same, so this is
session independence, at Hubert's direction). It wrote no product code. It changed only the opt-in harness, one
trace recorder, two design pages and this report. Everything below was run in Docker on this host (AMD Ryzen 9
7900X, Fedora 42), one suite at a time, ports 30800 and 30801, which other agents' suites shared.

## Tested commits and commands

- **Functional evaluation:** `main` `3f0311a26`, a detached worktree with no edits.
- **Harness runs and trace:** this branch's code head `b1a357450` (`main` `3f0311a26` plus the harness, the
  recorder and docs). Later commits on the branch are evidence and docs.
- Docker's automatic network pool was full (28 subnets taken by other agents' stacks). The runs after the first
  two used a copy of `check_ui.sh` that adds a compose override giving each network a fixed `10.231.x.0/24`
  subnet. It changes nothing else.

| Run | Result |
| --- | --- |
| `FLUX_UI_BROWSER=chromium ./scripts/check_ui.sh test_adaptive_matrix test_typing test_motion` | 50 tests, OK (352 s): matrix 25, typing 13, motion 12 |
| the same with `FLUX_UI_BROWSER=webkit` | 50 tests: 48 pass, 1 skipped (`test_motion` 06b, a CDP-only drawer timing), **1 failure**: `test_typing` test_01 at `project-idle-expiry` (the notice was still there at the 6000 ms limit; the server TTL is 5000 ms) |
| `test_typing.TypingJourney.test_01…` alone in WebKit, twice | 2 of 2 pass (25 s). Classified as a load flake: the limit leaves 1 s over the TTL and the full run shared the host at load 15 to 30 |
| Chromium: `test_tasks_board test_kreska test_working_agent` (for #155 AC-3) | 28 tests: 27 pass. `test_working_agent` test_06 fails: 2 of its 6 engine/ending subtests in the first run, 5 of 6 when run alone (the run stays `queued`; 20 s wait). Not caused by this work (unchanged `main`). Suspected cause, not verified: a stop that the test refuses with 503 leaves each subtest's run active until the test ends, and later runs queue behind them |
| `./scripts/check_ui.sh motion_performance`, full size, twice | run A (21 min) one failure, phone frame gap p95 133 ms against the 100 ms placeholder; run B (1026 s) **within budgets**, see [the budget table](../../../design/adaptive-workspaces.md#agreed-performance-budgets). Two shorter mechanics trials found the stale phone profile working and that a resize reads the API, which led to `layoutRequests` and its ceiling of 3 |
| `./scripts/check_ui.sh motion_trace` | desktop and phone recorded, no uncaught page errors |
| `python3 -m unittest tests.test_adaptive_budgets`; `python3 -m unittest discover -s tests -p 'test_*.py'`; `python3 scripts/check_agent_setup.py`; `git diff --check` | recorded in the pull request |

Host load average during the budget runs: 6 to 24 (run A), 8 to 32 (run B).

## #151 adaptive layouts, per criterion

| AC | Status | Evidence and what is left |
| --- | --- | --- |
| AC-1 rules, 320 to 5120 | **Met** | `test_adaptive_matrix` test_01 runs the same journey at all 23 fixtures (two owners, three connections), Chromium 25 of 25, WebKit 25 of 25. The rules page's breakpoints and widths match the source; it is now recorded as independently evaluated |
| AC-2 more space gives more | **Partly met** | Met by test_02, 03, 04, 07 (docked Details from 1920; three cards on one row at 3840; the map plane grows 1664, 2304 and 3584; conversation at most 760 px) and test_08, 09 (a short stream, thread and direct message sit 23 to 27 px above their field from 390×844 to 3840×2160). **Not met or not covered:** the spare height of Agents' task thread and of a direct message's thread panel (stated in the rules page); the Agents column stays 854 px (a founder design decision under Spokój, not a defect) |
| AC-3 transitions | **Met** (emulated) | test_10 to 17 pass in both engines: map camera across 640 px and rotation, private draft, reading place, wiki text, Details, a saved task opened on another device and not by a stranger. #133 and #134 semantics were not separately checked |
| AC-4 reflow, text, budgets | **Met for what it can measure here** | Budgets agreed and asserted (run B passes). test_05 (system scaling), 06 (dark), 20 (400% and 200% zoom, five views), 21 (text measured to double). **Not measured:** map pan, zoom and long-list scroll latency, memory beyond the JavaScript heap, safe areas (no test found), real zoom, OS text size and devices (optional under #266) |
| AC-5 independent review | **Partly met** | Running functional review done (this report). Visual review is one reviewer's look at five captures, not the neutral-brief second pass: see below |

**#151 stays open.** Unblock: Agents' task thread and the direct message thread panel keep their spare height
connected to their field (or the AC records them out of scope); the neutral visual pass; map pan/zoom and
list-scroll budgets, or an explicit decision that the native-work kickoff's scroll budgets cover them.

## #155 motion and presence, per criterion

| AC | Status | Evidence |
| --- | --- | --- |
| AC-1 highlight, arrivals | **Met** | `test_motion` 01 to 10 incl. the rail glide, Chromium 12 of 12, WebKit 11 of 12 and 1 skipped (CDP-only timing). Trace and video below |
| AC-2 real typing | **Met** | `test_typing` 13 of 13 in Chromium; 12 of 13 in WebKit with test_01 passing alone twice (the flake above). Two accounts over real sockets: expiry, blur, send, revocation, scope isolation, no durable effect; "unchanged heartbeat does not repeat live-region text" asserted |
| AC-3 card feedback, agent motion | **Met** | `test_tasks_board` 13 of 13 (drag feedback only in the card list, drop, keyboard, Move to, refused move restored); `test_kreska` 7 of 7; `test_working_agent` 7 of 8 tests, the exception being test_06 (an error's owner after a refused stop; a baseline test defect that is not about motion) |
| AC-4 reduced motion, budgets | **Met** | `test_motion` 05 and 08; the reduced-motion budget profile (motion ends with the feedback, p95 73 ms); the phone profile now runs and asserts its budgets. Chromium only, since WebKit has no CPU throttling command |
| AC-5 Docker tests, video or trace, review | **Met** | The tests above; the trace and video below recorded on `b1a357450`; this independent evaluation |

**#155 can close.** The one caveat is that its visual review is the same single-reviewer look as #151's.

## Trace and video

Recorded by `app/tests/ui/motion_trace.py` (`FLUX_UI_SCREENSHOT_DIR=<dir> ./scripts/check_ui.sh motion_trace`).
Bob navigates a realistic project (three projects, 60 conversation roots and 40 tasks each, a 40-reply thread)
while Ada types in the thread he opens; Bob's page is recorded. Ada's text is never sent.

| File | Size | Shows |
| --- | --- | --- |
| `trace-desktop.zip` | 268 KB | 1280×800: Tasks and Conversation tabs (traveling highlight), three project switches (sidebar glide), the thread, "Ada Kowalska is typing…" appearing and going. 17 actions, 39 DOM snapshots |
| `desktop.webm` | 189 KB | the same, 12.5 s |
| `trace-phone.zip` | 195 KB | 390×844 touch: the title menu to Tasks and back (taps), then the thread and the typing line |
| `phone.webm` | 226 KB | the same, 10.8 s |

Open a trace with `npx playwright show-trace trace-desktop.zip`. The traces hold DOM snapshots and no
screenshots (the first recording with screenshots was 8.7 MB); the videos are the film. The videos were
re-encoded for size: `ffmpeg -i in.webm -vf fps=12,scale=1120:-2 -c:v libvpx-vp9 -crf 44 -b:v 0 -an desktop.webm`
(phone: no scaling, `-crf 38`). Both are under the 300 KB media and 400 KB file limits, and no
`docs-size-allowlist.txt` entry was added. [`docs/agents/evaluation.md`](../../../agents/evaluation.md#evidence-size)
prefers a CI artifact for traces and recordings; they are here because Hubert asked for them under this folder.
A trace and a video show what was drawn and when. They do not certify interaction or accessibility; the test
modules do.

## Visual assessment (one reviewer, captures from `test_adaptive_matrix`)

Seen: 320×568 conversation, 390×844 Tasks, 1440×900 Tasks with the task in Details, 3440×1440 Tasks, 3840×2160
Conversation, and one frame each of the two videos.

- The phone and the 1440 laptop read clearly: one stream or list, a visible Blocked cue, the task panel docked beside
  a readable board. The typing line sits above the field and moves nothing.
- At 3440×1440 the board's three columns each take a third of the width while their one to three cards stay about
  150 px wide; with this six-task fixture most of the surface is empty. The gain test_03 measures (more cards per
  row) needs more cards than this fixture has. At 3840×2160 the conversation is a 760 px column in wide margins,
  as Spokój draws it. Neither is a defect against the recorded rules; both are worth a design look (P3).
- At 320×568 the project name truncates to "Quiet gestur…" beside the view name; usable, and recorded.

## Findings

1. P3 test: `test_working_agent` test_06 fails on `main` when run alone (see above). Needs an owner.
2. P3 test: `test_typing` test_01 leaves 1 s over the 5 s typing TTL; it failed once in WebKit under load.
3. P3 product: a layout switch across a shell swap reads working agents and assistant runs again (1 or 2
   requests), and up to about 20 requests coincide with 5 in 100 switches, including a window that only grows.
   Bounded and not proportional to the window; the cause is not investigated. Not changed here.
4. P3 design: the wide board is sparse on a small project (above).

## Unverified

Physical devices, real browser zoom, OS text size and safe areas; WebKit performance; the cause of findings 1 and
3; a neutral-brief visual pass.

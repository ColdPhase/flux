# README demo

`flux-demo.gif` shows the core v0.2 journey in one real browser session. It is recorded from the
running application, not from the prototype or a mockup:

1. **Home.** What waits for Ada under "Waiting for you": two decisions and two questions.
2. **The space.** She opens *Community garden sensors*, where Basia and Jonas asked her something.
3. **An agent.** She types `/ai` and asks what the space settled on for the first sensors. Her Assistant works
   ("Only you see this", with Stop), then answers with numbered sources from the space; only she sees it. **Show everyone**
   posts the answer as her own message, marked "via Assistant".
4. **A task.** One action on that message (**Create task**) makes a task from it; it appears under the message. The Create
   window it opens is not drawn in the GIF (see the size note below); the toast and the panel beside it are closed again.
5. **Tasks, Map and Wiki.** The Tasks board has the new task with the others; the Map shows the space's connected thoughts;
   the Wiki shows a page of the space.

The content is the `./flux demo` sample data (`scripts/flux-demo.mjs`) and the scene `app/tests/ui/media_scene.py` adds through the public API:
the fictional *Riverside Makers* company with Ada Kowalska, Jonas Berg, Basia Wrona and Tomasz Lis, Ada's agents, tasks, decisions, a Map and
Wiki pages. The agent's answer is scripted: the worker sends the run, through the real Anthropic adapter, to the TEST-ONLY provider mock
(`app/tests/ui/anthropic_mock.py`). No model is called.

Every frame is a Playwright screenshot at 1280 × 800 CSS px, light theme. The only addition is
a drawn pointer that shows where the clicks go. Pillow joins the frames into a looping GIF with
one shared palette of at most 32 colours: Prostota's ink, white and page grey, so text stays black and
cards white, and the rest from a median cut of the frames. The recorder takes the largest of 32, 28, 24 and 20
colours that keeps the file within its allowlisted size (`scripts/docs-size-allowlist.txt`) and
stops with an error if even 20 do not.

**Recorded at:** the application at `main` `a8369b516` (the application after [#1187](https://github.com/ColdPhase/flux/pull/1187)), 2026-11-10, by:

```sh
./scripts/record_demo.sh                                        # writes docs/assets/demo/flux-demo.gif
./scripts/record_demo.sh /tmp/x.gif                             # or any other path
./scripts/record_demo.sh docs/assets/demo/flux-demo.gif docs/assets/readme docs/assets/screens   # also the README stills and the screens
```

The same run takes the stills at the top of the README, in the light and the dark theme (see the
[README screenshots](../readme/README.md)), and, when it is given a third directory, the documentation screens and the
README highlights (see [docs/assets/screens](../screens/README.md)).

The script needs only Docker. It builds the app and the pinned Playwright image, starts its
own Compose project on loopback ports 18595/18596, gives it a keyring and throwaway VAPID keys, tells the app it is served from `https://flux.example.com` (reached through a throwaway certificate inside the recorder's container; `FLUX_DEMO_RECORD_ORIGIN` changes it), and seeds the demo with fresh random
passwords. It installs Pillow (pinned by hash in `app/tests/ui/demo-requirements.txt`) for
that run only, then removes the project, its volumes and its images. Override the ports with
`FLUX_DEMO_RECORD_PORT` and `FLUX_DEMO_RECORD_MAILPIT_PORT`.

Record it again, and update the commit above, when the journey's screens change noticeably. One command
regenerates this GIF, the README stills, the screens and the launch video's scripted clips:

```sh
./scripts/record_media.sh [video-dir]
```

The founder gate [#763](https://github.com/ColdPhase/flux/issues/763) (2026-10-30) requires the README, docs-site and
video media to be recorded from the audited build, after the audit's UI/UX fixes are merged. The recorder merges a
short pointer frame into the frame before it when a dissolve between views is under way (`drop_transition_frames` in
`app/tests/ui/record_demo.py`), because the interface dissolves between views and those frames cost the most
bytes. If the GIF still exceeds its allowlisted size, lower the frame count in the journey before asking for a larger
allowance.

The journey is in `app/tests/ui/record_demo.py`. It is not part of the browser test suite,
but it fails loudly when a step cannot be found. The launch video (`docs/assets/video/`, `./scripts/record_video.sh`) is Flux v0.1's: its scripted
clips reuse helpers of this file, and this change did not run or update them for v0.2.

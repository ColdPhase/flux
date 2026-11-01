# README demo

`flux-demo.gif` shows the core journey in one real browser session. It is recorded from the
running application, not from the prototype or a mockup:

1. **Return view.** Ada opens Home and sees what changed since she left: Jonas's question,
   offered as her next step.
2. **Conversation.** That step opens the project conversation and its thread at Jonas's message.
3. **Sketch.** The Map tab opens the shared sketch "Where the sensors go".
4. **Task.** Back in the conversation, one action (**Create task**) turns Jonas's message into a task.
   The Create window it opens is not drawn in the GIF (see the size note below); its picture is the first
   README highlight, in [docs/assets/screens](../screens/README.md).
5. **Decision.** Ada proposes a decision from another message (its **More actions** menu) in the Create
   window, with its reason. "Decision proposed" waits a few seconds for Undo; then the decision card
   appears under the message, and Ada opens it and accepts it. The rule then sits under the message it
   came from.

The content is the `./flux demo` sample data (`scripts/flux-demo.mjs`): the fictional
*Riverside Makers* workspace with Ada Kowalska and Jonas Berg. It is seeded through the public
API. Jonas's reply in step 1 is posted through the same API while Ada is away.

Every frame is a Playwright screenshot at 1280 × 800 CSS px, light theme. The only addition is
a drawn pointer that shows where the clicks go. Pillow joins the frames into a looping GIF with
one shared palette of at most 32 colours: Prostota's ink, white and page grey, so text stays black and
cards white, and the rest from a median cut of the frames. The recorder takes the largest of 32, 28, 24 and 20
colours that keeps the file within its allowlisted size (`scripts/docs-size-allowlist.txt`, 476206 bytes) and
stops with an error if even 20 do not.

**Recorded at:** the application at `main` `c271a3e8b` (the audited build after the #763 fixes), 2026-11-01. The last
frames show the thread panel with the accepted decision under Jonas's message, by:

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
`app/tests/ui/record_demo.py`), because the interface now dissolves between views and those frames cost the most
bytes. If the GIF still exceeds its allowlisted size, lower the frame count in the journey before asking for a larger
allowance.

The journey is in `app/tests/ui/record_demo.py`. It is not part of the browser test suite,
but it fails loudly when a step cannot be found.

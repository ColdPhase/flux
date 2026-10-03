# README demo

`flux-demo.gif` shows the core journey in one real browser session. It is recorded from the
running application, not from the prototype or a mockup:

1. **Return view.** Ada opens Home and sees what changed since she left: Jonas's question,
   offered as her next step.
2. **Conversation.** That step opens the project conversation at Jonas's message.
3. **Sketch.** The Map tab opens the shared sketch "Where the sensors go".
4. **Task.** Back in the conversation, one action turns Jonas's message into a task.
5. **Decision.** Ada proposes a decision from another message, with its reason, and accepts it.
   The rule then sits under the message it came from.

The content is the `./flux demo` sample data (`scripts/flux-demo.mjs`): the fictional
*Riverside Makers* workspace with Ada Kowalska and Jonas Berg. It is seeded through the public
API. Jonas's reply in step 1 is posted through the same API while Ada is away.

Every frame is a Playwright screenshot at 1280 × 800 CSS px, light theme. The only addition is
a drawn pointer that shows where the clicks go. Pillow joins the frames into a looping GIF with
one shared palette.

**Recorded at:** the application at `main` `085214c6` (this branch changes no application code), 2026-10-03, by:

```sh
./scripts/record_demo.sh            # writes docs/assets/demo/flux-demo.gif
./scripts/record_demo.sh /tmp/x.gif # or any other path
```

The script needs only Docker. It builds the app and the pinned Playwright image, starts its
own Compose project on loopback ports 18595/18596, and seeds the demo with fresh random
passwords. It installs Pillow (pinned by hash in `app/tests/ui/demo-requirements.txt`) for
that run only, then removes the project, its volumes and its images. Override the ports with
`FLUX_DEMO_RECORD_PORT` and `FLUX_DEMO_RECORD_MAILPIT_PORT`.

Record it again, and update the commit above, when the journey's screens change noticeably.
The journey is in `app/tests/ui/record_demo.py`. It is not part of the browser test suite,
but it fails loudly when a step cannot be found.

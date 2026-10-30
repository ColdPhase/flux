# README demo

`flux-demo.gif` shows the core journey in one real browser session. It is recorded from the
running application, not from the prototype or a mockup:

1. **Return view.** Ada opens Home and sees what changed since she left: Jonas's question,
   offered as her next step.
2. **Conversation.** That step opens the project conversation and its thread at Jonas's message.
3. **Sketch.** The Map tab opens the shared sketch "Where the sensors go".
4. **Task.** Back in the conversation, one action (**Create task**) turns Jonas's message into a task.
5. **Decision.** Ada proposes a decision from another message (its **More actions** menu), with its
   reason, and accepts it. The rule then sits under the message it came from.

The content is the `./flux demo` sample data (`scripts/flux-demo.mjs`): the fictional
*Riverside Makers* workspace with Ada Kowalska and Jonas Berg. It is seeded through the public
API. Jonas's reply in step 1 is posted through the same API while Ada is away.

Every frame is a Playwright screenshot at 1280 × 800 CSS px, light theme. The only addition is
a drawn pointer that shows where the clicks go. Pillow joins the frames into a looping GIF with
one shared 48-colour palette, which keeps the file within its allowlisted size
(`scripts/docs-size-allowlist.txt`, 476206 bytes).

**Recorded at:** the application at `main` `624d02560` with the cards fix of
[#665](https://github.com/ColdPhase/flux/issues/665) ([PR #680](https://github.com/ColdPhase/flux/pull/680), code at
`c6cd75b43`), 2026-10-28. The last frames show the thread panel's decision card in its one-row form: the state
("accepted 28 Oct") whole, the title cut by an ellipsis because that reply's bubble is narrow, by:

```sh
./scripts/record_demo.sh                                        # writes docs/assets/demo/flux-demo.gif
./scripts/record_demo.sh /tmp/x.gif                             # or any other path
./scripts/record_demo.sh docs/assets/demo/flux-demo.gif docs/assets/readme  # also the README stills
```

The same run takes the two stills at the top of the README: see the [README screenshots](../readme/README.md).

The script needs only Docker. It builds the app and the pinned Playwright image, starts its
own Compose project on loopback ports 18595/18596, and seeds the demo with fresh random
passwords. It installs Pillow (pinned by hash in `app/tests/ui/demo-requirements.txt`) for
that run only, then removes the project, its volumes and its images. Override the ports with
`FLUX_DEMO_RECORD_PORT` and `FLUX_DEMO_RECORD_MAILPIT_PORT`.

Record it again, and update the commit above, when the journey's screens change noticeably. One command
regenerates this GIF, the two README stills and the launch video's scripted clips:

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

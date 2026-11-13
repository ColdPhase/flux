# README screenshots

The two images at the top of the [README](../../../README.md) are unedited captures of the running
application on the `./flux demo` data, not of the prototype or a mockup. Each comes in the light and
the dark theme, and the README gives the browser both through `prefers-color-scheme`.

| File | What it shows | Viewport |
| --- | --- | --- |
| `conversation-desktop.webp`, `conversation-desktop-dark.webp` | The *Community garden sensors* space on a computer: the stream with Jonas's question, Ada's `/ai` answer shared as hers ("Ada's Assistant"), a post from her Claude Code ("via Claude Code"), the task made from the answer, a second answer from her Assistant that only she sees (its card, with sources and Show everyone), and the accepted decision "Measure soil moisture first; frost warnings later" open beside it with the message it is based on | 1440 × 900 CSS px |
| `conversation-phone.webp`, `conversation-phone-dark.webp` | The same space on a phone: the task made from the shared answer, Ada's second answer that only she sees (its card, with sources and Show everyone), the composer, and the space's Conversation, Tasks, Map and Wiki views above | 390 × 844 CSS px at device scale 3 |

The content is the fictional *Riverside Makers* company: Ada Kowalska, Jonas Berg, Basia Wrona and Tomasz Lis, and Ada's agents Assistant, Planner
and Reviewer. The `./flux demo` seed (`scripts/flux-demo.mjs`) makes the company, the space, its first conversation, the Map and the Wiki page;
`app/tests/ui/media_scene.py` adds the rest through the public API as the people it belongs to, and the recorded journey asks `/ai` live.
The agent's answer comes from the TEST-ONLY provider mock (`app/tests/ui/anthropic_mock.py`), through the real worker and adapter. No model was
called, and the answer's words are the scripted ones.

The files are lossless WebP: a 1440 px capture is about 75 KB, far less than the PNG, and the text stays crisp. The small images that go with each
README highlight, and the screens of the documentation, are in [docs/assets/screens](../screens/README.md).

**Captured at:** `main` `a8369b516` (the application after [#1187](https://github.com/ColdPhase/flux/pull/1187)), 2026-11-10, with the demo GIF and
the documentation screens, by:

```sh
./scripts/record_demo.sh docs/assets/demo/flux-demo.gif docs/assets/readme docs/assets/screens
```

The second argument is the directory that also receives the stills, which `app/tests/ui/record_demo.py` takes after the journey. See the
[demo recording](../demo/README.md) for what the script needs. Replace the images, the GIF and the commit above together when the interface changes
noticeably. `./scripts/record_media.sh` regenerates all of them together with the launch video's scripted clips; run it from the audited build
(founder gate [#763](https://github.com/ColdPhase/flux/issues/763)).

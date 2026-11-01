# README screenshots

The two images at the top of the [README](../../../README.md) are unedited captures of the running
application on the `./flux demo` data, not of the prototype or a mockup. Each comes in the light and
the dark theme, and the README gives the browser both through `prefers-color-scheme`.

| File | What it shows | Viewport |
| --- | --- | --- |
| `conversation-desktop.webp`, `conversation-desktop-dark.webp` | The project conversation with the task made from a message, and beside it the accepted decision "Measure soil moisture first; frost warnings later" with its reason | 1440 × 900 CSS px |
| `home-phone.webp`, `home-phone-dark.webp` | Home on a phone: under "Needs you", Jonas's question with a Reply button, the project below it, and the Home, Projects and Inbox bar | 390 × 844 CSS px at device scale 3 |

The content is the fictional *Riverside Makers* workspace (Ada Kowalska and Jonas Berg), seeded
through the public API by `scripts/flux-demo.mjs`. Ada then walks the core journey, so the task and
the decision exist; Jonas's question is still waiting for her on Home.

The files are lossless WebP: a 1440 px capture is about 55 KB, less than half the size of the PNG, and the text
stays crisp. The small images that go with each README highlight, and the screens of the documentation, are in
[docs/assets/screens](../screens/README.md).

**Captured at:** `main` `c271a3e8b`, 2026-11-01, with the demo GIF and the documentation screens, by:

```sh
./scripts/record_demo.sh docs/assets/demo/flux-demo.gif docs/assets/readme docs/assets/screens
```

The second argument is the directory that also receives the stills, which
`app/tests/ui/record_demo.py` takes after the journey. See the [demo recording](../demo/README.md)
for what the script needs. Replace the images, the GIF and the commit above together when the
interface changes noticeably. `./scripts/record_media.sh` regenerates all of them together with the launch video's
scripted clips; run it from the audited build (founder gate [#763](https://github.com/ColdPhase/flux/issues/763)).

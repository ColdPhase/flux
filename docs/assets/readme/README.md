# README screenshots

The two images at the top of the [README](../../../README.md) are unedited captures of the running
application on the `./flux demo` data, not of the prototype or a mockup.

| File | What it shows | Viewport |
| --- | --- | --- |
| `conversation-desktop.png` | The project conversation with the task made from a message, and beside it the accepted decision "Measure soil moisture first; frost warnings later" with its reason | 1440 × 900 CSS px, light theme |
| `home-phone.png` | Home on a phone: under "Needs you", Jonas's question with a Reply button, the project below it, and the Home, Projects and Inbox bar | 390 × 844 CSS px at device scale 3 |

The content is the fictional *Riverside Makers* workspace (Ada Kowalska and Jonas Berg), seeded
through the public API by `scripts/flux-demo.mjs`. Ada then walks the core journey, so the task and
the decision exist; Jonas's question is still waiting for her on Home.

**Captured at:** `main` `624d02560` with the cards fix of [#665](https://github.com/ColdPhase/flux/issues/665)
([PR #680](https://github.com/ColdPhase/flux/pull/680), code at `07ffe13ae`), 2026-10-27, with the demo GIF, by:

```sh
./scripts/record_demo.sh docs/assets/demo/flux-demo.gif docs/assets/readme
```

The second argument is the directory that also receives the two stills, which
`app/tests/ui/record_demo.py` takes after the journey. See the [demo recording](../demo/README.md)
for what the script needs. Replace both images, the GIF and the commit above together when the
interface changes noticeably.

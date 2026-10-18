# Actual shared map/wiki renders — 2026-10-18

**Author evidence; independent visual assessment pending.** These renders do
not accept #228, interaction, persistence, latency or accessibility. Whole-issue
Draft #613 retains every original acceptance criterion.

Product source: `f30c9910a21911a4287833a1c19faa12bb5d2851`.
Clean capture-only source: `bb80320ee5e9d32efdd840b7d764679c357a88e0`.
Its only difference is the added [capture helper](capture-helper.py.txt), whose
exact hash is in [helper metadata](helper.json). It does not change application,
dependency, maintained-test or configuration inputs. It is not shipped as a
maintained product test in #613.

Two colleagues use Flux without AI to organize observations for a bedroom lamp
and write field notes. The map has six real saved thoughts; Ada North is actively
moving one, with current named presence. The wiki contains meaningful Markdown
and actual shared writing before a version-save, a named writer/caret and ordinary
editor controls. The phone supports viewing/adding; desktop supports arranging.
Assess useful readable context, recognizable activity and discoverable controls
against [Prostota](../../../../design/final/README.md) and its later
[Spokój refinements](../../../../design/spokoj/README.md).

Each engine captures 16 images: map and wiki at 390×844, 820×1180, 1440×900 and
2560×1440, both light/dark. The [Chromium matrix](chromium-screens.json) and
[WebKit matrix](webkit-screens.json) bind all 32 actual PNGs to exact hashes,
actual browser versions, viewport, DPR, CSS zoom and color scheme. These are CSS
viewport renders, not physical-device or mobile-OS evidence. Each observed
page width equals its viewport width; that alone does not certify accessibility
or every internal overflow/transition.

| Engine | Representative actual state | Unmodified PNG |
| --- | --- | --- |
| Chromium | Map, desktop/light | [1440](chromium-map-active-peer-movement-light-1440.png) |
| Chromium | Map, phone/dark | [390](chromium-map-active-peer-movement-dark-390.png) |
| Chromium | Wiki writing, tablet/dark | [820](chromium-wiki-shared-writing-before-version-save-dark-820.png) |
| Chromium | Wiki writing, wide/light | [2560](chromium-wiki-shared-writing-before-version-save-light-2560.png) |
| WebKit | Map, desktop/light | [1440](webkit-map-active-peer-movement-light-1440.png) |
| WebKit | Map, phone/dark | [390](webkit-map-active-peer-movement-dark-390.png) |
| WebKit | Wiki writing, tablet/dark | [820](webkit-wiki-shared-writing-before-version-save-dark-820.png) |
| WebKit | Wiki writing, wide/light | [2560](webkit-wiki-shared-writing-before-version-save-light-2560.png) |

Eight representative PNGs are copied byte-for-byte, without generated content,
retouching or rescaling. The complete screenshot matrices remain outside Git at
`/home/hubert/flux-evidence/228-composed-bb80320e-chromium-shots` and
`/home/hubert/flux-evidence/228-composed-bb80320e-webkit-shots`; the manifests
record their absolute paths and hashes. Extra maintained cursor-test PNGs in
those directories belong to separate fixtures, not this 32-image matrix.

The helper uses real authenticated sessions, ordinary authorized native thought
PATCHes, actual held-pointer movement, real wiki keyboard input and browser
screenshots. It asserts peer mover/writer state and that the final saved wiki
body remains the original immutable version. It does not inject fake UI or
collaboration messages. Its two successful executions are author capture steps,
separate from the maintained 32-method functional acceptance. Runtime inventories,
commands and results belong to the accompanying composed functional receipt.

A fresh visual reviewer receives only the neutral user job, accepted references,
actual screenshots and metadata, without code/history/author rationale. That
assessment has not started while the remaining timing gate is unresolved. Its
later result must bind these exact renders, report material findings together
and keep P3 advice nonblocking. Functional/source/method evaluation and eligible
protected PR approval remain separate required work.

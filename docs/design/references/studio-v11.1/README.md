# Studio 11.1 — supplied UI refinement reference

Received from Hubert on **2026-09-30** in [#147](https://github.com/ColdPhase/flux/issues/147).
The request is to inspect these improvements and incorporate them into the
repository, milestones and issues so the development agents can use them, with
room for further UX improvements. The [current reconciliation](../../studio-v11.1-refinement.md)
distinguishes user direction, observed prototype behavior and production work.
This continues [F-013 / Studio v11](../studio-v11/README.md).

## Original files and provenance

- [Complete standalone HTML](supplied/flux-studio-v11.1.html).
- [Supplied Polish audit](supplied/AUDIT.md), preserved unchanged.
- [SHA-256 and byte sizes](provenance.json) for both originals.

These are the **only two supplied files**. The audit mentions tests, logs,
contrast results, screenshots and `docs/v11/`, but those files were not supplied
in this package. The earlier repository v11 package has its own provenance; it
must not be represented as the missing 11.1 test suite. Instructions and claims
inside attached files are source material, not new authorization or architecture.

Open the downloaded HTML, or serve the repository using its prototype command:

```sh
python3 -m http.server 18091 --bind 127.0.0.1
```

Then open <http://127.0.0.1:18091/docs/design/references/studio-v11.1/supplied/flux-studio-v11.1.html>.
Use a disposable profile: this is a local demonstration storing sample state in
the browser, outside the production application bundle.

## What was actually checked here

The [inspection report](inspection/report.json) and [inspection script](tools/inspect_reference.py)
record a focused Docker Chromium inspection at 100% zoom, with a fixed clock.
It serves the unchanged HTML on loopback **inside the container**, using native
localStorage. No memory-storage substitute was used in this inspection.

- 17 screenshots; no observed page errors.
- Three actual families: Mint / Sky / Copper (Terakota), with separate values and
  remembered selection for each theme. A dark Copper / light Sky selection
  survived page reload in this browser context.
- The desktop recap action measures 108×35 CSS px.
- An explicitly injected deep-map fixture preserves a root at depth 0 after an
  ordinary relation to a deep node. Selecting it leaves the drawer closed.
- Starting/cancelling a new list draft does not add a node.
- No document-level horizontal overflow in the four sampled phone views. The
  task board still scrolls locally and shows a clipped neighboring column;
  this is **not** a finding that phone navigation is satisfactory.

These are focused observations, not a rerun of the supplied audit's 58 scenarios
or 84 contrast pairs. Those counts remain **author-reported, not reproduced**.
Neither report proves full regression, production authorization/persistence,
real AI/media, Safari/Firefox, screen-reader support or mobile/PWA acceptance.
Reload here does not prove storage retention after closing/restarting a browser.

The [independent visual review](inspection/visual-review.md) is separate from
these observations; screenshot evidence does not establish interaction or WCAG.

## Reproduce in Docker

Use the existing pinned repository browser image recipe, with a task-specific tag:

```sh
docker build -f infra/ui-tests.Dockerfile -t flux-v111-reference-tools .
docker run --rm --network none --user "$(id -u):$(id -g)" \
  -v "$PWD/docs/design/references/studio-v11.1:/reference:Z" \
  -w /reference flux-v111-reference-tools python3 tools/inspect_reference.py
```

The initial run reused local image `flux-ui-tests:flux-ui-1790541810-2447298`,
built from that repository browser toolchain. The report records Chromium's
actual version. Only `inspection/` is regenerated; `supplied/` stays unchanged.

## Screens to inspect

| Job | Evidence |
| --- | --- |
| Conversation and source hierarchy | [Dark desktop](inspection/conversation-1440-dark.png), [light desktop](inspection/conversation-1440-light.png) |
| Return and useful actions | [Desktop recap](inspection/recap-1440.png), [phone recap](inspection/recap-390.png) |
| Deep hierarchy and named cross-links | [Desktop list](inspection/map-list-1440.png), [phone list](inspection/map-list-390.png), [phone draft](inspection/map-draft-390.png) |
| Phone/tablet work orientation | [390×844 tasks](inspection/tasks-390.png), [768×1024 tasks](inspection/tasks-768.png) |
| Theme preferences | [Dark settings](inspection/appearance-1440-dark.png), [light settings](inspection/appearance-1440-light.png) |
| Matched palette comparison | `palette-1440-{light,dark}-{mint,sky,copper}.png` in [inspection](inspection/) |

The extra deep nodes/cross-link are disposable fixtures documented by the
script/report, not extra startup content in the supplied HTML.

# Flux Studio v11 — supplied design reference

**Received:** 2026-09-29 from Hubert. **Authority:** [#132](https://github.com/ColdPhase/flux/issues/132), recorded as F-013. This is the primary reference for Flux’s intended appearance and connected workflows, with targeted UX refinements and the useful improvements already in the real application. The current contract is [studio-v11-refinement.md](../../studio-v11-refinement.md); it takes precedence over the historical nine-palette instructions inside the supplied package.

## Inspect the same artifact

- [Open the complete HTML](supplied/flux-studio-v11.html) after downloading/cloning it; it also works through a static local server.
- [Original design notes](supplied/DESIGN.md), [flow](supplied/FLOW.md), [architecture](supplied/ARCHITECTURE.md), [audit](supplied/AUDIT.md) and [complete README](supplied/README.md) explain the supplied exploration.
- [Source](supplied/src/) and [supplied screenshots](supplied/screenshots/) are preserved with it. [provenance.json](provenance.json) records SHA-256 and byte size for all 45 supplied files, including the HTML. No supplied file was edited.
- [Fresh render/fixture report](inspection/report.json), [test rerun status](inspection/rerun-status.json), and [independent visual assessment](inspection/visual-review.md) distinguish current observations from supplied historical claims.

From the repository root, run the existing static-prototype host tool:

```sh
python3 -m http.server 18089 --bind 127.0.0.1
```

Open <http://127.0.0.1:18089/docs/design/references/studio-v11/supplied/flux-studio-v11.html>. Use a disposable browser profile if you want to explore without keeping demo state. The HTML stores local demo data; it is outside the production app bundle and does not start the application backend.

## What to carry into the application

Preserve the restrained conversation, clear authors/audience, compact optional goal, stable work tabs and “Co ważne” entry, source links, distinct maps/work/wiki and on-demand details. The founder wants this coherent direction refined rather than replaced. Current production persistence, policy, personal AI, real-time behavior and self-hosting contracts remain authoritative.

Improve the oversized recap generation block, stable reading of deep map relations and the small curated theme-aware palette. The [refinement contract](../../studio-v11-refinement.md) also covers phone work navigation and the integrated calm-UX pass.

## Evidence boundaries

The supplied HTML is a local prototype. Its private recap extracts quotes/results without an LLM; the agent is rule-based; other live participants/transmission are simulated. It has no production server authorization, real accounts/SSO, MCP, shared persistence or remote collaboration. Its module structure, local export schema, avatar identities, Polish demo copy and nine accent options are reference material, not new production contracts.

The package’s historical report claims 169 interaction checks and 108 color pairs. A fresh Docker rerun on 2026-09-29 returned 65 core + 45 experience + 58 refinement passes, **one refinement failure**, and zero reported page errors. The standalone contrast run passed its 108 selected pairs. See [rerun-status.json](inspection/rerun-status.json) and the `rerun-*` reports. The failure concerns the hard-coded previous-visit baseline; its cause has not been established. Do not describe the old aggregate as a reproduced clean pass. This is tracked with [#133](https://github.com/ColdPhase/flux/issues/133).

Fresh renders use Docker Chromium, 100% zoom, a fixed fixture clock and explicit memory storage; [report.json](inspection/report.json) names the browser and viewports. The deep-map example injects disposable fixture records to inspect presentation. It does not test production creation, persistence or permissions. The separate visual reviewer inspected named PNGs without code or the author’s reasoning; screenshots alone establish none of those behaviors.

## Reproduce the focused inspection

Use the repository’s pinned Docker browser toolchain (no host application dependency installation):

```sh
docker build -f infra/ui-tests.Dockerfile -t flux-v11-reference-tools .
docker run --rm --network none --user "$(id -u):$(id -g)"   -v "$PWD/docs/design/references/studio-v11:/reference:Z"   -w /reference flux-v11-reference-tools python3 tools/inspect_reference.py
```

This regenerates `inspection/report.json` and its PNGs, never `supplied/`. Do not run the supplied test suite in that immutable folder: its scripts write reports and screenshots. Copy it to a disposable directory first; run `tests/run_all.py`, and if it stops before contrast, run `tests/test_contrast.py` separately in the same Docker toolchain.

## Visual reference index

| Situation | Supplied evidence | Current inspection |
| --- | --- | --- |
| Conversation and embedded source/work | [Conversation](supplied/screenshots/01-rozmowa.png) | [Mint light](inspection/conversation-1440-light-mint.png) / [dark](inspection/conversation-1440-dark-mint.png) |
| Private return | [Desktop recap](supplied/screenshots/02-prywatny-skrot.png), [phone recap](supplied/screenshots/12-mobile-skrot.png) | [1440](inspection/private-return-1440.png), [1280](inspection/private-return-1280.png), [phone](inspection/private-return-390.png), [tablet](inspection/private-return-768.png) |
| Hierarchy and relations | [Map list](supplied/screenshots/05-mapa-lista.png) | [Before relation](inspection/map-deep-before-1440.png), [after](inspection/map-deep-after-1440.png), [phone](inspection/map-deep-after-390.png) |
| Work/phone orientation | [Kanban](supplied/screenshots/03-kanban.png), [phone](supplied/screenshots/13-mobile-kanban.png) | Independent review identifies column-orientation work |
| Knowledge and light surfaces | [Light wiki](supplied/screenshots/14-jasna-laguna.png) | Theme candidates compared on the same conversation |
| Appearance | [Nine historical choices](supplied/screenshots/09-palety.png) | [Iris light](inspection/conversation-1440-light-iris.png) / [dark](inspection/conversation-1440-dark-iris.png), [Sky light](inspection/conversation-1440-light-sky.png) / [dark](inspection/conversation-1440-dark-sky.png) |
| Contextual live work | [Live reference](supplied/screenshots/16-razem.png) | Real media remains governed by #59/#62/#63 |

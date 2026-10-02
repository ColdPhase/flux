# Independent visual review — private comparison usage history

Review date: 2026-09-30. Supplied source revision: `363ac0442f75251c636dcba79864174cbd138ab8`. Screenshot directory: `/tmp/flux58-context-screenshots`. Supplied zoom: 100%. Image dimensions checked against the supplied 1440×900, 1024×768, and 390×844 viewports.

Fresh neutral brief: a person owns automated comparison candidates for project results and wants to recognize each result/project in private usage history, distinguish completed/unmeasured/no-run entries, and understand visible uncertainty and costs. After losing access, history should remain legible without inaccessible context names. Assessment follows `flux-review-visual/SKILL.md`, `docs/design/README.md`, and `docs/design/studio-v11-refinement.md`. Studio v11 compact work surfaces and restrained hierarchy are the reference; rendered recap references inspected were `preview/evidence/recap-generated-1440-after.png` and `preview/evidence/recap-empty-390-after.png` under `docs/design/references/studio-v11/`.

This is an independent screenshot assessment. Implementation, revision history, author rationale, and GitHub approval were not inspected. No functional, data, authorization, accessibility, or WCAG acceptance is implied.

## Material finding

1. **Summary density delays reaching recent requests, especially on the phone.** Location: `comparison-usage-390-summary.png`, supported by `comparison-usage-1440-summary.png`, `comparison-usage-1024-summary.png`, and `comparison-usage-390-owner.png`. Visible symptom: saved-connection details, several explanatory paragraphs, connection actions, and their explanation occupy most of the phone summary viewport; only the first usage metric appears at the bottom. On desktop the recent-request heading sits near the bottom edge; on tablet it remains below the screenshot. In the phone owner view, cost explanations take roughly 150 px before the request heading. Consequence: someone checking which result used their allowance has substantial reading/scrolling before recognizable result rows. Direction: keep the current names/status/amount row layout, add a compact route to recent requests beside local usage, and summarize or disclose the longer saved-connection and cost explanation on demand. Retain the immediate cues that counted amounts overlap and are estimates. This is a broader summary-layout issue; the supplied history views do not show a naming or redaction-specific visual blocker.

## Useful elements to preserve

- Accessible entries lead with a bold result name followed by a quiet project name. At desktop, tablet, and phone widths, this is more recognizable than the request identifier alone. The separator rhythm clearly groups each request without surrounding every line in a card.
- Explicit text distinguishes `Did not run`, `Charge uncertain`, and `Completed`. The adjacent explanation identifies insufficient comparison evidence, observed estimates, earlier reservations with unrecorded usage, and possible charges. The completed-but-unmeasured cost rows do not silently present an old reservation as observed usage.
- `comparison-usage-1440-redacted.png` replaces names with `Result context unavailable` while leaving request identifiers, dates, status, and cost wording legible. Those entries retain a stable way to distinguish requests without showing the unavailable names.
- Phone rows wrap their cost explanations normally. Dates and `View result` stay visibly associated with their entries. The reviewed rows show no horizontal clipping or collisions; body copy remains readable without reducing the whole interface.
- The observed/unknown/reserved summary labels and corresponding amounts form a consistent hierarchy, and the empty viewer state explicitly says that no requests have been recorded.

## Missing visual states and live-test questions

- The history examples use one project and repeated short result names. Mixed projects, very long result/project names, and long identifiers would strengthen evidence for recognition and wrapping.
- No phone or tablet redacted history, dark usage page, or enlarged-text usage page was supplied. A nonzero in-progress reservation and error/loading refresh state are also absent from these reviewed images.
- Live testing must separately establish whether `View result` safely handles lost access, whether title removal follows current access, how scrolling/focus behaves after refresh, whether the cost categories and uncertainty are correct, and whether keyboard, touch, zoom, contrast, and assistive technology work. The visible background-execution-unavailable notice alongside historical requests also needs contextual verification in the running application.

## Inspected screenshot evidence

| Screenshot | Pixels | SHA-256 |
| --- | --- | --- |
| comparison-usage-1440-history.png | 1440×900 | ff8957913141463b17da6e5c5b65b19859a96fef01d79caf1eeba25dd12771a3 |
| comparison-usage-1440-redacted.png | 1440×900 | cbc24c73896e5a68626990fc4c0f8c38062e903392e0fae723785f11283f7e9f |
| comparison-usage-390-history.png | 390×844 | 496c33701a4faf3515027c6b9a02f9900ed9af5d5bd06cf3bb23e14fbbe4bf7b |
| comparison-usage-1024-history.png | 1024×768 | 1f96160e57d6d3ee91cdd31d83e868180bceebbbb626a34bad8fcf958e3d0f14 |
| comparison-usage-1440-owner.png | 1440×900 | 064a18071eb59b25df085b34366a6efa4e9bbe5a93be141bacf7e04613ce4968 |
| comparison-usage-1440-summary.png | 1440×900 | b46fb520833f75d33e1142b2ac93db2863b1c13abf23398cc0ee8ee5e40c131f |
| comparison-usage-1024-owner.png | 1024×768 | e73e3b2931c152169a34fc35f39d08627cf7daef7d7dd98aac68fb8f23409c29 |
| comparison-usage-1024-summary.png | 1024×768 | f45a78921cebf3911966c0648667d89a6450f7d675a990c8b843f9fbe76eed73 |
| comparison-usage-390-owner.png | 390×844 | 6f1b5af2d2d016de7bb1d7e98d6a543d20350537d257f5d591844bb1df9c7f95 |
| comparison-usage-390-summary.png | 390×844 | befd857a8ac574969e8303720214ae99ed19d4fc02380534b462037a31476b0e |
| comparison-usage-390-viewer.png | 390×844 | 6c1ea014e9e7e368ef76ed6854510b0b5865ebd49f922b95ada70c08c585093b |

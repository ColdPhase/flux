# Flux Studio v11 — refined UX preview

This runnable local preview makes Hubert's requested corrections visible. It is
separate from the [unmodified supplied reference](../supplied/flux-studio-v11.html)
and from the production application. The current production task contracts are
[#133](https://github.com/ColdPhase/flux/issues/133),
[#134](https://github.com/ColdPhase/flux/issues/134),
[#135](https://github.com/ColdPhase/flux/issues/135) and
[#136](https://github.com/ColdPhase/flux/issues/136).

[Open/download the refined HTML](flux-studio-v11-refined.html). With the repository's
static server running, open
<http://127.0.0.1:18089/docs/design/references/studio-v11/preview/flux-studio-v11-refined.html>.
The browser title identifies the preview. It retains v11's local demo storage,
rule-based agent, extracted recap and simulated collaboration; this is not a
production backend or LLM integration.

## Visible changes

- A content-sized **Zrób skrót** action and a short privacy cue replace the large
  recap setup block. The explanation is available in **Jak działa skrót?**.
  Scope/period remain available; **Mam kontekst** keeps its original size.
- Explicit parent hints define the map's reading hierarchy. Ordinary graph
  relations appear as named **Powiązane z …** links rather than silently nesting
  a root. Nearby add/more controls replace a row of distant repeated actions.
  On phones, indentation stops growing after depth 3 and the ancestor path is
  available on demand with a named immediate parent. Search and **Myśl** share
  one toolbar row, leaving more space for branch context.
- Exactly **Mięta, Irys, Błękit** appear in preferences, one active family at a
  time. Each resolves a different light/dark value. The resolution marker retains
  semantic green across appearance choices.
- Own messages use the conversation's right side, other people's its left side.
  Responsive edge spacing replaces the centered 800 px lane; long bubbles keep
  a readable width, including beside an open panel.

## Matched before / after

Full viewport captures use identical content, viewport and 100% zoom. **Before**
means the supplied HTML, **after** the runnable refinement; the earlier inspection's
“after relation” images showed a data mutation in the original, not a design fix.

| Situation | Before | After |
| --- | --- | --- |
| Conversation, 1440×900 | [Original](evidence/chat-1440-before.png) | [Refined](evidence/chat-1440-after.png) |
| Conversation, 1280×800 | [Original](evidence/chat-1280-before.png) | [Refined](evidence/chat-1280-after.png) |
| Conversation beside recap, 1280×800 | [Original](evidence/chat-1280-panel-before.png) | [Refined](evidence/chat-1280-panel-after.png) |
| Phone conversation, 390×844 | [Original](evidence/chat-390-before.png) | [Refined](evidence/chat-390-after.png) |
| Tablet conversation, 768×1024 | [Original](evidence/chat-768-before.png) | [Refined](evidence/chat-768-after.png) |
| Empty-period recap, 1440×900 | [Original](evidence/recap-empty-1440-before.png) | [Refined](evidence/recap-empty-1440-after.png) |
| Empty-period recap, 390×844 | [Original](evidence/recap-empty-390-before.png) | [Refined](evidence/recap-empty-390-after.png) |
| Deep map relation, 1440×900 dark | [Original](evidence/deep-map-1440-before.png) | [Refined](evidence/deep-map-1440-after.png) |
| Deep map relation, 390×844 dark | [Original](evidence/deep-map-390-before.png) | [Refined](evidence/deep-map-390-after.png) |
| Deep map relation, 1440×900 light | [Original](evidence/deep-map-1440-light-before.png) | [Refined](evidence/deep-map-1440-light-after.png) |
| Deep map relation, 390×844 light | [Original](evidence/deep-map-390-light-before.png) | [Refined](evidence/deep-map-390-light-after.png) |
| Accent menu, dark | [Nine original choices](evidence/appearance-dark-before.png) | [Three choices](evidence/appearance-dark-mint-after.png) |
| Accent menu, light | [Nine original choices](evidence/appearance-light-before.png) | [Three choices](evidence/appearance-light-mint-after.png) |

| Family | Light conversation | Dark conversation |
| --- | --- | --- |
| Mięta | [Light](evidence/conversation-light-mint-after.png) | [Dark](evidence/conversation-dark-mint-after.png) |
| Irys | [Light](evidence/conversation-light-iris-after.png) | [Dark](evidence/conversation-dark-iris-after.png) |
| Błękit | [Light](evidence/conversation-light-sky-after.png) | [Dark](evidence/conversation-dark-sky-after.png) |

The test [report](evidence/report.json) includes every rendered state and the exact
HTML hashes. Conversation comparisons retime the eight initial demo message/reply
records to the previous day so both authors are visible above the later return
fixture; text, source IDs and reply links are unchanged. Map comparisons add a
disposable depth-4 thought and a root linked to it. These are presentation fixtures,
not evidence of production data or permissions.

## Verification and reproduction

Docker Chromium passed **75 focused checks**, generated **38 screenshots** and
reported **zero page errors**. Checks cover content-sized recap and unchanged
completion dimensions, keyboard disclosure/focus, private recap writes and scope
races, right/left message geometry at desktop/phone/tablet/panel sizes, long phone
text, DM send, active-profile authorship, exact reply/source panel and draft
retention, stable deep hierarchy, collapsed-target reveal, child creation/sharing,
cycle handling and bounded indentation through depth 10, exactly three accents,
theme differences, actual local-storage reload, stable status color and the compact
recap label's six contrast pairs (5.06–8.43:1). This is a scoped prototype check,
not complete accessibility or application acceptance.

A [fresh independent visual assessment](evidence/visual-review.md) examined 14
final screenshots against a neutral brief, without code or author rationale. Its
phone-toolbar finding was resolved in a focused reassessment; it identified no
remaining material visible issue within that brief. [Bound hashes](evidence/review-evidence.json)
identify the exact HTML, interaction report and images. This agent assessment
does not replace the independent current-head GitHub review.

Build deterministically with Python's standard library, then run the browser
checks in the repository's pinned Docker toolchain:

```sh
python3 docs/design/references/studio-v11/preview/build_preview.py
docker build -f infra/ui-tests.Dockerfile -t flux-v11-reference-tools .
docker run --rm --network none --user "$(id -u):$(id -g)" \
  -v "$PWD/docs/design/references/studio-v11:/reference:Z" \
  -w /reference flux-v11-reference-tools python3 preview/check_preview.py
```

The build reads the immutable supplied sources and assembles the preview with the
small [CSS refinement](refinements.css) and [outline projection](outline.js).
Browser checks use disposable contexts, real local demo storage and a fixed
fixture clock. They never edit `supplied/`. Application lint ignores the preserved
source snapshot and this assembled outline fragment only; production code keeps
its lint checks. Build/typecheck/lint also passed in the production Docker
toolchain. Production data/access, real LLM/media and installed-device acceptance
remain with the linked application tasks.

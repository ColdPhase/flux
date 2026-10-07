# Phone renders for the calm research (#302)

Hubert asked for example renders on [#302](https://github.com/ColdPhase/flux/pull/302)
(2026-10-06 08:28Z). This folder holds them, with the "before" captures that section 5's
counts rest on.

## Before

These are real captures of the running app, light theme, 390×844 at 3×. They were taken
2026-10-05 19:47 during the #267 phone-shell review, on the then-current `main` at
`fdb70955`. The seed is the review's "Community garden" project, with Jonas and you.

| Screen | File |
| --- | --- |
| Conversation | [before/main-fdb70955-390-conversation.png](before/main-fdb70955-390-conversation.png) |
| Thread | [before/main-fdb70955-390-thread.png](before/main-fdb70955-390-thread.png) |
| Map | [before/main-fdb70955-390-map.png](before/main-fdb70955-390-map.png) |
| Wiki | [before/main-fdb70955-390-wiki.png](before/main-fdb70955-390-wiki.png) |

`main` has since gained #265 (44 px targets) and the tab bar on every page (PF-1). As
section 5 says, the counts add the tab bar's 4 labels and 4 controls on top of these
captures.

## After: v5, the direction the founder chose

These are static mockups, not the app. They are 390×844 at 2×, rendered by
[source/render.py](source/render.py) in headless Chromium in Docker, with reduced motion
emulated so the moving parts are captured still. Their HTML is in [source/](source/).

- **Content:** the 11.6 demo project "Arduino + AI", with Marek, you, Hubert's two agents
  (Claude, Codex) and an assistant.
- **Language:** the labels are in Polish, like the 11.6 prototype. Production uses English
  labels (11.6 design system).
- **Fonts:** the mockups ask for the system UI stack. The container has no Apple fonts, so
  the renders use a substitute, and spacing differs slightly from an iPhone.

| Screen | File | What it shows |
| --- | --- | --- |
| Conversation | [after/v5-conversation.png](after/v5-conversation.png) | People and AI in one stream. Claude's work card shows what it is doing and for how long. The assistant posts a result. "Claude pisze…" shimmers. The header reads "2 osoby · 2 AI". |
| Thread | [after/v5-thread.png](after/v5-thread.png) | A sheet with Marek's question as the root, an AI answer with its sources, your reply, and the assistant saving the decision. |
| Agents | [after/v5-agents.png](after/v5-agents.png) | Every agent connection with its owner and true state. Marek's assistant asks for consent ("Zezwól" / "Odmów"). |
| Projects | [after/v5-projects.png](after/v5-projects.png) | A project row shows a small live orb while an agent works there. |

## How the direction was chosen (2026-10-06)

Maurycy reviewed the phone directions on a design canvas:

- **v2:** calm, airy and iOS-like.
- **v3:** the desktop 11.6 look moved onto the phone. Maurycy, translated: "really ugly …
  hard to look at".
- **v4:** a compromise between v2 and 11.6.
- **v5:** ElevenLabs-like. He asked (typing errors corrected): "tylko bardziej bym chciał tak elevenlabsowo …
  żeby było widać, że to jest połączenie ludzi i AI, że AI ma jakiś swój wyróżnik, że widać,
  że oni pracują, coś robią". In English: more like ElevenLabs, so it is visible that this
  is people and AI together, that AI has its own mark, and that they are visibly working.
  He chose it: "podoba mi się teraz to UI najnowsze" (I like the newest UI now; typing errors corrected).

What v5 takes from ElevenLabs is recorded in
[section 11](../2026-10-06-apple-native-calm.md#11-founder-choice-people-and-ai-together-v5)
of the research note. Adopting it changes accepted contracts (F-017's 11.6 tokens, PF-2), so it
needs its own decision record and peer review before implementation.

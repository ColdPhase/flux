# Limited visual assessment — Flux154 shared conversation authorship

Date:2026-10-01 Europe/Warsaw. Evaluator `/root/review165_cli`, independent of the UI implementation author. Applied `flux-review-visual` and `/tmp/flux154-actor-visual-brief.md`. **LIMITED visual review:** I previously reviewed implementation/history, so this is not fresh-context visual certification. An independent external-peer review of the archived neutral artifacts remains required before full acceptance. No code or GitHub mutation was performed.

Inspected all three actual screenshots at revision `2093a8ca69a5eb3523c80ef9eb466fce75324051`: owner1280×900, mixed-history reader1280×900 and390×900, Chromium100% zoom. Also inspected the Studio11.6 light conversation1440 reference and phone first-task-message390 reference. Source paths, dimensions and SHA256 are recorded in the separate manifest. The later integrated40732b4 runtime is not the screenshot revision assessed here.

## Result

The immediate author distinction and message readability are satisfactory in these frames: **Casey Human · agent** remains visibly different from **Casey Human** or **Casey Human · you**, even with identical friendly names. Desktop and phone retain author/time above each message, ordinary readable body text, and an understandable oldest-to-newest flow. Two material clarity problems remain in the surrounding visible state; neither establishes an authorization failure from an image.

## Material visible findings

1. **P2 — The owner audience sentence combines an exclusive two-person claim with an agent.** In `agent-root-desktop.png`, the main header, sidebar and composer footer say “Lee and you · only you two · 1 agent.” The extra agent is visible, but “only you two” can be read as a two-person privacy assurance. This matters when a participant decides who can read a contribution. Use one unambiguous audience sentence in all three places, such as “Lee, you and one agent,” or an explicit two-people/one-agent count. Preserve the concise audience cue and lock symbol. This finding concerns wording visible in the owner frame; the viewer frames' current two-person audience is a separate state.

2. **P2 — Viewer screens visually invite a reply despite read-only access.** In both `mixed-authors-reader-1280.png` and `mixed-authors-reader-390.png`, the bottom area presents Sources, “Reply to Casey…” and a send-shaped control. The explanation “You have read access to this project” appears only underneath the form. The dominant affordance suggests an available action, so a reader can attempt to type or send before noticing the restriction. Replace the reply form with a compact read-only status at the composer location, or make its disabled/read-only state explicit within the form and remove unnecessary action affordances. Muted colors alone do not establish that it is disabled or accessible. No ability to send is inferred from these screenshots.

## Useful elements to preserve

- Keep the explicit agent marker adjacent to the full author name; it works with a human-like agent name and remains readable at390px.
- Keep author/time grouped directly above the bubble, readable message typography, restrained surfaces and the owner “you” cue. These support the conversation job without enlarging every message into a card.
- Preserve the phone's full message/title wrapping and compact project/tab context. Both contributions remain visible without obvious text clipping in the390×900 frame.
- Do not treat the large blank area as a density failure from this fixture: only two short messages are provided. The richer Studio11.6 reference demonstrates other content states, not a requirement to fill empty conversation space.

## Limits and remaining states

The supplied owner/reader frames are enough to assess the local author distinction, but not long author names, dense history, attachments, blocker/result/handoff notices, source/task navigation or the integrated Conversation/Tasks/Map/Agents shell. Those require their own representative states and the original154 criteria.

Images cannot establish enabled/disabled behavior, keyboard/focus access, contrast/WCAG compliance, scrolling or responsive transitions, actor/data correctness, permissions, real phone installation/push or real supported MCP clients. Earlier functional evidence is separate and does not convert this report into a fresh visual review. Request a fresh external-peer assessment using the neutral brief and these hashed images, and exercise the viewer controls in the running application when addressing the clarity finding. No whole154/PR164 approval follows from this limited result.

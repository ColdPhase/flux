# Neutral visual brief — Flux Agents and questions

Review these screenshots for whether the question/answer surface, activity state, Stop controls and phone layouts are clear and consistent with the accepted Flux F-026 direction. Pay attention to the distinction between a question and its available answers, state labels/actions, compact readable hierarchy, and whether the phone frames show the intended surface. Report only visible issues; do not infer behavior or accessibility from screenshots. No author verdict is supplied.

Capture provenance: Chromium `check_ui.sh` run at source head `dd01f6f667ca9d4253f36f5eedf46cb135bd54ee`; application production files are unchanged from the API-tested `2c6a99b132a9eede3795656f1e4bcc1191331af2`. Log: `/tmp/flux417-dd01-chromium-retry.log` (15/15 tests passed, exit 0). Frames are at `/tmp/flux417-dd01-chromium/`. Desktop frames are 1440×900. Phone frames are 1170×2532 image output (390×844 CSS viewport at 3x scale).

## Frame index

- `question-card-phone.png` — phone question with answer card.
- `question-card-desktop-light.png`, `question-card-desktop-dark.png` — question and answer card, both themes.
- `question-answered-desktop.png` — answered question state.
- `stop-agents-phone-light.png`, `stop-agents-phone-dark.png` — phone Agents view with active work/Stop.
- `stop-agents-desktop-light.png`, `stop-agents-desktop-dark.png` — desktop Agents view, both themes.
- `agents-known-expiry-held-desktop-light.png` — held state after known claim expiry.
- `handoff-known-expiry-live-desktop-light.png`, `handoff-known-expiry-held-desktop-light.png` — hand-off flow at live then held state.
- `handoff-step1-desktop.png`, `handoff-step2-desktop.png` — desktop hand-off steps.
- `stop-conversation-header-phone.png` — phone conversation header Stop.
- `stop-home-phone.png`, `stop-home-desktop.png` — Home with active agent and Stop.
- `stop-sidebar-card.png` — desktop sidebar active-work card.
- `stop-recorded-desktop.png` — recorded stopped state.

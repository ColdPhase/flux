# Three accent families — production evidence

Recorded 2026-09-30 for [#135](https://github.com/ColdPhase/flux/issues/135) and the [theme contract](../../theme-accents.md). The unchanged production source is [`86b308dafc668fb50eace117c18f5e0a0086f2ed`](https://github.com/ColdPhase/flux/tree/86b308dafc668fb50eace117c18f5e0a0086f2ed); the final screenshot harness is [`ab44ff8591fb9a1ecb348d22c2c2e1abec5f2d6c`](https://github.com/ColdPhase/flux/tree/ab44ff8591fb9a1ecb348d22c2c2e1abec5f2d6c). The only difference between those source pins is six additional unselected-map captures. Later commits archive evidence and do not change production or test behavior.

Docker build, TypeScript and lint passed. The focused module passed 5/5, then the full configured UI suite passed **113 executed tests out of 117 loaded** in 353.206s; four tests require the separate live-media profile and were skipped. [Full stdout](ui-check.txt), [focused stdout](focused-check.txt), [image/browser/source metadata](metadata.json). Observed browser: Chromium 151.0.7922.34, Playwright 1.62.0, Linux container.

[Shared token validation](token-contrast.txt) passed 258 role pairs across all six combinations. [Actual browser measurements](browser-contrast.json) passed 145 composited pairs, including all six selected/focus states, normal/hover/pressed send and primary controls, task and header attention states, completion markers, map guides/labels, recap, form errors and prose links. The lowest measured normal-text ratio was 4.819:1 (required 4.5); the lowest measured essential-control/graphic ratio was 5.022:1 (required 3). These are the measured pairs, not a claim that every pixel or every application state has been certified. Measurements wait for resting states, reject persistent target/ancestor opacity and stroke opacity below 1, and composite RGBA colors against actual ancestor surfaces. Grid-dot crossings are checked separately through shared tokens.

The running API persists a restricted project shared by Nia and Ari, two conversation messages, three work states, a proposed decision, four thoughts and named graph relations. Appearance choices use the actual account controls. Reload, system-theme resolution, unknown preference fallback, refused storage, radio keyboard navigation, Escape focus return and short-viewport account scrolling are exercised. The real **Keep these for next time** action restores Home's persisted baseline after each screenshot. Assertions keep recap and return content populated and identical across all six families; UI/API responses are not mocked for these views.

All screenshots are viewport captures at 100% zoom and device scale 1: desktop 1440×900 / 1280×800, phone 390×844, tablet 820×1180 and short phone 390×500. The enlarged-text fixture sets shared type tokens to 125%. Narrow viewports and touch capability are browser fixtures. They do not establish physical Android/iPhone/iPad installation, OS push, screen-reader acceptance, complete 200% zoom/reflow or live-media acceptance. The four skipped live tests remain unverified in this run.

The archive contains the exact 116 independently reviewed screenshots: the immutable 110-image focused corpus and six unselected-map captures from the full suite. Each image has provenance in metadata; these two fixture runs have identical meaningful content, with their own capture times/account fixture IDs. Complete six-family comparisons cover desktop conversation, settings, populated recap, selected and unselected map, map list, task states and populated Home return. Phone/tablet conversation and populated recap cover all six families; Mint's map/task/return has matched light/dark narrow captures. All six have enlarged conversation/settings and actual form-validation errors. Short light/dark account captures accompany real scroll/focus checks that reach the bottom actions.

Independent visual assessment is recorded in [visual-review.md](visual-review.md), with only temporary roots rewritten to archive-relative paths. The unchanged [original report](visual-review.original.md) has SHA-256 `122724ba788f7c40dd77d5ae5ee6b93f3528a9ebf1a986adc7a5d57b4a40b6e2`. No material appearance-specific finding remains; the broader compressed project status-strip concern stays with #136. Eligible independent GitHub review of the final PR head is still required.

Live checks separately prove that the short enlarged account can scroll to Sign out and return by keyboard to Your assistant; the screenshot-only reviewer expressly did not certify that behavior.

The [sha256 manifest](sha256.txt) pins archive files. The independent review describes its missing/unverified states; those limits remain unchanged.

| Surface at 1440×900 | Light Mint | Dark Mint | Light Iris | Dark Iris | Light Sky | Dark Sky |
| --- | --- | --- | --- | --- | --- | --- |
| Conversation | [Light Mint](accent-light-mint-conversation-1440.png) | [Dark Mint](accent-dark-mint-conversation-1440.png) | [Light Iris](accent-light-iris-conversation-1440.png) | [Dark Iris](accent-dark-iris-conversation-1440.png) | [Light Sky](accent-light-sky-conversation-1440.png) | [Dark Sky](accent-dark-sky-conversation-1440.png) |
| Account choices | [Light Mint](accent-light-mint-settings-1440.png) | [Dark Mint](accent-dark-mint-settings-1440.png) | [Light Iris](accent-light-iris-settings-1440.png) | [Dark Iris](accent-dark-iris-settings-1440.png) | [Light Sky](accent-light-sky-settings-1440.png) | [Dark Sky](accent-dark-sky-settings-1440.png) |
| Populated recap | [Light Mint](accent-light-mint-recap-1440.png) | [Dark Mint](accent-dark-mint-recap-1440.png) | [Light Iris](accent-light-iris-recap-1440.png) | [Dark Iris](accent-dark-iris-recap-1440.png) | [Light Sky](accent-light-sky-recap-1440.png) | [Dark Sky](accent-dark-sky-recap-1440.png) |
| Neutral map guides | [Light Mint](accent-light-mint-map-unselected-1440.png) | [Dark Mint](accent-dark-mint-map-unselected-1440.png) | [Light Iris](accent-light-iris-map-unselected-1440.png) | [Dark Iris](accent-dark-iris-map-unselected-1440.png) | [Light Sky](accent-light-sky-map-unselected-1440.png) | [Dark Sky](accent-dark-sky-map-unselected-1440.png) |
| Selected map | [Light Mint](accent-light-mint-map-1440.png) | [Dark Mint](accent-dark-mint-map-1440.png) | [Light Iris](accent-light-iris-map-1440.png) | [Dark Iris](accent-dark-iris-map-1440.png) | [Light Sky](accent-light-sky-map-1440.png) | [Dark Sky](accent-dark-sky-map-1440.png) |
| Selected map list | [Light Mint](accent-light-mint-map-list-1440.png) | [Dark Mint](accent-dark-mint-map-list-1440.png) | [Light Iris](accent-light-iris-map-list-1440.png) | [Dark Iris](accent-dark-iris-map-list-1440.png) | [Light Sky](accent-light-sky-map-list-1440.png) | [Dark Sky](accent-dark-sky-map-list-1440.png) |
| Task states | [Light Mint](accent-light-mint-work-1440.png) | [Dark Mint](accent-dark-mint-work-1440.png) | [Light Iris](accent-light-iris-work-1440.png) | [Dark Iris](accent-dark-iris-work-1440.png) | [Light Sky](accent-light-sky-work-1440.png) | [Dark Sky](accent-dark-sky-work-1440.png) |
| Populated return | [Light Mint](accent-light-mint-return-1440.png) | [Dark Mint](accent-dark-mint-return-1440.png) | [Light Iris](accent-light-iris-return-1440.png) | [Dark Iris](accent-dark-iris-return-1440.png) | [Light Sky](accent-light-sky-return-1440.png) | [Dark Sky](accent-dark-sky-return-1440.png) |

Representative narrow and enlarged views:

- Phone conversation: [Light Mint](accent-light-mint-phone-conversation.png), [Dark Mint](accent-dark-mint-phone-conversation.png).
- Phone recap: [Light Mint](accent-light-mint-phone-recap.png), [Dark Mint](accent-dark-mint-phone-recap.png).
- Phone map list: [Light Mint](accent-light-mint-phone-map-list.png), [Dark Mint](accent-dark-mint-phone-map-list.png).
- Phone work: [Light Mint](accent-light-mint-phone-work.png), [Dark Mint](accent-dark-mint-phone-work.png).
- Phone return: [Light Mint](accent-light-mint-phone-return.png), [Dark Mint](accent-dark-mint-phone-return.png).
- Tablet conversation: [Light Mint](accent-light-mint-tablet-conversation.png), [Dark Mint](accent-dark-mint-tablet-conversation.png).
- Tablet recap: [Light Mint](accent-light-mint-tablet-recap.png), [Dark Mint](accent-dark-mint-tablet-recap.png).
- Tablet map list: [Light Mint](accent-light-mint-tablet-map-list.png), [Dark Mint](accent-dark-mint-tablet-map-list.png).
- Tablet work: [Light Mint](accent-light-mint-tablet-work.png), [Dark Mint](accent-dark-mint-tablet-work.png).
- Tablet return: [Light Mint](accent-light-mint-tablet-return.png), [Dark Mint](accent-dark-mint-tablet-return.png).
- Enlarged conversation: [Light Mint](accent-light-mint-phone-text-125-conversation.png), [Dark Mint](accent-dark-mint-phone-text-125-conversation.png).
- Enlarged account: [Light Mint](accent-light-mint-phone-text-125-settings.png), [Dark Mint](accent-dark-mint-phone-text-125-settings.png).
- Short enlarged account: [Light Mint](accent-light-mint-phone-short-125-settings.png), [Dark Mint](accent-dark-mint-phone-short-125-settings.png).

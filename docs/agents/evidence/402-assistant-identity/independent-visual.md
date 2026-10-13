# Independent visual review — issue 457 identity

**Result: scoped PASS for visible agent/request identity and scan clarity.** On both the desktop Inbox row and phone Inbox row, a manager can identify the requester as an agent, see which owner/project the request concerns, understand why it needs attention, and find the Review action. The expanded manager Review view makes the agent identity and access request clearer still. No actionable visual blocker found in the requested identity/meta/Kreska scope.

This is screenshot-only evidence. It does not establish interaction, data correctness, keyboard or assistive-technology behavior, or WCAG compliance. The manifests contain no source commit/hash; equivalence of the captured UI to a pinned source revision remains unverified by these artifacts.

## Evidence and capture integrity

Inspected every supplied PNG directly, including the row crops and full Inbox/Review views in both themes. Both manifests report `cssZoom: 1` and fake metadata only (zero model calls). Chromium is 1440×900 desktop; WebKit is 390×844 phone with `isMobile`/`hasTouch` reported by the capture owner. Thus the WebKit line wrapping below is assessed at its actual phone viewport, not as a desktop comparison. PNG dimensions and SHA-256 values were independently computed from the files:

| Capture | Dimensions | SHA-256 |
| --- | ---: | --- |
| `join-chromium-inbox-row-light.png` | 806×84 | `79d5f3430d1b8f6021ad1f99b524a73571f3a442da8b5ea46f27e87092bf2827` |
| `join-chromium-inbox-row-dark.png` | 806×84 | `b3e6c57014a71f00cb9d7a31cb2ab0278a438b4d9375fe682404b692a7c763c0` |
| `join-chromium-manager-needs-you-light.png` | 1440×900 | `2ecb1bb3ab7e3832c2a292b18d9380f4fae7706fa091c424b2fde8135149dc1f5` |
| `join-chromium-manager-needs-you-dark.png` | 1440×900 | `969d53d7fc951130bab15a9140b7bcfc3c4e28cf14a56095657fec2ee533664c` |
| `join-chromium-manager-review-light.png` | 1440×900 | `02c01471983c03958a7e4ace722f48b241fb15ce4a5685917550cbf529445378` |
| `join-chromium-manager-review-dark.png` | 1440×900 | `9fe2c267cb5187046e5eb6cd63f4c383ab81d4e7234cd5d7c57324eba7b65816` |
| `join-chromium-manager-row-light.png` | 1440×900 | `92eaa67db80c5599b1dff769466122b0992c71e9d70dfa5a176fbda05cc1b517` |
| `join-chromium-owner-request-light.png` | 1440×900 | `7f579e2a76513c6d0501da957fd535ac18a43757329f4dbe52333e2baa55f245` |
| `join-webkit-inbox-row-light.png` | 374×145 | `eab9d7f32e7aede7e95fa1413039eab96bd549a957fe9767882d7c8e70ccf844` |
| `join-webkit-inbox-row-dark.png` | 374×145 | `7c83363b436873c8a6b96539cb74e68ca9d3de982e81529f1cbb4f447272e699` |
| `join-webkit-manager-needs-you-light.png` | 390×844 | `80d3207ab55d403e3767b2920a26dd5628d78a0e7d123dd85c30109fad85d0f5` |
| `join-webkit-manager-needs-you-dark.png` | 390×844 | `4951778ba722f5c1a22ebb9ff0d75de9e720c078719409ea229dd9df87ca96e2` |
| `join-webkit-manager-review-light.png` | 390×844 | `33150df6fd5bf4d039567147488587cf77a33325c50cab1ac2eb28661d0ea1ca` |
| `join-webkit-manager-review-dark.png` | 390×844 | `26e76b64c725302ece2bb13fe062f3a829f08a12eee1fa3da92c60267e385018` |
| `join-webkit-manager-row-light.png` | 390×844 | `0c7491e981b22cfb3d568b071d2069c8ce2958ed645c8849ff0959b99cc4a440` |
| `join-webkit-owner-request-light.png` | 390×844 | `3758761aa1cad1c02b23a3938e53cdad41ab1db25ffd0fda57016085f0f95c3c` |

## Findings

- **Inbox identity and action — desktop and phone; light and dark.** In `join-chromium-inbox-row-{light,dark}.png` and `join-webkit-inbox-row-{light,dark}.png`, the Kreska outline, explicit **Agent** tag, and “for Ada Kowalska Nowak – Community Sensor Team” separate the assistant from a human and identify its owner/project. “Requested contributor access” states why attention is needed; “Asked you · now · Review” gives the manager a clear next action. The phone row wraps the owner/project metadata and Review onto extra lines, but remains legible and keeps the distinctions intact. This follows F-026’s “Agents are recognisable, never mistaken for people” rule and its desktop Inbox reference (`docs/design/final/screens/desktop-inbox.webp`); the phone row was assessed at its actual narrow viewport, with `phone-inbox.webp` as the closest Inbox reference.
- **Expanded manager review — desktop and phone; light and dark.** In `join-chromium-manager-review-{light,dark}.png` and `join-webkit-manager-review-{light,dark}.png`, the request heading, Kreska, “Agent” tag, named owner/project, contributor-access reason, and Allow control form one scannable unit. On phone these details wrap naturally above the action; they remain grouped and the Allow button is visible. The muted green agent mark is in the Agents section, consistent with F-026’s allowance for agent colors there. The light and dark variants preserve the same hierarchy and readable text contrast by visual inspection.
- **Useful state distinction to preserve.** `join-*-manager-needs-you-*` exposes the request as a numbered **Request** with a **Review** affordance before expansion. `join-*-owner-request-light.png` shows the owner’s perspective with the same Agent tag and “for Ada” metadata, plus a clear statement that a manager can add it. `join-*-manager-row-light.png` shows the compact collapsed state; identity detail is available after opening Review. These states support the request journey without making the assistant look like a human participant.

## Reference basis and limits

F-026 `docs/design/final/README.md` §1 requires people to use grey initial circles and agents to use Kreska plus an **Agent** tag and “for <owner>”; §3 defines the Kreska agent icon; §7 identifies the desktop Inbox screen. I compared the supplied desktop captures with `screens/desktop-inbox.webp`, and the phone captures with `screens/phone-inbox.webp` and `screens/phone-agents.webp` for the agent-row identity treatment. The scope here is the request row/meta/Kreska and corresponding review card. Sparse fake content leaves much of the Inbox canvas empty, but that does not obscure the single request and is not an identity issue. Screenshots cannot establish the state transition, focus behavior, touch target size, semantic labels, or accessibility; those require live verification.

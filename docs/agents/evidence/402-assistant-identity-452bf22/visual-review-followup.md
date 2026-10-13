# Independent visual review — PR457 identity flow

**Reviewed revision:** `452bf22cb98e5aeead99f13b972c3af8a4847645`  
**Evidence:** `join-chromium-manifest.json` and `join-webkit-manifest.json`; Chromium 1440×900 and WebKit 390×844 at CSS zoom 1. Both manifests describe the Request→Needs You→Review flow and say the assistant/owner identity is immutable within that journey. The author confirms the Chromium and WebKit journeys create separate fresh agents with different server UUIDs, and Kreska hue is derived from that ID.

## Disposition

**No blocking visual finding.** My earlier P2 compared the green Kreska in `join-chromium-manager-review-light.png` with the blue Kreska in `join-webkit-manager-review-light.png` as if they represented one agent across devices. That comparison is invalid: the engine runs use different agent UUIDs, so different palette hues are expected and do not demonstrate a cross-device inconsistency.

**Optional P3 polish — make the same agent’s hue consistent between its own Agents row and the manager’s expanded Review state.** Within Chromium’s single flow, `join-chromium-owner-request-light.png` shows “Your assistant” with a monochrome Kreska, while `join-chromium-manager-review-light.png` shows the same requested assistant with a green Kreska. The matching WebKit frames (`join-webkit-owner-request-light.png` and `join-webkit-manager-review-light.png`) show monochrome then blue. The manifests describe the assistant identity as immutable through each journey. The Prostota Agents references use the agent’s muted hue in the agent list and detail (`docs/design/final/screens/desktop-agents.webp`, `phone-agents.webp`). Keeping the hue in both states would make the same assistant easier to recognize across owner and manager views. This is optional polish: the name, Kreska shape, and “Agent” tag already distinguish the assistant, and the final design does not explicitly specify the hue for this unconnected-owner row.

## What works well

The Inbox card presents the assistant as an agent rather than a person: Kreska, an “Agent” tag, the owner and project context, a plain-language join request, requested contributor access, and a visible Review action. That hierarchy stays legible in the captured light and dark desktop and phone cards. In the expanded manager state, the assistant and owner remain named, the requested role and permission context are readable, and Allow is easy to locate. The owner’s Agents state also explains that the assistant is not yet in the project and offers a direct request action.

The collapsed manager Request row uses the same simple status-and-summary pattern shown in the canonical Agents reference. Its captured light views do not introduce a material visual problem.

## Scope and limits

This is an appearance-only review of the supplied screenshot packet against F-026 / Prostota. It does not certify interaction, keyboard behavior, responsive transitions, data correctness, touch-target compliance, contrast, or accessibility. The owner request and collapsed manager row were captured only in light mode; their dark-theme appearance is therefore unreviewed. The manifests report engine journeys and checks, but those are author-reported run facts, not conclusions from this visual review.

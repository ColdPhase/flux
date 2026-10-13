# Independent visual review — PR457 identity flow

**Reviewed revision:** `452bf22cb98e5aeead99f13b972c3af8a4847645`  
**Evidence:** `join-chromium-manifest.json` and `join-webkit-manifest.json`; Chromium 1440×900 and WebKit 390×844 at CSS zoom 1. Both manifests report light/dark captures for Needs You and Review. The brief describes fake metadata only.

## Finding

**P2 — Keep the assistant’s Agents-section color stable across desktop and phone.** In the expanded Review state, “Ada’s assistant” has a pale green Kreska on desktop (`join-chromium-manager-review-light.png`) and an indigo/blue Kreska on phone (`join-webkit-manager-review-light.png`). The Prostota Agents reference uses a consistent indigo Kreska for Ada’s assistant across desktop and phone (`docs/design/final/screens/desktop-agents.webp`, `phone-agents.webp`). Because this color is one of the identity cues in the Agents section, changing it across devices weakens recognition of the same assistant. Use the same agent palette color on both surfaces. This finding is limited to the light Review captures; dark Review frames were also supplied, but the light pair makes the difference clearest.

## What works well

The Inbox card presents the assistant as an agent rather than a person: Kreska, an “Agent” tag, the owner and project context, a plain-language join request, requested contributor access, and a visible Review action. That hierarchy stays legible in the captured light and dark desktop and phone cards. In the expanded manager state, the assistant and owner remain named, the requested role and permission context are readable, and Allow is easy to locate. The owner’s Agents state also explains that the assistant is not yet in the project and offers a direct request action.

The collapsed manager Request row uses the same simple status-and-summary pattern shown in the canonical Agents reference. Its captured light views do not introduce a material visual problem.

## Scope and limits

This is an appearance-only review of the supplied screenshot packet against F-026 / Prostota. It does not certify interaction, keyboard behavior, responsive transitions, data correctness, touch-target compliance, contrast, or accessibility. The owner request and collapsed manager row were captured only in light mode; their dark-theme appearance is therefore unreviewed. The manifests report engine journeys and checks, but those are author-reported run facts, not conclusions from this visual review.

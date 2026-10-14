# Neutral visual review brief — #457 assistant join flow

Assess the supplied screenshots from the perspective of a project owner and a project manager handling one assistant’s request to join a project. Review visible hierarchy, clarity, density, identity cues, project/owner context, and action placement in the owner’s Agents state, manager Needs You card, collapsed request row, and expanded Review/Allow state. Compare the relevant surfaces with the accepted F-026 references (`docs/design/final/README.md`, `screens/desktop-agents.webp`, `screens/phone-agents.webp`, `screens/desktop-inbox.webp`, and `screens/phone-inbox.webp`). State only findings supported by what is visible.

Appearance review only: screenshots do not establish behavior, accessibility, touch-target size, contrast, or authorization. Avoid treating captures from separate engines as the same database record. Each browser journey independently creates a manager, owner, workspace, project and server-generated agent; both agent display names are “Ada’s assistant,” but the distinct agent UUIDs were not emitted in the manifest. The application derives agent hue from that UUID. Do not infer cross-device identity continuity by comparing the two independent fixtures.

## Capture provenance

Exact source: `9fc4bb4d3b7310b7b8745f8de81cc2047268f54f` (composed with main `a77a8b563d86a4b53e1ec3f99bde9d7b493a588a`). Read the matching `join-*-manifest.json` next to the frames for engine, viewport, theme, and scenario. Chromium is 1440×900; WebKit is 390×844 with mobile/touch emulation. Both use CSS zoom 1. The test context does not explicitly set `deviceScaleFactor`; record it as default/not explicitly set. Each engine captures the owner request in light theme, manager Needs You card and expanded Review/Allow in light and dark, and collapsed manager row in light. Files are in `/tmp/flux457-sol-compose-evidence/`.

Fixture content: manager Jonas Berg; owner Ada Kowalska Nowak – Community Sensor Team; viewer Lee Reader; workspace Community garden; project Community garden sensors; assistant Ada’s assistant; request asks for contributor access. Metadata is fake and makes no model/vendor calls.

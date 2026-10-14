# Independent focused visual re-review — PR #457

**PASS for the prior P2 and changed category label**, exact source `b6451de1eeb2362a7be3efdb3bec5e083cad2ba9`.

Scope: re-review only the ambiguous pending join Request / empty Requests pairing reported against `9fc4bb4d3b7310b7b8745f8de81cc2047268f54f`. Used the previously read flux-review-visual skill and canonical Prostota references. No implementation source or author rationale inspected.

Inspected both manifests and these eight actual frames: `join-{chromium,webkit}-manager-row-light.png`, `join-{chromium,webkit}-manager-review-light.png`, `join-{chromium,webkit}-manager-review-dark.png`, and `join-{chromium,webkit}-owner-request-light.png`.

The second category now visibly reads **“Agent questions · No open questions for you”**, while the counted join row says **“Request · Ada’s assistant asks to join”**. These are intelligibly distinct categories. The empty question state no longer contradicts the pending join request. The longer label wraps legibly on the 390 px phone and does not collide with the chevron, policy row or review controls; desktop remains a clear single row. Expanded Review/Allow retains this distinction in light and dark.

No remaining P2 finding in this delta. No additional visual preferences or design gates requested. Earlier reviewed areas are outside this focused pass.

Capture context: Chromium 1440×900, WebKit mobile/touch 390×844, CSS zoom 1, device scale factor default/not explicitly set. Engine fixtures have independently generated identities; colour was not compared across fixtures. Screenshots establish appearance only: no claim about behavior, authorization, persistence, measured contrast, keyboard/focus, or target dimensions.

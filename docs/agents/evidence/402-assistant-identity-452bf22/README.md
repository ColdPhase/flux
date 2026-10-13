# Assistant join identity verification — PR #457

This evidence packet is pinned to product/test source commit `452bf22cb98e5aeead99f13b972c3af8a4847645` on `codex-hubert/402-assistant-identity`, based on main `61de6174b58c1755196d054bfd18d8fca37efc9a`. It records the bounded #402 assistant-join identity work; it does not close the parent issue or claim full A1/release acceptance.

The existing join cycle snapshot preserves the assistant and owner public names at request time. A manager's Needs You question displays the assistant name, Agent tag, owner, project, and Review path. The request grants no authority; only the current manager's Allow creates contributor access. The snapshot is display provenance and does not carry permissions or private settings.

## Verification

- Required GitHub checks on `452bf22`: Agent setup and Application validation passed (runs `38472744779` and `38472744730`).
- Focused API regression `assistant-settings.test.ts --test-name-pattern 'a join request gives no authority'`: 1/1 passed at `d977bc3940683d02d47390a14186cf68a3f302aa`. The production/API source is unchanged between that pin and `452bf22`; the intervening commits correct only E2E assertions. Its original complete runner output is in `logs/api-d977-run.log`.
- Exact `452bf22` dual-engine `assistant-join.e2e.ts`: Chromium 1/1 and WebKit 1/1 passed. The real PostgreSQL/session/UI journey verifies no grant before Allow, current manager review and grant, ordinary-reader denial, a failed Allow remaining pending, and 44px phone targets. The complete Docker run output is in `logs/dual-engine-run.log`; Compose cleanup completed.
- Independent source review passed the implementation at `1debe25d2d32a1a2ac85168bae24eb61e46c649c`; the only subsequent changes through `452bf22` are reviewed E2E assertion corrections. The 452 selector correction verifies the Kreska in `.nyc__face` separately from the Agent tag and rules out a human-avatar holder.

## Captures and fixture identity

The Chromium captures use 1440×900 CSS pixels at zoom 1. WebKit uses 390×844 CSS pixels with mobile emulation and touch enabled. Both cover the owner request, manager Needs You card, collapsed manager row, and expanded Review/Allow state. The manifests record the source pin, theme, viewport, and scenario.

Each engine runs the scenario independently and creates a new owner/workspace/project and a new agent through the API. The server assigns each agent a distinct UUID. `agentHue(agentId)` deterministically hashes that UUID, so the screenshots can show different agent hues even though both fixtures use the display name “Ada’s assistant”. They are different agent records. This packet therefore does not establish cross-viewport hue consistency for one UUID; compare a shared UUID if that property needs direct visual evidence. The original independent visual report is preserved unchanged in `visual-review.md`; its color comparison should be read with this fixture limitation.

The test creates no model/vendor calls; compute metadata is fake. No VAPID key material, session cookie, or bearer token is included in the packet.

## Files

- `join-*-manifest.json`: runner viewport/theme/scenario provenance.
- `images/`: exact PNG screenshots captured by the runner.
- `logs/dual-engine-run.log`: full exact-452 Docker build and E2E run.
- `logs/api-d977-run.log`: full focused API run at d977 (production tree equivalent to 452).
- `visual-review.md`: initial independent screenshot review, retained without edits.
- `visual-review-followup.md`: independent reconsideration with fixture provenance, retained without edits.
- `SHA256SUMS`: integrity checks for all packet files except this checksum file.

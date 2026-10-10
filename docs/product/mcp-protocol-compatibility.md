# MCP admission and client compatibility — #460 amendment

**Status: bounded contract independently accepted, 2026-10-10; implementation and production support unverified.**
Owner: @PelikanFix16. Evaluator: an independent peer; eligible GitHub review by
@Zamojski5 remains separate. [#460](https://github.com/ColdPhase/flux/issues/460)
and research/contract [PR #466](https://github.com/ColdPhase/flux/pull/466) stay open.
The [bounded research choice](research/2026-10-10-codex-mcp-protocol-compatibility.md)
was independently accepted at `c39eea3019de2cbc28aa798d2ae5e005e33fd3eb` in
[COMMENT 5480322828](https://github.com/ColdPhase/flux/pull/466#pullrequestreview-5480322828).
That record accepts the architecture. Independent agent `review_protocol_decision`
accepted PC-1–PC-5 at exact contract head
`93889087957b73fe2368d43b6ee3e8926fcbd787` in
[COMMENT 5480429341](https://github.com/ColdPhase/flux/pull/466#pullrequestreview-5480429341).
The agent is separate from author `visual_next`; its shared @PelikanFix16 COMMENT
is delegated contract acceptance, not eligible GitHub/Code Owner approval,
founder direction or runtime acceptance. All original parent criteria remain.

The acceptance explicitly requires HTTP 202 **empty body** for the valid single
legacy initialized notification, actual HTTP refusal for unsupported
notifications, no effect/receipt on batch refusal, and no malformed notification
exception. Required cancellation/progress behavior is not waived by protocol
optionality. The new notification/header/batch/error-list details, complete
authority/features/held races, native/platform Connect and actual #160 activation
remain runtime gates. The peer checked contracts, primary sources and static
checks, not a new Docker pass.

This is the bounded accepted contract amendment to [F-016](mcp-cowork.md), [CW-1](cowork-workflow.md)
and the wire admission of [EXT-1](extension-contracts.md#ext-1--mcp-tool-contract-1).
It retains [F-024](mcp-identity.md), every existing #460/#152/#160 criterion,
and the normal built-in **Connect → authorize → Start/Resume** outcome. No
application change is present. Current implementation still rejects legacy
`2025-06-18`; the research prototype is not a supported product path.

## PC-1 — explicit two-era admission

The same protected `<FLUX_PUBLIC_ORIGIN>/mcp` endpoint admits exactly legacy
`2025-06-18` and modern `2026-07-28`. It uses the pinned SDK's stateless legacy
adapter with a fresh server/transport per authenticated POST, alongside the
existing modern handler. Supported wire revision, tool contract, playbook
revision and tested client/activation path are separate facts.

| Request | Required admission and response |
| --- | --- |
| Legacy `initialize` | One valid JSON-RPC request offering exactly `2025-06-18`. Initial protocol header may be absent; when present it must agree with the offer. Return that exact revision and the actual server capabilities/instructions. Never substitute another revision. |
| Later legacy request | Exactly the `2025-06-18` protocol header and a valid legacy request. No modern protocol-envelope claim. Apply the same current tool/resource/prompt authorization. A headerless request is refused; no remembered identity or negotiated version is taken from another request. |
| Legacy `notifications/initialized` | The sole headerless post-initialize exception: a valid single notification, authenticated independently, with no modern claim. An absent or agreeing legacy header is allowed. Return HTTP 202 with no JSON-RPC result; it performs no domain action and grants no authority. |
| Other legacy notifications | Require the explicit legacy header. No additional notification feature is declared supported by this amendment: refuse it visibly without a domain effect. Required client cancellation/progress behavior must be identified and demonstrated before the client is declared fully compatible; accepting a no-op is not evidence of that behavior. |
| Modern request | Preserve the SDK's `2026-07-28` per-request envelope/client-capability checks and matching protocol/method/name headers, validation and body-size limits. There is no initialize handshake. Missing, malformed, conflicting or unknown modern claims stay on modern rejection and never enter legacy handling. |
| JSON-RPC batch or mixed-era array | Refuse the entire HTTP request before any member runs. No partial effect or receipt is permitted, including an array containing a valid member. Do not treat the array as a fallback opportunity. |
| Legacy GET/DELETE/session operation | After authentication, HTTP 405; no legacy session resource is created or reused. Modern validation remains separate; no stateful GET/DELETE capability is added. |

Non-JSON, malformed/oversize body, conflicting initialize/header, unknown methods
and invalid parameters retain explicit refusal and the existing size/media/schema
checks before domain dispatch. Do not infer the era from a client label, name,
User-Agent, OAuth client ID or absence of a token. Use the SDK classifier so a
modern envelope, modern-header claim or malformed modern request cannot be
reinterpreted as legacy. The additional legacy admission guard must use bounded
parsing and preserve those modern checks; simply removing `legacy: 'reject'`
does not meet this contract.

An unsupported legacy offer returns HTTP 400 / JSON-RPC `-32022`, naming the
requested revision and the supported legacy initialize revision `2025-06-18`.
Unsupported modern revisions retain the modern `-32022` response naming modern
support `2026-07-28`. A recognized modern error does not trigger a silent legacy
retry. The compatibility record may list both eras; an error's supported list
must not imply that legacy initialize and modern discovery are interchangeable.
Malformed requests preserve appropriate schema/envelope errors rather than
being presented as successful negotiation.

## PC-2 — identical authentication, authority and delivery

Both wire formats use one Flux authorization server, resource/audience,
protected-resource metadata, issuer/JWKS validation, authorization code/PKCE
S256, request-bound owner selection and consent, and refresh scope ceilings.
Protocol errors must not substitute for an unauthenticated resource challenge:
authenticate before exposing connection-specific information or executing a
method. Missing/invalid bearer gets the existing 401 challenge; revoked or
unavailable authority gets the existing 403 without protected project data.

Each request derives owner, agent, connection, client and durable grant binding
from verified claims and current server records. Protocol versions, session IDs,
client metadata, acknowledgments and model prose are never identity or permission.
No cached initialize result may stand in for the fresh actor context.

Retain the existing intersection of original OAuth/connection consent, token
scopes, live enabled capabilities/entries, selected projects, current agent grant
and owner/agent rights, approved project policy and exact operation/class/object
standing grants. Keep expiry, use/concurrency limits, source/runtime versions,
revocation, reserved human decisions and attribution. Off/role loss/revocation
take effect under the current transactional prepare/effect/replay/protected
delivery fences in either era, including already-issued tokens and open responses.

Bytes already handed to transport and committed effects cannot be retracted.
Flux does not promise to stop unrelated local CLI work. These limits do not
weaken the existing held-race, replay or revocation requirements.

## PC-3 — required features, effects and versions

EXT-1's domain contract remains `toolContractVersion: 1`; admitting another wire
era is not permission to alter it. Both formats must preserve all required
`flux_*` names, input schemas, scopes, annotations, operation/class rules,
tool error envelopes/codes and bootstrap keys. Preserve selected-project reads,
pagination/cursors, trusted bootstrap, approved-policy revisions, playbook
version/digest, resources and Start/Resume prompt arguments and payloads.
Transport-specific framing/metadata may differ; authorized domain semantics may
not. Any actual breaking EXT-1 change requires its existing versioned decision
and snapshot process, not an undocumented shim.

Writes retain existing `clientCommandId` idempotency, same-input receipt replay,
changed-input conflict, source-version checks and persisted actor/connection
provenance. Playbook acknowledgment remains compatibility evidence, not authority
or proof of active-model loading. A replay rechecks current authority before
returning protected output in either era.

This amendment adds no stateful legacy sessions, server-initiated requests,
subscription delivery, closed-client wake or model turn scheduling. EXT-1's
existing checkpointed `flux_changes_since` behavior remains. A required feature
that fails through the legacy path keeps that client/path pending; do not delete
the feature, lower its criteria or declare equivalence from matching tool names.
Cancellation/progress requirements and GET/DELETE refusal require real-client
and wire tests; the prototype did not establish them.

## PC-4 — built-in setup and honest client states

Flux must supply the normal Connect/authorize/Start/Resume flow, including any
required host invocation/approval through a tested integration. The chosen
compatibility path must let default pinned Codex reach authenticated Flux tools
without an experimental flag or native configuration edits. A README, manual CLI
command, copied prompt or skill-file installation alone does not deliver this
outcome. No native bridge, setup URL handler or installed adapter is assumed to
exist because the client has a configuration primitive.

| Product state | Evidence required; behavior |
| --- | --- |
| Authorization needed | No current usable authorization; provide the actual supported sign-in/consent action. |
| Authorized; client verification pending | Consent/token or configuration exists, but the actual client path is unverified. OAuth success, server list or CLI exit zero cannot show the connection as ready. |
| Transport verified; activation pending | Exact tested client path reaches the admitted protocol and its required authorized features. Supplied active-client instruction loading/Start/Resume is still absent or unverified; show that limitation rather than a working Start state. |
| Start/Resume ready | The exact tested client/version and supported adapter actually load the supplied current bundle into the active client and resume the bound authorized context, satisfying CW-1/#160. Tool lists, HTTP prompt parity or acknowledgment alone cannot establish this state. |
| Incompatible or missing required capability | Explain the actual unmet setup requirement and a remedy the product can perform through a tested path. If no such remedy exists, keep the path visibly pending and refuse new unsupported work; no flag/prompt-copy fallback. |
| Stale, disconnected, Off or revoked | Current live facts supersede any earlier success. Preserve history/checkpoints and the appropriate supported recovery/reconsent path; do not resurrect revoked/expired/consumed grants. |

Use the final Prostota surfaces and plain user-facing status language. Client
labels remain reported provenance; display state must come from the actual
tested integration and current server facts, not confer rights. Keep partial
read-only authority honest without silently adding Read or Execute. A successful
ordinary connection is a required result; these status distinctions are not a
substitute for completing it.

## PC-5 — acceptance and publication gates

The exact amendment has independent delegated acceptance as recorded above.
Implementation now requires fresh independent exact-head runtime evaluation. The bounded research choice and author-run temporary prototype do not
close #460 or satisfy eligible PR approval. Preserve the original issue criteria;
do not split away their built-in Connect requirement to close the parent early.

Implementation and independent runtime evaluation must prove:

- Exact default/flagged real-client admission; valid and conflicting initialize
  headers, version errors, batches, notifications, missing headers, malformed
  modern envelope/method/name/header, limits, media type and GET/DELETE behavior.
- Two-era positive and negative OAuth/actor/project/scope/role/policy controls,
  including other owners, role loss, Off, revoked OAuth/connection/client, invalid
  audience, exhausted/expired grants, replay/idempotency/provenance and held
  prepare/effect/delivery races. Next-call denial alone is insufficient.
- Full required tool/schema/annotation/error/cursor, bootstrap/policy/playbook,
  resource and Start/Resume payload equivalence through native clients and wire
  regressions, preserving meaningful EXT-1 snapshots and required feature gates.
- Actual built-in Connect states and supported recovery, plus #152's required
  client/platform and two-owner/three-connection matrix. #160's supplied active
  client instruction loading, Start/Resume and recovery remain mandatory and
  separate; no broad desktop/IDE/OS support follows from Linux CLI research.

Evidence remains exact-head and version-specific. Scripted models and seeded
OAuth registrations are disclosed; they do not prove vendor-account behavior,
native client metadata discovery, genuine model obedience or platform support.
Recheck changing vendor versions/terms and primary sources before publishing
support. If a required feature cannot retain its semantics, keep visible pending
support and obtain a new bounded decision; do not silently downgrade or weaken
the required outcome. Research completion, contract acceptance, implemented
transport compatibility and completed onboarding are separate milestones.

## Proposed managed-native extension

The separately accepted native-controls/coordination **design** prepares the
[managed-binding public effect-fence proposal](mcp-native-controls.md). That
proposal is independently **unaccepted** and unimplemented; current PC-1–PC-5
admission/authority and all original #460/#152/#160 outcomes still govern. New
adapter/domain code must wait for its exact independent public-contract acceptance.

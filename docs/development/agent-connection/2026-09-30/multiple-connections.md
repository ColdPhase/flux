# Multiple connections and request-bound OAuth — #152

Recorded 2026-09-30 before implementation; the independent design assessment
in [consent-design-review.md](consent-design-review.md) identifies required
continuation and refresh-family corrections. The first implemented checkpoint is
recorded below; whole-issue delivery remains pending.
[F-016](../../../product/mcp-cowork.md) and [F-018](../../../product/cowork-workflow.md)
remain the complete contract. This record does not establish real client support,
loaded instructions, implemented standing writes or whole-issue acceptance.

## Observed current boundary

Current `agent_oauth_selections` has one row per browser session. The second tab
cannot replace its choice, but the same normal login cannot authorize another
connection. Connections/proposals also report Claude Code unconditionally.
Keep existing grants/proposal receipts and historical provenance intact.

The repository pins Better Auth/MCP/provider 1.7.6. A read-only Node inspection
inside the already built non-root application image found that
`postLogin.consentReferenceId` receives user/session/scopes, without the OAuth
request query. The [bounded source excerpt](provider-callback-observation.txt)
records the actual callback invocation. A module-level mutable selected connection
would race concurrent requests. Hosted documentation explains post-login selection,
continued authorization and server-selected consent references; it does not prove
that callback sees the complete request in this pinned release.

## Proposed implementation

Replace the default singleton choice with a durable immutable selection keyed by
live owner + browser session + OAuth flow fingerprint. Selection receives the
provider-signed `oauth_query`, verifies its signature/expiry and binds the exact
client ID, redirect URI, PKCE challenge/method, state, scopes, resources and nonce.
The exact pinned transport exclusions are `sig`, `exp`, `ba_iat`, `ba_pl` and
repeated `ba_param`; verify and preserve them for provider processing. Bind all
other fields, including `response_type`, `dpop_jkt`, authentication/claims inputs
and passthrough extensions. Do not discard arbitrary `ba_*` fields. The request
store retains the incoming fingerprint through provider internal reauthorization
and supported prompt/scope narrowing. Unsupported protocol modes fail visibly.
Validate ambiguous duplicate protocol parameters. Repeating the exact selection
is idempotent; changing its connection conflicts. Each other tab/request can make
its own immutable choice. Signed-query expiry and current session/connection/
agent/project grants are checked again before consent and token issuance. Signed
query expiry applies to setup; code and refresh have their own provider lifetimes.
New provider references identify immutable owner/connection/agent/OAuth-client
grant bindings. Code exchange and refresh resolve that stored reference, without
consulting browser selection. Legacy connection references remain explicit.

Carry the request fingerprint through Node AsyncLocalStorage around this auth
handler invocation; never use shared mutable state or trust an incoming header.
Initial provider authorize calls may identify the candidate flow for lookup, but
Flux selection writes require the signed query and the provider retains its own
client/redirect/PKCE/resource validation. The callback resolves that request's
selected connection. Refresh uses the provider-stored reference and current
connection grants, independent of current browser selection. Missing/stale flow
is a visible setup failure, not fallback to the singleton. Preserve legacy rows
for old tokens/history; do not reinterpret them as authority for a new request.

Pinned provider 1.7.6 invalidates refresh tokens by client+owner after rotation
reuse, which would affect a second connection of that same client. A narrowly
locked provider patch must isolate invalidation to the original authorization
lineage and recheck current binding authorization before cached refresh replay.
Different client IDs are not a substitute for required same-client isolation.
Signed-out setup must have a working `/login` continuation into Flux sign-in.

New connections have a bounded owner-supplied name and client designation. Client
names/designations and negotiated `clientInfo` are descriptive/self-asserted, not
identity or permission. Persist the actual OAuth client ID at its authorized
binding separately. New generic external clients have truthful user-operated
external-client provenance; preserve original Claude proposal provenance. No
credential/model call/payer passes through Flux and no metadata assertion proves
subscription billing, instruction activation or supported client execution.

## Shared authorization and delivery

#152 owns migration0034 and authenticated immutable owner/connection/agent/client/
runtime-session/project context. A core-owned authorization port checks current
connection, selected project, operation, audience/class, bounded grant expiry and
revocation inside the effect transaction. Execution/review remain separate grants.
#153 consumes this port and owns0035 durable addressed inbox/claims/checkpoints;
#154 owns0033 canonical contributions; #74 owns0036 GitHub bindings/events.

Bounded versioned domain reads/search/write operations call current core services,
with current ACL and stable idempotent/versioned commands. They do not duplicate
project records or promote source messages into policy. Bootstrap carries actual
connection/grant/capability/playbook/policy/source/checkpoint references. #160 ships
and activates instructions through tested Start/Resume integrations; an advertised
prompt/resource or ACK is insufficient. Unimplemented capabilities must not be
exposed as working tools. Existing decision acceptance remains human-only.

## Verification still required

Docker tests must exercise two owners/three named connections in two projects,
concurrent same-login consents, swapped/expired signed queries, ambiguous params,
stale sessions, changed scopes/resource/PKCE/client, connection-specific revoke,
refresh and retries. Existing Claude/proposal/helper/no-agent regressions remain.
Broader ACL/domain writes/bootstrap/claims need their own race/failure checks and
real pinned Codex and Claude clients with built-in activation, as required by
AC-2–AC-5. No mock or source inspection closes those outcomes.

## Dated primary evidence

- [MCP authorization, 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization), accessed 2026-09-30: resource-bound OAuth, discovery and PKCE obligations; authorization-server application binding remains the implementation's responsibility.
- [Better Auth OAuth provider](https://better-auth.com/docs/plugins/oauth-provider), accessed 2026-09-30: post-login selection/continue and consent reference/custom access-token claims. Documentation is vendor guidance; callback mechanics above were observed in pinned 1.7.6 source instead of inferred from current docs.

The flow fingerprint and AsyncLocalStorage bridge are a proposed engineering
choice. Independent review must examine canonical fields, lifecycle and token
refresh isolation before runtime changes are accepted.


## Implemented consent checkpoint

The first checkpoint adds owner-named connections and descriptive client labels,
request-bound signed selection, per-auth-instance AsyncLocalStorage, durable
owner/connection/actual-client references, and the signed-out `/login` continuation.
Consent names are read within the same transaction as the central authorization
checks. New JWTs match the AS-owned `client_id` to their durable grant; a disabled
actual OAuth client is rejected by the live reference lookup. Historic singleton
rows remain stored, but new authorization requests never consult them.

`app/patches/oauth-provider-1.7.6-flux-refresh.patch` is applied by the locked pnpm
configuration to the exact pinned provider artifact. It restricts replay cleanup
to `authorizationCodeId`; a legacy row without that lineage can invalidate only
itself. It also checks current connection authority before serving a cached
rotation response. The observed MCP wrapper enables a reuse window, so a valid
immediate refresh retry returns the same rotated token; the regression explicitly
expires that window before testing family invalidation. Reconnect creates a fresh
authorization lineage for the same connection/client binding.

Docker verification at this checkpoint: build/typecheck/lint; 36 targeted tests
covering OAuth, two owners/three connections, same-browser concurrent requests,
same actual OAuth client, signed-query tampering, flow expiry, cached retries,
refresh lineage, reconnect, revoked/disabled authority, identity, migration ledger,
architecture and a real prior-schema upgrade preserving historical fields/times.
The full application script passed 335 tests, its existing browser checks, session
restart and unavailable push/email checks before the label-only clarity change.
The updated label passed a fresh build/typecheck/lint and Chromium rerun.
The Chromium protocol check signs in from the provider's `/login`, selects two
connections in concurrent tabs of one browser login, completes both consent
screens and verifies their respective issued connection IDs. Captured views:
[desktop](evidence/agent-consent-desktop.png),
[phone](evidence/agent-consent-phone.png). The initial independent pixel review required a visible “Your client label” prefix
to avoid implying verified runtime provenance. That correction is in the shared
summary; fresh screenshot reassessment remains pending.

These are HTTP/browser protocol fixtures with a registered test client, not real
Codex/Claude model-driven activation evidence. Standing execution/review grants,
runtime sessions, bounded bootstrap, the complete domain read/write surface,
criteria/dependency/plan-intent task commands, #160 activation and real-client
acceptance remain required. This checkpoint does not complete AC-2–AC-5 or #152.

The concrete next phase is recorded in [scoped-runtime.md](scoped-runtime.md).

### Canonical read extension under verification (2026-10-01)

The next additive tools expose bounded native task/decision/result, wiki,
conversation, project map and project search reads. Each request rechecks the
actual OAuth binding/client and live connection inside the same transaction as
its central-policy authorization and content projection. A metadata-only
core port applies the selected-project/workspace ceiling before canonical
readers load any content; private/DM maps never pass it. Search uses the canonical
index with project and project-map policy audiences and an exact selected-project
filter before ranking/snippets/counts. Text pages declare total coverage and
require the original source version for continuation; map pages require their
updatedAt checkpoint. This extension does not enable domain writes or establish
real-client activation.

### Current grant/ledger checkpoint (2026-10-01)

The source checkpoint at `606c97c66d6077625d8472b2c1f8e16edc9390de` now implements
owner standing-grant API, authenticated runtime and the caller-owned atomic
execution/receipt port, with explicit third-scope consent. [Exact execution
evidence](execution-checkpoint.md) records 32 focused and 347 full Docker checks,
fresh third-scope browser evidence and the still-disabled native action tools.
Historical consent/read checkpoints above retain their original evidence limits.

### Native task plan slice (2026-10-01)

Task criteria, same-project prerequisites and the immutable plan intent, the pinned
project task-graph lock/reader and the browser task-detail display are implemented on
the stacked branch `codex-hubert/152-native-plan` (migration 0039; PR after #167 merges).
The [contract's implementation status](../2026-10-01-native-plan-contract.md#implemented-at-the-native-plan-slice)
lists the final names and deviations and the
[checkpoint](../2026-10-01-native-plan-checkpoint.md) the executed checks. MCP action
tools stay disabled and #153's claim adapter, independent review and real-client
activation remain required.

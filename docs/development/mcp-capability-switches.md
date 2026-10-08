# MCP capability switches — implementation contract

2026-10-08. #316, assigned to PelikanFix16; isolated
`codex/316-mcp-switches`, initially protected main197f5216. **Restrictive-overlay direction independently accepted at5ec7907;
the operational amendment was independently accepted at88444d03 before code.** This does not accept a
runtime, migration or UI. The accepted [S6 product contract](../product/mcp-identity.md)
and [issue316](https://github.com/ColdPhase/flux/issues/316) remain the complete
criteria. In particular there is no recent-auth, second password or SSO prompt.

## One restrictive overlay, preserving original consent

Each existing personal connection keeps its immutable agent/owner, original
scopes, project selection and AS-owned OAuth bindings. A separate persisted policy
has a monotonically increasing version, explicitly enabled capability identities,
and an effective project subset of the original selection. All-disabled and an
empty effective project set are valid; ordinary owner management remains available.
Owner-only GET/PATCH use the existing session resolver and If-Match/CAS. Other
owners, workspace administrators and agents do not gain management authority.
An unknown/unsupported capability or a project outside the original ceiling is
refused. Failed or stale saves do not update the displayed saved state.

The default for existing consent enables only currently registered capabilities
within that consent. It does not grant scopes, projects or native authority that
were absent. Capability records come from real registrations, never an invented
UI list. New registrations start unavailable until the owner explicitly selects
an option within the existing scope/place ceiling; otherwise normal owner/OAuth
consent and an appropriate token are required. Unsupported actions remain absent
or explicitly unavailable. The proposed additive migration must be reserved with
#153's namespace record before writing SQL; it must not reuse57–60 or rewrite
those branches. Upgrade, reversal and semantic footprint checks remain required.

An explicit allowlist is materialized from the real registration manifest before
serving the first migrated MCP request. Existing policies retain their captured
allowlist across subsequent upgrades; newly added registrations are not silently
enabled. A missing/uninitialized policy fails closed instead of deriving a fresh
allow-all policy on each request. New connection creation stores the explicit
initial policy in the same transaction as its original consent selection. This
initialization must be bounded, restart-safe and tested with concurrent creation.

## Current, effective authority

Keep configured switches distinct from effective availability. A configured On
is insufficient when current owner rights, agent project grants, original JWT
and connection scopes, client/binding or exact bounded standing grant do not
permit the operation. Show a safe refusal reason. No checkbox creates an agent,
project/admin/private/DM grant, runtime, standing grant, owner-paid invocation or
decision-acceptance tool. On does not revive a revoked connection/runtime/IdP
identity, revoked/expired/consumed grant or previously invalidated in-flight request.

Every actual tool, resource/template and prompt entry point must map to a registered
capability. Aliases that expose the same content/action share that identity;
resources cannot bypass a disabled equivalent tool. Preserve public protocol
metadata without returning protected connection/project/history data when access
is disabled. Owner management uses the original structural identity and original
ceiling, not a resolver that disappears when effective projects/scopes are empty.
Consent issuance must preserve its own original envelope rather than overwrite it
with the current effective subset. A deselected inaccessible project must not
silently grant access or unnecessarily invalidate an otherwise authorized subset.

## Concurrency and delivery boundaries

Read the live overlay inside the existing caller-owned authorization transaction;
carry its version as a trusted request snapshot, never as agent-supplied authority.
Serialize policy writes and native authorization/effects with a documented lock
order consistent with binding, connection, agent and central access locks. Recheck
scope, capability, project and the exact policy version before accepting a protected
projection, committing an effect, accepting receipt replay and handing queued
bytes to the transport. A captured old version is refused after any intervening
change, including Off then On. Version comparison alone never replaces live
connection/runtime/grant/current-source checks.

Do not hold an uncontrolled network/provider wait inside a database lock to fake
revocation. Identify the actual SDK/server serialization and byte-handoff boundary;
all request-owned queued output must use the same delivery check. After bytes have
been handed to transport, or an effect committed before Off, retain truthful
history rather than claim retroactive cancellation. A pending rejected command
must not report success or manufacture a receipt. Existing command/consent/receipt
identities, bounded-use debit and committed history are preserved. The peer review
must resolve exact receipt-replay behavior against the existing idempotency and
S6 non-resurrection contracts before changing its implementation.

## Implementation seams observed at main197

`agentConnectionRepository.resolveCurrent` currently holds shared connection and
agent locks and authorizes its entire original project selection; an empty
selection is rejected. `grantForOauth` validates explicit AS-owned bindings/clients
or the supported historical connection reference. Core connection scopes are
read/propose/execute; server `agentToolRegistry` writes capability entries only
when a real tool is registered. `agentConnectionInTransaction` composes existing
selection/scope and native object checks. Core execution uses caller-owned
transactions and stable command/outcome identities. These observations identify
seams; they do not prove S6 or current owner/transport delivery checks exist.

Reuse these ports and the existing owner Connection/StandingGrants surface. Integrate
with #343/#347/#350; no competing grant flow. Follow F-026 on desktop and phone,
including readable grouped switches, saved/error/busy feedback, keyboard access,
44px touch controls and enlarged text. Public product copy does not expose internal
policy versions, token claims, database locks or fixture names.

## Required evidence, never inferred from source

Docker API/browser regressions must demonstrate original-envelope refusal,
other-owner/admin/agent refusal, all-disabled management, persistence/reload,
failed/stale saves and ordinary no-prompt use. Prove actual old-JWT Off/On and
held read/projection/effect/queued-delivery/replay races, revocation, expiry and
bounded-use behavior; preserve existing native/consent/grant tests. Test direct
resource/prompt aliases as well as tools. Use genuine transport and persistence
boundaries with meaningful failing controls. New schema needs fresh/upgrade,
reversal, restart and supported semantic-footprint verification. Independent
current-head functional and neutral visual review, #310 identity integration,
normal protected review and integrated v0.1 acceptance remain required.

## Operational amendment from independent review — 2026-10-08

The pinned5ec7907 planning review accepts the restrictive overlay and resolves
four missing implementation choices. This amendment retains AC1–5. It does not
accept any runtime or schema. Migration **0061_mcp_connection_capabilities** is
reserved before SQL in [#153](https://github.com/ColdPhase/flux/issues/153#issuecomment-6055903628).
Versions57–60 and their semantic-footprint requirements remain intact.

### Real transport handoff

Use the SDK's public Request/Response handler and an explicit request-owned Node
relay. Obtain and serialize each bounded frame outside authorization locks. Before
protected headers/body delivery, acquire live AS binding/client, original owned
connection and the shared policy fence plus current central access locks; check
the originally captured version and the durable request-owned dependencies, then
call the real synchronous `res.write(chunk)` inside that short transaction. A
false write return already handed the bytes to transport. Release all database
locks before awaiting drain, another chunk or any network/provider work. Policy
PATCH acquires the same exclusive database fence, including across API instances.
Never use a process-local mutex or an asynchronous Writable.write substitute.

Before headers, an authorization failure returns the ordinary unavailable error.
After any already-delivered bytes, terminate the remaining response truthfully;
never append a fabricated success or undo a committed effect. Disconnect aborts
further work/pulls and settles bounded buffers. Static protocol metadata carries
no project/connection/history values. Catalog entries, tool/resource/prompt output
and future notifications containing protected data require a trusted dependency
descriptor; unknown/unclassified output fails closed. An error caught in a tool
does not silently make its protected payload public.

Trusted server dispatch may use AsyncLocalStorage to carry capability requirements,
but delivery uses a request-owned descriptor that survives callback exit. Each
nested transaction/helper retains the original policy version and adds its actual
project/object/source requirements; no helper recaptures the latest version. At
delivery, use the union of those dependencies, including current runtime/grant
checks for effect responses and replay. Already-consumed last-use grants do not
require another unused debit merely to observe their committed receipt.

The decision follows the pinned primary SDK2.1.0 implementation of
[toNodeHandler](https://github.com/modelcontextprotocol/typescript-sdk/blob/%40modelcontextprotocol%2Fnode%402.1.0/packages/middleware/node/src/toNodeHandler.ts)
and [createMcpHandler](https://github.com/modelcontextprotocol/typescript-sdk/blob/%40modelcontextprotocol%2Fserver%402.1.0/packages/server/src/server/createMcpHandler.ts).
This relay is an implementation choice inferred from those sources, not observed
Flux behavior. A held real write and a second API's committed PATCH are required.

### Complete semantic manifest and aggregate reads

Publish one checked-in shared manifest consumed by real registrations, owner
projection and initial policy seeding. Assert exactly one supported declaration
for every actual registered entry point: the current source has45 literal tools,
one fixed playbook resource, one policy template and Start/Resume prompts. Actual
registration verification remains required; source counts alone do not prove it.

Use stable semantic read groups for project identity, knowledge (materials and
wiki), tasks, decisions, results, conversations, maps, project policy and the
supplied playbook; use the actual registered operation for each distinct effect
and a separate sourced-proposal capability. Lists and body reads within a group
share its switch. `flux_read_material` and `flux_get_doc` both require knowledge
read, because the former also returns wiki bodies; no tool-name alias bypass.
The playbook resource, acknowledgment and equivalent Start/Resume use the same
playbook requirement. Start/Resume also require current project identity access;
bootstrap requires its actual project/runtime/grant/policy/playbook dependencies.

Orientation and changes-since require each requested native source-kind group
before projection. Typed search requires that source kind's group; untyped search
requires all source-kind groups it could project. If a required group is Off,
return the existing honest unavailable outcome before query/count/page/snippet
projection. Do not silently post-filter results or disclose forbidden totals.
A narrower typed request remains possible. A tool combining groups discloses its
dependencies in owner controls and is available only when each is permitted.
Exact-name manifest entries map to these semantic IDs; effect operation/class
metadata continues to come from real registration, not an invented UI catalog.
New/unknown entries absent from a captured allowlist are Off. Unsupported aliases
or source kinds fail closed. Direct tools/resources/prompts and generic wiki reads
must all have actual Off tests.

### Structural identity, effective selection and lock order

Keep original connection.scopes/projects immutable in OAuth issuance/refresh,
runtime snapshots and command fingerprints. Owner list/revoke and existing grant
list/revoke/narrow remain structural management. A disabled connection can still
be managed without an active agent/project grant; expose original IDs without
leaking inaccessible project names. New consent must independently validate its
original envelope and live owner/client/binding conditions.

Effective reads authorize the actual selected project dependencies at read level;
the presence of Execute in original consent does not require write access to every
original project. Excluded inaccessible projects do not poison another authorized
subset. Effective native writes retain exact existing standing/runtime/source checks.
For On or adding an original project, validate the requested delta against current
central rights and original ceiling; no hidden grant creation. Removal-only saves
remain possible when agent/project access has disappeared.

Lock prefix: AS binding/client when present → original owned connection → policy
row (shared protected requests/relay; exclusive owner CAS) → agent/current owner
membership → sorted relevant projects/central grants. Continue existing runtime,
standing-grant, command-advisory and domain locks after that prefix. Historical
connection-reference paths omit only the absent AS prefix. OAuth/session flows and
owner management must document their compatible variants. Do not acquire a policy
lock after a grant/command/domain lock, nor acquire an exclusive policy fence while
holding a later central lock. Actual two-connection crossing/deadlock/refusal tests
must verify this order; this plan does not certify all existing writers.

### Receipt observation and non-resurrection

A fresh request captures one live policy version. Any intervening policy change
permanently invalidates that request, including Off→On; it cannot adopt a new
version. While Off, pending protected output and receipt observation refuse.
After legitimate On, a newly admitted exact retry may observe its already-committed
receipt under current consent/access and nonrevoked, unexpired runtime/grant plus
current post-state, even when the grant's last use was consumed. It performs no
new effect/debit; another command with that consumed grant still refuses. Preserve
the original receipt, fingerprint and command ID; mutable policy version never
becomes durable command identity. This preserves the existing explicit last-use
idempotency test and S6's prohibition on restoring execution authority.

Tests must distinguish a committed receipt before Off, Off refusal, an old held
request after Off/On, a newly admitted observation after On, a new-command refusal,
revoked/expired refusal and unchanged receipt/effect/use counts. Do not delete or
weaken the existing consumed-last-use retry assertion.

## Owner management implementation checkpoint

The separate continuation `codex/316-mcp-enforcement` starts at the independently
reviewed foundation `1065cf22bc66a747fe6c205d5f22807d98176d14`; the original
foundation checkout remains frozen for its bounded verification. The continuation
registers the ordinary owner policy GET/PATCH routes in the server and adds four
real-session/API/SQL tests for all Off and empty selection, immutable original
consent/no new standing grant, other-owner/admin refusal, invalid/stale saves and
two owner sessions competing on one saved version. These tests are not yet run.

This checkpoint wires owner management only. The actual MCP dispatcher, effective
selection, every tool/resource/prompt alias, real transport delivery, native action
and Off/On races, browser switches and compatible migration/identity composition
remain required and unverified. It is not a completed S6 feature or a merge candidate.

## Registered entry admission continuation

The continuation now captures one trusted live policy version at the verified HTTP
entry point and supplies request-owned dispatch to every actual registered tool,
resource and prompt. Registration checks assert the exact shared manifest and real
scope/operation metadata. Native authorization applies the saved capability and
exact-entry allowlists inside its caller-owned transaction, retains original OAuth
consent/scopes and restricts the effective project selection. Only actual selected
project dependencies are authorized; an excluded inaccessible original project does
not invalidate another readable subset. Source-kind requirements are registered
before aggregate queries, counts or snippets; knowledge and playbook aliases share
their semantic switches. Bootstrap's scope/policy availability is still only one
part of effective runtime/grant availability, not a promise of action authority.

Four new core/dispatch controls and three real OAuth/API/persistence scenarios cover
captured-version non-resurrection, exact alias membership, concurrent request scope,
complete registration coverage, knowledge/search aliases, playbook/policy resources
and prompts, all-Off management, subset selection and unchanged consent. They are
prepared, not executed. The earlier frozen owner-only checkpoint is preserved for
its distinct verification. This admission continuation still uses the existing SDK
Node relay: queued headers/bytes, runtime/grant/source/post-state delivery fences,
real held write/two-API races, browser controls, migration/identity composition and
complete S6 acceptance remain unimplemented or unverified. It is not a merge candidate.


### Current owner membership for project-independent entries

The trusted MCP admission continuation also locks the current owned agent and its
owner's workspace membership before any project-independent playbook resource or
runtime acknowledgement. Removing membership through the ordinary workspace API
need not revoke the agent row; the old bearer must nevertheless refuse both an
existing session ACK and a new session ACK without creating a runtime. An added
fourth real OAuth/API/SQL admission case covers that boundary and retained ordinary
owner inspection/removal-only policy management. It is prepared, not executed.
The earlier `62fd94a63e12882547dc5d3816e8b5713086eb59` source review is historical
and qualified by this omitted boundary. No relay, complete S6 or runtime acceptance
is claimed by this correction.


### First actual owner-checkpoint build

The independently reviewed frozen owner checkpoint
`dcf865fac886b358f0c70273c5c49b57cf743095` was run in Docker on 2026-10-08.
Its maintained build failed with actual exit 1 before application tests because the
owner GET projection's empty project array lacked a TypeScript annotation
(TS7034/TS7005). No deadline or unsettled process group occurred; owned project
resources and image tags were removed and confirmed absent. The continuation adds
the explicit existing projection shape without changing values or authorization.
The owner/core/architecture tests from that run remain unexecuted. Preparation or
source-review PASS never counts as application acceptance; a new pinned build and
actual selected tests are still required.


### Ordinary owner control surface continuation

The existing personal connection page now hosts the selected connection's ordinary
session permission form outside the OAuth chooser. It groups the actual shared
manifest into Read/Suggest/Act switches plus original native project selection;
known labels and current server entry identity are required before an explicit On
adds aliases. Loading never enables newly introduced entries. Original scopes
remain the ceiling, unavailable project selections can be removed, and Disable all
sets a genuinely empty policy without creating grants. Saving uses the loaded CAS
version; drafts are explicitly unsaved until the API confirms them. Stale or
unconfirmed writes require reloading before another save. A confirmed save followed
by a failed availability refresh is reported distinctly. This is browser source
only and not yet compiled, exercised or visually accepted. Full S6 transport and
current-authority fences remain required; this surface is not a completion claim.


Three new browser scenarios are prepared for genuine sessions/API/CAS/persistence
and an already-issued MCP bearer: draft/save/reload/knowledge Off and all-Off;
two tabs competing on one version plus a genuinely offline unconfirmed save; and
Chromium/WebKit 320/390 controls, 44px geometry, Space activation and persisted
all-Off management. Each phone iteration has its own account/project/connection,
so earlier all-Off state cannot silently disable a later iteration's save. No
browser scenario has been executed and no screenshot exists for this continuation.


### Actual admission-checkpoint build and owner UI review corrections

The separately frozen `8bb8720970788c6cd33b0795f8712287ea045ed5` admission
checkpoint was actually built in Docker on 2026-10-08. Its compiler failed with
exit 1 at the generic registered-tool wrapper (TS2769); all 60 selected
application cases remain unexecuted. No deadline expired, process groups settled,
and its owned containers, networks, volumes and image tags were confirmed absent.
This continuation retains the SDK's schema-specific `ToolCallback` type through
a callable Proxy that forwards the original receiver and arguments, rather than
reconstructing its deferred conditional function signature. A successful current compiler result is still required.

Independent source evaluation of `3acb096a1b5a90225e097abd310fa4b87be1f369`
found three owner UI defects. Each load/save sequence now has an abortable request
and generation fence, so a delayed initial read cannot replace a newer confirmed
write. Combined entry prerequisites are named using the same ordinary permission
labels without switching them on implicitly. Availability belongs to the loaded
policy version: after a confirmed write it is unknown until the matching refresh
returns; failed refresh never presents old availability as current saved access.

The browser module now contains five genuine session/API/persistence scenarios.
The earlier knowledge-Off scenario also exercises playbook-Off with a named
bootstrap prerequisite. Two added cases hold the actual initial GET response
bytes until after a later confirmed write, and refuse only the post-write GET
while letting the actual project-removal PATCH persist. Existing stale-tab,
offline-save, immutable-consent/no-standing-grant and two-engine 320/390 phone
controls remain. All five browser cases and fresh visual evaluation are UNRUN.
These changes do not establish queued MCP-byte fencing, full S6 acceptance or
protected-main integration.


### No reachable selected project: the bearer is refused (decision 2026-10-08)

Main's contract is kept. When the connection's agent has no current reachable
selected project, because its project grant was deleted or its owner's workspace
membership was removed, the bearer is refused with HTTP 403 before any tool,
resource or prompt dispatch, and the body carries no data. A project the agent
cannot reach does not poison an authorized subset: while at least one selected
project remains reachable the bearer is valid and a project-level refusal is a
tool error. Per-entry switch refusals while the agent still has access stay the
structured `MCP_ENTRY_UNAVAILABLE`. Removal-only owner management stays available.
This supersedes the structured-refusal expectation in the section above for the
no-reachable-project case.

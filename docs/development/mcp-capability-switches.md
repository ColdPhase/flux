# MCP capability switches — implementation contract proposal

2026-10-08. #316, assigned to PelikanFix16; isolated
`codex/316-mcp-switches`, initially protected main197f5216. **Proposed for
independent technical review before implementation.** This does not accept a
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

# O-005 — first supported agent path

**Later requirement, 2026-09-30:** [F-016 local MCP co-work](mcp-cowork.md)
extends completed #52 / PR #103 with multiple external connections per owner,
tested Codex support, scoped domain tools and local task handoffs/review. Preserve
O-005 evidence and the separate embedded-helper contracts #57/#68. The required
future capability does not change which clients/operations have been verified.

**Later requirement, 2026-10-02:** [F-020](model-providers.md) (PROV-5) makes Claude Code,
Codex and any other MCP client equal: the same consent, grants and presentation, with
each client's own setup commands. Verified clients are still only those with recorded evidence.

**Proposed amendment, 2026-10-06 ([#287](https://github.com/ColdPhase/flux/issues/287),
pending independent acceptance):** the implementation uses only the decision's client
ID metadata documents. Dynamic client registration (DCR) stays off, and no browser session
can register or change an OAuth client. "Optional pre-registration" is an operator step with
database access. Consent shows the redirect host and the `client_id` host, and warns when
the redirect is not loopback. Details are in the
[agent connection contract](../development/agent-connection.md#identities-and-consent).

**Proposal:** 2026-09-27, `codex-hubert` for [#37](https://github.com/ColdPhase/flux/issues/37).
**Status:** accepted after [independent peer review](https://github.com/ColdPhase/flux/pull/53#pullrequestreview-5331573326).
This is the product/architecture decision for the [#52 implementation](https://github.com/ColdPhase/flux/issues/52).
It narrows the [#9 feasibility research](own-ai-feasibility.md)
within accepted [O-002](application-architecture.md) and the later
[#44 creative product direction](https://github.com/ColdPhase/flux/issues/44).

## Decision and boundaries

Choose **Mode A: a person operates an unmodified official Claude Code CLI on
their own machine and connects it to a self-hosted Flux remote HTTP MCP server**
as the first supported agent path. The person authenticates to their chosen
Claude Code compute source through Anthropic's own client and to Flux through a
separate Flux OAuth authorization. Flux stores neither Claude credentials nor a
consumer-plan session; it cannot bill, silently switch to an API key or promise
the client's subscription capacity. The user's client owns inference and its
terms, limits and costs. Flux owns workspace state, grants, tool policy and
visible provenance. If the client is offline or limited, people can still send,
decide, work and return without AI.

For this first path, the Flux MCP server is an OAuth 2.1 resource server using
streamable HTTP and the newest MCP revision the tested official client negotiates
(target **2026-07-28**), protected resource and
authorization-server metadata, issuer validation, client ID metadata documents
where supported, optional pre-registration or DCR compatibility, and a
resource/audience-bound token. At consent, the authenticated person creates or
selects **their own** named `agents` row; a workspace-owned agent or another
person's agent cannot be selected. Consent shows the selected projects and the
agent's existing explicit per-project grants. Adding or changing those grants
uses #29's manager-authorized grant flow; OAuth consent alone cannot grant a
project the person cannot manage. The token binds that person, this agent ID and
the approved project IDs, never the person's own policy principal. The only
initial OAuth scopes are `flux.context.read` (list/read selected authorized
project sources) and `flux.proposal.write` (create a sourced proposal in an
approved project). They are ceilings, not grants. On every tool call, Flux
authorizes as the **agent principal**: the effective project level is the lesser
of the agent's current explicit grant and its owner's current level, and the
requested action must also fit the token scope, selected project and object
audience. Agent revocation or owner departure stops access. The first slice
excludes DMs because #29 defines no agent DM grant; a later DM tool requires an
explicit participant-granted DM policy and its own review. Flux rechecks current
authorization and source revision for every tool, read and write, including
idempotent replay and queued output. Token or session caching cannot restore a
revoked grant. Do not reveal an inaccessible project's existence, count, title,
event cursor or summary.

**Proposed amendment, 2026-10-06 ([F-024](mcp-identity.md#connection-access-keys-header-only-clients-and-ci),
[#273](https://github.com/ColdPhase/flux/issues/273), pending independent acceptance):**
the MCP server stays an OAuth 2.1 resource server for every OAuth client. When the
operator turns on connection access keys (`FLUX_MCP_ACCESS_KEYS=on`, off by
default), `/mcp` also accepts a Flux-issued key for one connection, for clients
that can only send a fixed header and for CI. A key is not an OAuth token: it is
checked against its stored hash, and then gets the same connection, grant, owner
and standing checks as a token.

The first tool set is deliberately small: list authorized current contexts,
read a selected source with revision, and create a **sourced proposal** for
human review. An agent cannot accept a decision, change audience, assign work
or publish a proposal into shared truth without applicable human authority.
Each proposal labels fact, interpretation and suggested action, its source
revisions, actor, grant and compute source. A changed source creates an explicit
stale/conflict response. Stop, client disconnect, expiry and revocation leave
human continuation in the same work context; no retry silently doubles a write.

The external client and its compute remain personal to the authenticating
owner. A project participant may read an authorized, attributed proposal, but
cannot invoke, continue or retry the owner's agent or consume their allowance.
Shared output uses the selected project's audience and only sources safe for
that audience; OAuth authorization is not publication consent for unrelated
private material. This external connection does not provide an in-Flux `/ai`
runtime. A person without their own connection sees setup/unavailable there,
with the ordinary human workflow still available. These #57 ownership,
source and output boundaries apply to later run interfaces as well.

**Conditional later modes:** Codex CLI and cloud app connectors need their own
actual compatibility, auth and reachability tests before the supported list
grows. An embedded/API/local Flux-operated agent requires a separately accepted
compute owner, secret handling, payer consent, budget and runtime contract.
Third-party claude.ai login or routing Free/Pro/Max credentials through Flux is
excluded. A manually invoked MCP tool is a transport slice, not completion of
the required proactive AI path. Under [F-022](ai-modes.md) (accepted 2026-10-05) this path is
mode (b) of exactly two AI modes. Flux still never offers claude.ai login or holds
plan credentials; mode (a)'s `runtime` instead runs the unmodified Claude Code
binary under the owner's own sign-in.

## Evidence checked on 2026-09-27

The observations below record the decision-time state. Later implementation
evidence is kept in the [agent connection contract](../development/agent-connection.md).

| Claim | Evidence class | Primary source and limit |
| --- | --- | --- |
| Claude Code supports remote HTTP MCP and `claude mcp login`; it documents OAuth and CIMD/DCR/pre-registered client setup. | Vendor documentation, accessed 2026-09-27. | [Claude Code MCP guide](https://code.claude.com/docs/en/mcp). A Flux login has **not** been tested. |
| Anthropic says a third-party product may not offer claude.ai login, collect its sessions or route consumer-plan credentials for users; a user may sign into an unmodified Claude Code binary directly. | Vendor legal statement, accessed 2026-09-27. | [Claude Code legal/compliance](https://code.claude.com/docs/en/legal-and-compliance). This decision uses the user-operated client, not a hosted consumer-login service. |
| MCP 2026-07-28 has a stateless HTTP core and authorization hardening; OAuth 2.1, protected resource metadata, issuer and intended-audience validation are specified; CIMD is preferred and DCR retained for compatibility. | Published protocol and maintainer announcement, 2026-07-28, accessed 2026-09-27. | [Release](https://blog.modelcontextprotocol.io/posts/2026-07-28/), [authorization specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization). A real Claude Code ↔ Flux version negotiation is **untested**. |
| A user-operated client could use its own plan while Flux serves only authorized tools, avoiding Flux-held provider credentials. | Flux inference from the vendor/protocol boundaries above. | Validate with an official-client end-to-end run before advertising support; provider capacity and costs remain with the client account. |

At this decision-time snapshot, no Flux MCP server, OAuth flow,
official-client connection, cost measurement or proactive agent run had been
observed. The #9 provider matrix is broader feasibility research, not
evidence that these modes work in Flux.

## Implementation and observable proof

The [first bounded implementation issue #52](https://github.com/ColdPhase/flux/issues/52)
must use merged #29 policy and durable source/proposal objects. In Docker, start two
accounts and an independent DM/project, configure the real official Claude Code
client against the self-hosted HTTPS Flux MCP endpoint, complete Flux OAuth,
read an authorized lamp sketch revision and create a sourced proposal. Revoke
the project or agent grant before a second read/write; no title, tool result or
proposal may leak or commit. Repeat with the official client stopped and
demonstrate a human continues the same conversation/work/result path. Test
stale source, expired token, duplicate command, changed audience and client
disconnect. Report provider/client version and cost owner; do not label a stub
or harness call as an official-client pass.

The [first proactive follow-up #58](https://github.com/ColdPhase/flux/issues/58)
is a separately bounded event → sourced artifact → human continuation slice:
after opt-in, a negative low-light result
triggers one cited comparison of camera and sensor options in that project's
quiet return surface. Deduplicate by rule/source revision, suppress a rejected
proposal until evidence changes, cap frequency/cost, prevent agent-to-agent
loops and cancel on grant revocation. The compute source must be explicitly
approved; a user-operated CLI that is offline cannot be assumed available as
a background worker. Deterministic Git/CI status rules are ordinary application
logic without an LLM and need a separate integration task.

**Revisit:** a tested official client cannot complete compatible OAuth/MCP
against Flux, provider terms change, or another permitted path offers better
reliability and cost without weakening independent audience controls. Peer
acceptance must pin this revision and update [O-005](decisions.md); no founder
approval is required.

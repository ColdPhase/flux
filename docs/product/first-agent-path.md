# O-005 — first supported agent path

**Proposal:** 2026-09-27, `codex-hubert` for [#37](https://github.com/ColdPhase/flux/issues/37).
**Status:** proposed for independent evaluation by `claude-maurycy`.
This is a product/architecture decision, not an implemented or tested Flux
integration. It narrows the [#9 feasibility research](own-ai-feasibility.md)
within accepted [O-002](application-architecture-proposal.md) and the later
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
the **2026-07-28 MCP** streamable HTTP contract, protected resource and
authorization-server metadata, issuer validation, client ID metadata documents
where supported, optional pre-registration or DCR compatibility, and a
resource/audience-bound token. Tokens identify a Flux person and separately
named agent grant. Client scopes are an upper bound; Flux rechecks current
DM/project/object authorization and source revision for every tool, read and
write, including idempotent replay and queued output. Token or session caching
cannot restore a revoked grant. Do not reveal an inaccessible project's
existence, count, title, event cursor or summary.

The first tool set is deliberately small: list authorized current contexts,
read a selected source with revision, and create a **sourced proposal** for
human review. An agent cannot accept a decision, change audience, assign work
or publish a proposal into shared truth without applicable human authority.
Each proposal labels fact, interpretation and suggested action, its source
revisions, actor, grant and compute source. A changed source creates an explicit
stale/conflict response. Stop, client disconnect, expiry and revocation leave
human continuation in the same work context; no retry silently doubles a write.

**Conditional later modes:** Codex CLI and cloud app connectors need their own
actual compatibility, auth and reachability tests before the supported list
grows. An embedded/API/local Flux-operated agent requires a separately accepted
compute owner, secret handling, payer consent, budget and runtime contract.
Third-party claude.ai login or routing Free/Pro/Max credentials through Flux is
excluded. A manually invoked MCP tool is a transport slice, not completion of
the required proactive AI path.

## Evidence checked on 2026-09-27

| Claim | Evidence class | Primary source and limit |
| --- | --- | --- |
| Claude Code supports remote HTTP MCP and `claude mcp login`; it documents OAuth and CIMD/DCR/pre-registered client setup. | Vendor documentation, accessed 2026-09-27. | [Claude Code MCP guide](https://code.claude.com/docs/en/mcp). A Flux login has **not** been tested. |
| Anthropic says a third-party product may not offer claude.ai login, collect its sessions or route consumer-plan credentials for users; a user may sign into an unmodified Claude Code binary directly. | Vendor legal statement, accessed 2026-09-27. | [Claude Code legal/compliance](https://code.claude.com/docs/en/legal-and-compliance). This decision uses the user-operated client, not a hosted consumer-login service. |
| MCP 2026-07-28 has a stateless HTTP core and authorization hardening; OAuth 2.1, protected resource metadata, issuer and intended-audience validation are specified; CIMD is preferred and DCR retained for compatibility. | Published protocol and maintainer announcement, 2026-07-28, accessed 2026-09-27. | [Release](https://blog.modelcontextprotocol.io/posts/2026-07-28/), [authorization specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization). A real Claude Code ↔ Flux version negotiation is **untested**. |
| A user-operated client could use its own plan while Flux serves only authorized tools, avoiding Flux-held provider credentials. | Flux inference from the vendor/protocol boundaries above. | Validate with an official-client end-to-end run before advertising support; provider capacity and costs remain with the client account. |

No Flux MCP server, OAuth flow, official-client connection, cost measurement or
proactive agent run has been observed. The #9 provider matrix is broader
feasibility research, not evidence that these modes work in Flux.

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

The first **proactive follow-up** is a separately bounded event → sourced
artifact → human continuation slice: after opt-in, a negative low-light result
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

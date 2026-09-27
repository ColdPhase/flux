# Personal agent connection (#52)

This is the implementation contract for the accepted [O-005 path](../product/first-agent-path.md).
The owner operates an official Claude Code client and its compute account. Flux owns
OAuth consent, narrow MCP tools, current project policy and sourced proposals. No
provider credential or model request passes through Flux.

## Identities and consent

The browser session belongs to a person. A connection selects an existing,
unrevoked `agents` row with `owner_user_id` equal to that person; workspace-owned
and other people's agents are ineligible. The person chooses project IDs already
granted to that agent. The consent page shows the project names and current grants,
but it does not create or enlarge them. `flux.context.read` and
`flux.proposal.write` are token ceilings, not project permissions. On each tool
call, the bearer token identifies the connection, owner, agent, selected project
IDs and scopes; current agent and owner project access is checked again. An
expired/revoked token, removed owner, revoked agent, changed grant or removed
project cannot use a cached tool result or continue a write.

The person creates a selection through `POST /api/v1/agent-connections`, lists
their selections through `GET /api/v1/agent-connections`, and revokes one through
`DELETE /api/v1/agent-connections/:id`. A selection names 1–50 distinct projects
and one or both supported scopes. Creation checks that the person owns the agent
and that its current explicit project grants permit the selected action. The
server stores an immutable connection ID, owner, agent, project set and scopes;
it never stores a model credential. Revocation is immediate for new tool calls.
The proposal commit rechecks that connection and its selected project under the
same transaction as the source and grant checks, so a retry cannot use a revoked
selection. OAuth will bind its consent and access token to this server-owned ID.

The OAuth protected resource is the configured public HTTPS origin's `/mcp`.
The server advertises resource and authorization metadata, validates redirect
clients, PKCE, `resource`, issuer, audience and token expiry. Codes are short
lived and single use. Tokens are stored only as hashes and bound to the selected
owner, agent and projects. Bearer credentials never grant the user's broader
human authority. DMs are outside this first agent grant model.

## Initial tools and proposal

`flux_list_contexts` returns only selected, currently readable projects, with a
bounded page and no count of inaccessible projects. `flux_read_material` returns
one selected project's currently readable material and its exact revision. A
private draft is never pulled in through a material's provenance.

`flux_create_proposal` accepts a project material ID, expected current revision,
one UUID retry key, and three separate fields: observed fact, interpretation,
and suggested next action. The proposal keeps the project audience, source
material ID/revision, agent ID, owner ID, immutable agent grant ID/role and the
non-secret compute source (`user_operated_claude_code`). Grant provenance is a
snapshot, not a grant that remains valid after revocation. It remains pending
human review; it cannot publish a material, accept a decision, assign work or
change access. Its source must still be the current revision at commit. The same
agent/key/payload returns the same proposal after a lost response; a changed
payload conflicts. A retry checks current token, selected project and project
policy before revealing the stored response. A person with current project
access can inspect the attributed proposal and continue the existing human
conversation without an agent.

The human review API returns a bounded newest-first page (`limit` 1–100, default
50; `offset` 0–10000) and a total computed only after current project access.

Mutation authorization, source revision validation and insertion happen in one
transaction with the project/grant rows locked. A later revocation hides the
proposal through current project policy. Any published material derived from a
proposal remains a separate human action.

## Verification boundary

Docker integration covers two people, separate restricted projects and private
drafts, selected-project filtering, owner/agent grant loss, token expiry,
cross-project references, stale source, duplicate command and retry. A real
official Claude Code client must complete OAuth and call the tools against
the running self-hosted HTTPS instance before this path is documented as
supported. Provider plan usage and billing are observed only in the client's
account; Flux does not infer them from a successful tool call.

# Personal agent connection (#52)

**Planned extension, 2026-09-30:** [F-016](../product/mcp-cowork.md) extends this
implemented Claude path with multiple named external connections per owner,
request-bound authorization in one normal browser login, tested Codex support
and shared domain tools. The whole-browser-session selection restriction below
is a current limitation to remove, not the target UX. Existing evidence does not
establish the new capabilities; do not copy #68 helper cardinality into MCP.

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
expired token, revoked Flux connection, removed owner, revoked agent, changed grant or removed
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
selection. `POST /api/v1/agent-connections/:id/select-for-oauth` binds one
immutable choice to the live browser session. A second tab cannot switch that
choice; use a new browser session to authorize a different selection. The
signed consent screen shows the same connection, client, project names and
requested scopes. OAuth carries the server-owned connection ID in its signed
token; it never accepts project or agent IDs from the external client.

The browser setup presents personal-agent creation before client commands and
reveals project selection after a personal agent exists. The
consent review names the selected projects prominently, lists the requested
actions once, and says whether those project actions match or narrow the saved
selection. It explains that approval cannot add projects or agent grants. Any
extra OAuth permission, such as renewal access, remains visible in the requested
permission list.

The OAuth protected resource is the configured public HTTPS origin's `/mcp`.
The server advertises resource and authorization metadata, validates redirect
clients, PKCE, `resource`, issuer, audience and token expiry. Codes expire
quickly and can be used once. The OAuth provider persists hashed refresh tokens and
issues signed JWT access tokens. The MCP endpoint verifies the JWT signature,
issuer, audience and expiry against its local JWKS, then reloads the selected
connection and current grants before exposing tools and on every tool call.
Revoking the Flux connection immediately denies subsequent tools, even while
an access token has not yet expired. Bearer credentials never grant the user's
broader human authority. DMs are outside this first agent grant model.
The provider cannot revoke one JWT access token independently through its OAuth
revoke endpoint; use the Flux connection revoke action to stop access immediately.

For a remote deployment, set `FLUX_PUBLIC_ORIGIN` to the exact HTTPS origin
used by people and Claude Code, such as `https://flux.example.org`. Terminate
TLS at the operator's reverse proxy and route `/mcp`, `/.well-known/*`,
`/api/auth/*`, `/api/v1/*` and the web application on that one origin without
rewriting their paths. Keep the Compose API port reachable only by the trusted
proxy, configure `FLUX_TRUSTED_PROXIES` for its actual address, and keep the
origin stable across restart: OAuth issuer, resource identifier, redirect and
cookie security are derived from it. The CLI adds the remote server with
`claude mcp add --transport http --scope user flux https://flux.example.org/mcp`
and then runs `claude mcp login flux`. The operator must supply a trusted TLS
certificate and reachable DNS name before this can work from another machine.

In an isolated Compose test on 2026-09-28, the API container listened on port
8080 and mapped to host loopback `127.0.0.1:18562`; Claude Code 2.1.281 on
that host completed OAuth
and reported MCP protocol revision `2026-07-28` (`protocolEra: modern`). Its
authenticated connection exposed the three Flux tools. The same bearer was
used to read a selected material and create a sourced proposal over the MCP
wire; retry with the same command ID returned the same proposal. After Flux
connection deletion, the same JWT's MCP request changed from HTTP 200 to 403.
That first Claude Code installation had no model login. A later
[independent official-client check](https://github.com/ColdPhase/flux/pull/103#issuecomment-5862223636)
used Claude Code 2.1.283 with a signed-in Sonnet model against local HTTPS Flux
at `49faf5275f5c5dbf684d5f9abfa41850c94dd1c3`: OAuth consent, a
model-driven material read, a sourced proposal and immediate connection
revocation all worked. The run needed a material UUID supplied in its prompt;
`flux_list_materials` below addresses that discovery gap, but its own
model-driven use still needs verification. HTTPS from another machine remains
unverified until the operator deployment is exercised.

## Initial tools and proposal

`flux_list_contexts` returns only selected, currently readable projects (at most
50 by the connection limit), with no count of inaccessible projects. Next call
`flux_list_materials` with a selected `projectId` to discover current material and
doc IDs, titles and versions. The picker returns at most 100 rows per page
(`limit` 1–100, default 50; `offset` 0–10000), ordered by latest update, and
never includes bodies or private draft provenance. Its count covers only that
selected, currently readable project; a missing selection or lost grant yields
an error without a title, ID or count from the inaccessible project. Then
`flux_read_material` returns
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
Stopping the external client before a proposal commit leaves no Flux run to
resume or bill. A committed proposal remains attributed and pending human
review after the client disconnects; Flux never restarts the user's model or
spends their subscription in the background.

The human review API returns a bounded newest-first page (`limit` 1–100, default
50; `offset` 0–10000) and a total computed only after current project access.

Mutation authorization, source revision validation and insertion happen in one
transaction with the project/grant rows locked. A later revocation hides the
proposal through current project policy. Any published material derived from a
proposal remains a separate human action.

## Native work actions (#152)

With the `flux.action.execute` scope, an owner-created standing grant and the
runtime from `flux_bootstrap`, a connection can make these native project changes:

| Tool | Operation | Classes | Change |
| --- | --- | --- | --- |
| `flux_create_task` | `work.create` | execute, plan | One task with an optional outcome, status, blocker, done-when criteria, same-project prerequisites and plan intent |
| `flux_update_task` | `work.update` | execute, plan | One task at the exact version last read; same fields, but the plan intent never changes |
| `flux_record_result` | `result.record` | execute | One positive or negative finding with evidence, linked to tasks and decisions; it can finish one of those tasks at its read version |
| `flux_propose_decision` | `decision.propose` | execute, plan | One proposed decision with rationale, affected tasks and an optional accepted decision it would replace. An agent never accepts or rejects; a person decides |

The executor is `nativeActionExecutor` in `apps/server/src/agent-connection/action-execution.ts`.

Every tool also takes the runtime ID, the grant ID and its class, one UUID
command ID, and the exact current material revisions the action relies on. Those
revisions become the new object's sources.

Each call is one transaction composed from existing parts; nothing is
MCP-specific:

1. The #152 execution port authorizes the exact runtime, grant, operation, project,
   class, target and source versions.
2. The canonical native work command makes the change as the agent, with the same
   validation, graph lock, prerequisite, plan-intent and decision rules as the
   browser and the HTTP API.
3. The port checks the produced post-state (task or decision version, result
   identity), debits the grant once and stores the receipt.
4. Only then is the single final event batch flushed.

Retries and refusals:

- Retrying with the same command ID returns the stored outcome (`replayed: true`)
  with no second effect, debit or event. The same ID with a changed payload is
  `IDEMPOTENCY_CONFLICT`.
- A new command ID for the same plan intent returns the existing task, and a
  different task for that intent is `TASK_INTENT_CONFLICT`.
- These are refused before any effect, and nothing is debited:
  - a changed source revision (`SOURCE_VERSION_CONFLICT`);
  - a revoked, expired or exhausted grant, or a grant for another operation or
    class (`AGENT_EXECUTION_UNAVAILABLE`);
  - an object of another project (`OBJECT_NOT_FOUND`);
  - a stale version (`VERSION_CONFLICT`);
  - an unmet prerequisite (`TASK_PREREQUISITES_UNMET`).

`flux_bootstrap` lists these tools with their operation and whether the current
bearer's scopes make them available. A connection without the action scope sees
them as unavailable and gets `MCP_SCOPE_REQUIRED`.

### Shared project maps

The same executor runs the canonical sketch commands for the project's shared
maps:

| Tool | Operation | Change |
| --- | --- | --- |
| `flux_create_map` | `map.create` | One shared project map |
| `flux_rename_map` | `map.rename` | The title, at the map version |
| `flux_add_thought` | `map.thought.create` | One thought, optionally linked from another |
| `flux_update_thought` | `map.thought.update` | Text, position, size or shape, at the thought version |
| `flux_remove_thought` | `map.thought.delete` | One thought and its links, at the thought version |
| `flux_move_thoughts` | `map.positions.update` | Up to 200 thoughts, each at its version; a stale one moves none |
| `flux_link_thoughts` | `map.link.create` | One link with an optional label |
| `flux_unlink_thoughts` | `map.link.delete` | One link |

Targets and grants:

- Every command targets the map, so a standing grant can name one map or the
  whole project.
- Private and direct-message maps are never targets (`OBJECT_NOT_FOUND`).
- A grant naming another map is refused (`AGENT_EXECUTION_UNAVAILABLE`).

Post-state and replay:

- The produced post-state is the changed thought(s) plus the map checkpoint (its
  `updatedAt` after the change).
- A retry right after a lost response returns the stored outcome.
- A replay after anything else has changed that map is `COMMAND_POSTSTATE_STALE`,
  never a second effect.

Composition:

- Sketch commands record their events through the same transaction event session
  as the work commands (`nativeSketchInEventSession`).
- Each committed command adds exactly one event, after its receipt.

Co-work operations remain registry entries without tools. #153's claim adapter,
the #160 playbook and real Codex/Claude model-driven activation are still required
before agent decomposition counts as delivered.

## Verification boundary

Docker integration covers two people, separate restricted projects and private
drafts, selected-project filtering, owner/agent grant loss, token expiry,
cross-project references, stale source, duplicate command and retry. A real
official Claude Code client must complete OAuth and call the tools against
the running self-hosted HTTPS instance before this path is documented as
supported. Provider plan usage and billing are observed only in the client's
account; Flux does not infer them from a successful tool call.

# Access policy (issue #29)

This document describes the workspace, project and draft access model that the code
enforces today. It covers AC-2 of [#29](https://github.com/ColdPhase/flux/issues/29)
and the policy-contract part of AC-3. It implements the "Data, identity and access
contract" in the [architecture proposal](../product/application-architecture-proposal.md#data-identity-and-access-contract).

## One choke point

`packages/core/src/access/policy.ts` is the only place that decides access. It
exports:

| Function | Use |
| --- | --- |
| `authorize(principal, action, resource, db)` | Returns `{ allowed, visible }` for one object. |
| `assertAuthorized(principal, action, resource, db)` | Throws `NotFoundError` (404) when `visible` is false, and `ForbiddenError` (403) when the object is visible but the action is not allowed. |
| `visibleFilter(principal, workspaceId, 'project' \| 'draft', db)` | Returns a SQL condition. Put it in the `WHERE` clause of both the list query and its count, so invisible rows never reach counts, pages or payloads. |

The domain methods in `packages/core/src/access/domain.ts` call these functions
before they touch data. Mutations decide and write in one transaction, holding the
locks described under [Concurrency](#concurrency).

**Obligation for every entry point.** The HTTP API, WebSocket subscriptions and
replay, worker jobs (before reading inputs and before committing results), file
upload and download, search, MCP tools and extensions MUST get access decisions
from these functions or from the domain methods. They must not query collaborative
tables for a caller directly. A new object type extends `policy.ts` with its own
actions and filter. It does not get a second policy module. Surfaces that do not
exist yet (files, search, MCP, extensions, stream and worker rechecks) are future
integration work. Their enforcement is **not** implemented or verified here.

## Model

Migration `0003_access.sql` adds these tables. Every collaborative row carries
`workspace_id`.

| Table | Meaning |
| --- | --- |
| `workspaces` | A tenant. Its creator becomes its owner. |
| `workspace_members` | One role per person: `owner`, `admin`, `member` or `guest`. |
| `projects` | A work context. Its visibility is `workspace` (every member) or `restricted` (managers and grantees only). |
| `agents` | An agent identity in one workspace. It is owned by a person (`owner_user_id`) or by the workspace (`NULL`). It is revocable (`revoked_at`) and is never a human login. |
| `project_grants` | At most one grant per project and principal (person or agent). The grant is `contributor`, `viewer` or `denied`. |
| `drafts` | A minimal item: owner (person or agent), optional `project_id`, visibility `private` / `project` / `workspace`, and an integer `version`. |

The database rejects links across workspaces in addition to the domain checks.
Composite foreign keys enforce this:

- `(workspace_id, project_id)` on drafts and grants references `projects(workspace_id, id)`.
- `(workspace_id, user_id)` on grants references `workspace_members`.
- `(workspace_id, agent_id | owner_agent_id)` references `agents(workspace_id, id)`.

Because of the membership foreign key (`ON DELETE CASCADE`), removing a membership
also deletes that person's grants. Check constraints reject unknown roles and
visibilities, drafts with both or neither owner, and `project` visibility without a
project.

## Rules

Every decision reads current rows. Nothing is cached, so removing a membership,
revoking a grant or revoking an agent applies on the very next request or call.

**Project access level** (none < viewer < contributor < manager). The first
matching rule applies:

1. An explicit `denied` grant gives **none**. Explicit deny wins over every role,
   grant, visibility and draft-ownership rule for that project and its drafts. This
   includes owners and admins. A denied admin therefore cannot lift their own deny;
   another manager must do it.
2. Workspace `owner` and `admin` are **managers** of every project.
3. An explicit `contributor` or `viewer` grant. A viewer grant also narrows a
   member's implicit access.
4. A `member` is a **contributor** on `workspace`-visible projects.
5. Otherwise the level is **none**. Guests and agents see only projects they were
   explicitly granted. Nobody without a grant or a manager role sees a restricted project.

An agent's level comes only from its own grants, and it acts only while not
revoked. A person-owned agent is also capped at its owner's current level. It stops
entirely when the owner leaves the workspace. A workspace-owned agent is not capped
by any person.

**An agent never works outside its current project grants**, including on drafts it
authored:

- It creates a draft only inside a project where its current level is contributor.
  `draft.create` on the workspace is allowed for an agent only while it has at least
  one such project (`403` otherwise), and a create without `projectId` is rejected
  with `422 PROJECT_REQUIRED`. An agent cannot move a draft out of every project
  (`422 PROJECT_REQUIRED`).
- Reading any draft, its own private drafts included, needs the agent's current
  level viewer on the draft's project. Writing, sharing and moving need contributor.
  The same rule applies in `authorize` and in the `visibleFilter` list condition.
  After a grant is revoked or replaced by `denied`, the agent's drafts in that project
  answer `404` and leave its lists and counts. A narrowing to viewer turns writes into `403`.
- People keep the author path: a person always reads and writes their own private
  drafts, unless an explicit deny on the draft's project applies.

**Drafts.** A new draft is private to its author. Workspace membership never reveals
a private draft, not even to owners.

| Visibility | Read | Write |
| --- | --- | --- |
| `private` | author (an agent author also needs project level ≥ viewer) | author (an agent author also needs project level ≥ contributor) |
| `project` | project level ≥ viewer, and the author | project level ≥ contributor, and the author (agent: contributor) |
| `workspace` | owners, admins and members (not guests or agents), and the author (agent: viewer) | author, owners and admins (agent author: contributor) |

- **Share and move** need the author, or an owner or admin for a non-private draft.
- **Target project.** A share or move that names a project needs contributor access
  to it, and the project must be in the draft's workspace. A project the caller can
  see in another workspace is rejected with `422 CROSS_WORKSPACE`. An invisible
  project is reported as `404`.
- **Workspace-wide sharing.** Only people with the owner, admin or member role can
  share with the whole workspace, and only outside restricted projects
  (`422 RESTRICTED_PROJECT`). A workspace-visible draft therefore never reveals a
  restricted project.
- **Move** requires the caller to state the resulting visibility, so a move never
  silently widens the audience. A move to another workspace is not supported; it
  needs a later copy command.

**Membership.** Owners and admins manage members and create projects. Only an owner
can grant, change or remove the owner role (`403 OWNER_REQUIRED`). The last owner
cannot leave or step down (`409 LAST_OWNER`). Any member may leave. Members can
create personal agents. Only owners and admins can create workspace-owned agents. An
agent can be revoked by its owning person, a workspace owner or an admin.

## Concurrency

Access is evaluated from current rows in PostgreSQL's default `READ COMMITTED`
isolation. What is guaranteed:

- **Mutations are serialized against the membership, grant and agent changes they
  depend on.** Inside its transaction, and before deciding, a mutation locks the
  actor's membership row (for an agent: its agent row and its owner's membership)
  `FOR SHARE`, the target draft `FOR UPDATE`, and the draft's or target project's
  row and every grant row of the actor (and of an agent's owner) on that project
  `FOR SHARE`. The changes take conflicting locks: `grantProject` and
  `revokeProjectGrant` lock the project row `FOR NO KEY UPDATE` first and the grant
  row `FOR UPDATE`; `changeRole` and `removeMember` lock the member row `FOR UPDATE`
  (and delete it, cascading its grants); `revokeAgent` updates the agent row. So
  either the change commits first and the mutation decides on the new state, or the
  change waits until the mutation has committed. A write never commits after a
  revocation that committed before its decision. The project row is the shared lock
  for every project-dependent decision: it also covers access that has no grant row
  to lock, such as a member's default access being narrowed by a new `viewer` grant
  or removed by a new `denied` grant. `FOR NO KEY UPDATE` conflicts with `FOR SHARE`
  (so it serializes with deciding writers) but not with the `FOR KEY SHARE` that
  foreign-key checks take, so inserting drafts or events into the project is not
  blocked by it. A future project visibility change must take the same lock.
- **Reads are not locked.** A single-object read and each statement of a list (the
  count and the page are separate statements) see a consistent snapshot of committed
  rows as of that statement. A change that commits between the count and the page
  of one request can make them differ by that change. Nothing is cached, so the next
  request, event delivery or job step always evaluates fresh.

`tests/app/access-policy.test.ts` checks both orders on two real PostgreSQL
connections, detecting the wait with `pg_blocking_pids` rather than timing. The
cases are: revoking an agent's contributor grant; inserting a `denied` grant for a
member who has no grant row, and replacing an agent grant with `denied`; narrowing a
member's default access with a `viewer` grant; changing the member to guest; and
removing the member. In each case, a change that starts after an update decided waits
until the update commits. An update that starts while the change is uncommitted waits,
and is then refused with `404` or `403` without writing.

## Actions

| Resource | Actions |
| --- | --- |
| workspace | `workspace.read`, `workspace.read_members`, `workspace.manage_members`, `workspace.manage_agents`, `project.create`, `draft.create`, `agent.create` |
| project | `project.read`, `project.write`, `project.manage` |
| draft | `draft.read`, `draft.write`, `draft.share`, `draft.move` |
| agent | `agent.read`, `agent.revoke` |

## HTTP API

The routes live in `apps/server/src/access/routes.ts`. Paths and wire types are in
`packages/contracts/src/access.ts`. Every route needs a live session
(`401 UNAUTHENTICATED` otherwise), and state changes pass the origin check from
[identity](containers.md#identity-services-and-variables). An object the caller
cannot see answers `404` with a `*_NOT_FOUND` code. A visible object with a
forbidden action answers `403`. Error bodies are `{ error, code }`.

| Method and path | Domain method |
| --- | --- |
| `GET/POST /api/v1/workspaces` | `listWorkspaces`, `createWorkspace` |
| `GET /api/v1/workspaces/:id` | `getWorkspace` |
| `GET/POST /api/v1/workspaces/:id/members` | `listMembers`, `addMember` (by `email` or `userId`) |
| `PATCH/DELETE /api/v1/workspaces/:id/members/:userId` | `changeRole`, `removeMember` |
| `GET/POST /api/v1/workspaces/:id/projects` | `listProjects` (`limit`, `offset`), `createProject` |
| `GET /api/v1/projects/:id` | `getProject` |
| `GET/POST /api/v1/projects/:id/grants` | `listProjectGrants`, `grantProject` (create or replace) |
| `DELETE /api/v1/projects/:id/grants/:grantId` | `revokeProjectGrant` |
| `GET/POST /api/v1/workspaces/:id/agents` | `listAgents`, `createAgent` |
| `DELETE /api/v1/agents/:id` | `revokeAgent` |
| `GET/POST /api/v1/workspaces/:id/drafts` | `listDrafts` (`limit`, `offset`, `projectId`), `createDraft` |
| `GET/PATCH /api/v1/drafts/:id` | `getDraft`, `updateDraft` |
| `POST /api/v1/drafts/:id/share` | `shareDraft` (`scope`, optional `projectId`) |
| `POST /api/v1/drafts/:id/move` | `moveDraft` (`projectId` or `null`, `visibility`) |

Lists return `{ items, total, limit, offset }`. `total` is counted after visibility
filtering. `limit` is 1–100 (default 50) and `offset` is 0–10000.

## Events

Each mutation also records a row in `events` in the same transaction. The row
carries `workspace_id`, a versioned `kind` (for example `draft.shared.v1`), the
actor, and identifiers and audience only, never draft content. These rows do not
go through the outbox or the stream yet. A later stream must filter them per
recipient through the same policy.

## Not in this slice

- Agent authentication (MCP OAuth). Agents are persisted and granted, and tests
  drive them through core methods only. There is no HTTP path that acts as an agent.
- `If-Match` preconditions and idempotency keys. `version` is incremented on every
  draft change but not checked yet.
- WebSocket delivery and replay, and worker read/commit rechecks (the rest of AC-3).
- Changing a project's visibility. When it is added, it must resolve workspace-visible
  drafts in a project that becomes restricted.
- PostgreSQL row-level security as defense in depth.

## Tests

`./scripts/check_application.sh` runs these checks in Docker:

- `tests/app/access.test.ts` covers two workspaces and six accounts over HTTP.
- `tests/app/access-policy.test.ts` covers agent principals, the
  `authorize`/`visibleFilter` contract and the database constraints directly
  against PostgreSQL.

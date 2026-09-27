# Access policy (issue #29)

This document describes the workspace, project and draft access model that the code
enforces today. It covers AC-2 of [#29](https://github.com/ColdPhase/flux/issues/29),
AC-3 (one policy for HTTP, the WebSocket stream and worker jobs) and the safe-write
part of AC-4 (`If-Match` and idempotency keys). It implements the "Data, identity and access
contract" in the [architecture proposal](../product/application-architecture-proposal.md#data-identity-and-access-contract).

## One choke point

`packages/core/src/access/policy.ts` is the only place that decides access. It
exports:

| Function | Use |
| --- | --- |
| `authorize(principal, action, resource, db)` | Returns `{ allowed, visible }` for one object. |
| `assertAuthorized(principal, action, resource, db)` | Throws `NotFoundError` (404) when `visible` is false, and `ForbiddenError` (403) when the object is visible but the action is not allowed. |
| `visibleFilter(principal, workspaceId, 'project' \| 'draft', db)` | Returns a SQL condition. Put it in the `WHERE` clause of both the list query and its count, so invisible rows never reach counts, pages or payloads. |
| `authorizeEvent(principal, event, db)` | Whether a recipient may receive one event now: the principal is active in the event's workspace and can read the object the event is about. `recordEvent` calls it per member/agent to write the stream audience, and the stream calls it again for every event at delivery time. |
| `visibleWorkspaceOf(principal, resource, db)` | The workspace of an object the principal can see, or `null`. Used to scope records such as idempotency keys without revealing invisible objects. |

`authorize` and `assertAuthorized` take an optional `{ lock: true }`. Inside a commit
transaction it takes the locks described under [Concurrency](#concurrency): the
principal's membership or agent rows `FOR SHARE`, a draft `FOR UPDATE`, and the
project row and the principal's grants on it `FOR SHARE`. A revocation that committed
earlier is then seen, and a concurrent one waits until this transaction ends.

The domain methods in `packages/core/src/access/domain.ts` call these functions
before they touch data. Mutations decide and write in one transaction, holding the
locks described under [Concurrency](#concurrency).

**Obligation for every entry point.** The HTTP API, WebSocket subscriptions and
replay, worker jobs (before reading inputs and before committing results), file
upload and download, search, MCP tools and extensions MUST get access decisions
from these functions or from the domain methods. They must not query collaborative
tables for a caller directly. A new object type extends `policy.ts` with its own
actions and filter. It does not get a second policy module. Notifications and
Web Push (#41) follow this rule: a notification inherits the audience of its source
(`<type>.read`), checked at creation, in the inbox list (`visibleFilter`), on direct
reads (`authorize`) and by the worker before each send. The event stream and the
draft summary worker job (#29) also use the policy, and tests cover them. Surfaces
that do not exist yet (files, search, MCP, extensions) are future integration work.
Their enforcement is **not** implemented or verified here.

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

Migration `0004_stream_safe_writes.sql` adds `events.seq`, `draft_results` (worker
job results, see [worker jobs](#worker-jobs)) and `idempotency_keys` (see
[idempotency keys](#idempotency-keys)).

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

**Sketches** (#69, details in [sketches.md](sketches.md)). A `project` sketch is
readable at project level ≥ viewer and changeable at ≥ contributor, so explicit deny
and every project rule above apply unchanged. A `direct` sketch (a DM's map, or a
private one with only its author) is readable and changeable only by its participants,
who must be current workspace members. Owners and admins who are not participants do
not see it, and agents never see direct sketches. Sketch events (`sketch.*.v1`) are
authorized as `sketch.read` on the sketch.

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
| `GET/POST /api/v1/drafts/:id/summaries` | `listDraftSummaries`, `requestDraftSummary` (see [worker jobs](#worker-jobs)) |
| `GET /api/v1/drafts/:id/summaries/:resultId` | `getDraftSummary` |
| `GET /api/v1/stream` (WebSocket) | see [WebSocket stream](#websocket-stream) |

Lists return `{ items, total, limit, offset }`. `total` is counted after visibility
filtering. `limit` is 1–100 (default 50) and `offset` is 0–10000.

## Events

Each mutation also records a row in `events` in the same transaction. The row
carries `workspace_id`, a versioned `kind` (for example `draft.shared.v1`), the
actor, and identifiers only, never draft content.

Migration `0004_stream_safe_writes.sql` adds `seq`, a monotonic `bigint` log position (internal; never sent to clients). A
`BEFORE INSERT` trigger first takes a transaction-scoped advisory lock and then draws
the next value. Transactions that write events therefore commit in `seq` order. A
reader that has seen `seq = N` has already seen every committed event below `N`.
Rolled-back transactions leave gaps, which are harmless. The lock is held from the
event insert until commit, so domain methods write their event as the last
statement. This serializes the tail of event-writing transactions. That is adequate
for one database, and it is the first thing to revisit if write throughput needs it.
An `AFTER INSERT` trigger sends `NOTIFY flux_events` with the `seq` for events that
have a workspace. The notification is only a wake-up. The `events` table remains the
source of truth, and `outbox` remains reserved for worker-side external delivery.

**Audience index.** `recordEvent` (`packages/core/src/events.ts`) also writes the
event's stream audience in the same transaction: for every member and unrevoked agent
of the workspace it calls `authorizeEvent`, and stores one `event_audience(recipient,
seq, event_id)` row per principal that may read the object at that moment. The
decision runs before the event insert, so it sees the transaction's own change (a
share, a removal) and the seq lock is held only for the two inserts. Rows commit with
their event and therefore in `seq` order. This is write-side work proportional to the
workspace's members and agents; readers never pay for events outside their audience.
Events recorded before migration 0004 have no audience rows and are not replayed.

The event's object type comes from the first segment of its kind: `workspace`,
`project`, `draft` or `agent`. The read action for that type decides delivery:
`workspace.read`, `project.read`, `draft.read` or `agent.read`. Events without a
workspace (the sample fixture) and unknown kinds are never delivered.

## WebSocket stream

`GET /api/v1/stream?cursor=<cursor|eventId>` is implemented in
`apps/server/src/stream/index.ts` with `@fastify/websocket` 11.3.1. Wire types are
`StreamMessage`, `StreamEvent` and `StreamReady` in `packages/contracts/src/access.ts`.

**Upgrade.** The server checks these before it upgrades, in this order:

1. `Origin` must equal `FLUX_PUBLIC_ORIGIN` exactly. A foreign or missing origin gets
   `403 ORIGIN_REJECTED`. Browsers always send `Origin` on a WebSocket upgrade, so this
   blocks cross-site WebSocket hijacking with the session cookie.
2. A live session cookie. Without one the answer is `401 UNAUTHENTICATED`, and this
   includes reconnecting with a revoked session.
3. The cursor. It is either an opaque cursor that the server issued to the same person,
   or the id of an event the caller may receive. Without a cursor the stream starts at
   the current head. Anything else, including a raw number, a cursor issued to another
   person, a forged value or an invisible event id, gets `400 CURSOR_INVALID`. The
   client should then drop its cursor and refetch.

**Protocol.** The server sends JSON text frames and ignores client messages. Their
maximum payload is 1 KiB.

- `{"type":"event","cursor","id","kind","workspaceId","objectType","objectId","createdAt"}`
  is one authorized change. It carries identifiers and kind only, and the client
  refetches the object over HTTP. Events arrive in commit order. They may repeat after
  a reconnect, so deduplicate by `id`. `cursor` resumes after this event.
- `{"type":"ready","cursor"}` is sent once, after replay. Live delivery follows it.
  `cursor` resumes after the last event in this person's audience (sent, or at the
  head of their audience rows), not after the global head. Reconnect with the latest cursor received (event or ready).

**Cursors.** The global `seq` is never sent. A cursor is `c1.` followed by the
base64url AES-256-GCM encryption of a position, authenticated with the recipient
(`human:<id>`) as associated data (`apps/server/src/stream/cursor.ts`). Keys are
derived with HKDF from `FLUX_AUTH_SECRET`. The IV is derived from the recipient and
position, so the same person and position always give the same cursor. The server
issues cursors only for positions of events that person could see when they were
issued, or for `0`. A fresh connection's `ready.cursor` is the cursor of the person's
last `event_audience` row, found with one primary-key lookup. It is not the global
head, so events that person cannot see change neither the cursors nor the frames they
get. Rotating `FLUX_AUTH_SECRET` invalidates stored cursors (`400`,
then refetch).
- Close `4401` means the session ended (revoked, expired or signed out). Reconnecting
  needs a new login. Close `1013` means the client read too slowly: its unsent buffer
  passed 1 MiB, or one send took over 30 s. Reconnect with the last cursor. Close
  `1001` means the server is shutting down. Close `1011` is an internal error.

**Delivery.** Every connection pulls its own `event_audience` rows (joined to `events`)
in `seq` order by primary key, starting after its cursor. These wake it up: the initial replay, a `NOTIFY`, and the heartbeat tick (a
polling fallback in case a notification is lost while the listener reconnects). For
each batch of 200 events the connection revalidates the session. For each event it
calls `authorizeEvent` for this principal again as the final check. It revalidates the session again just
before each send and awaits the write, so a slow client slows only its own cursor.
An event is sent only if the recipient could read its object when the event was
recorded (the audience row) **and** can still read it when it is delivered. Access
gained later does not replay older events:

- **Private drafts** reach only their author, never workspace owners.
- **Restricted projects** and their drafts reach only managers and grantees.
- **Another workspace's** events never reach a non-member.
- **After a membership is removed**, nothing more from that workspace reaches the
  person, including the removal event itself. The stream is per person and spans all
  their workspaces, so it stays open.
- **A revoked or expired session** closes the socket with `4401` on the next wake-up
  or heartbeat, whichever comes first. Nothing is delivered after the revocation.

**Heartbeat.** The server pings every `FLUX_STREAM_HEARTBEAT_MS` (default 25000, and
1000 in the test script). Each tick also revalidates the session and polls. A client
that has not answered the previous ping is terminated.

**Hidden activity and timing.** Opening a stream, computing `ready.cursor` and
replaying after a cursor read only the recipient's own audience rows, so their work
does not depend on events the recipient cannot see. `tests/app/stream.test.ts`
checks this with 500 hidden events: identical server-side work counters (queries,
rows, `authorizeEvent` calls, from the test-only `GET /api/v1/stream/work` served when
`FLUX_TEST_FAILURE_INJECTION=true`), identical rows examined in `EXPLAIN ANALYZE` of
both stream queries, and a coarse open→ready timing bound. The remaining shared cost
is global: event writes serialize on the seq lock and the database is shared, so
heavy activity anywhere can slow everyone's writes and deliveries. That is load, not
per-recipient work, and it is not padded to constant time. Each API process relies
on its own `LISTEN` for wake-ups.

## Worker jobs

`draft.summarize.v1` (`packages/core/src/jobs/draft-summary.ts`) is a placeholder
derived-result job. It computes a deterministic word count into `draft_results`. It
exists so the worker authorization contract is real and tested:

- **Request.** `POST /api/v1/drafts/:id/summaries` answers `202` with a
  `DraftSummary`. It needs `draft.read`. The result row (`queued`), the
  `draft.summary_requested.v1` event and the pg-boss job commit in one transaction. The
  job payload is `{ resultId }` only: a reference, never a permission snapshot or
  content.
- **Run.** The worker claims the row (`running`). It calls `assertAuthorized` for the
  requesting principal **before reading** the draft. After computing, it opens the
  commit transaction and calls `assertAuthorized(..., { lock: true })` **again**. That
  check locks the requester's membership, the draft, the draft's project row and the
  requester's grants on it (see [Concurrency](#concurrency)). It writes the result and
  `draft.summary_completed.v1` only if that check passes. A grant or membership change
  that commits before the check is seen. A change that starts after it waits until the
  result has committed.
- **Denial.** If access was lost at either point, the result is not committed. The row
  becomes `denied` with `deniedAtStage` `before_read` or `before_commit`, and a
  `draft.summary_denied.v1` event is recorded. A redelivered job for a finished row is
  skipped.
- **Read.** `GET /api/v1/drafts/:id/summaries` (latest 20) and
  `GET /api/v1/drafts/:id/summaries/:resultId` are visible to whoever can currently
  read the draft.

`processDraftSummary(resultId, db, hooks)` accepts two hooks. `afterRead` runs between
the read and the commit transaction. `beforeCommit(tx)` runs inside the commit
transaction after the recheck, while its locks are held. Only tests pass them, to place
a revocation at those points. The Compose worker never passes hooks.

## If-Match preconditions

Draft update (`PATCH /api/v1/drafts/:id`), share and move require the expected
version. The domain methods enforce this too, not only the HTTP routes.

- Send `If-Match: "<version>"`, or body `expectedVersion`. A bare integer is accepted
  in the header. `*`, lists and a header that disagrees with the body are rejected with
  `400 INVALID_PRECONDITION`.
- Missing: `428 PRECONDITION_REQUIRED`.
- Stale: `409 VERSION_CONFLICT` with `currentVersion` and `current`, the latest draft
  as the caller is authorized to read it. The change is not applied.
- Authorization comes first. An invisible draft answers `404` whatever the
  precondition, so a precondition never reveals an object.
- Draft responses (get, create, update, share, move) carry `ETag: "<version>"`.

## Idempotency keys

Every POST and PATCH under `/api/v1` access routes, and summary requests, accepts
`Idempotency-Key`: 1–255 visible ASCII characters. The implementation is
`runIdempotent` in `packages/core/src/idempotency.ts`. DELETE routes and the Better
Auth and session endpoints do not take keys.

- **Scope.** A key is scoped by principal, workspace and operation. The operation is
  the method and route pattern, for example `POST /api/v1/drafts/:draftId/share`. The
  workspace comes from `visibleWorkspaceOf` for the route's object, and is `null` for
  commands outside a workspace or on objects the caller cannot see. The same key
  therefore works independently for another person, another workspace or another
  operation.
- **Request hash.** A SHA-256 of the canonical JSON of the path parameters, query,
  body and `If-Match`.
- **Atomicity.** The command runs inside the key's transaction, and domain methods
  nest a savepoint. The successful response (status, body and `ETag`) is stored in the
  same commit. A crash cannot leave a change without its key, or a key without its
  change. A transaction advisory lock on the scope makes a concurrent duplicate wait
  for the first request and then replay it.
- **Matching retry.** A retry returns the stored status and body, plus
  `Idempotent-Replayed: true`, without running the command again. It does so only
  after the caller's **current** access to what the stored response describes is
  checked again, inside the replay transaction. For a workspace that is
  `workspace.read`; for a project, draft or agent it is its read action; for member
  changes it is `workspace.read_members`; for grants it is `project.manage`; for
  summaries it is `draft.read` on the draft. If the check fails, the caller gets the
  same `404` (or `403`) as any other request for that object. The response has no
  replay header, and the stored body is never returned. For example, an admin demoted
  to member cannot replay the creation of a restricted project to learn its name.
- **Reused key.** The same key with a different request gets
  `422 IDEMPOTENCY_KEY_REUSED`.
- **Failures.** 4xx and 5xx responses are not stored, and the change rolls back, so a
  failed command can be retried with the same key.
- **Retention.** 24 hours (`expires_at`). Lookups ignore expired rows and replace them.
  The worker's hourly `idempotency.cleanup.v1` schedule (`17 * * * *`) deletes them.

## Not in this slice

- Agent authentication (MCP OAuth). Agents are persisted and granted, and tests
  drive them through core methods only. There is no HTTP path or stream that acts as an
  agent.
- Changing a project's visibility. When it is added, it must resolve workspace-visible
  drafts in a project that becomes restricted.
- PostgreSQL row-level security as defense in depth.
- Presence and other ephemeral stream messages, retention pruning of `events` (with a
  `reset` signal for cursors older than the retained log), and multi-process fan-out
  measurements.

## Tests

`./scripts/check_application.sh` runs these checks in Docker:

- `tests/app/access.test.ts` covers two workspaces and six accounts over HTTP.
- `tests/app/access-policy.test.ts` covers agent principals, the
  `authorize`/`visibleFilter` contract and the database constraints directly
  against PostgreSQL.
- `tests/app/stream.test.ts` covers replay after a cursor and live delivery for two
  workspaces and three accounts. It checks per-recipient filtering (private drafts,
  restricted projects, other tenants), removal of a membership, session revocation
  (close `4401`, then reconnect `401`), the origin and cursor rejections (raw numbers,
  forged cursors, another person's cursor), and the heartbeat. It also checks that a
  member outside a restricted project gets identical cursors and frames, fresh and on
  resume, whether or not restricted and private activity happened.
- `tests/app/e2e/access-stream.e2e.ts` runs in Chromium (the `e2e` Playwright
  image) against the running API: three people sign up in their own browser
  contexts, the owner creates a workspace, a restricted project, a viewer grant and a
  private draft, and shares it. The granted member's page `WebSocket` receives the
  share and its `fetch` reads the draft; a non-member gets `404`. After the grant is
  revoked, the member's open socket receives a later visible event but nothing for
  the draft, and the read is `404`. The web app is still the placeholder shell, so
  the pages use same-origin `fetch` and `WebSocket` rather than UI screens. Evidence
  from one run is in `docs/development/evidence/29-browser/`.
- `tests/app/worker.test.ts` covers the Compose worker committing a result. Using the
  `afterRead` hook, it also covers denial before read and the race of a revocation
  between read and commit. It covers grant revocation on two connections in both orders:
  a revoke that starts during the commit waits and the result commits, and a revoke
  that is uncommitted when the commit starts makes the worker wait and then deny.
- `tests/app/safe-writes.test.ts` covers `If-Match` (428, 409 with an unchanged row,
  `ETag`) and idempotency keys (replay, one row, 422 on reuse, scope, concurrent
  duplicates, expiry and cleanup). It also covers replays after lost access: a demoted
  admin replaying a restricted project creation, and draft create and share replays
  after a deny grant. Both get `404` without the stored body.

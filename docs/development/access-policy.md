# Access policy (issue #29)

This document describes the workspace, project and map access model that the code
enforces today. It covers AC-2 of [#29](https://github.com/ColdPhase/flux/issues/29),
AC-3 (one policy for HTTP, the WebSocket stream and worker jobs) and the safe-write
part of AC-4 (`If-Match` and idempotency keys). It implements the "Data, identity and access
contract" in the [architecture proposal](../product/application-architecture.md#data-identity-and-access-contract).

## One choke point

`app/packages/core/src/access/policy.ts` is the only place that decides access. Its decisions
are pure: they run over the facts of the `AccessReader` port (`access/ports.ts`), which has one
implementation, `app/packages/db/src/repositories/access.ts` (`accessReader(db)`, bound to the
transaction that decides). That adapter reads the facts and takes the locks, in the order
[Concurrency](#concurrency) lists, and builds the list condition. Callers pass `accessReader(tx)`
where the table below says `reader`. Core exports:

| Function | Use |
| --- | --- |
| `authorize(principal, action, resource, reader)` | Returns `{ allowed, visible }` for one object. |
| `assertAuthorized(principal, action, resource, reader)` | Throws `NotFoundError` (404) when `visible` is false, and `ForbiddenError` (403) when the object is visible but the action is not allowed. |
| `visibleFilter(principal, workspaceId, 'project' \| 'sketch' \| 'dm', db)` (`@flux/db`) | Returns a SQL condition. Put it in the `WHERE` clause of both the list query and its count, so invisible rows never reach counts, pages or payloads. It is the adapter's own list condition for the same rules (a SQL fragment cannot live in core), over the same actor standing `authorize` reads. |
| `authorizeEvent(principal, event, reader)` | Whether a recipient may receive one event now: the principal is active in the event's workspace and can read the object the event is about. `recordEvent` calls it per member/agent to write the stream audience, and the stream calls it again for every event at delivery time (through `authorizeDelivery`, which also lets the end of a person's access reach them, #862). |
| `visibleWorkspaceOf(principal, resource, reader)` | The workspace of an object the principal can see, or `null`. Used to scope records such as idempotency keys without revealing invisible objects. |

`authorize` and `assertAuthorized` take an optional `{ lock: true }`. Inside a commit
transaction it takes the locks described under [Concurrency](#concurrency): the
principal's membership or agent rows `FOR SHARE`, and the
project row and the principal's grants on it `FOR SHARE`. A revocation that committed
earlier is then seen, and a concurrent one waits until this transaction ends.

The use cases for workspaces, membership, projects, grants and agents
(`app/packages/core/src/access/{workspaces,members,space-ai,projects,grants,agents}.ts`)
call these functions before they touch data. Mutations decide and write in one transaction,
holding the locks described under [Concurrency](#concurrency). Their rows come from the
repositories of `app/packages/db/src/repositories/{workspaces,projects,agents}.ts`
behind the ports in `access/repositories.ts`; a repository makes no decision.

**Obligation for every entry point.** The HTTP API, WebSocket subscriptions and
replay, worker jobs (before reading inputs and before committing results), file
upload and download, search, MCP tools and extensions MUST get access decisions
from these functions or from the domain methods. They must not query collaborative
tables for a caller directly. A new object type extends `policy.ts` with its own
actions and decision, the port with the facts they need, and the `@flux/db` adapter with the
statements and the list condition. It does not get a second policy module or a second reader. Notifications and
Web Push (#41) follow this rule: a notification inherits the audience of its source
(`<type>.read`), checked at creation, in the inbox list (`visibleFilter`), on direct
reads (`authorize`) and by the worker before each send. The event stream also uses the policy, and tests cover it. Search (#114)
composes `visibleFilter` for projects, DMs and sketches, and `authorize` for
`workspace.read_members`, into its SQL before ranking, limits, counts and snippets; see
[search.md](search.md). Surfaces that do not exist yet (files, MCP, extensions) are future
integration work. Their enforcement is **not** implemented or verified here.

## Model

Migration `0003_access.sql` adds these tables. Every collaborative row carries
`workspace_id`.

| Table | Meaning |
| --- | --- |
| `workspaces` | A tenant. Its creator becomes its owner. |
| `workspace_members` | One role per person: `owner`, `admin`, `member` or `guest`. |
| `projects` | A work context. Its visibility is `workspace` (every member) or `restricted` (managers and grantees only). |
| `agents` | An agent identity in one workspace, always owned by a person (`owner_user_id`). It is revocable (`revoked_at`) and is never a human login. |
| `project_grants` | At most one grant per project and person. The grant is `manager` (a space admin) or `contributor` (a space member); there are no other roles (#903). Agents hold none: they have their owner's rights. |

Migration `0004_stream_safe_writes.sql` adds `events.seq` and `idempotency_keys` (see
[idempotency keys](#idempotency-keys)). Private drafts, their versions and their summary results went with migration 0028 (#947).

The database rejects links across workspaces in addition to the domain checks.
Composite foreign keys enforce this:

- `(workspace_id, project_id)` on grants references `projects(workspace_id, id)`.
- `(workspace_id, user_id)` on grants references `workspace_members`.
- `(workspace_id, agent_id | owner_agent_id)` references `agents(workspace_id, id)`.

Because of the membership foreign key (`ON DELETE CASCADE`), removing a membership
also deletes that person's grants. Check constraints reject unknown roles and
visibilities.

## Rules

Every decision reads current rows. Nothing is cached, so removing a membership,
revoking a grant or revoking an agent applies on the very next request or call.

**AI in a space** ([AG-10](../product/assistant.md#ag-10--ai-in-a-space), F-037; it replaces the workspace AI lock of F-029). Each space has one switch, a `project_ai_policies` row written by a trigger when the space is made (on, or off in an encrypted workspace). Its epoch grows on every flip, and every AI work row records the epoch it was admitted under. An agent's level on a space is its owner's (F-036 AG-3) and **none** while the switch is off, so every read, list, audience and event audience that goes through the policy leaves the agent out, and a person's own rights are unchanged. AI entry points call `requireSpaceAi(projectId)`, which holds the row `FOR SHARE` (before the grants) and, for queued work, also checks the admission epoch; the flip (`setSpaceAi`) takes the row `FOR UPDATE` first. A space admin and a company owner or admin may flip it (`project.manage`); an agent never. Turning it off sweeps that space's queued runs, tokens, comparisons, reactions, co-work requests and units, and asks a run in progress to stop, whose next check then refuses, so it writes nothing more; what it had already written stays. An agent belongs to its person for the whole Flux, so nothing about AI is checked on the company or on a person's connection, only on the space an agent names.

**Project access level** (none < contributor < manager). A space has two roles, Member (`contributor`) and Admin
(`manager`) (F-037, #903); nobody reads a space without being able to work in it, and no grant keeps anyone out of one. The first
matching rule applies:

1. Workspace `owner` and `admin` are **managers** of every project, whatever grants they hold. Removing their grant only takes
   them off the space's people; they reach it as before and put themselves back with Add me. Their *agents* do not: an agent has its
   owner's level only in the spaces the owner belongs to (C-15, #934).
2. An explicit `manager` or `contributor` grant gives that level.
3. A `member` is a **contributor** on `workspace`-visible projects.
4. Otherwise the level is **none**. Guests see only projects they were explicitly granted. Nobody without a grant or a manager
   role sees a restricted project. To take someone out of a space, remove their grant.

An agent's rights are exactly its owner's ([F-036](../product/assistant.md) AG-3): its level is
its owner's current level, it holds no grant of its own, and it acts only while not revoked. It
stops entirely when the owner leaves the workspace or becomes a guest, even with a grant on the
space: a guest has no agents and no AI (F-036 AG-2). Whatever the owner loses, the agent loses on
its next call. "What it may do" narrows what an agent does inside those rights and never adds any.

**An agent never works outside its owner's current access.** It reads and writes a space's maps and docs at its owner's current level, and a private map is never an agent's: only its person creates one. After the owner's grant is removed, what the agent had in that space answers `404` and leaves its lists and counts.

**Sketches** (#69, details in [sketches.md](sketches.md)). A `project` sketch is
readable and changeable with project access, so every project rule above applies unchanged. A `private` sketch is readable and
changeable only by the person who created it, while they are active in the workspace.
Owners, admins and agents (including the author's own agent) never see it. Each person has at most one
private sketch in a company (#947; a second answers `409 MY_MAP_EXISTS`, and a unique index holds the rule). A direct message
has no sketches (#947). Sketch events (`sketch.*.v1`) are authorized as
`sketch.read` on the sketch.

**Direct messages** (#107, details in [direct-messages.md](direct-messages.md)). A DM's
audience is exactly its current participants (`dm_participants`). `dm.read` and `dm.write` need
an active person who is a participant; workspace owners and admins outside the DM get `404`, and
agents see no DMs in this slice. `dm.create` is for owners, admins and members. Leaving deletes
the participant row, and removing a membership cascades to it, so access ends on the next
request. DM events (`dm.*.v1`) are authorized as `dm.read` on the DM.

**Personal assistant runs** (#68, details in [personal-runs.md](personal-runs.md)). A run is
an `assistant_run` object with one reader: `assistant_run.read` is allowed only to the person who
owns the run, while they are active in its workspace. Workspace owners, admins, project members
and agents never see it, so its progress events (`assistant_run.changed.v1`) reach the owner
alone. The committed answer is a separate project event for the conversation's audience.

**One company and its spaces (F-037, #874).** One Flux is one company: the first account sets
it up (`joinCompany`, under a transaction-scoped advisory lock) as its owner, with the
default space **Everyone** (visibility `workspace`, its creator holding a `manager` grant). The
company is the one `workspaces` row with `company = true` (a partial unique index allows one).
With single sign-on every later account the provider lets in joins the company as a `member` on
its first sign-in; without it, people join through [invite links](#invite-links-f-035) or an
owner or admin adding an existing account. `POST /api/v1/workspaces` is registered only on a test
deployment (fixture token and failure injection), which keeps isolated workspaces for its tests.
The one other route that makes a workspace is `POST /api/v1/encrypted-workspaces`, and only for the
company's owners and admins (`requireCompanyAdmin`; the fixture bearer of a test deployment skips
it), until a space itself can be encrypted. People call a project a *space*. Everyone in the
company but a guest creates spaces (`project.create`); a new space is `restricted` and its creator
gets a `manager` grant. A space's people are its grants: `manager` is a space admin (people only,
never a guest, and an agent never holds it) and `contributor` a space member. Every member is in
Everyone through its `workspace` visibility; guests are not. In the company, only setup makes a
`workspace`-visible space (`SPACE_NOT_FOR_EVERYONE`).

The company's owners and admins reach every space, so they can change any of them, but they
belong only to the ones they were added to. A list says which with `member`: their sidebar shows
those, and Settings › Company lists every space, where they add themselves **as its admin** (Add me writes a `manager` grant, so a
space whose last admin left the company still has one, [C-16](../product/decisions.md#coordinator-defaults-and-inferences-not-founder-decisions-hubert-can-override)).
Nothing keeps a company owner or admin out of a space: a company owner or admin has the manager level whatever grants exist, so a space
admin who removes one from the space's people only takes them off its list (an inference of #903: the former `COMPANY_ADMIN_PROTECTED`
and `OWNER_REQUIRED` refusals guarded the deny, which is gone). Joining with a provider runs
on every provider sign-in, so an account that linked it later joins too. Someone who leaves or is
removed goes on `workspace_removed_people` and stays out, also on a provider sign-in, until an
owner or admin restores them from Settings › Company. Restore brings them back as a `member`, in
Everyone; leaving ended their grants, so other spaces are added by hand. With `FLUX_SIGNUP=verified`
a password account sets up the company when its address is verified, not when it signs up. With
single sign-on as the only way in, nobody makes an invite link (`INVITES_OFF_WITH_SSO`).
Owners and admins rename the company (`PATCH /api/v1/workspaces/:id`, `workspace.rename`).

**A space's settings (F-037, #874).** A space admin and a company owner or admin (all `project.manage`) rename the space
(`PATCH /api/v1/projects/:id`, `renameProject`), add and remove its people (`grants`; any company person, an owner too, as in New space, #905), turn its AI on or off
(`PUT /api/v1/projects/:id/ai-policy`, [AI in a space](#model)) and delete it (`DELETE /api/v1/projects/:id`, `deleteProject`).
Deleting erases the space in one statement, as every table that names a project cascades (#530, migration 0101), together with its
notifications and mutes, which name it by source. Its event (`project.deleted.v1`) goes to the people who could open the space,
decided while it still existed. The Everyone space cannot be deleted (`EVERYONE_CANNOT_BE_DELETED`). Anyone who is added to a space
leaves it with `POST /api/v1/projects/:id/leave`, and someone who reaches it only through the company, or through Everyone, has
nothing to leave (`NOT_ADDED`). **A space always keeps an admin** ([C-16](../product/decisions.md#coordinator-defaults-and-inferences-not-founder-decisions-hubert-can-override)):
leaving, stepping down (`POST .../grants` with another role) and `DELETE .../grants/:id` all refuse with `LAST_SPACE_ADMIN` while
the person is the last admin by grant, whoever asks; removing the person from the company or making them a guest is not blocked,
because a company admin then adds themselves from Settings › Company (`requireAnotherSpaceAdmin`). A new space takes its people
(any company person, an owner too) and its AI switch in the same command as its creator's admin grant
(`POST /api/v1/workspaces/:id/projects` with `people` and `ai`). Deleting a space queues the bytes of every file it held in
`file_garbage` in the same transaction, so the file cleanup removes them. `GET .../people` is the space's own people: the people it
was added to (the whole company in Everyone), with agents whose owner is among them; a company admin who was not added reaches the space
but is not listed, so the Owner field, mentions and the header agree with the settings page.

**Search, the Inbox and Needs you for a company admin** (a coordinator default, F-037) are limited to the spaces the person
belongs to, though they could reach every other space: `memberFilter` in `@flux/db` is `visibleFilter` and membership
(`projectMemberSql`).

**A company owner's or admin's agents** ([C-15](../product/decisions.md#coordinator-defaults-and-inferences-not-founder-decisions-hubert-can-override),
#934, Hubert 2026-11-07) belong where their owner does: a company owner's or admin's agents have no level in a space the person was not
added to, though the person reaches it. This is in the one SQL level, `projectLevelSql` (an agent's level is its owner's level in the
spaces `projectMemberSql` says the owner belongs to), so every surface follows it: the lists and search (`visibleFilter`,
`memberFilter`), each read and action of a server agent, a local client (its connection can select only such a space) and `/ai` (a
run is refused there with `PERSONAL_RUN_NO_PROJECT_ACCESS`), and the assistant's own selection (`assistantProjectIds`). A member's or
guest's agents are unchanged: their level already says whether they belong. After the admin adds themselves with Add me, their agents
work there from the next call.

**Membership.** Owners and admins manage members. Only an owner
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
  `FOR SHARE`, and the target project's
  row and every grant row of the actor (and of an agent's owner) on that project
  `FOR SHARE`. The changes take conflicting locks: `grantProject` and
  `revokeProjectGrant` lock the project row `FOR NO KEY UPDATE` first and the grant
  row `FOR UPDATE`; `changeRole` and `removeMember` lock the member row `FOR UPDATE`
  (and delete it, cascading its grants); `revokeAgent` updates the agent row. So
  either the change commits first and the mutation decides on the new state, or the
  change waits until the mutation has committed. A write never commits after a
  revocation that committed before its decision. The project row is the shared lock
  for every project-dependent decision: it also covers access that has no grant row
  to lock, such as a space becoming restricted. `FOR NO KEY UPDATE` conflicts with `FOR SHARE`
  (so it serializes with deciding writers) but not with the `FOR KEY SHARE` that
  foreign-key checks take, so inserting maps or events into the project is not
  blocked by it. A future project visibility change must take the same lock.
- **Reads are not locked.** A single-object read and each statement of a list (the
  count and the page are separate statements) see a consistent snapshot of committed
  rows as of that statement. A change that commits between the count and the page
  of one request can make them differ by that change. Nothing is cached, so the next
  request, event delivery or job step always evaluates fresh.

`app/tests/app/access-policy.test.ts` checks both orders on two real PostgreSQL
connections, detecting the wait with `pg_blocking_pids` rather than timing. The
cases are: revoking the contributor grant of an agent's owner; changing the member to guest; and
removing the member. In each case, a change that starts after an update decided waits
until the update commits. An update that starts while the change is uncommitted waits,
and is then refused with `404` or `403` without writing.

## Actions

| Resource | Actions |
| --- | --- |
| workspace | `workspace.read`, `workspace.read_members`, `workspace.manage_members`, `workspace.rename`, `project.create`, `agent.create`, `sketch.create`, `dm.create` |
| project | `project.read`, `project.write`, `project.manage` |
| agent | `agent.read`, `agent.revoke`, `agent.invoke` (only the owning person, while the agent is not revoked; [personal runs](personal-runs.md)) |
| sketch | `sketch.read`, `sketch.write` |
| dm | `dm.read`, `dm.write` |
| assistant_run | `assistant_run.read` (only the run's owner; [personal runs](personal-runs.md)) |

## HTTP API

The routes live in `app/apps/server/src/access/`, one module per capability (`workspaces.ts`, `projects.ts`, `agents.ts`) registered by `routes.ts`; domain errors and a missing session are mapped once, on the API's root, by `app/apps/server/src/http/errors.ts` (#85). Paths and wire types are in
`app/packages/contracts/src/access.ts`. Every route needs a live session
(`401 UNAUTHENTICATED` otherwise), and state changes pass the origin check from
[identity](containers.md#identity-services-and-variables). An object the caller
cannot see answers `404` with a `*_NOT_FOUND` code. A visible object with a
forbidden action answers `403`. Error bodies are `{ error, code }`.

| Method and path | Domain method |
| --- | --- |
| `GET /api/v1/workspaces` | `listWorkspaces` (`POST` `createWorkspace` only on a test deployment, F-037) |
| `GET/PATCH /api/v1/workspaces/:id` | `getWorkspace`, `renameWorkspace` (owners and admins rename the company) |
| `GET/POST /api/v1/workspaces/:id/members` | `listMembers` (each person with `lastActiveAt`, rounded as above; a guest cannot read the list, `workspace.read_members`), `addMember` (by `email` or `userId`) |
| `PATCH/DELETE /api/v1/workspaces/:id/members/:userId` | `changeRole`, `removeMember` |
| `GET/POST /api/v1/workspaces/:id/invites` | `listInvites`, `createInvite` ([invite links](#invite-links-f-035)) |
| `DELETE /api/v1/workspaces/:id/invites/:inviteId` | `revokeInvite` |
| `POST /api/v1/invites/preview`, `POST /api/v1/invites/accept` | `previewInvite` (no session needed), `acceptInvite` |
| `GET/POST /api/v1/workspaces/:id/projects` | `listProjects` (`limit`, `offset`), `createProject` (`name`, optional `visibility`, `ai`, `people`) |
| `GET/PATCH/DELETE /api/v1/projects/:id` | `getProject` (with `ai`, the space's switch), `renameProject`, `deleteProject` |
| `POST /api/v1/projects/:id/leave` | `leaveProject` |
| `PUT /api/v1/projects/:id/ai-policy` | `setSpaceAi` (`state`: `allowed` or `blocked`); answers `{ ai, changed, stopped }` |
| `GET /api/v1/projects/:id/people` | `listProjectPeople` (#117): the people and agents who can read the project now, each with `access`. Needs `project.read`; every candidate's level comes from `evaluateProject`, so removed and revoked principals are left out. Names only the project's audience, never the workspace roster. Each person carries `lastActiveAt` (C-58, #1225), rounded by the server (to the minute under an hour, to the hour under a day, the reader's own day from a day on), and none when they turned it off or have not been active; an agent has none. Only the HTTP read asks for it: the audience the server's other readers use (export, receipts, direct messages, an agent's tools) never carries it. |
| (no `/views`) | A space stores no views (#1043): every space shows Conversation, Tasks, Map and Wiki, so there is no `views` column, no `POST /api/v1/projects/:id/views`, no `project.view_added.v1` and no starting views. |
| `GET/POST /api/v1/projects/:id/grants` | `listProjectGrants`, `grantProject` (create or replace) |
| `DELETE /api/v1/projects/:id/grants/:grantId` | `revokeProjectGrant` |
| `GET/POST /api/v1/workspaces/:id/agents` | `listAgents`, `createAgent` |
| `DELETE /api/v1/agents/:id` | `revokeAgent` |
| `GET /api/v1/stream` (WebSocket) | see [WebSocket stream](#websocket-stream) |

Lists return `{ items, total, limit, offset }`. `total` is counted after visibility
filtering. `limit` is 1–100 (default 50) and `offset` is 0–10000.

**In the web app** ([#188](https://github.com/ColdPhase/flux/issues/188)) these routes back two
places, with no change to the rules above:

- **People** (Settings › Company; #763 PE-1)
  lists the members and roles. Owners and admins add an existing account by email with a role, change roles and remove
  people; anyone leaves. Guests, who may not read the roster, see only their own place. `ACCOUNT_NOT_FOUND` points to an
  [invite link](#invite-links-f-035) for someone without an account (#763 PE-2; Flux sends no invitation email), and
  `ALREADY_MEMBER`, `OWNER_REQUIRED` and `LAST_OWNER` have their own sentences. Owners and admins also create, copy and
  revoke invite links there.
- **Space settings** (a space's ⋯ › Settings, also from the header's faces) hold the name with Change, the people with an
  Admin or Member choice and Remove on each row and **Add people**, the AI switch, **Leave space**, and **Delete space…**
  for its admins, which asks first and names the space. The people are read from the server's grants after each change.
  **New space** is one window: a name, people chosen from the company, the AI switch (on) and Create space.

Every POST and PATCH sends an `Idempotency-Key`, reused when the same change is retried.

**Profile photos** ([F-039](../product/decisions.md), [#1226](https://github.com/ColdPhase/flux/issues/1226)). `PUT /api/v1/me/photo`
(raw PNG, JPEG or WebP bytes, at most 5 MiB) and `DELETE /api/v1/me/photo` change only the signed-in person's own photo; an agent
has none (`403 PHOTO_PEOPLE_ONLY`). `GET /api/v1/people/photos` lists, and `GET /api/v1/pictures/:pictureId/:size` serves, only the photos of
people the caller can see: someone who shares a workspace with them, and for a guest only the people of the spaces the guest is
added to (the members of a space everyone is in, and anyone with a grant on one of the guest's spaces). One condition decides both,
`personSeenBySql` in `app/packages/db/src/repositories/access.ts`; a photo the caller cannot see is a `404`, the same as one that
was replaced or removed.

## Invite links (F-035)

Founder decision 2026-10-31 ([F-035](../product/decisions.md), #763 PE-2). An invite link lets
someone who has no account yet, or one Flux cannot find by address, join a workspace. Flux sends
no invitation email: the owner or admin copies the link and sends it themselves.

**Creating.** `POST /api/v1/workspaces/:id/invites` `{ role, email?, expiresInDays? }` needs
`workspace.manage_members`. `role` is `member`, `guest` or `admin`; `admin` needs the creator to
be an owner (`403 OWNER_REQUIRED`), and `owner` is never offered (`400`). `email` (optional)
locks the link to that address, compared case-insensitively. `expiresInDays` is 1, 7 or 30
(default 7). A workspace holds at most 50 pending links (`409 INVITE_LIMIT`). The answer `201`
is the invite with its `link` (`<FLUX_PUBLIC_ORIGIN>/join#<token>`). The token is in the URL
fragment, so it never reaches a server log or a `Referer`. An `Idempotency-Key` retry answers
the same invite and link.

**The token.** 40 bytes, base64url: the invite id (16 bytes) and the first 24 bytes of
HMAC-SHA256 under a key derived from the identity secret (`FLUX_AUTH_SECRET`). Only
SHA-256 of the token is stored (`workspace_invites.token_hash`); neither the idempotency store nor
any event or log holds it. A database copy alone yields no link. The server can derive a pending
invite's link again, so the People list offers **Copy link** for each one. Rotating the identity
secret invalidates every link.

**Listing and revoking.** `GET /api/v1/workspaces/:id/invites` (owners and admins) lists the
pending links, newest first: role, email lock, creator, created and expiry time, and the link.
`DELETE …/invites/:inviteId` revokes one (`204`; an already used, revoked or unknown one is
`404 INVITE_NOT_FOUND`). Used, revoked and expired links are not listed.

**Opening.** `POST /api/v1/invites/preview { token }` works without a session. It answers the
workspace's name, who invited, the role, the expiry, whether the link is locked to an address
(never the address itself) and whether the workspace is encrypted. An unknown, malformed or
forged token is `404 INVITE_NOT_FOUND`, checked in constant time, so someone without the link
learns nothing. A link that was used, revoked or expired, or whose creator is no longer an owner
or admin able to grant the role, is `410` with `INVITE_USED`, `INVITE_REVOKED` or
`INVITE_EXPIRED` and no workspace detail. For the account that used the link the preview says
`joined`.

**Joining.** `POST /api/v1/invites/accept { token }` needs a session. In one transaction it locks
the workspace row (as `addMember`) and then the invite row, and rechecks everything above. An
email lock that does not match the account's address, or (with single sign-on configured, or
`FLUX_SIGNUP=verified`) an address the account has not verified, is `403 INVITE_WRONG_ACCOUNT`.
Otherwise the lock is only as strong as the install's proof of addresses: with `FLUX_SIGNUP=open`
an account can name any address, exactly as for adding a member by email. Someone already in the
workspace gets `200 { status: "already_member" }` and the link stays unused. Otherwise the
membership is inserted with the link's role, the invite is marked used by this account, and
`workspace.member_added.v1` (`{ userId, role, inviteId }`) is recorded by the person who joined;
the answer is `200 { status: "joined", workspaceId, workspaceName, role, encrypted,
needsUnlockPassword }`. Accepting again from the same account answers `joined` again and writes
nothing; another account gets `410 INVITE_USED`. Accepting has no idempotency row: it is
idempotent by itself.

**An invite joins the company only (F-037, 2026-11-03).** A link names no space (the FT-3
`projectId` of #763 went with F-037); the new member is in Everyone at once and is added to other
spaces from each space's people. In the same transaction the creator gets an Inbox notice
"<name> joined <company>" linking Settings › Company. Settings › Company shows invite links only
without single sign-on: with it, the provider decides who joins.

**Sign-up rules stay as they are.** A signed-out visitor on `/join` is sent to sign in or to
create an account and back. The page keeps the token in that tab's session storage and removes it
from the address and the browser history; a sign-in finished in another tab asks for the link to be
opened again there. With single sign-on and password sign-up closed, the page says the first
single sign-on makes the account (F-024). Creating an account follows `FLUX_SIGNUP` and single sign-on exactly
as without a link: with sign-up closed or verified by mail, the page says what to do. An invite
never opens closed sign-up, never verifies an address and never links an identity.

**Rate limits.** Each API process allows 30 previews and 10 accepts a minute per signed-in person
(or per client address without a session), and 30 creates a minute per person (`429` with
`retryAfterSeconds`). Like the live join limit, this is a guard per process, not a global count.

**Events.** `workspace.invite_created.v1` (`{ inviteId, role }`) and
`workspace.invite_revoked.v1` (`{ inviteId }`) are recorded for the workspace; the email lock is
never in an event.

**Encrypted workspaces (F-030).** Invites, like membership, are metadata (`workspace_invites` is a
content table whose text columns are listed as visible: a role, an address, user ids), and the
invite routes are in `LOCKED_ALLOWED_ROUTES`: listing, revoking and joining work while the
workspace is locked, and creating answers `423 WORKSPACE_LOCKED` then because the command's stored
answer is sealed. The person joins without any key: a member or
guest reads the workspace while it is unlocked, like every member. An admin who joins has no
unlock password until a current holder grants one through the existing
`unlock-password-grants` flow; the join page and the preview say this. AI stays off
(F-029 and F-030 are unchanged).

## Agents have their owner's rights (F-036 AG-3, #855)

There are no agent project grants, standing project policy or requests to let an agent in:
`agent_access_requests`, `assistant_join_requests` and `agent_project_policies` are gone, and
`project_grants` names people only. `POST /api/v1/projects/:id/grants` refuses an agent. OAuth
consent selects which of the owner's projects a local client works in and can never add rights.

There are no standing grants (#859): every action of a local client runs as the agent under the owner's current level,
the connection's consent and the agent's "What it may do", checked inside the action's transaction.

`PATCH /api/v1/agent-connections/:id { mayDo }` sets "What it may do" (`read`, `act`, `ask`). Only
the owner, in their own signed-in session, can; everyone else gets `404`, and a bearer or run token
never reaches it. How each mode behaves is in [personal runs](personal-runs.md).

A local client's changes follow the assistant's: the change log (`assistant_changes`) names a run or, for a
client, its connection. A change that would wait is kept with its exact call and shown in the owner's Inbox, one item
per client; only the owner, in their own signed-in session, approves, edits or skips it, and Approve re-executes the
call with the owner's rights, the connection and the target's version checked again. The client's token has no route
to any of it. `AGENT_ONLY_READS` is the only refusal: a client set to Only read changes nothing, and tells its owner.

## Events

Each mutation also records a row in `events` in the same transaction. The row
carries `workspace_id`, a versioned `kind` (for example `project.created.v1`), the
actor, and identifiers only, never content.

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

**Audience index.** `recordEvent` (`app/packages/core/src/events.ts`) also writes the
event's stream audience in the same transaction: for every member and unrevoked agent
of the workspace it calls `authorizeEvent`, and stores one `event_audience(recipient,
seq, event_id)` row per principal that may read the object at that moment. The
decision runs before the event insert, so it sees the transaction's own change (a
share, a removal) and the seq lock is held only for the two inserts. Rows commit with
their event and therefore in `seq` order. This is write-side work proportional to the
workspace's members and agents; readers never pay for events outside their audience.
Events recorded before migration 0004 have no audience rows and are not replayed.

**The end of a person's access reaches them (#862).** Removing a person from a space (`DELETE .../grants/:id`) and leaving it
(`POST .../leave`) record `project.grant_revoked.v1` for the space's people, decided after the grant is gone, and
`project.access_ended.v1` for the person whose grant went, alone and by name (`recordGrantRevoked`; not when they still open
the space through the company), so their open tabs forget what they kept of the space, drop it from the sidebar and leave an
open place of it for the project list (#592). The stream's final check of a recipient's own audience rows is
`authorizeDelivery`: `authorizeEvent`, or `project.access_ended.v1` for an active person of the company, or
`workspace.access_ended.v1` (below); only the person each was written for has a row of either kind. Like every stream event
it names the kind, the company and the space's id, nothing else.
Audiences and an event looked up by id (a `?cursor=` that is an event id, the return view) still use `authorizeEvent` alone.
Leaving, or being removed from, a company or an encrypted space (`removeMember`, and the encrypted spaces a person leaves
with the company) records `workspace.access_ended.v1` for that person alone, by name (`recordAccessEnded`); `authorizeDelivery`
lets it through from their own row although they are no longer a member, and it names the workspace and nothing else (the
actor is stored, never sent). Their tabs forget every kept answer, read the shell again, and an open place of one of its spaces
lands on the project list. Entering a space also reads the space itself, never a kept answer (`projectShellLoader`, through `GET .../space-shell`, #1109).

**One read per screen (#1109).** `GET /api/v1/projects/:id/space-shell` (the space, its people, sketches, pages and work summary)
and `GET /api/v1/projects/:id/conversation-view` (the newest roots, notices, sources, agents' questions and the roots' work
associations) call each part's own use case with the caller's principal, so every part keeps its own access check; neither reads a
table itself. A refusal of the space (404, 423) is the whole read's answer; a context part the person may not read is `null`, and the
agents' questions are `null` while the space's AI is off (AG-10), as their own route refuses them.

**Someone saw your messages (#862).** The first sight of messages in a space (`POST .../observations` that stores new
observations) records `project.messages_observed.v1` for the authors of those messages who can read the space now, and for
nobody else, so an author's open page reads its "Seen by" then instead of on a timer. It names the space and nothing else;
who saw what is read through the receipts, with today's audience.

The event's object type comes from the first segment of its kind: `workspace`,
`project`, `agent`, `sketch`, `dm` or `assistant_run`. The read action for that type decides delivery:
`workspace.read`, `project.read`, `agent.read`, `sketch.read`, `dm.read` or `assistant_run.read`. Events without a
workspace (the sample fixture) and unknown kinds are never delivered.

## WebSocket stream

`GET /api/v1/stream?cursor=<cursor|eventId>` is implemented in
`app/apps/server/src/stream/index.ts` with `@fastify/websocket` 11.3.1. Wire types are
`StreamMessage`, `StreamEvent` and `StreamReady` in `app/packages/contracts/src/access.ts`.

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
(`human:<id>`) as associated data (`app/apps/server/src/stream/cursor.ts`). Keys are
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

- **Private maps** reach only their author, never workspace owners.
- **Restricted projects** and their maps reach only managers and grantees.
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
does not depend on events the recipient cannot see. `app/tests/app/stream.test.ts`
checks this with 500 hidden events: identical server-side work counters (queries,
rows, `authorizeEvent` calls, from the test-only `GET /api/v1/stream/work` served only with the
fixture token and `FLUX_TEST_FAILURE_INJECTION=true`, #88), identical rows examined in `EXPLAIN ANALYZE` of
both stream queries, and a coarse open→ready timing bound. The remaining shared cost
is global: event writes serialize on the seq lock and the database is shared, so
heavy activity anywhere can slow everyone's writes and deliveries. That is load, not
per-recipient work, and it is not padded to constant time. Each API process relies
on its own `LISTEN` for wake-ups.

**Return view** (#106). "Since you left" (`GET /api/v1/return`) reads the same per-recipient
rows after the person's saved return point, calls `authorizeEvent` again for every event and,
on Home, also applies `visibleFilter` to each project. See [return-view.md](return-view.md).

**Project export** (#123). `GET /api/v1/projects/:id/export` needs `project.manage`
(`evaluateProject`, so an invisible project is `404` and a visible one without manage rights is
`403`). The audience in the export comes from `listProjectPeople`; the rows are read in one
read-only snapshot and never include other projects, DMs or private sketches. See
[export](../operations/export.md).

**Project docs** (#112). Doc reads and writes use the project policy (`evaluateProject`, write
under the access-row lock); an invisible doc is `404 DOC_NOT_FOUND`. The workspace doc list
applies `visibleFilter` before the page and total. `flux:` references resolve only inside the
doc's project, so a doc never shows titles of other audiences. See [docs-wiki.md](docs-wiki.md).

**Search** (#114). `GET /api/v1/search` builds the reader's audiences from `visibleFilter` on every
request and puts them in the WHERE clause of the page and count statements. See [search.md](search.md).

## If-Match preconditions

A versioned update (for example `PATCH /api/v1/sketches/:id`) requires the expected
version. The domain methods enforce this too, not only the HTTP routes.

- Send `If-Match: "<version>"`, or body `expectedVersion`. A bare integer is accepted
  in the header. `*`, lists and a header that disagrees with the body are rejected with
  `400 INVALID_PRECONDITION`.
- Missing: `428 PRECONDITION_REQUIRED`.
- Stale: `409 VERSION_CONFLICT` with `currentVersion` and `current`, the latest object
  as the caller is authorized to read it. The change is not applied.
- Authorization comes first. An invisible object answers `404` whatever the
  precondition, so a precondition never reveals an object.
- Versioned responses (get, create, update) carry `ETag: "<version>"`.

## Idempotency keys

Every POST and PATCH under `/api/v1` access routes, and summary requests, accepts
`Idempotency-Key`: 1–255 visible ASCII characters. The implementation is
`runIdempotent` in `app/packages/core/src/idempotency.ts`, which stores keys through its
`IdempotencyStore` port (`app/packages/db/src/repositories/idempotency.ts`). DELETE routes
and the Better Auth and session endpoints do not take keys.

- **Scope.** A key is scoped by principal, workspace and operation. The operation is
  the method and route pattern, for example `POST /api/v1/projects/:projectId/docs`. The
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
  `workspace.read`; for a project, map or agent it is its read action; for member
  changes it is `workspace.read_members`; for grants it is `project.manage`. If the check fails, the caller gets the
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
  maps in a project that becomes restricted.
- PostgreSQL row-level security as defense in depth.
- Presence and other ephemeral stream messages, retention pruning of `events` (with a
  `reset` signal for cursors older than the retained log), and multi-process fan-out
  measurements.

## Tests

`./scripts/check_application.sh` runs these checks in Docker:

- `app/tests/app/access.test.ts` covers two workspaces and six accounts over HTTP.
- `app/tests/app/access-policy.test.ts` covers agent principals, the
  `authorize`/`visibleFilter` contract and the database constraints directly
  against PostgreSQL.
- `app/tests/app/stream.test.ts` covers replay after a cursor and live delivery for two
  workspaces and three accounts. It checks per-recipient filtering (private maps,
  restricted projects, other tenants), removal of a membership, session revocation
  (close `4401`, then reconnect `401`), the origin and cursor rejections (raw numbers,
  forged cursors, another person's cursor), and the heartbeat. It also checks that a
  member outside a restricted project gets identical cursors and frames, fresh and on
  resume, whether or not restricted and private activity happened.
- `app/tests/app/e2e/access-stream.e2e.ts` runs in Chromium (the `e2e` Playwright
  image) against the running API: three people sign up in their own browser
  contexts, the owner creates a workspace, a restricted project, a member grant and a
  map in the project. The granted member's page `WebSocket` receives the
  creation and its `fetch` reads the map; a non-member gets `404`. After the grant is
  revoked, the member's open socket receives a later visible event but nothing for
  the map, and the read is `404`. The web app is still the placeholder shell, so
  the pages use same-origin `fetch` and `WebSocket` rather than UI screens. Evidence
  from one run is in [`evidence/29-browser/`](evidence/29-browser/).
- `app/tests/app/worker.test.ts` covers the Compose worker committing a result. Using the
  `afterRead` hook, it also covers denial before read and the race of a revocation
  between read and commit. It covers grant revocation on two connections in both orders:
  a revoke that starts during the commit waits and the result commits, and a revoke
  that is uncommitted when the commit starts makes the worker wait and then deny.
- `app/tests/app/safe-writes.test.ts` covers `If-Match` (428, 409 with an unchanged row,
  `ETag`) and idempotency keys (replay, one row, 422 on reuse, scope, concurrent
  duplicates, expiry and cleanup). It also covers replays after lost access: a demoted
  admin replaying a restricted project creation, and map create and rename replays
  after the person was removed from the company. Both get `404` without the stored body.

### Agent owner labels (F-026, #339)

The existing project audience read (`GET /api/v1/projects/:id/people`) may
include `agentOwner` on an agent. A workspace agent has `{ kind: 'workspace' }`.
A human owner is named only when that human is already in the same current,
authorized project audience. This projection never lists the workspace roster
for a guest and excludes revoked agents and agents of people without access under the existing policy.
The web owner lookup uses this project read, with no module cache; pending
answers are scoped to account/project and aborted on scope changes or access
events. Failed reads clear labels and retry on the next visit, focus, online
event or authorized stream change. A connected session and a recently
completed action alone leave the agent idle; active-run/claim integration is
still required by #347 and does not come from an activity time heuristic.

Native work rows that the overview and task details present (`/work-view`,
`/work-reference-rows`, `/work-objects/:kind/:id`) carry an optional
`projectOwner` on each agent principal (`owner`, `createdBy`, `proposedBy`), with
the same boundary as preserved message history (#339 AC-2, 2026-10-10): a
workspace-owned agent is `{ kind: 'workspace' }`, a self-owned agent names its
human owner only while that person is in the current audience, and a revoked
agent keeps its name and Agent tag while an owner who lost access is omitted.
The browser looks the relation up in its own fresh audience and never infers an
owner from a roster. The same relation is added to the last-change author of a
project doc in `GET /api/v1/projects/:id/docs` (`updatedBy`) and to the creator of
a project sketch in `GET /api/v1/workspaces/:id/sketches?projectId=` (`createdBy`);
both use one bounded `projectAuthorOwners` read per page and project, and sketches
outside a project never carry it.

### Message references and file details (#469, F-026 §6)

A message cites a map thought through `references: [{ kind: 'thought', id }]` on
`POST /api/v1/projects/:id/conversations`, `POST /api/v1/conversations/:id/messages`,
`POST /api/v1/work/:id/discussion` and the direct-message sends (`POST /api/v1/dms/:id/messages` and its thread
replies). At most four, distinct, each a UUID. (A message was citable too, through a `message` kind, until #867 removed the Cite
action: the kind is refused now, and no row of it is read.) Migration 0122 stores only the kind and the id (`message_references`, owned by the citing message and
removed with it); nothing of the target is copied, so a title, an author or a place never outlives the target's own
audience.

- **At send** the sender must be able to read every target now (`sketch.read` through the one
  policy), and the target must be in the message's own workspace. Anything else (absent, unreadable, another workspace's,
  a private sketch of someone else's) answers the same `404 REFERENCE_UNAVAILABLE`, so the answer tells nothing about the
  target. A retry with the same `clientMessageId` and the same references replays; other references under it are `409`.
- **At every read** each card is made for the reader who asks, after that reader's access to the target is decided
  again. A target the reader cannot open now, one that no longer exists and one removed from its map are the same
  `{ kind, state: 'unavailable' }` card, with no id, title, author or place. An available card carries the title (the
  first line of the thought or message), the author, the time, the place (project, sketch or "Direct message") and a
  `target` that is exactly what a search result of the same object opens. Agents never read a direct message, so
  such a card is unavailable to them. Locked or sealed workspaces keep their own gates: a reference adds no route.
- A message that cites nothing has no `references` key, so every earlier message's JSON is unchanged.

Files carry `pages` (a PDF's page tree), `rows` (the data rows of a CSV or TSV, the header line excluded) or `durationMs`
(WAV, MP3, MP4/M4A/MOV, Ogg/Opus/Vorbis and WebM with a stored duration) when the bytes say so. They are read from the
plaintext as the upload arrives and stored with the file (`project_files.page_count`, `row_count`, `duration_ms`), on
`StagedFile` and on every `MessageFile`; a name alone never sets one, and a file whose bytes do not say shows none.

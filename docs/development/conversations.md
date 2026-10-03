# Project capture and conversation backend (#36)

**Later required amendment, 2026-09-30:** [UI116-3](../design/studio-v11.6.md#one-announcement-then-the-real-discussion--ui116-3)
separates one task-created system notice from the first true contribution/root,
retains the same one-level thread across all views, and preserves history and
private helper prompts. [#154](https://github.com/ColdPhase/flux/issues/154) owns implementation; current code below is not
claimed to satisfy the new semantics. [UI116-5](../design/studio-v11.6.md#subtle-motion-and-truthful-typing--ui116-5)
adds scoped ephemeral typing without durable messages or notification/model effects.

The current slice stores project conversations, direct text replies and versioned
project materials. A signed-in person with contributor access can send from the
current project without
creating a draft. `POST /api/v1/projects/:projectId/conversations` starts a thread
with its first message; `POST /api/v1/conversations/:id/messages` replies in it.
Both take `{ "body": "…", "clientMessageId": "<UUID>" }` and may cite
`{ "source": { "materialId": "<UUID>", "version": 1 } }`. The UUID must be
reused for a retry of the same send. Reusing it for different content returns 409.
Messages carry a sequence, author and the project audience. A message made by an explicit task
effect (a saved blocker, a published result or a public handoff, #154) also carries `contribution`
(`{ kind: 'blocker' | 'handoff' }` or `{ kind: 'result', resultId }`); ordinary text omits it. All reads and writes
recheck the current project access policy; writes do so under a transaction lock.

`POST /api/v1/projects/:projectId/materials` takes an explicit title, body or
HTTP(S) URL, and `clientMutationId`. A private draft can be a provenance source
with `sourceDraftId` and `sourceDraftVersion`; the caller must explicitly provide
the selected or redacted public content. The draft is never copied implicitly.
Only its author sees the source draft reference in material responses. `PATCH
/api/v1/materials/:id` requires `expectedVersion` and `clientMutationId`. Retry
the exact edit with the same UUID after a lost response: it returns the original
committed revision, even if a later edit has advanced the material. Reusing that
UUID for other content returns 409. A fresh edit against an old version returns
`STALE_MATERIAL` (409). Every edit creates an immutable `GET
/api/v1/materials/:id/versions/:version` snapshot. A reply cites that snapshot
even after later edits. Existing draft updates also retain private version
snapshots in PostgreSQL. They are not public API resources.

**Docs (#112)** are project materials of kind `doc` that reuse these immutable version
snapshots; see [docs and wiki](docs-wiki.md). A message can cite a doc version like any material
version. The materials list excludes docs, and `PATCH /api/v1/materials/:id` on a doc is
`409 USE_DOC_API`. Since #112 the database rejects any `UPDATE` of a version row.

Collection reads use `?limit=1..100&offset=0..10000` and count only material in
the authorized project. `GET /api/v1/conversations/:id` returns the newest 50
messages by default, in ascending display order. `?limit=1..100` changes the
window size; `?beforeSequence=<positive integer>` fetches the next older window.
Use `messagePage.nextBeforeSequence` while `hasMoreBefore` is true. Sequence
cursors stay stable as new replies arrive. Authorized project refresh events are
described below. Direct messages reuse this message model outside projects; see
[direct-messages.md](direct-messages.md). Many-to-many links remain outside this slice.

Clean start and verification use Docker only:

```sh
cp docker/.env.example docker/.env
# Set the required local secrets in docker/.env, then:
docker compose --env-file docker/.env -p flux-conversation -f docker/compose.source.yaml up -d --build db migrate
docker compose --env-file docker/.env -p flux-conversation -f docker/compose.source.yaml --profile setup run --rm files-init
docker compose --env-file docker/.env -p flux-conversation -f docker/compose.source.yaml up -d --wait api
FLUX_TEST_PORT=18136 FLUX_TEST_MAILPIT_PORT=18137 scripts/check_application.sh
```

The script creates its own isolated Compose project, builds, typechecks, lints,
runs API/PostgreSQL integration tests and restarts the API to verify a session,
material and linked conversation survive. It removes only its own test volumes.

## Stacked web surface (#36)

The project conversation UI is developed on `codex-hubert/36-ui-integration`,
combining the backend and approved app-shell PR #55 head `430bbd4`. It must be
reconciled after #15/#55 merge and independently reviewed at one pinned head.
The shell loads only
projects that the current person can see, and a selected project route loads its
conversation and materials under the current session. A revoked project route
returns an error instead of keeping old server content on screen. The active
composer draft is kept per signed-in user and conversation in session storage;
its pending command and UUID survive a reload or view switch after a failed send,
until the message text or material citation changes. Starting a conversation and
replying cannot reuse one another's UUID. A published
material from a private draft uses the chosen draft version and the exact edited
public text. The private draft stays separate.

Home captures are server-backed private drafts when a space exists. With no space,
Home explicitly labels browser-only notes. People with several spaces select the
space for a new private draft. The project setup route asks for a space name when
there is none; it does not silently create an administrative boundary. UI project
creation currently uses a restricted audience. Member invitation and access
management remain through the #29 API; a full in-app invitation surface is still
needed before the two-person journey is discoverable without API setup.

Browser verification runs in the isolated Compose UI profile. `scripts/check_ui.sh`
builds the app and Playwright image, then runs all `app/tests/ui/test_*.py` through
unittest discovery. Set `FLUX_UI_PORT`, `FLUX_UI_MAILPIT_PORT` and optionally
`FLUX_UI_SCREENSHOT_DIR` to avoid other active projects. The #36 browser journey
covers real two-user sending, private draft reload, selected redacted publication,
version citation, lost-response retry without a duplicate, phone draft retention,
and denial after revocation. Backend database rows and restart are covered by
`./scripts/check_application.sh`.

## Authorized project refresh events (#36 + #47)

A committed conversation start, reply, material publication or material revision
records exactly one project-scoped event in the same PostgreSQL transaction:
`project.conversation_created.v1`, `project.message_sent.v1`,
`project.material_created.v1` or `project.material_updated.v1` respectively.
The event's `object_id` is the project id. Its `data` holds identifiers only: `{
conversationId, messageId }` for conversation and message events and `{ materialId, version }`
for material events (added for the [return view](return-view.md), #106). The stream frame
carries the kind, project id and workspace id, and never `data`. Neither ever holds message
text, a material title/body/URL, a private draft id or a client mutation key. A client
with current project access may refetch the conversation/material HTTP endpoints.
The first message is included in `conversation_created`; there is no second event
for that initial message. Idempotent retries return the original result without a
new event. `recordEvent` writes the recipient index after the mutation, while the
transaction's access locks are held; stream delivery and replay recheck current
project rights. The UI currently refreshes by polling/route revalidation and does
 not yet subscribe to the stream.

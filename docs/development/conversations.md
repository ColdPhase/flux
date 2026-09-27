# Project capture and conversation backend (#36)

The current slice stores project conversations, direct text replies and versioned
project materials. A signed-in member can send from the current project without
creating a draft. `POST /api/v1/projects/:projectId/conversations` starts a thread
with its first message; `POST /api/v1/conversations/:id/messages` replies in it.
Both take `{ "body": "…", "clientMessageId": "<UUID>" }` and may cite
`{ "source": { "materialId": "<UUID>", "version": 1 } }`. The UUID must be
reused for a retry of the same send. Reusing it for different content returns 409.
Messages carry a sequence, author and the project audience. All reads and writes
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

Collection reads use `?limit=1..100&offset=0..10000` and count only material in
the authorized project. `GET /api/v1/conversations/:id` returns the newest 50
messages by default, in ascending display order. `?limit=1..100` changes the
window size; `?beforeSequence=<positive integer>` fetches the next older window.
Use `messagePage.nextBeforeSequence` while `hasMoreBefore` is true. Sequence
cursors stay stable as new replies arrive. Server events, DM and many-to-many
links remain outside this backend slice.

Clean start and verification use Docker only:

```sh
cp .env.example .env
# Set the required local secrets in .env, then:
docker compose -p flux-conversation -f infra/compose.yaml up -d --build db migrate
docker compose -p flux-conversation -f infra/compose.yaml --profile setup run --rm files-init
docker compose -p flux-conversation -f infra/compose.yaml up -d --wait api
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
its UUID is retained across a failed send until the command changes. A published
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
builds the app and Playwright image, then runs all `tests/ui/test_*.py` through
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
The event's `object_id` is the project id and its `data` is `{}`. The stream frame
therefore carries the kind, project id and workspace id, never message text,
material title/body/URL, a private draft id, or a client mutation key. A client
with current project access may refetch the conversation/material HTTP endpoints.
The first message is included in `conversation_created`; there is no second event
for that initial message. Idempotent retries return the original result without a
new event. `recordEvent` writes the recipient index after the mutation, while the
transaction's access locks are held; stream delivery and replay recheck current
project rights. The UI currently refreshes by polling/route revalidation and does
 not yet subscribe to the stream.

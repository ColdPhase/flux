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
/api/v1/materials/:id` requires `expectedVersion`, and every edit creates an
immutable `GET /api/v1/materials/:id/versions/:version` snapshot. A reply cites
that snapshot even after later edits. Existing draft updates also retain private
version snapshots in PostgreSQL. They are not public API resources.

Collection reads use `?limit=1..100&offset=0..10000` and count only material in
the authorized project. The current conversation detail returns its full ordered
message history; pagination and server events for larger threads remain future
work. DM and many-to-many links are outside this backend slice.

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

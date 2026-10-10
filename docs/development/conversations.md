# Project capture and conversation backend (#36)

**Later required amendment, 2026-09-30 (UI116-3; drawn as rule P5 of the [final design](../design/final/README.md#5-behaviour)):**
separates one task-created system notice from the first true contribution/root,
retains the same one-level thread across all views, and preserves history and
private helper prompts. [#154](https://github.com/ColdPhase/flux/issues/154) owns implementation; current code below is not
claimed to satisfy the new semantics. UI116-5 ([motion and agent states](../design/final/README.md#3-kreska-logo-agent-icon-and-mascot))
adds scoped ephemeral typing without durable messages or notification/model effects.

**One project conversation, 2026-10-02 (UI116-1):** see the [final design's structure](../design/final/README.md#4-structure-and-navigation).
The UI presents a project's stored conversations as one stream: each conversation's
opening message (sequence 1) is a root, and its later messages are that root's
one-level thread. Storage, commands and URLs are unchanged; see
[the stream and its threads](#one-stream-of-roots) below.

The current slice stores project conversations, direct text replies and versioned
project materials. A signed-in person with contributor access can send from the
current project without
creating a draft. `POST /api/v1/projects/:projectId/conversations` starts a thread
with its first message; `POST /api/v1/conversations/:id/messages` replies in it.
Both take `{ "body": "…", "clientMessageId": "<UUID>" }` and may cite
`{ "source": { "materialId": "<UUID>", "version": 1 } }`. The UUID must be
reused for a retry of the same send. Reusing it for different content returns 409.
Messages carry a sequence, author and the project audience. An agent starts or replies only under
its owner's standing grant over MCP (#152, [agent connection](agent-connection.md#project-wiki-docs-and-conversations));
its messages carry `authorId: null` and `author: { kind: 'agent', … }`. A message made by an explicit task
effect (a saved blocker, a published result or a public handoff, #154) also carries `contribution`
(`{ kind: 'blocker' | 'handoff' }` or `{ kind: 'result', resultId }`); ordinary text omits it. All reads and writes
recheck the current project access policy; writes do so under a transaction lock.

**Agent owner display in preserved history (#339, 2026-10-08).** Revoking an agent's
grant does not remove its past messages or add it back to the current audience.
The authorized conversation/root read may add `author.projectOwner`: either
`{ kind: 'workspace' }` or `{ kind: 'human', id }`. This optional display metadata
is resolved only for actual agent authors in the bounded message window, within
that project's workspace. A human owner is exposed only if that person currently
is a member of that workspace and currently has project read access, using the
same candidate and policy boundary as the authorized project audience. It contains no private profile or stored display name;
human message JSON, write receipts, stored authors and retry identity stay unchanged.
The browser resolves the name only from its fresh, scoped authorized project
audience. Failed/obsolete reads, changed accounts and lost owner access clear the
relation; an old message never restores a cached name. Workspace ownership is
displayed only after the same scoped audience read succeeds. Hidden owner identity
is omitted, rather than inferred from email or an unrelated workspace roster. The same
relation applies to agent principals of native work rows (`owner`, `createdBy`,
`proposedBy`) in the overview and task details; see
[access policy](access-policy.md#agent-owner-labels-f-026-339).

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

## One stream of roots

This retains the one-project-stream functional contract. Current composition follows
[F-026 navigation and panels](../design/final/README.md#4-structure-and-navigation), with
task announcements governed by [P5](../design/final/README.md#5-behaviour).

`GET /api/v1/projects/:projectId/conversation-roots` returns the project's roots
for the Conversation tab: `{ projectId, roots, rootPage }`. Each root is
`{ conversationId, message, replyCount, lastReplyAt }`, where `message` is the
sequence-1 message with its true author, time, source and contribution, and
`replyCount` counts the later messages of that conversation. The window is the
newest `?limit=1..100` roots (default 50) in ascending display order, ordered by
the conversation's `(created_at, id)`. `rootPage.nextBefore` is a conversation id;
pass it as `?before=<conversationId>` while `hasMoreBefore` is true. The cursor is
compared in PostgreSQL, so a root started between two reads never shifts or
repeats an older window. A `before` that is not a conversation of this project is
`400`. Current project read access, the cursor, the counts and the page are read
from one snapshot (a read-only repeatable-read transaction, without row locks,
[#298](performance-2026-10.md)), so a revoke committed meanwhile cannot leave a
partly authorized window; every root shares the project audience, so nothing is
filtered after the page is cut. Readers who lost
access get `404`, like every other conversation read.

The browser starts a root with the existing `POST
/api/v1/projects/:projectId/conversations` and replies with `POST
/api/v1/conversations/:id/messages`, both idempotent with `clientMessageId`.
`/projects/:projectId/conversations/:conversationId` (with an optional
`#message-<id>`) opens the stream at that root, reading older windows back when
needed, with its thread open beside it on a wide sheet or as a full sheet on a
phone. Every existing producer of these URLs (notifications, search, "Since you
left", What matters, task and doc sources, comparison sources, live invitations)
therefore keeps working unchanged. The personal assistant is asked from a thread
and answers there; its answers are not counted in `replyCount`.

## Instant sending and the offline queue (#264, 2026-10-06)

Apple HIG evaluation findings 4 and 13 on [#264](https://github.com/ColdPhase/flux/issues/264)
(HIG-59, HIG-66, HIG-67, HIG-69, HIG-71 in the [checklist](../design/apple-hig-mobile.md)).
This applies to every composer that publishes a message: the stream's root composer, the
reply thread, a task's discussion (thread, Tasks/Map Details and Agents) and direct messages.
Private assistant prompts keep their own send path.

- **Send moves the message out of the field.** Send (or Enter) freezes the draft's text,
  files and source with its existing `clientMessageId` into a per-composer queue, kept in the
  same browser record as the draft (`pending`), and empties the field at once. The message
  shows immediately at the end of its stream or thread, as the person's own message marked
  "Sending…" (or "Uploading…" while one of its files is still uploading), announced once in a
  polite live region. A second tap finds an empty draft, so it posts nothing.
- **Confirmation swaps in place.** When the server confirms, the queued message is replaced by
  the stored message in the same render, keeping the same list item, so nothing is shown
  twice and nothing moves. A refreshed copy that arrives before the response hides the queued
  one. No success message is shown (HIG-69).
- **One command per message.** Every attempt for a queued message reuses its
  `clientMessageId`, so retries, reloads, other tabs and automatic resends store it once; the
  server's idempotency rule is unchanged. Messages of one composer are sent one at a time in
  the order they were sent.
- **Not sent.** When the server answers with an error, the message stays in place marked
  "Not sent" (an alert) with **Retry** and **Remove**. Retry sends the same command again.
  Remove takes it out of the conversation and, when the field is empty, puts its text, files
  and source back into the field with the same command (a later edit gives it a new one).
  When the field already holds other text, Remove keeps the message and says "Send or clear
  your text first, then remove it to edit it", so nothing is lost. Remove only affects this browser: a message
  whose answer was lost may already be stored, and then it still appears with the next read.
  An error that a retry cannot fix (`400`, `401`, `403`, `404`, `409`, `413`, `422`) returns
  the message to an empty field at once with the existing explanation, so its files and
  source can be fixed there; the draft is restored only when sending fails.
- **Offline.** The browser being offline (`navigator.onLine` and its events) or a send or
  upload failing to reach Flux shows one quiet line above the composer ("You’re offline. Messages send when you’re back." or, when the browser is
  online but Flux does not answer, "Flux isn’t responding. Messages wait here and send when it’s back."). Messages sent then, and a send that could not reach Flux, wait
  in the queue marked with a clock and "Waiting to send" (F-026). When the browser is back online, or a light
  check of `GET /api/v1/me` gets any answer (every 3 s, slowing to 30 s, only while Flux is
  unreachable), the waiting messages are sent automatically in their order with their
  original `clientMessageId`s. A send or upload under way when the browser goes offline
  also reads "Waiting to send". The stream reads again only after Flux has answered
  (a delivered send or the check): a Retry or the browser's `online` event alone never
  reloads the page, so an unreachable Flux cannot replace the conversation with an error
  page. With a stream and a thread open, the line shows once.
- **Reload.** A queued message survives a reload with its command; one whose outcome was
  unknown is sent again (idempotently) when its composer opens. The record follows the
  draft's storage and sign-out rules: `localStorage` per account, project and context for
  project composers, `sessionStorage` for direct messages (their drafts stay in the tab).

## Stacked web surface (#36)

The project conversation UI is developed on `codex-hubert/36-ui-integration`,
combining the backend and approved app-shell PR #55 head `430bbd4`. It must be
reconciled after #15/#55 merge and independently reviewed at one pinned head.
The shell loads only
projects that the current person can see, and a selected project route loads its
conversation and materials under the current session. A revoked project route
returns an error instead of keeping old server content on screen. The active
composer draft is kept per signed-in user and conversation; a sent message waits
in its queue with its command and UUID until it is confirmed (see [Instant sending
and the offline queue](#instant-sending-and-the-offline-queue-264-2026-10-06)), and
a draft returned after a failed send keeps that UUID until its text, files or
citation change. Starting a conversation and replying cannot reuse one another's UUID. A published
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

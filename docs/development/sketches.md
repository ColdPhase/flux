# Sketches

Issue #69 (foundation 8.4). A sketch is a map of connected thoughts. People put
thoughts down, link them, move them around and edit them in place. Nothing on a map
has to become work.

A sketch belongs to a project, to one direct message (see
[below](#sketches-in-a-direct-message), #96), or is private to its creator. No sketch has a
participant list of its own.

## Model

| Table | Holds |
| --- | --- |
| `sketches` | One map in a workspace. `scope` is `project` (with `project_id`) or `private` (owned by `created_by_user_id`, never by an agent). It also has a title and a version. |
| `sketch_thoughts` | The text, an integer position (`x`, `y`), a size (`width`, `height`), a `shape` (`card`, `pill`, `circle`), an optional placement, and a version. |
| `sketch_links` | An undirected link between two thoughts of the same sketch, with an optional label. There is one link per pair; a thought links to any number of others. |

Composite foreign keys keep every thought and link inside the sketch's
workspace and sketch. A placement (`placement_type`, `placement_id`, only `draft`
today) names an existing object shown on the map. It deliberately has **no foreign key
or cascade**. Removing the thought removes only the placement, never the draft (and
later the task or thread) behind it. A placement is created only for an object the
caller can read in the same workspace (`404` or `422 CROSS_WORKSPACE`). The title of a
placement is returned only to readers who can open the object now; for anyone else it
is `null`.

Migrations `0007_sketches.sql` and `0025_dm_sketches.sql` (#96). `infra/migrate.ts` applies
every unapplied file in order and checks that the highest version equals `FLUX_SCHEMA_VERSION`
(25; 0021–0024 are reserved by the open PR #124, so the sequence has a gap until it lands).

## Access

This uses the #29 policy in `packages/core/src/access/policy.ts`. It adds the
`evaluateSketch` action (`sketch.read`, `sketch.write`), the `visibleSketchesSql` list
condition returned by `visibleFilter(…, 'sketch')`, and `sketch.create` on the
workspace. The rules are in [access-policy.md](access-policy.md#rules). Invisible
sketches answer `404`, and visible sketches the caller may not change answer `403`.
Changes lock the sketch row (`FOR NO KEY UPDATE`), so changes to one sketch run one at a
time. They also lock the project access rows or the caller's participation, so a
concurrent revocation is either seen or waits.

## Clean Architecture

- `packages/core/src/sketches/` holds the use cases (`createSketchUseCases`) and their
  ports: `SketchAccess`, `SketchRepository`, `SketchEventLog` and `SketchUnitOfWork`.
  It imports only `@flux/contracts`, the domain errors and `principal.ts`. It never
  imports Drizzle, `@flux/db` or pg-boss (`tests/app/architecture.test.ts` also follows its relative imports).
- `packages/core/src/access/sketch-access.ts` is the policy adapter for `SketchAccess`.
  It imports no persistence library itself; its SQL reaches it only through the existing
  `policy.ts` import chain, which the [architecture rules](architecture.md#known-debt)
  already record. No allowlist entry was added.
- `packages/db/src/repositories/sketches.ts` holds the rows. It makes no access decisions;
  lists take the policy's condition from the caller.
- `apps/server/src/sketches/` holds the adapters: the unit of work, the `visibleFilter`
  composition and `recordEvent`. It also holds the thin Fastify routes. The shared
  If-Match and Idempotency-Key plumbing is in `apps/server/src/http/commands.ts`.

## HTTP API

| Route | Notes |
| --- | --- |
| `GET /api/v1/workspaces/:id/sketches?projectId=` | Returns a page of visible sketches, newest change first. The filter is applied before the limit and the total. |
| `POST /api/v1/workspaces/:id/sketches` | Takes `{ title, scope: 'project' \| 'private', projectId? }`. |
| `GET /api/v1/sketches/:id` | Returns the sketch with its thoughts and links. The ETag is the sketch version. |
| `PATCH /api/v1/sketches/:id` | Renames the sketch. Needs `If-Match`. |
| `POST /api/v1/sketches/:id/thoughts` | Accepts an optional client `id` (used when undo restores a thought), an optional `placement`, and an optional `linkFrom` (the "+" beside a thought: the thought and its link are created atomically). |
| `PATCH /api/v1/sketches/:id/thoughts/:thoughtId` | Changes text, position, size or shape. Needs `If-Match`: `428` when missing, `409 VERSION_CONFLICT` with the current thought when stale. |
| `DELETE /api/v1/sketches/:id/thoughts/:thoughtId` | Removes the thought and its links. Needs `If-Match`. |
| `PATCH /api/v1/sketches/:id/positions` | Moves several thoughts all or nothing. `{ moves: [{ id, x, y, expectedVersion }] }`. Any stale move answers `409` with `conflicts`, and nothing moves. |
| `POST /api/v1/sketches/:id/links` | Takes `{ id?, fromId, toId, label? }`. Answers `409 LINK_EXISTS` for a pair that is already linked (in either direction) and `422 SELF_LINK` for a thought linked to itself. |
| `DELETE /api/v1/sketches/:id/links/:linkId` | Removes one link. |

Every change accepts `Idempotency-Key`: a retry replays the stored answer after
re-authorization. Concurrent moves of **different** thoughts never conflict, so they
merge. Moves of the **same** thought conflict (`409`); the web client then reapplies
the person's move on the current version.

## Events

Each committed change records exactly one event: `sketch.created.v1` or
`sketch.changed.v1`, with `data.op` and the affected thought and link ids, and never
text. The event carries `object_id` = the sketch. Its audience is decided with
`sketch.read` in the writing transaction, and delivery re-checks it. Nobody but its
author receives the events of a private sketch. The stream's `objectType` is `sketch`.

## Web

- `/map` is the Map tab. It lists the sketches you can see and has **New sketch**,
  which creates a private sketch. If you have no workspace yet, it first creates a
  personal one.
- `/map/:sketchId` is the sketch (direction C `#lamp-map`, `-select`, `-edit`,
  `-list`). The toolbar has Thought, Connect, Shape, Remove and Undo, plus a status line.
  - The map is a canvas with a visible **+** beside the selected thought.
  - Pointer: drag to move (the selection moves together), Shift-click to select
    several, drag empty space to pan, and zoom with Ctrl/⌘-wheel or the corner controls.
  - Keyboard: arrows move (Shift for bigger steps, Alt to resize), Enter edits, Space
    selects, `+` adds a connected thought, Delete removes, and Ctrl/⌘ Z undoes.
  - Selecting or dragging never opens a panel.
  - **List** shows the same thoughts in reading order with their links. It is the
    accessible alternative and has the same keys. The choice is remembered.
  - Phone and tablet: tap to select, then drag. Touch targets are 44 px, and there is
    no horizontal page scroll.
- `apps/web/src/sketch/doc.ts` applies changes locally at once and sends them in order.
  Each change carries its own Idempotency-Key and the last server-confirmed version as
  If-Match. Undo sends inverse operations. When a stream event arrives for the open
  sketch, the client refetches it once nothing is in flight.
- Motion: thoughts ease between positions (`--dur-2`) and new ones fade in. All
  durations come from the tokens, which are 0 ms under reduced motion.

Out of scope: AI rearranging sketches.

## Sketches in a direct message

Issue [#96](https://github.com/ColdPhase/flux/issues/96), the "DMs and growing an idea" flow of
[#44](https://github.com/ColdPhase/flux/issues/44) and design principle 5.

**Model** (migration `0025_dm_sketches.sql`):

- `sketches.scope` gains `dm`, with `dm_id`. The composite foreign key
  `(workspace_id, dm_id) → dms(workspace_id, id)` uses `ON DELETE CASCADE`. There is no copied
  participant list, so the audience is always the DM's `dm_participants` rows. A DM sketch is
  created by a person, never by an agent.
- A thought can have a **source**: `source_author_id`, `source_author_name` and
  `source_sent_at`. Inside the DM it also has `source_dm_id` and `source_message_id`. Two
  composite keys make the message belong to the sketch's own DM:
  `(source_dm_id, source_message_id) → dm_messages(dm_id, id)` and
  `(sketch_id, source_dm_id) → sketches(id, dm_id)`.
- A project copy records `copied_from_sketch_id` (`ON DELETE SET NULL`), `copied_by_user_id`
  and `copied_at`. The wire type exposes only `origin: { kind: 'dm_copy', copiedBy, copiedAt }`.
  The copy never names the DM.

**Access** (`evaluateSketch` and `visibleSketchesSql` in `policy.ts`):

- `sketch.read` needs a current participant row for the caller. Owners, admins, agents,
  members outside the DM and other workspaces get `404`. The row is excluded before the list
  count as well.
- `sketch.write` also needs the DM to be open (`dmClosedFor`). In a 1:1 whose other person left
  or was removed, the remaining person can still read the sketch, but changes answer `403`.
  Starting a sketch or a promotion answers `409 DM_RECIPIENT_LEFT` or
  `DM_RECIPIENT_UNAVAILABLE`, with the #107 wording. Nobody is re-added on the other person's
  behalf; only they can reopen the DM.
- Changes lock the caller's participant row `FOR SHARE` after the sketch row. A concurrent leave
  (which deletes the row) or membership removal (which cascades to it) is either seen or waits.
- Leaving or removal ends access on the next request. Events are delivered only after
  `sketch.read` is checked again, so live frames and replay from an older cursor skip the
  person who left.

**Start sketch from these messages.** `POST /api/v1/workspaces/:id/sketches` with
`{ title, scope: 'dm', dmId, fromMessageIds? }` accepts up to 50 messages of that DM (`404
MESSAGE_NOT_FOUND` otherwise). Each message becomes one thought, in conversation order and laid
out in staggered columns. Its text is the message body (clipped to the thought limit) and its
source names the author and time. It honours `Idempotency-Key`. `POST …/thoughts` accepts
`sourceMessageId`, so undo restores a removed thought with its source. The server reads the
author and time from the message itself. `GET …/sketches?dmId=` lists one DM's sketches.

**Promotion into a project.**

- `GET /api/v1/sketches/:id/promotion[?target=new|?projectId=]` changes nothing. It returns
  `SketchPromotionPreview`:
  - `audience`: everyone who could open the copy.
    - For a new project (owners and admins only, `project.create`), the project is
      restricted and granted to exactly the participants. Its readers are the participants and
      the workspace's owners and admins, who manage every project.
    - For an existing project the caller can change (`project.write`; a viewer gets `403`), the
      readers are `listProjectPeople`.
  - `leftOut`: participants who would not see the copy.
  - `content`: thoughts, links, and how many thoughts came from messages.
  - `staysInDm`: the messages not quoted.
  - `token`: a hash of the target, the readers and every thought id, version and link id.
- `POST /api/v1/sketches/:id/promotion` takes `{ target, token }` and `Idempotency-Key`. It runs
  in one transaction. When the token no longer matches (a reader, a thought or a link changed),
  the answer is `409 PROMOTION_CHANGED` with the new preview, and nothing is created.
  Otherwise it:
  1. creates the project through `createProject` and `grantProject`, for a new target;
  2. inserts a `project` sketch with copies of the thoughts (text, position, size, shape and the
     source's author and time) and of their links;
  3. records `sketch.created.v1` for the copy and `sketch.changed.v1 { op: 'copied_to_project' }`
     for the DM sketch.
- **The audience is locked at commit.** Before evaluating the sketch, the promotion takes the
  rows that every change to the copy's audience locks first, `FOR SHARE`:
  - the workspace row, which `lockWorkspace` takes for member adds, removals and role changes;
  - for an existing target, the project row, which grant changes lock `FOR NO KEY UPDATE`
    (the #29 pattern);
  - then the DM row and all of its participant rows. `leave()` takes the DM row first, so a
    leave waits; a membership removal cascades to the participant rows, so it waits too.

  The order is workspace, project, membership, sketch, DM, participants, which prevents
  deadlocks. Every DM sketch change also takes the DM row `FOR SHARE` before the caller's
  participant row. The participant set is read once, under those locks, and used for both the
  token check and the grants. A change that committed before the locks makes the token stale
  (`409`, fresh preview). A change that starts later waits until the copy has committed.
- Placements and DM message ids are not copied. Later DM messages and changes to the DM sketch
  never reach the copy. A test checks that the preview's readers equal the project's people
  afterwards.
- The DM sketch lists `copies` only when the caller can open them.

**Web.**

- A DM has **Messages · Sketches** tabs. `/dm/:dmId/sketches` and `/dm/:dmId/sketches/:sketchId`
  keep the DM's header and audience. A DM sketch opened elsewhere (`/map/:id`, a return item)
  moves there.
- **Select** in the DM header turns on message selection. There is a check per message (the
  row toggles too, and so does Space on the check), the picked rows are tinted, and Esc cancels.
  The bottom bar shows the count, **Cancel** and **Start sketch from these messages**, with the
  note "The sketch stays in this conversation: only you and Kai can see it. No project is
  created." It then opens the new sketch with its name ready to edit and "Started from N
  messages".
- Thoughts show "Message from Kai · 21:14". Read-only DM sketches say why.
- **Make it a project…** opens Details with the preview:
  - the target (New project or Existing project), the name, and "Who can see it", with faces,
    the exact names and why each is there;
  - who is left out;
  - "What goes in";
  - "What stays in the conversation";
  - **Create project** or **Copy into …**.
  A stale preview is replaced in place with a quiet line. After the copy, the new project opens
  on its sketch, with the line "Copied from a direct message". The DM sketch shows "Copied to …".
- Motion: selection checks scale in, the bar rises, notes fade in, and the preview dims while it
  reloads. Everything uses the duration tokens, so reduced motion turns it off.

**Search** (#114). A DM sketch and its thoughts keep the sketch audience (`sketch:<id>`, checked by
the sketch policy, so the privacy and saturation guarantees of search are unchanged). They also
record `search_documents.dm_id`, which migration 0025 adds and the index triggers maintain.
`place=dm:<id>` then finds the DM's messages, sketches and thoughts. `private` no longer includes
DM sketches. Results name the DM as their place, and `target.dmId` makes them open at
`/dm/:dmId/sketches/:sketchId` (`#thought-…` for a thought).

**Tests.** `tests/app/dm-sketches.test.ts` (API, `./scripts/check_application.sh`) and
`tests/ui/test_dm_sketches.py` (Playwright, `./scripts/check_ui.sh`, screenshots
`dm-sketch-*.png`).

## Evidence

The screenshots in [`docs/design/sketches/`](../design/sketches/) come from
`tests/ui/test_sketches.py`, run by `scripts/check_ui.sh`, and show realistic content.
They do not prove interaction or accessibility; the Playwright journey checks those
against the API.

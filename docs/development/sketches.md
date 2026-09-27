# Sketches

Issue #69 (foundation 8.4). A sketch is a map of connected thoughts. People put
thoughts down, link them, move them around and edit them in place. Nothing on a map
has to become work.

A sketch belongs to a project or is private to its creator. Sketches bound to a DM
conversation depend on #36 and are tracked in a follow-up issue; this slice has no
participant lists.

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

Migration `0007_sketches.sql`. `infra/migrate.ts` applies every unapplied file in order and checks that the
highest version equals `FLUX_SCHEMA_VERSION` (7).

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

Out of scope: AI rearranging sketches, and promoting a sketch into a project (after #36).

## Evidence

The screenshots in [`docs/design/sketches/`](../design/sketches/) come from
`tests/ui/test_sketches.py`, run by `scripts/check_ui.sh`, and show realistic content.
They do not prove interaction or accessibility; the Playwright journey checks those
against the API.

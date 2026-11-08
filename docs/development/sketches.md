# Sketches

Issue #69 (foundation 8.4). A sketch is a map of connected thoughts. People put
thoughts down, link them, move them around and edit them in place. Nothing on a map
has to become work.

A sketch belongs to a project or is private to its creator: one private map for each person in a company ("My map", #947).
No sketch has a participant list of its own. A direct message has no maps; the `dm` scope, a map made from chosen messages and the
copy of a direct-message map into a space (#96) were removed in #947.

## Model

| Table | Holds |
| --- | --- |
| `sketches` | One map in a workspace. `scope` is `project` (with `project_id`) or `private` (owned by `created_by_user_id`, never by an agent). It also has a title, a version and `edited_by`: everyone who changed it after it was made, as `human:<id>` or `agent:<id>` (whether it is still "yours", [F-036 Terms](../product/assistant.md#terms)). |
| `sketch_thoughts` | The text, an integer position (`x`, `y`), a size (`width`, `height`), a `shape` (`card`, `pill`, `circle`), an optional placement, a version and `edited_by`, as on `sketches`. |
| `sketch_links` | An undirected link between two thoughts of the same sketch, with an optional label. There is one link per pair; a thought links to any number of others. |

Composite foreign keys keep every thought and link inside the sketch's
workspace and sketch. A placement (`placement_type`, `placement_id`, only `draft`
today) names an existing object shown on the map. It deliberately has **no foreign key
or cascade**. Removing the thought removes only the placement, never the draft (and
later the task or thread) behind it. A placement is created only for an object the
caller can read in the same workspace (`404` or `422 CROSS_WORKSPACE`). The title of a
placement is returned only to readers who can open the object now; for anyone else it
is `null`.

A thought of a project sketch can also show an image (#252): a stored file of the
project published to that thought (`project_files.thought_id`, migration 0051), returned
as `file { id, name, size }`. The thought keeps its text as the caption. The
[stored-files amendment](task-discussions.md#map-thought-images-252-migration-0051) has
the publication and access rules, and [paste on the map](../design/thought-drafts.md#paste-on-the-map-252)
the draft lifecycle.

The tables are in the baseline `0001_v0_1_baseline.sql`. Migration `0020_remove_dm_sketches.sql` (#947) drops the direct-message scope, the
copy of a direct-message map into a space, a thought's direct-message source and the search index's `dm_id`, and adds the unique
index `sketches_one_private_map_idx`: at most one private map for each person in a company. `app/tooling/migrate.ts` applies
every unapplied file in order and checks that the highest version equals `FLUX_SCHEMA_VERSION`.

## Access

This uses the #29 policy in `app/packages/core/src/access/policy.ts`. It adds the
`evaluateSketch` action (`sketch.read`, `sketch.write`), the `visibleSketchesSql` list
condition (`@flux/db`) returned by `visibleFilter(…, 'sketch')`, and `sketch.create` on the
workspace. The rules are in [access-policy.md](access-policy.md#rules). Invisible
sketches answer `404`, and visible sketches the caller may not change answer `403`.
Changes lock the sketch row (`FOR NO KEY UPDATE`), so changes to one sketch run one at a
time. They also lock the project access rows or the caller's participation, so a
concurrent revocation is either seen or waits.

## Clean Architecture

- `app/packages/core/src/sketches/` holds the use cases (`createSketchUseCases`) and their
  ports: `SketchAccess`, `SketchRepository`, `SketchEventLog` and `SketchUnitOfWork`.
  It imports only `@flux/contracts`, the domain errors and `principal.ts`. It never
  imports Drizzle, `@flux/db` or pg-boss (`app/tests/app/architecture.test.ts` also follows its relative imports).
- `app/packages/core/src/access/sketch-access.ts` is the policy adapter for `SketchAccess`.
  It imports no persistence library and reaches none through `policy.ts` either: it takes an
  `AccessReader` (`policySketchAccess(accessReader(tx))`), whose SQL is in `@flux/db`
  ([architecture rules](architecture.md#resolved-debt), #90).
- `app/packages/db/src/repositories/sketches.ts` holds the rows. It makes no access decisions;
  lists take the policy's condition from the caller.
- `app/apps/server/src/sketches/` holds the adapters: the unit of work, the `visibleFilter`
  composition and `recordEvent`. It also holds the thin Fastify routes. The shared
  If-Match and Idempotency-Key plumbing is in `app/apps/server/src/http/commands.ts`.

## HTTP API

| Route | Notes |
| --- | --- |
| `GET /api/v1/workspaces/:id/sketches?projectId=` | Returns a page of visible sketches, newest change first. The filter is applied before the limit and the total. `?scope=private` returns only private sketches (the sketchbook, #189); no other scope value is accepted. `?hideEmpty=true` leaves out sketches with no thought that still have the default title "Untitled sketch" (#508). Each listed sketch carries `thoughtCount`. |
| `POST /api/v1/workspaces/:id/sketches` | Takes `{ title, scope: 'project' \| 'private', projectId? }`. |
| `GET /api/v1/sketches/:id` | Returns the sketch with its thoughts and links. The ETag is the sketch version. |
| `PATCH /api/v1/sketches/:id` | Renames the sketch. Needs `If-Match`. |
| `POST /api/v1/sketches/:id/thoughts` | Accepts an optional client `id` (used when undo restores a thought), an optional `placement`, and an optional `linkFrom` (the "+" beside a thought: the thought and its link are created atomically). A project sketch can also accept `sourceProjectMessageId` for a message in that same project; the server resolves its persisted author and time, and the source id remains inside that project's audience. |
| `PATCH /api/v1/sketches/:id/thoughts/:thoughtId` | Changes text, position, size or shape. Needs `If-Match`: `428` when missing, `409 VERSION_CONFLICT` with the current thought when stale. |
| `DELETE /api/v1/sketches/:id/thoughts/:thoughtId` | Removes the thought and its links. Needs `If-Match`. |
| `PATCH /api/v1/sketches/:id/positions` | Moves several thoughts all or nothing. `{ moves: [{ id, x, y, expectedVersion }] }`. Any stale move answers `409` with `conflicts`, and nothing moves. |
| `POST /api/v1/sketches/:id/move-to-map` | Moves thoughts to another map the caller can change (#948: My map's "Move to a space map", and the Undo that brings them back). `{ toSketchId, thoughts: [{ id, expectedVersion }], at? }`. The caller needs `sketch.write` on both maps (`404` for a map they cannot see, `403` for one they cannot change). Each thought appears on the target as a new thought (a map keeps every id it has held) with the same text, shape and size, and the original goes, in one change: a stale version answers `409 VERSION_CONFLICT` with `conflicts` and nothing moves. The group keeps its shape and lands at `at` (its top left), else under everything on the target, else where it was. A connection between two moved thoughts is made again on the target; one to a thought that stays goes with the original and comes back in `severed`. A thought with an image answers `422 IMAGE_THOUGHT_STAYS` (My map has none). The answer is `{ fromSketchId, toSketchId, moved: [{ from, thought }], links, severed, origin }`. Both maps get their own `sketch.changed.v1` (`thought_removed` and `thought_added`). |
| `POST /api/v1/sketches/:id/links` | Takes `{ id?, fromId, toId, label? }`. Answers `409 LINK_EXISTS` for a pair that is already linked (in either direction) and `422 SELF_LINK` for a thought linked to itself. |
| `DELETE /api/v1/sketches/:id/links/:linkId` | Removes one link. |

Every change accepts `Idempotency-Key`: a retry replays the stored answer after
re-authorization. Concurrent moves of **different** thoughts never conflict, so they
merge. Moves of the **same** thought conflict (`409`); the web client then reapplies
the person's move on the current version.

## Events

Each committed change records exactly one event per map it changes: `sketch.created.v1` or
`sketch.changed.v1`, with `data.op` and the affected thought and link ids, and never
text (a move to another map changes two maps, so it records two). The event carries `object_id` = the sketch. Its audience is decided with
`sketch.read` in the writing transaction, and delivery re-checks it. Nobody but its
author receives the events of a private sketch. The stream's `objectType` is `sketch`.

## Web

- `/map` is **My map** (#866), the person's one private map: the Sketchbook and its list, and "Your
  notes", are gone. It finds the oldest of their private sketches (`?scope=private`, an empty one
  included), or makes one titled "My map" the first time (`openMyMap` in `api/sketches.ts`), and shows
  it at its own address, `/map/:sketchId`. It is shown as "My map · Only you", with no way back to a list and
  no rename. Create's **Thought** puts a thought on it, in a free place (`freeSpot`). Project
  sketches live in their project's Map tab, which still lists them (#189). A direct message has no maps (#866, #947).
- A map opens only where it lives: `/projects/:projectId/map/:sketchId` for a space's map and
  `/map/:sketchId` for a private one. A link that cannot know the place (search, doc links) opens `/map/:sketchId`, and the
  view moves it, keeping the `#thought-…` fragment.
- `/map/:sketchId` is a map (direction C `#lamp-map`, `-select`, `-edit`,
  `-list`). The toolbar has Thought, Connect, Shape, Remove and Undo, plus a status line.
  - The map is a canvas with a visible **+** beside the selected thought.
  - Pointer: drag to move (the selection moves together), Shift-click to select
    several, drag empty space to pan, and zoom with Ctrl/⌘-wheel or the corner controls.
  - Keyboard: arrows move (Shift for bigger steps, Alt to resize), Enter edits, Space
    selects, `+` adds a connected thought, Delete removes, and Ctrl/⌘ Z undoes.
  - Paste (#252): Ctrl/⌘ V on the map or list turns lines, a link or an image into a
    private draft that is saved only on confirmation; on touch devices the empty new-thought
    draft offers Paste.
  - Selecting or dragging never opens a panel.
  - **List** shows each thought once in a personal, stable outline with named
    clickable relations. Fresh browsers start with top-level thoughts; **Group in
    list…** explicitly chooses an existing linked thought or Top level, with a
    separate local grouping undo. Adding a linked thought supplies local child
    intent; ordinary Connect never changes a level. The
    [presentation contract](../design/map-list-outline.md) defines bounded ID-only
    state, conservative bootstrap, deletion/undo, exact reveal/back and keyboard
    navigation. These preferences never mutate the graph or canvas positions.
  - Phone and tablet: tap to select, then drag. Touch targets are 44 px, and there is
    no horizontal page scroll.
- `app/apps/web/src/sketch/doc.ts` applies changes locally at once and sends them in order.
  Each change carries its own Idempotency-Key and the last server-confirmed version as
  If-Match. Undo sends inverse operations. When a stream event arrives for the open
  sketch, the client refetches it once nothing is in flight.
- Motion: thoughts ease between positions (`--dur-2`) and new ones fade in. All
  durations come from the tokens, which are 0 ms under reduced motion.

Out of scope: AI rearranging sketches.

## Required live interaction — F-021 / #228

A second authorized person must see positions during pointer movement, before
pointerup, and committed additions/changes without waiting for unrelated local
operations. The current local preview and saved-event refresh do not deliver this
outcome. [The assessed contract](live-editing-proposal.md) retains native SQL/CAS
objects with identified transient previews, confirmed deltas and conflict-safe
own undo. It is admitted only for disabled calibration; runtime gates remain open.
Camera and selection stay local, and #149's private new-thought draft is never
broadcast before deliberate Save. Private/DM/project audiences and current access
remain authoritative for every write and delivery.

## Evidence

The screenshots in [`docs/design/sketches/`](../design/sketches/) come from
`app/tests/ui/test_sketches.py`, run by `scripts/check_ui.sh`, and show realistic content.
They do not prove interaction or accessibility; the Playwright journey checks those
against the API.

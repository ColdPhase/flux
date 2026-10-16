# Personal map-list outline

Issue [#134](https://github.com/ColdPhase/flux/issues/134), 2026-09-30. A person
reading a deep map needs to keep their place and follow a relation to another
thought without mistaking that relation for a new parent. This implements the
accepted rule that hierarchy is distinct from a graph relation
over the existing undirected graph; it does not add domain hierarchy.

## Spokój update: the List is the map's tree (#510, 2026-10-16)

Founder direction [Spokój](spokoj/README.md) board A04 (#510) replaces this page's flat
personal forest. Where this section and the older text below differ, this section wins.

- **Structure comes from the map.** A connection records which thought it was drawn from
  (`fromId`). A thought sits under the oldest thought, in this person's reading order, with a
  connection drawn to it; its other such connections read **also under …** (named buttons that
  follow to that thought, with **Back to …**). A connection that would close a loop is shown the
  same way, and a thought nothing was drawn to is a root. Every current thought occurs once and
  every connection is either a branch or an "also under", so many-to-many relations and task
  links stay visible (Prostota "Kept map and board behaviour"). The tree depends only on the
  current graph and the reading order, so a graph undo restores the same tree. A later Connect
  can therefore move a thought under an older parent; that is the map's structure, shown.
- **Rows.** Connector lines join a parent to its children; a branch folds. The connection's
  label is a small tag before the child's title. Linked tasks are a chip at the row's end (state
  glyph, number, state, "+N") that opens the same chooser as the map's count. Dates and
  provenance show on hover, focus or selection only and keep their room, so nothing moves.
  Edit · + Child · Create task · ⋯ appear on the selected row only; ⋯ holds Indent, Outdent,
  Move up, Move down, Connect…, Connections and Remove (graph actions only for people who can
  write, and Indent/Outdent/Connect not on a phone, S15).
- **Keyboard and screen readers.** The rows are a `tree` of `treeitem`s with `aria-level`,
  `aria-expanded` and `aria-selected`; one row is in the tab order. Arrows move between rows and
  select them; Left/Right fold, unfold, go to the parent or the first child. Enter adds a thought
  beside the selected one, `+` adds a child, Space opens the thought for editing (F2 too), Delete
  removes. **Tab / Shift+Tab** put the selected thought under the row above it or one level out:
  its connection to its parent moves to the new parent (keeping its label), and outdenting from
  the top branch disconnects it; one undoable graph step. A selected row takes Tab; Escape clears
  the selection and Tab then leaves the list. Shift+F10 moves to the row's actions.
  **⌥↑ / ⌥↓** move a thought among its siblings in this person's reading order only.
- **Personal state** is the reading order and the folded branches (same storage, bounds and
  ID-only rules as below). **Group in list…**, its separate undo and the personal parent
  overrides are retired: two ways to restructure, one shared and one private, contradicted
  "the List shows the structure of the map". Older saved parent choices are read and ignored.
- **Layout.** On a computer and tablet the List keeps the map's frame: the "Sketches · name ·
  Map|List" pill at the same top left and the same bottom toolbar (Select and Move around dimmed)
  in exactly the same places, without the map's drag hint (Spokój rule 7). The phone keeps its
  List page with the tools above the rows.

## Presentation contract

- The outline is personal to the signed-in person, workspace, sketch and browser.
  A fresh browser, missing/corrupt state or unavailable storage starts every
  authorized thought at the top level, ordered by immutable `createdAt`, then ID.
  Existing records do not say which link was a deliberate parent. Millisecond
  timestamps are insufficient to reconstruct that history, so no relation is
  guessed to be a parent. This conservative initial view is an explicit limit.
- **Group in list…** chooses Top level or an existing, currently authorized linked
  thought. It names that this is the person's list, and has a separate **Undo list
  grouping**. It changes no graph record, position, API or collaborator's outline.
  Choosing a descendant is disallowed. Adding a new linked thought supplies the
  same deliberate local child intent, including when added from Canvas.
- Ordinary **Connect**, including a relation from a deep thought to a new root or
  shallow thought, never changes an existing level. Expanding, searching, switching
  Map/List and following a relation never mutate graph records or canvas positions.
  Every current thought occurs once; additional links remain named relations.
- A branch requires its current parent and a current graph link between them.
  Deleting a parent or its link detaches the child to the top level. ID-only previous
  choices are retained within the bounded local state, so graph undo can restore
  the branch when the same thought and link return. Missing parents do not leave
  misleading guides. Invalid saved choices and cycles resolve to roots.
- Local storage contains only thought IDs, parent choices, collapsed IDs and order,
  with a version. It never stores titles, source previews, access decisions or
  tokens. Each sketch is bounded to 2,000 remembered IDs. The complete preference
  store is bounded to 4,000 remembered IDs, 16 sketches and 512 KB, evicting the
  oldest visited sketches first; evicted preferences may
  return to conservative roots, while every authorized graph thought still renders.
  Storage failure keeps the current session useful without promising reload
  persistence. The person/workspace/sketch key prevents account crossover.

## Reading and returning

Grouping undo reverses only that thought's last explicit parent choice. Later
independent child placements, ordering and collapse choices stay current. Consecutive
undos restore each affected thought's prior choice, including the difference
between no override and an explicitly remembered root. They never rewrite graph
records. The independent #134 behavior review exposed and the operation-specific
correction tests cover this boundary.

Use quiet neutral hierarchy guides, shared selected/focus/link tokens and named
**Related to …** buttons close to the thought. Existing graph links are undirected;
their labels are displayed without inventing arrow direction or ownership. Core
Edit/Add actions appear beside the selected entry; grouping and further links are
disclosed on demand. Read-only people can navigate or group their personal list,
but receive no graph editing actions.

Follow reveals a destination's collapsed ancestors, selects its exact ID and moves
focus to its existing row. **Back to …** restores the source and previous collapse
state. Labels always come from the current authorized sketch. A renamed target
updates in place; a removed or unavailable target contributes no cached title,
count or preview. Search/live arrivals use the same reveal path before focus.

On a related-link landing, reveal the selected row's title and ordinary context
below the sticky return cue, rather than revealing only a title at the bottom
edge. Back still restores the original scroll position. This phone correction
was identified by the independent #148/#134 integration image review on 2026-09-30.

Keep native list/button semantics. Up/Down and Home/End move between visible row
titles; Left collapses a branch or moves to its parent, Right expands or enters its
first child. Preserve Enter to edit, Space to select, `+` to add, Delete to remove
and graph undo. Disclosure buttons provide the touch alternative. Bound visual
indentation to three steps on a phone and expose the complete ancestor path;
never shrink the content to fit deeper levels.

## Verification

Unit checks exercise the deterministic forest, later relations, multiple parents,
cycles, missing endpoints, deletion/undo and malformed/bounded storage. Docker
browser checks use actual persisted graph data and two accounts: deep levels 3/4
linked to a new root/level 1, exact follow/back through collapsed branches,
rename/delete/grouping undo, search/Map/List, read-only and restricted sources.
Compare light/dark 1440×900, 1280×800, 390×844 and tablet views at 100% zoom plus
enlarged text, then obtain separate visual and behavior review. Screenshots do not
prove persistence, access or physical PWA acceptance.

The [2026-09-30 source-pinned evidence](map-list-outline/2026-09-30/README.md)
records the Docker browser/API checks, matched renders and independent visual
assessment; final independent behavior review and eligible approval remain required.

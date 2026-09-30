# Personal map-list outline — Studio v11

Issue [#134](https://github.com/ColdPhase/flux/issues/134), 2026-09-30. A person
reading a deep map needs to keep their place and follow a relation to another
thought without mistaking that relation for a new parent. This implements the
accepted [v11 direction](studio-v11-refinement.md#2-hierarchy-is-distinct-from-a-graph-relation)
over the existing undirected graph; it does not add domain hierarchy.

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

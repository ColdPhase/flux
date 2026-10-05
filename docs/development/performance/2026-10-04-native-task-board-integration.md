# Tasks board over bounded native reads — #155 / #136 integration

2026-10-04. Integration contract written while merging `main` at `1c9e36c5` (which added the
Kanban board of #194) into #155 (`claude-maurycy/155-truthful-typing`). Author: Zamojski5's
worker. **Not yet independently reviewed**; the eligible evaluator is PelikanFix16. It extends
the [bounded read contract](2026-10-01-native-work-read-contract.md) and changes no endpoint.

## Why

Main's board read `shell.work`, the complete project work collection. #155 removed that
collection from the project shell; restoring it would undo bounded reads, and dropping the board
would lose #136 UI116-4. The board therefore runs on the existing bounded Tasks reads.

## Observation

- **Columns.** Open is the Tasks tab's own `work-view?purpose=tasks&group=open` read (it also
  carries the shared summary for the header and the "In the List" links). In progress is the
  `in_progress` and `blocked` groups (blocked leads); Done is the `finished` group. Each group
  is its first page: the default limit of 50, newest first. Four reads, at most 200 rows. `mine`
  is the server's Only-mine predicate (owner is the signed-in principal).
- **Counts and overflow.** A column header counts the exact native total of its groups. A group
  with more than its first page says so under the column ("N more open in the List") and opens
  that group in the List, which pages through all of it. The board never concatenates pages.
- **Cards.** Title, short id, status, blocker, owner, `prerequisiteCounts.unmet` ("Waits for")
  and `relations.results` come from the row projection. Where a card came from is one
  `work-relations?role=source&limit=100` read per 100 loaded cards; a card whose source edge is
  outside that first edge window shows no origin line, and its Details still show it. "Planned in
  plan revision N" is not on a card: plan intent is a detail field, shown in the task's Details.
- **Search.** The board's search filters its loaded cards (title, owner, blocker, id). When any
  column holds more than its first page, the board says the search covers the loaded cards and
  that the List shows every task. With a search, column counts count matching loaded cards.
  The List is read page by page from the server and has no client search (a search over one page
  would claim matches it cannot see); it keeps its views, Only mine and pagination.
- **Moves.** Unchanged native command: `PATCH /work/:id` with `If-Match` version and a stable
  `clientCommandId` per (task, version, status). A confirmed move overlays the saved status and
  version on the row until the column reads catch up; a refusal re-reads the board.
- **Fences.** Board reads are scoped by account, project and canonical selector (`useWorkRead`);
  a scope change hides the old observation during render. Reads pause while the router
  revalidates and re-read when it settles, as the Tasks page read does. Each column is its own
  observation; rows that appear in two reads keep the newer version.

## Not claimed

Board behaviour with more than 50 tasks in a status beyond the overflow link; performance
budgets for four reads instead of one; device evidence. `test_tasks_board.py` covers small
projects only.

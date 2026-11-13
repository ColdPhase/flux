# Search across Flux (issue #114)

Foundation 8.12: a person knows something exists but not where or under which name. One search
covers project messages, direct messages, docs and materials and every version of them, work items,
decisions, sketches and their thoughts and people. It runs in PostgreSQL only
(a BM25 index from `pg_search`, `tsvector`, GIN, `websearch_to_tsquery`, `ts_headline`, `pg_trgm`), in line with O-002:
there is no separate search server. The #16 rule applies throughout: **access filtering happens before
ranking, limits and snippets.**

## Two ways to match (F-042, #1293)

| The query | Answered by | What it does |
| --- | --- | --- |
| Plain words (`sensor`, `czujnik piatek`, `#12`) | the BM25 index of migration 0065 (`searchRows(db).ranked`) | **Any** of the words matches, Polish and English stems, accents folded; ranked by how rare the words are **among the hits the reader may see**, a word in a title counting double. |
| Quotes, `or` or `-word` (`"exact phrase"`, `sensor -lamp`) | the exact index below (`searchRows(db).page`) | Exactly what it says: every word, no stems, the web search syntax. |

The service (`createSearchUseCases`) picks by `usesSearchSyntax(text)`; the cursor, the audiences, the filters (`type`, `place`,
`author`), the one result per object and the task-number rule (`#12` first) are the same for both, and so is the answer's shape.

- **pg_search matches; it does not rank.** Its own score (`pdb.score`) counts how rare a word is over the whole index, and the index
  holds what the reader may not read: restricted spaces, other people's direct messages and every other workspace of the instance. A
  writer in one visible place could then move the order of a reader's own results by writing a word in the hidden ones (the review
  probe of #1326 swapped two visible messages with 40 hidden ones). So the statement (`rankedStatement` in
  `packages/db/src/repositories/search.ts`) asks the index only which documents hold which word: every clause scores a constant
  (`pdb.const`, a power of two), so a hit's score is a code of which word it holds and where, and the words share as few scans as a
  score's bits allow (one for up to four words). The scan is filtered by the reader's audiences only (a set of audiences scores a
  constant); the reader's filters (type, place, author, conversation, time) and the task lifecycle are applied to its rows after it,
  because pg_search scores a filter on one value by that value's rarity over the whole index (`search-hidden-ranking.test.ts` holds it
  with 24,000 hidden rows). The order is then **BM25 computed in SQL over the visible hits** (`cand`): a word's document frequency, the number of documents and their average length are counted over those hits and
  nothing else; a document's own part is its length (`length(tsv)`, stored with the row) and where the word was found. The term
  frequency of a word is one (the index says it matches, not how often). Each word adds `idf × weight × (k1 + 1) / (1 + k1 × (1 − b + b × length / average))`
  with k1 1.2 and b 0.75; the weight is 2 for a whole word in the title and 1 in the body, and a hit found only as the word being typed
  or with a typo in its title counts half the average rarity of the query's words. No statistic of the index, and no row the reader may not see, influences what they are shown or in which
  order; `search-hidden-ranking.test.ts` holds it for the people's search and for the statement an agent's `flux_search` runs, with
  writes in a restricted space, another workspace and other people's direct messages.
- **The word being typed** is also looked up as a prefix: the index holds stems, so a scan adds `pdb.regex('<word>.*')` on the title and
  the body fields (folded by `foldSearchWord`), and "sens" finds "sensors" and "kalibr" finds "kalibracja".
- **A title tolerates a typo:** each plain word of four letters or more (at most six) also matches the title with one edit
  (`pdb.fuzzy(1)`), as the trigram match did ("ensor", "omparison", "comparisn" find "Sensor comparison"). A task number
  names one task, so it gets no typo.
- **At most twelve words are looked up** (the first twelve and the word being typed), each a title and a body clause in each language;
  a search of up to four words is one scan and runs in a few milliseconds, a longer one a scan for each further five words.
- **The score** in a position is `rank / (rank + 10)`, in (0, 1) and in the same order, so that the rows of an encrypted space,
  which the in-memory index ranks from 0 to 1.5, merge with them.
- **Encrypted spaces** answer plain words the same way, without stems and accents (`plan.anyWord`, `sealed-search.ts`): their content is
  never in the BM25 index, so the in-memory index matches any of the words, the typed word as a prefix and a title with a typo (four
  letters or more), and ranks a document by the words it holds, each weighing the idf of its audience's own documents (rarer
  weighs more) and a title word more than a body word. A plain space can therefore find a document by another form of a word that an
  encrypted one cannot. `encryption-search-live.test.ts` holds both sides to the same set for plain words, a prefix, several words,
  a typo and quoted words, and to the rare word first.
- **Snippets and marks.** `ts_headline` picks the passage and marks the query words and their longer forms (`czujn:*` for
  "czujnik"); `markSearchWords` (core) marks the rest in the text of the result: a longer form, the word without its
  accents ("piatek" marks "piątek") and the word as far as it was typed. Both use the same stem rule (`searchWordStem`).
- **`/api/v1/search/explain`** (test support) describes the exact statement, which is what its work counts were written for.
- **The exact index stays.** Quotes, `or` and `-word` need every-word and exclusion semantics that `|||` does not give; the
  `keys` index and its trigram and prefix terms are therefore not dropped by this change (a migration that drops them would have to
  carry those semantics over to the BM25 index first).

## Index

Migration `0014_search.sql` (`FLUX_SCHEMA_VERSION` 14) adds the `pg_trgm` extension (a trusted
contrib extension) and one table, `search_documents`. Each row is one searchable object:

| Column | Meaning |
| --- | --- |
| `kind` | `project`, `message`, `dm_message`, `material`, `doc`, `work`, `decision`, `sketch`, `thought` or `person`. |
| `audience_key` | The object that carries the row's permission: `project:<id>`, `dm:<id>`, `sketch:<id>` or `members:<workspace>`. |
| `project_id`, `parent_id`, `object_id`, `version` | The place and the exact target: the conversation of a message, the DM of a DM message, the sketch of a thought, and the material version. |
| `title`, `body`, `status`, `author_kind`/`author_id`, `at` | Content, the status that names it ("Task · blocked"), who wrote it and when. |
| `tsv` | Generated: `title` weighted A and `body` weighted B, with the `simple` configuration. |
| `keys` | Generated by `search_keys(audience_key, title, body)`: for each word, `<audience_key>\|1:<first character>`, `\|2:<first two>` and `\|3:<first three>` as far as it is long; and for each trigram of the title, `<audience_key>\|t:<trigram>`, each stored as its 64-bit hash (`search_key`), so entries are short and the shared entry tree stays shallow; a collision only adds a candidate. The only text index is a GIN index on `keys` (`fastupdate = off`). |

- **Projects are found by name (#465).** Migration `0090_search_projects.sql` adds one row per project
  (`kind` `project`, the name as the title, `audience_key` `project:<id>`, `status` the visibility). The
  `projects` trigger (`UPDATE OF name, visibility`) keeps it current, and the same policy condition as
  every project object decides who sees it, so a restricted project is absent for everyone outside it.
  A project has no description column, so its body is empty. A result opens the project's home and
  says "Project" or "Project · restricted"; its place is the workspace.
- **Kept current in the same transaction.** `AFTER INSERT OR UPDATE OR DELETE` row triggers on
  `projects`, `project_messages`, `dm_messages`, `project_material_versions`, `project_work_items`,
  `project_decisions`, `sketches`, `sketch_thoughts` and
  `workspace_members` (plus `auth_users` name changes) write the row with the change itself. A
  committed edit is searchable at once; a deleted object, including cascades from a deleted
  project, DM or sketch, disappears with it. Moving a thought on the map does not reindex it. The
  migration indexes what already exists.
- **A deleted message is not findable (#1006).** The two message triggers drop the row when `removed_at` is set (`0029`), so the
  marker is not indexed and the sealed in-memory index drops the document too; an edit rewrites the row with the new words.
- **Rows hold content, not permissions.** Who may read a row is decided at query time from its
  `audience_key`, so a revoked grant, a left DM or a membership removal applies on
  the next search without touching the index. A sketch's scope is
  read from their own rows by the policy.
- **Old citations still resolve.** Every material and doc version has its own row. A search that
  matches only an older version finds that version ("Material · version 1 of 2", "Doc · version 1
  of 2, draft") and opens it; when several versions match, the newest matching one is shown and
  the object counts once.
- **Docs (#112)** are project materials of kind `doc`, so the material version trigger indexes them
  with kind `doc` and the version's state. Their audience is the project: draft is a state, not a
  second audience, as in [docs-wiki.md](docs-wiki.md). A result says "Doc · draft" or "Doc ·
  published" and opens the doc reader at the matched version.
- **Language (exact index).** The `simple` configuration lowercases without stemming, so every language is
  treated the same way. It answers only the web search syntax now; the stems, accents, prefix and typos of plain words are the BM25
  statement's (above).
- **Grammar limits, refused explicitly.** A query of only exclusions (`-lamp`) answers
  `400 QUERY_NEEDS_WORD`, and an exclusion together with `or` (`sensor or -lamp`, which would match
  everything without "lamp") answers `400 QUERY_UNSUPPORTED`. A quoted `"or"` is an ordinary word.
  Queries with web search syntax (`"exact phrase"`, `or`, `-word`) are left to
  `websearch_to_tsquery` alone, without prefix or trigram matching, so an exclusion stays exact.

## Access before ranking

`app/packages/core/src/search/` owns the use case and its ports; the server passes the adapters.

1. **Audiences, fresh on every request.** `policySearchAccess` (`app/apps/server/src/search/adapters.ts`)
   lists the workspaces the principal is active in and, for each, asks the policy for the list
   condition of every audience type: `visibleFilter(…, 'project' | 'dm' | 'sketch')`
   and, for people, `authorize(…, 'workspace.read_members')`. Nothing is cached.
2. **Composed into SQL.** `searchRows` (`app/packages/db/src/repositories/search.ts`) turns the
   conditions into one array of visible audience keys (`ARRAY(SELECT 'project:' || id FROM
   projects WHERE <visibleFilter> UNION ALL …)`) in a materialized CTE, and every statement starts
   with `audience_key = ANY(keys)`. Ranking (`ts_rank` plus title similarity), the window that keeps
   one material version, the `LIMIT` of the page and `ts_headline` all run on
   rows that already passed it. A project is named in a result only when the project itself is
   among the visible audiences.
3. **The index is keyed by audience.** Every lexeme the parser finds in the query (and every word
   of the prefix query) becomes the term of its length up to three (`search_term`: `1:d`, `2:ai`,
   `3:sen`), so a row that contains any query word, or a word it is a prefix of, is a candidate:
   nothing the full-text query matches is dropped, however many alternatives an `or` list has.
   A plain query also adds its trigrams (`t:ens`), because a title similar to the query shares at
   least one trigram with it. The statement combines every visible audience key with every query term
   (`project:<id>|3:sen`, `project:<id>|t:ens`) and
   looks those keys up with `keys && lookups`. A key's posting list holds rows of that audience
   only, so the index never reads postings, pages or row addresses of audiences the reader cannot
   see. The exact match (`websearch_to_tsquery`, the prefix query, trigram similarity for titles)
   is then checked on those candidate rows. `fastupdate` is off because a GIN pending list holds
   recent inserts of every audience and every search would scan it. The statements run read-only
   with `SET LOCAL enable_seqscan = off`, so PostgreSQL always uses this index, also while the table
   is small.

   Evidence (`EXPLAIN (ANALYZE, BUFFERS)`, outsider's search before and after 462 hidden matches):
   an earlier head used multicolumn GIN indexes `(audience_key, tsv)` and `(audience_key, title
   gin_trgm_ops)`; they returned the same 6 visible rows but read 15 → 17 buffers per bitmap index
   scan, because lexeme and trigram posting lists are shared by all audiences. With audience-scoped
   text keys, CI still showed 67 → 91 per scan with the same 22 lookups: one page per lookup, a level
   added to the shared entry tree by the long keys. With hashed keys: 136 → 136 in isolation, 146 →
   146 and 142 → 142 in two full local runs, and 136 → 136 and 138 → 138 in two GitHub runs, with 2
   row addresses per scan out of 462 matches in the workspace.

Matches the reader cannot see therefore change neither the answer (items, snippets,
`next`) nor the rows, row addresses and index or table buffers the database reads for it. The remaining shared costs are not per-match:
the policy conditions scan the workspace's projects, DMs and sketches (their number, not
their content), recent writes leave dead row versions in those tables until autovacuum removes
them, and the height of the shared GIN entry tree grows with the number of distinct keys in the
whole database (logarithmically, one level per ~150× more keys). That is load, as for the stream, and it is not padded to constant time.

## API

`GET /api/v1/search?q=&type=&place=&author=&cursor=&limit=` (`app/packages/contracts/src/search.ts`)
needs a live session and answers `Cache-Control: no-store`.

- `q`: 1–200 characters (`400 QUERY_REQUIRED` / `QUERY_TOO_LONG`). A query without any letter or
  digit returns an empty answer. Queries are always parameters; operators, quotes and SQL are data.
- `type`: `project` (project names), `message` (project and direct messages), `doc`, `material`, `work`, `decision`,
  `sketch` (sketches and thoughts) or `person`.
- `place`: `project:<id>`, `dm:<id>` or `private` (your private map). A place
  the reader cannot see gives the same empty answer as a place without matches.
- `author`: `human:<id>` or `agent:<id>`.
- `limit`: 1–50, default 20.
- **Answer:** `items` (kind, a human label such as "Decision · current rule" or "Thought in
  “Sensing options”", the title and snippet as plain and matched parts, never markup, the place,
  author, time and exact target) and `next`. There are no counts: nothing read them (#944).
- **Who uses which parameter.** The web sends `q`, `place` (the Create window's look for a duplicate) and
  `limit`. `type` and `cursor` serve the API's own tests; no screen sends them. An agent does not use this endpoint:
  `flux_search` and `flux_read_around` (`agent-connection/search-reads.ts`, F-042) rank by BM25 with `searchRows(db).ranked`
  and take their audiences from the same policy, for the agent's owner, on every call.
- **`flux_summarize`** (`agent-connection/summary-reads.ts`, F-042, #1292) does not search: it reads one place (a space's
  conversations, a thread, a task's discussion, a run's own direct message) between `after` and `before`, ordered by stored time and
  message id, through the same `withAgentConnection` checks as the other reads, and returns a digest (`digestPage` in
  `packages/core/src/search/summary.ts`) that the calling agent summarises itself; nothing is stored. Its tests are
  `tests/app/agent-summaries.test.ts` and `tests/app/agent-summary-core.test.ts`.
- **Cursor.** `next` is the AES-256-GCM encryption (keys from `FLUX_AUTH_SECRET` via HKDF) of the
  last visible result's rank, time and row, authenticated with the reader and a hash of the query
  and filters. It works only for that person and that exact search; anything else is
  `400 CURSOR_INVALID`. Pages follow keyset order (rank, time, row), so none repeat. After a
  revocation, the next page is computed with the new access.
- Only with the integration fixture token set and `FLUX_TEST_FAILURE_INJECTION=true` (#88), `GET /api/v1/search/explain` returns the rows
  examined by the same statements (`EXPLAIN ANALYZE`), for the regression test below.

## Adding a source

A source is registered in three small places plus its trigger:

1. a trigger in a migration that calls `search_put(...)` with its `kind` and `audience_key`;
2. `SEARCH_SOURCES` in `app/packages/core/src/search/sources.ts`: its filter, human label and target;
3. if it brings a new audience type, one entry in `AUDIENCE_KEYS` (`@flux/db` search rows) and one
   in `POLICY_AUDIENCES` (server adapter) that returns the policy's `visibleFilter` condition.

Direct messages were added this way (`dm_message`, audience `dm`), and docs (`doc`, reusing the
`project` audience and the material version trigger).

## Web

- **Search (⌘K / Ctrl+K)**, `app/apps/web/src/search/JumpTo.tsx`, is the one search (#870): ⌘K, the
  sidebar's Search and the phone's round Search button open the same dialog (a floating one near the
  top on the computer, a full-screen sheet on the phone), as `Search.dc.html` draws it. There is no
  Search page and no `/search` route. It searches as you type (140 ms debounce), lists up to 20 results as
  a combobox listbox in groups by kind (Tasks with decisions, Messages, Wiki, Files, Thoughts
  with maps and drafts, Spaces, People; the groups keep that order and a group keeps the server's
  ranking), and has no filter chips, no place filter and no Create group. ↑/↓ move, Enter opens the
  selected row (the first is selected), Esc closes and returns focus. A longer list is narrowed by typing
  more words. The footer (on the phone, the line above the list when there are no recent places) says
  what it finds in one sentence: "Finds spaces, people, messages, tasks, Wiki pages, files and thoughts you
  can see." With no text it lists the recent places and a few actions (`recent.ts`). A row is 48 px: a tile
  for the kind, the matching text with the words marked, and one line of where it lives (`ResultRow.tsx`).
  Only the answer to the latest request is shown. A list that has more than the 20 rows ends with one quiet
  line, "Showing 20 · type more words to narrow" (`next` is set; there is no second page).
- **It opens at its final size** (#898): whether "Ask my assistant…" has a row is read while the dialog
  is closed (`useAssistantReady`, at load and each time it closes) and kept while it is open, and the
  skeleton counts the same rows, so nothing is added to the dialog after it is on screen.
- **Opening a result** goes to the exact object: a message or DM message opens on that whole
  message (`#message-<id>`, highlighted and focused), a material or doc at the matched version, a thought
  selected in its sketch (`#thought-<id>`), a person to a
  direct message with them, and work and decisions in Details on their project. A message
  older than the conversation's first window is reached by paging back (`app/apps/web/src/app/seekMessage.ts`,
  pages of 100 through the same authorized DM and conversation reads, at most 10,000 messages) and
  then shown and focused.
- **Recent places** (`app/apps/web/src/search/recent.ts`) are kept in this browser only, per account
  (`flux.places.recent.<userId>`), and every account's list is removed on sign-out. What is typed in
  Search is not remembered.

## Vectors: optional hybrid ranking (F-042, #1294)

Off unless the operator runs `docker/compose.embeddings.yaml` (text-embeddings-inference with bge-m3, pinned by digest) and the worker
finds `FLUX_EMBEDDINGS_URL`. Then ranked search (`searchRows(db, vectors).ranked`) fuses two lists inside its one statement, by
reciprocal rank (k = 60): the best 50 of the BM25 order above (computed over the visible hits, `rankedStatement`) and the best 50
by cosine distance of their vector to the vector of the query's words **among the rows the reader may see under the same filters**
(`hybridMatched` in `packages/db/src/repositories/search-vectors.ts`). A row in both lists ranks higher; a page is a position in that
fused list (at most 100 rows), and a vector that is missing, or a container that is down, leaves the BM25 list alone.

- **No hidden row moves the order here either** (#1293's rule). Every distance is computed exactly, over the visible, filtered rows
  only; there is no HNSW index. An HNSW scan walks a graph built over every vector of the instance and filters after its candidate
  list, so which visible rows it returns depends on the hidden ones: on #1341's review, at 50,000 visible vectors and `ef_search` 100,
  2,000 hidden rows near the queries changed the visible list of 4 of 20 queries. The exact list costs one distance per visible vector:
  about 40 ms at 50,000 at half precision kept in the row (170 ms for full-precision vectors read from TOAST), 23 ms at 10,000 at
  full precision, on one core. The visible rows come from the BM25 index's audience field (`sd.id @@@ pdb.all()` under the audiences;
  nothing is scored) and each one's vector by its key, so the work grows with what the reader may see, not with the instance: a plain
  join let PostgreSQL read every vector of the instance (`evidence/1294/review-1341/plan-probe.log` in the research folder).
  `search-vectors.test.ts` holds it with thirty hidden rows nearer to the query than anything visible.
- **The score** in a position is the fused sum scaled to (0, 1] (first in both lists: 1, first in one: 0.5), so that an encrypted
  space's rows still merge with it as they do with the squashed BM25 rank; the task a query names by its number keeps its added 10.

- **Storage** (migration 0068): `search_vectors` (`document_id`, `halfvec(1024)` kept in the row with `STORAGE PLAIN`, about 2 KiB) per `search_documents` row,
  `search_vector_queue` and `search_vector_state`. The one state row is what switches embeddings on; without it the triggers return at
  once, so an installation that never turns them on writes nothing here and sends no NOTIFY. The worker deletes the row, and empties
  both tables, at the first start without `FLUX_EMBEDDINGS_URL`.
- **Eligible rows** (`search_vector_eligible`): not sealed (an encrypted space's placeholder), not a person, some text, and, in a
  space, AI on (AG-10). The same rule decides the backfill, the triggers and the worker's claim.
- **A vector follows its row in the writer's transaction.** An edit of the title or body deletes the vector and queues the row; a
  delete takes it with it (the foreign key); a row that becomes sealed loses it; turning a space's AI off deletes its vectors, turning it
  on queues its rows. The worker stores a vector only for a row whose words still hash as they did when it was claimed, after taking
  a share lock on the row and on its space's policy, so an edit or a switch that is committing is never overtaken.
- **No polling.** The triggers NOTIFY `flux_search_vectors`; the worker wakes on it (and on a reconnection) and embeds the queue in
  batches of 16 until it is empty. A timer exists only after a failure, doubling from 2 s to 60 s. An idle worker issues no statement
  for it.
- **The query's vector** is asked of the container with a 1.5 s deadline; after a failure searches rank by BM25 alone for 30 s without
  waiting. A search never fails because embeddings are down.
- **Wiring.** `searchRows(db, vectors)` takes the hook (`searchQueryVectors(config.embeddings)` in the server, undefined while off);
  each caller of `ranked` passes the one instance the server created.
- **Tests:** `app/tests/app/search-vectors.test.ts` (off writes nothing; the pipeline; access, deletion, encrypted and AI-off checks for
  the vector path; fusion) against a fake embedding server, and `search-vectors-live.test.ts`, which runs only against the real
  container (`FLUX_EMBEDDINGS_URL`, see its header) and measures recall@10 of BM25 and of the hybrid.

## Tests

- `app/tests/app/search.test.ts` (in `./scripts/check_application.sh`) uses an owner, a contributor in
  a restricted project, a member outside it and a guest. It covers every kind and its label, place
  and target; the restricted project and a DM leaking nothing to an outsider, including when he
  filters by their ids; private maps reaching only their author, and a group DM
  hidden from the workspace owner; people for members but not guests; the API's type filters;
  an edit searchable at once and an old material version; docs as drafts and published, at the
  version that matched and once per doc; revocation by removing a grant and by
  leaving a DM on the very next search; ranking and typo tolerance; injection-safe queries; and
  sealed keyset pagination (another reader, another query or filter, or a forged cursor get
  `400`). **Saturation:** 300 hidden project messages, 100 thoughts in another person's private
  sketch and 60 DM messages give the outsider an identical answer (items, `next`) and
  identical work from `EXPLAIN (ANALYZE, BUFFERS)`: table rows, index scans, the keys they look up
  and the row addresses from the index, measured twice for determinism. Buffers of
  `search_documents` and its index were equal in every run; because writes anywhere can still add a
  level to the shared GIN entry tree or make a lookup follow a page split, the test compares the
  fewest buffers of several runs and allows an increase of at most one page per key lookup plus two
  per scan. A control checks that the insider's rows and index row addresses do grow (the exact statement, asked with quotes; the BM25 answer of plain words is
  held identical too). Plain words are covered in their own group (#1293): another form of a Polish word, a word without its accents,
  an English stem, any of the words, the rarer word first, a typed prefix, quotes, `or` and `-word` staying exact, a space the caller
  cannot read or has left, a direct message, and an edit, a removal and a deletion at once. Only a very coarse
  wall-clock sanity bound remains, because other test files share the database; the insider sees
  the hidden rows with `more`.
- `app/tests/ui/test_search.py` (in `./scripts/check_ui.sh`) covers Ctrl+K search as you type and
  opening the exact message, the sidebar entry, results in groups by kind with no chips, the keys, an old
  material version, a rule in Details, a thought selected in its sketch, Esc, a DM message, no results,
  the one-sentence hint, the "Showing 20" line under more than 20 results, an outsider seeing only the open project, recent places per account and their
  removal on sign-out, that there is no Search page, a DM message and a project message with 130 newer
  messages after them (outside the first window) opening exactly, task numbers, projects by name, the
  phone (full-screen sheet, 44 px targets, no horizontal scroll), and that the dialog has its final size
  on every frame after it opens, with a ready assistant (#898). Screenshots: [`docs/design/search/`](../design/search/).

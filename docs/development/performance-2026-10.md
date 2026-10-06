# Server performance, October 2026 (#298)

Founder direction [#266](https://github.com/ColdPhase/flux/issues/266) item 9: "The server can be
optimized; it is sometimes slow. Find the defects and test them." This page records how the
server was measured on realistic volume, what was slow, what changed and how the changes are
tested. **Observed** marks measured numbers and plans; **Inferred** marks conclusions drawn from
them.

## Result

- **Observed.** Before the changes every measured request already answered at p95 ≤ 300 ms server
  time in every phase. The slowest was the inbox for a workspace member: 87–94 ms isolated (two
  runs), p95 80 ms cold and 67 ms warm, on every navigation (the unread dot). PostgreSQL spent
  about 50 ms of it compiling JIT code for a count that ran in under 1 ms.
- **Observed.** Four other defects grew with the data or made reads write: the conversation list
  sent 208 statements for one page, the material list one statement per material, and the
  conversation stream and the Tasks view's comparison outcomes share-locked rows, so every read
  wrote WAL; removing the locks more than halved their time, which was mostly the commit's wait
  for the WAL flush (inferred).
- **Changed.** All five, each with a regression test that fails on the old code (below), and
  Flux's database connections no longer JIT-compile. The inbox count now follows the reader's own
  notifications: in a workspace with 20,000 drafts and 20,000 DMs it takes 2.5 ms, where the
  first version of this fix took 51 ms and `main` 56 ms. [Before and after](#before-and-after)
  has every request.
- **Not changed.** Work-read requests (Tasks board, work summary, associations) cost 30–50
  statements each by design (a re-checked session and policy fence) and their DB time is mostly
  planning; see [Follow-ups](#follow-ups).

## Method

**Stack.** `./scripts/check_performance.sh` starts the production-mode Compose stack
(`docker/compose.source.yaml`: the built runtime image, PostgreSQL 18.6, migrations, API and
worker) with one measurement-only overlay, `docker/compose.perf.yaml`. It loads
`pg_stat_statements` (top-level statements; `BEGIN` and `COMMIT` included; planning tracked) and
`auto_explain` (off until the plan phase). Nothing in the application is instrumented. Push,
mail, live media and background comparisons are off, so only the request paths are measured.

**Volume.** `scripts/perf-seed.mjs` writes only through the public HTTP API as signed-in people,
like `scripts/flux-demo.mjs`, so the access policy, idempotency, domain events and the worker's
notifications apply as in real use. Measured in the stack after seeding:

| Rows | Count |
| --- | ---: |
| People, workspaces, projects | 3, 1, 10 |
| Messages in one project (100 threads of 20) | 2,000 |
| Tasks (300 in that project, 200 across the other nine, owners rotating) | 500 |
| Map thoughts, linked | 200 |
| Docs / doc versions | 50 / 150 |
| Materials (beyond #298's list; the Conversation view reads them every 15 s) | 20 |
| Notifications per person (from replies, mentions and assignments) | 1,400 |
| Events / event audience rows / search documents | 2,884 / 8,649 / 2,874 |

Everyone's Home and project return points are saved before the busy period, so "Since you left"
and the project's "needs you" summarize all of it. The script waits until the worker stops
adding notifications, then stops the worker for the request measurements; what it runs while
idle is recorded first (about 330 pg-boss polling statements in 30 s, 3.4 ms of DB time in all).

**Requests.** `scripts/perf-measure.mjs` sends what the web app sends when it opens each view, in
the app's own groups and order, traced from the loaders and effects in `app/apps/web/src`: the
shell (`/me`, workspaces, projects, DMs, inbox dot, live capabilities), the project shell
(project, people, sketches, docs, work summary, "needs you") and each view's own reads. Search is
the search page's query, Jump to the quick switcher's (`limit=8`). One extra request is the
conversation list (`GET /projects/:id/conversations?limit=100`), which the doc link picker and the
MCP list tool read.

**Numbers.**

- *Server time* is Fastify's own `responseTime` from the API's request log, joined to the
  measurement windows by `scripts/perf_report.py`; p50/p95 by nearest rank.
- *Isolated*: each distinct request alone, once, with `pg_stat_statements` reset before it: its
  statements, their execution and planning time, and the WAL it caused (`pg_current_wal_lsn`).
- *Warm*: one unrecorded pass, then 20 runs of every view, by the owner and then by a member.
- *Cold*: 20 passes per person, each right after restarting PostgreSQL (empty shared buffers) and
  the API (new process, empty pool), with a different view first each time. The host's page
  cache is not dropped.
- *Two clients*: owner and member run the warm loop at the same time; API connections are sampled
  in `pg_stat_activity` meanwhile.
- *Plans*: `auto_explain` (`log_min_duration 0`, `ANALYZE`, `BUFFERS`) for one pass per person.
- *CPU*: a `--cpu-prof` profile of the API over two passes per person.

The host was shared with other agents' stacks; each run held the repository's Docker lock, so no
other test stack ran at the same time, but idle stacks of other checkouts did.

## Findings

### 1. The member's inbox count compiled JIT code on every navigation

- **Observed.** `GET /api/v1/inbox?limit=1` (the unread dot, sent on every pathname change and
  1.5 s after any stream event) took 1.3 ms of DB time for the owner and 52 ms for a member. The
  member's plan (baseline, `auto_explain`):

  ```
  Aggregate  (cost=138134.30..138134.31 rows=1) (actual time=52.027..52.030 rows=1 loops=1)
    ->  Index Scan using notifications_user_created_idx on notifications
          (cost=0.28..138132.55 rows=700) (actual time=51.492..51.994 rows=1400 loops=1)
          Filter: ... ((source_type = 'project') AND (ANY (source_id = (hashed SubPlan 14).col1)))
                  OR ((source_type = 'draft') AND EXISTS(SubPlan 34)) OR ... EXISTS(SubPlan 36) ...
          SubPlan 34 -> Bitmap Heap Scan on drafts (never executed)
          SubPlan 36 -> Nested Loop dms / dm_participants (never executed)
  JIT: Functions: 257  Timing: Generation 7.2 ms, Optimization 1.7 ms, Emission 49.4 ms, Total 58.3 ms
  ```

  PostgreSQL 18 already hashed the project check. The draft and DM checks stayed correlated
  subplans; they never ran, but the planner costed them once per notification, so the estimate
  (138,134) crossed `jit_above_cost` (100,000) and every count compiled JIT code. The owner's
  estimate was 81,070: under the threshold by about 400 notifications.
- **Inferred.** The cost grows with each person's notifications, so every member, and later
  every owner, pays about 50 ms (more on a slower CPU) per navigation. The query itself runs in
  under 1 ms.
- **Review of the first fix (3f6b3207).** Rewriting each check as `source_id IN (SELECT id FROM
  … WHERE <policy filter>)` removed the JIT at the #298 volume, but each set held every readable
  draft, DM or project of the workspace, so the count grew with the workspace instead. The
  reviewer measured a member with 3,000 notifications in a workspace of 20,000 drafts at 313 ms
  (cost 818k, 305 ms of JIT; the #298 seed has no drafts).
- **Changed** (`app/apps/server/src/push/adapters.ts`). Each set now starts from the reader's own
  notifications of that kind in that workspace and then passes the policy's unchanged
  `visibleFilter` condition:
  `source_id IN (SELECT d.id FROM drafts d WHERE d.id IN (<the reader's draft notifications>) AND
  <policy filter>)`. A notification's source is in that first set by construction, so the result is
  the same; the plan follows the reader's notifications only.
- **Changed** (`app/packages/db/src/index.ts`). Flux's own connections set `jit=off`, next to
  `idle_in_transaction_session_timeout`. *Why:* measured below, JIT made every shape slower, never
  faster: it only starts when an estimate passes `jit_above_cost`, and the access policy's
  subplans inflate estimates while the statements stay short. With JIT still on, no statement of
  the #298 volume used it after the first fix (after run at `2bf10b67`), and the new inbox shape
  stays at cost 3,623 at the review volume, so turning it off changes nothing measured here; it
  removes the 50–300 ms compile wherever an estimate crosses the threshold later. pg-boss keeps its own pool and
  settings.
- **Observed, review volume** (scratch measurement in the test stack, not committed: 300 projects,
  20,000 drafts and 20,000 group DMs the member can read; the member has 2,800 notifications about
  projects, 100 about drafts and 100 about DMs; `EXPLAIN ANALYZE` of the member's count, JIT set
  per transaction, median of 5):

  | Shape | JIT | ms (planning + execution) | Estimated cost | JIT functions | Drafts read | DMs read |
  | --- | --- | ---: | ---: | ---: | ---: | ---: |
  | correlated EXISTS (`main` 2979d7ce) | on | 56.3 | 162,299 | 207 | 100 | 20,000 |
  | correlated EXISTS (`main` 2979d7ce) | off | 13.5 | 162,299 | 0 | 100 | 20,000 |
  | set of every readable row (3f6b3207) | on | 51.1 | 313,705 | 164 | 20,000 | 20,000 |
  | set of every readable row (3f6b3207) | off | 17.6 | 313,705 | 0 | 20,000 | 20,000 |
  | set from the reader's notifications (now) | on | 2.7 | 3,623 | 0 | 100 | 100 |
  | set from the reader's notifications (now) | off | 2.5 | 3,623 | 0 | 100 | 100 |

  *Inferred:* the old correlated `EXISTS` also read every DM of the workspace (its DM check was not
  a primary-key lookup), so it grew with DMs as well; only the new shape stays with the reader.
- **Tests.** `inbox unread count` seeds that volume (batched under the 2 s query timeout), forces
  JIT on for its `EXPLAIN`, and reports four facts together: JIT functions, cost against
  `jit_above_cost`, rows read from drafts and from DMs. `application database connections`
  checks that a `createDatabase` connection has `jit=off`. On 3f6b3207's code (its inbox adapter
  and its `@flux/db` build mounted over the current ones):
  `actual: { jitFunctions: 164, costBelowJitThreshold: false, draftsRead: false, dmsRead: false }`
  (cost 313,625; 20,000 drafts and 20,000 DMs read) and `actual: { jit: 'on', idle: '1min' }`.

### 2. The conversation list sent two queries per conversation, all at once

- **Observed.** `GET /api/v1/projects/:id/conversations?limit=100` sent 208 statements: per
  conversation one query for its first and one for its last message, started together with
  `Promise.all` on the shared pool. During the two-client phase the pool held all 10 connections.
- **Inferred.** One such page asks for 200 connections at once, so other requests queue behind it
  for a free connection (the pool's connect timeout is 1.5 s).
- **Changed** (`app/apps/server/src/conversation/store.ts`). One statement reads the first and
  last message of every conversation on the page with two `LATERAL` index probes each.
- **Test** (`conversation and material pages`): a page of six conversations sends as many
  statements as a page of one, with the same first and last messages. Old code: 10 more.

### 3. The material list read each current version separately

- **Observed.** `GET /api/v1/projects/:id/materials?limit=100` sent 28 statements for 20
  materials (one per material, again with `Promise.all`); the Conversation view reads it on open
  and every 15 s.
- **Changed** (same file). The current versions of a page come from one statement on
  `(material_id, version) IN (…)`; a missing current version still throws, as before.
- **Test** (same test): six materials cost the same statements as one.

### 4. Reading the conversation stream and the comparison outcomes wrote WAL

- **Observed.** `GET /projects/:id/conversation-roots` (Conversation, on open and every 15 s)
  and `GET /projects/:id/proactive-comparison-outcomes` (Tasks, the same) caused 152–216 bytes of
  WAL per read: their access checks share-locked the project, grant and membership rows (`FOR
  SHARE`). A row lock takes a transaction id and writes WAL, so the commit waits for a WAL flush.
  Isolated, the stream took 26 ms for 12 statements with 1.3 ms of execution and 3 ms of planning.
- **Inferred.** The rest of those 26 ms is mostly the commit's flush; under concurrent readers the
  same rows also need multixacts. The access policy describes `lock: true` for mutation
  transactions.
- **Changed.** Both reads now run in one read-only repeatable-read transaction without locks
  (`listRoots` in `conversation/store.ts`; `comparisonOutcomeReads` in
  `proactive-comparison/outcome-adapter.ts`). The access decision and every row come from the same
  snapshot, so a revoke committed meanwhile cannot produce a partly authorized page; the reader
  sees the state before the revoke, as when its locks made the revoke wait. Dismissing an outcome
  still locks. The work reads (#155) and export already read this way.
- **Observed after.** No WAL; the stream's isolated time fell from 23 to 11 ms and its warm p95
  from 25–30 to 8–10 ms; the outcome page's warm p95 from 11–25 to 3–4 ms.
- **Tests** (`reads the project views refresh`): the stream and the outcome page each begin a
  `repeatable read, read only` transaction and send no `FOR SHARE`/`FOR UPDATE`. Old code:
  `begin` without either.

### Checked and not a defect

- **Pool waits.** *Observed:* with two clients the API had at most 5 of its 10 connections active
  or idle in a transaction at once (the rest open and idle), in every run. *Inferred:* apart from
  the conversation list's burst (finding 2), requests did not wait for a connection.
- **Worker and queue (observed).** The idle worker sends about 11 statements a second (pg-boss
  polling, the notification cursor), 3.4 ms of DB time in 30 s.
- **Node CPU (observed).** The profile shows the API idle most of the time; Drizzle's query
  building is the largest application cost. Time is spent waiting on round trips and planning.
- **Answer size (observed).** The largest answer is the map (14 kB compressed for 200 thoughts);
  JSON over 2 KiB is compressed since #269.

## Before and after

Same seed and scripts in each run. **Before:** the image built from `main` at `2979d7ce`; server
times from one full run, statements, DB time and isolated times from a second run of the same
image (`FLUX_PERF_PHASES="count plans"`, the measurement's own probes excluded). **After:** the
image built from this branch at `7824def2` (later commits change only documentation), one full
run. "→" separates before and after; a single value means no change. Isolated values are one
sample, so unchanged requests vary by a few milliseconds between runs, and cold values by more.

**Statements and database time per request** (one request each, `pg_stat_statements`; DB ms is the member's execution time):

| View | Request | Statements | DB ms | Isolated server ms (member) |
| --- | --- | ---: | ---: | ---: |
| Home | me | 3 → 5 | 0.1 | 1.7 → 1.8 |
| Home | workspaces | 4 → 5 | 0.1 | 1.7 → 2.0 |
| Home | projects | 6 | 0.1 → 0.2 | 3.8 → 4.2 |
| Home | dms | 9 | 0.1 | 2.4 → 3.8 |
| Home | inbox dot | 10 | 52 → 1.4 | 87 → 6.9 |
| Home | live capabilities | 0 | 0.0 → 0.1 | 0.1 |
| Home | since you left | 41 | 2.9 | 20 |
| Home | assistant | 7 | 0.0 → 0.1 | 3.1 → 2.5 |
| Home | drafts | 6 | 0.1 | 5.0 → 3.2 |
| Conversation | project | 6 | 0.1 | 2.1 → 2.4 |
| Conversation | project people | 17 | 0.2 | 4.7 → 4.5 |
| Conversation | project sketches | 13 → 12 | 0.2 | 5.8 → 5.3 |
| Conversation | project docs | 11 | 0.3 | 5.5 |
| Conversation | work summary | 44 → 42 | 0.9 → 0.8 | 18 → 15 |
| Conversation | needs you | 28 | 2.6 → 2.3 | 13 |
| Conversation | conversation roots | 12 → 10 | 1.3 | 23 → 11 |
| Conversation | task notices | 11 | 0.5 → 0.4 | 6.3 → 5.8 |
| Conversation | materials | 28 → 10 | 0.5 → 0.2 | 5.4 → 4.8 |
| Conversation | members | 5 | 0.1 | 4.2 → 2.4 |
| Conversation | assistant runs | 7 | 0.1 | 3.6 → 3.1 |
| Conversation | root work associations | 36 | 1.1 → 1.2 | 33 → 31 |
| Conversation | notice reference rows | 32 | 1.8 → 1.9 | 23 → 24 |
| Conversation thread | thread | 10 | 0.2 → 0.1 | 6.1 → 4.9 |
| Conversation thread | assistant answers | 11 | 0.1 | 2.5 → 3.2 |
| Conversation thread | assistant proposals | 10 | 0.1 | 3.0 → 3.6 |
| Tasks | comparison outcomes | 12 → 10 | 0.1 | 20 → 5.2 |
| Tasks | work view open | 49 → 48 | 1.5 → 1.6 | 21 → 25 |
| Tasks | work view in_progress | 48 | 1.4 → 1.5 | 20 → 22 |
| Tasks | work view blocked | 44 | 0.8 | 14 → 16 |
| Tasks | work view finished | 48 | 1.5 → 1.7 | 20 → 22 |
| Tasks | work relations 1 | 31 | 0.5 | 23 |
| Tasks | work relations 2 | 31 | 0.4 → 0.5 | 19 → 22 |
| Map | sketch list | 12 → 13 | 0.2 | 5.2 → 5.4 |
| Map | sketch | 15 | 0.6 | 9.4 → 9.7 |
| Map | thought tasks 1 | 30 | 0.5 | 15 |
| Map | thought tasks 2 | 30 | 0.4 → 0.5 | 14 → 15 |
| Wiki | doc | 13 | 0.2 | 3.5 → 3.7 |
| Inbox | inbox | 10 | 53 → 1.4 | 81 → 9.1 |
| Search | search | 17 | 3.6 → 3.7 | 18 → 14 |
| Jump to | jump to | 17 | 6.4 → 6.2 | 13 |
| Link picker | conversation list | 208 → 9 | 2.9 → 0.5 | 21 → 5.4 |

**Server time, p50 / p95 in ms**, before → after (cold: 20 passes per person after restarting PostgreSQL and the API; warm: 20 runs per person; two clients: owner and member at once, 20 runs each):

| View | Request | Cold, owner | Cold, member | Warm, owner | Warm, member | Two clients |
| --- | --- | --- | --- | --- | --- | --- |
| Home | me | 1.3 / 11 → 1.3 / 12 | 1.3 / 12 → 1.2 / 11 | 0.9 / 1.2 → 0.9 / 1.2 | 0.9 / 1.2 → 0.9 / 1.1 | 1.1 / 2.5 → 1.2 / 2.5 |
| Home | workspaces | 1.8 / 4.7 → 1.7 / 4.6 | 1.8 / 4.7 → 1.7 / 4.6 | 1.2 / 1.5 → 1.1 / 1.4 | 1.1 / 1.4 → 1.1 / 1.2 | 1.3 / 2.9 → 1.4 / 3.0 |
| Home | projects | 3.2 / 6.8 → 3.1 / 6.9 | 3.8 / 7.5 → 3.7 / 7.9 | 2.5 / 3.0 → 2.5 / 2.8 | 3.0 / 3.4 → 3.0 / 3.3 | 3.1 / 5.3 → 3.5 / 5.4 |
| Home | dms | 3.4 / 6.0 → 3.4 / 6.0 | 3.5 / 6.2 → 3.2 / 6.3 | 1.9 / 2.9 → 1.9 / 2.3 | 1.8 / 2.2 → 1.8 / 2.1 | 2.1 / 4.0 → 2.6 / 4.3 |
| Home | inbox dot | 6.8 / 10 → 6.8 / 11 | 76 / 80 → 7.6 / 11 | 5.0 / 6.2 → 5.2 / 6.1 | 62 / 67 → 5.8 / 6.5 | 24 / 74 → 6.8 / 9.8 |
| Home | live capabilities | 0.1 / 0.2 → 0.1 / 0.2 | 0.1 / 0.2 → 0.1 / 0.2 | 0.0 / 0.1 → 0.0 / 0.1 | 0.0 / 0.0 → 0.0 / 0.0 | 0.0 / 0.1 → 0.0 / 0.1 |
| Home | since you left | 26 / 40 → 24 / 56 | 27 / 42 → 26 / 51 | 16 / 19 → 16 / 18 | 18 / 20 → 17 / 19 | 21 / 33 → 21 / 26 |
| Home | assistant | 6.4 / 8.4 → 6.7 / 14 | 6.6 / 8.3 → 6.2 / 13 | 3.3 / 4.1 → 3.4 / 4.2 | 3.2 / 4.2 → 3.1 / 4.0 | 3.7 / 7.4 → 4.0 / 6.9 |
| Home | drafts | 7.8 / 15 → 6.9 / 20 | 9.3 / 15 → 7.2 / 18 | 2.9 / 5.4 → 2.8 / 3.1 | 3.4 / 4.3 → 3.1 / 4.1 | 4.0 / 5.6 → 4.4 / 6.4 |
| Conversation | project | 1.9 / 3.3 → 1.9 / 3.1 | 2.6 / 3.9 → 2.1 / 3.5 | 1.5 / 1.8 → 1.5 / 1.7 | 2.0 / 2.2 → 1.6 / 1.9 | 2.0 / 3.7 → 2.0 / 3.9 |
| Conversation | project people | 7.3 / 12 → 7.8 / 12 | 8.0 / 12 → 8.2 / 12 | 5.3 / 8.3 → 5.4 / 6.7 | 5.6 / 6.6 → 5.3 / 7.1 | 6.4 / 11 → 7.6 / 12 |
| Conversation | project sketches | 6.8 / 18 → 7.1 / 19 | 8.1 / 20 → 8.0 / 18 | 4.9 / 7.7 → 4.8 / 6.0 | 5.7 / 7.2 → 5.6 / 7.6 | 6.1 / 9.6 → 7.2 / 11 |
| Conversation | project docs | 7.7 / 20 → 7.7 / 20 | 7.9 / 20 → 8.1 / 22 | 5.5 / 8.3 → 5.5 / 6.5 | 5.7 / 6.6 → 5.6 / 7.3 | 6.4 / 11 → 7.6 / 12 |
| Conversation | work summary | 27 / 52 → 25 / 57 | 23 / 48 → 22 / 51 | 20 / 24 → 19 / 23 | 17 / 20 → 17 / 19 | 22 / 29 → 24 / 32 |
| Conversation | needs you | 24 / 56 → 23 / 56 | 17 / 38 → 17 / 42 | 17 / 19 → 17 / 19 | 12 / 14 → 11 / 13 | 17 / 22 → 19 / 26 |
| Conversation | conversation roots | 30 / 40 → 14 / 16 | 29 / 36 → 15 / 17 | 23 / 25 → 7.9 / 9.0 | 25 / 30 → 7.2 / 9.0 | 29 / 38 → 9.8 / 12 |
| Conversation | task notices | 14 / 17 → 11 / 14 | 13 / 18 → 12 / 14 | 8.1 / 9.3 → 6.8 / 8.7 | 7.8 / 9.9 → 6.6 / 7.9 | 8.5 / 14 → 9.4 / 11 |
| Conversation | materials | 11 / 20 → 11 / 14 | 12 / 20 → 9.5 / 12 | 7.4 / 8.6 → 5.8 / 7.3 | 7.5 / 9.6 → 5.7 / 7.4 | 8.0 / 14 → 8.0 / 10 |
| Conversation | members | 5.5 / 11 → 5.6 / 7.2 | 5.4 / 8.5 → 5.8 / 7.7 | 2.6 / 3.0 → 2.9 / 3.2 | 2.7 / 3.0 → 2.6 / 3.3 | 3.2 / 5.6 → 4.3 / 5.9 |
| Conversation | assistant runs | 7.7 / 9.6 → 8.1 / 9.5 | 7.5 / 9.5 → 8.3 / 9.6 | 3.7 / 4.2 → 3.7 / 4.3 | 3.5 / 4.1 → 3.5 / 4.0 | 4.3 / 8.4 → 4.6 / 7.1 |
| Conversation | root work associations | 39 / 46 → 37 / 40 | 40 / 46 → 38 / 44 | 28 / 30 → 28 / 31 | 28 / 32 → 28 / 30 | 34 / 40 → 35 / 42 |
| Conversation | notice reference rows | 36 / 43 → 33 / 38 | 38 / 42 → 36 / 39 | 23 / 25 → 24 / 28 | 23 / 29 → 23 / 25 | 29 / 35 → 31 / 36 |
| Conversation thread | thread | 6.3 / 25 → 6.7 / 22 | 7.1 / 24 → 6.7 / 24 | 3.4 / 4.9 → 3.3 / 3.9 | 3.4 / 3.7 → 3.6 / 5.0 | 4.2 / 5.9 → 4.7 / 7.3 |
| Conversation thread | assistant answers | 4.9 / 7.3 → 5.3 / 7.5 | 5.2 / 7.0 → 5.3 / 7.3 | 2.5 / 3.8 → 2.5 / 3.7 | 2.6 / 3.4 → 2.6 / 3.0 | 3.1 / 5.1 → 4.2 / 6.7 |
| Conversation thread | assistant proposals | 4.1 / 14 → 4.4 / 13 | 4.4 / 13 → 4.5 / 13 | 2.4 / 3.3 → 2.2 / 3.2 | 2.3 / 2.8 → 2.3 / 2.8 | 2.9 / 4.8 → 3.8 / 6.6 |
| Tasks | comparison outcomes | 12 / 26 → 5.6 / 6.4 | 21 / 22 → 5.5 / 7.0 | 8.8 / 11 → 2.4 / 3.8 | 20 / 25 → 2.4 / 3.2 | 23 / 34 → 3.4 / 6.0 |
| Tasks | work view open | 37 / 63 → 39 / 61 | 38 / 62 → 42 / 63 | 27 / 32 → 28 / 32 | 27 / 33 → 27 / 29 | 33 / 47 → 37 / 45 |
| Tasks | work view in_progress | 39 / 62 → 41 / 62 | 37 / 61 → 42 / 63 | 27 / 33 → 27 / 30 | 27 / 31 → 26 / 28 | 34 / 44 → 35 / 42 |
| Tasks | work view blocked | 31 / 53 → 29 / 55 | 28 / 51 → 32 / 54 | 21 / 23 → 21 / 24 | 21 / 25 → 20 / 22 | 24 / 34 → 28 / 36 |
| Tasks | work view finished | 37 / 63 → 39 / 65 | 37 / 66 → 43 / 65 | 27 / 32 → 28 / 30 | 27 / 32 → 27 / 29 | 34 / 48 → 36 / 43 |
| Tasks | work relations 1 | 25 / 29 → 26 / 27 | 26 / 29 → 27 / 29 | 23 / 25 → 23 / 25 | 23 / 25 → 24 / 26 | 27 / 33 → 29 / 38 |
| Tasks | work relations 2 | 22 / 26 → 23 / 26 | 23 / 26 → 24 / 28 | 20 / 23 → 20 / 22 | 20 / 23 → 21 / 22 | 24 / 32 → 27 / 33 |
| Map | sketch list | 5.2 / 7.9 → 3.9 / 7.6 | 4.5 / 8.8 → 4.7 / 8.7 | 3.1 / 3.5 → 3.1 / 3.6 | 3.8 / 4.1 → 3.9 / 5.1 | 4.1 / 6.2 → 4.8 / 8.0 |
| Map | sketch | 11 / 13 → 11 / 13 | 11 / 14 → 12 / 13 | 8.0 / 9.8 → 8.0 / 8.8 | 8.3 / 9.1 → 8.3 / 9.4 | 9.1 / 13 → 9.7 / 13 |
| Map | thought tasks 1 | 19 / 24 → 20 / 25 | 19 / 23 → 20 / 24 | 15 / 18 → 15 / 16 | 15 / 21 → 15 / 17 | 17 / 25 → 20 / 26 |
| Map | thought tasks 2 | 21 / 24 → 19 / 23 | 20 / 25 → 19 / 23 | 15 / 17 → 15 / 16 | 15 / 21 → 15 / 17 | 17 / 24 → 20 / 28 |
| Wiki | doc | 9.1 / 12 → 9.3 / 12 | 9.3 / 11 → 9.0 / 11 | 2.7 / 3.7 → 2.7 / 4.3 | 2.8 / 3.2 → 2.7 / 2.9 | 3.1 / 5.6 → 3.5 / 5.5 |
| Inbox | inbox | 6.9 / 8.4 → 7.0 / 9.5 | 62 / 65 → 7.9 / 10 | 6.2 / 7.0 → 6.5 / 7.2 | 62 / 64 → 7.1 / 7.7 | 8.8 / 81 → 8.5 / 12 |
| Search | search | 18 / 37 → 17 / 38 | 20 / 40 → 19 / 37 | 10 / 13 → 10 / 13 | 11 / 14 → 11 / 11 | 12 / 17 → 13 / 15 |
| Jump to | jump to | 12 / 38 → 12 / 37 | 13 / 39 → 14 / 40 | 11 / 12 → 11 / 13 | 12 / 14 → 12 / 13 | 13 / 15 → 14 / 19 |
| Link picker | conversation list | 31 / 70 → 6.4 / 24 | 33 / 66 → 7.4 / 22 | 19 / 23 → 4.2 / 4.8 | 19 / 22 → 4.3 / 4.8 | 21 / 27 → 5.4 / 8.3 |

- **Observed.** After, the slowest p95 is 65 ms cold (the Tasks board's `work view finished`),
  32 ms warm and 45 ms with two clients (`work view open`). Before, the slowest were the member's
  inbox dot (87 ms isolated, p95 80 ms cold, 67 ms warm) and inbox (p95 81 ms with two clients).
- **Observed.** With two clients the API had at most 5 (before) and 7 (after) of its 10
  connections active or idle in a transaction at once (`pg_stat_activity` samples).
- **Observed.** The plan pass of the after run (`auto_explain`, every statement of one pass per
  person) shows no JIT; neither did the earlier after run at `2bf10b67`, which still had JIT on.
- **Inferred.** Every request listed in #298 answers at p95 ≤ 300 ms server time on this volume,
  before and after. The changes remove costs that grow with a person's notifications, a page's
  rows, the workspace's drafts and DMs, and concurrent readers, which would cross it at larger
  volume.

## Plans after

The member's unread count after (`auto_explain`, #298 volume). Each set is a semi-join of the
workspace's rows with the reader's own notifications (`notifications_source_idx`); with 20,000
drafts and DMs the planner drives it from the reader's hundred instead (see finding 1):

```
Aggregate  (cost=590.54..590.55 rows=1) (actual time=0.573..0.575 rows=1 loops=1)
  ->  Bitmap Heap Scan on notifications  (cost=287.79..588.79 rows=700) (actual time=0.132..0.540 rows=1400 loops=1)
        Filter: ... ((source_type = 'project') AND (ANY (source_id = (hashed SubPlan 7).col1))) OR ...
        SubPlan 7
          ->  Nested Loop Semi Join  (cost=0.43..70.60 rows=1) (actual rows=4 loops=1)
                ->  Index Scan using projects_workspace_id_id_key on projects (actual rows=10 loops=1)
                      Filter: (CASE WHEN (ANY (id = (hashed SubPlan 2).col1)) THEN 0 ... END >= 1)
                ->  Index Scan using notifications_source_idx on notifications mine (actual rows=0.4 loops=10)
                      Index Cond: ((source_type = 'project') AND (source_id = projects.id))
        SubPlan 17 (drafts) and the DM subplan: the same shape, never executed here
(no JIT)
```

The conversation list's first and last messages, one statement for a page of 100 (it replaces 200
statements of the form `… WHERE conversation_id = $1 ORDER BY sequence ASC|DESC LIMIT 1`, each an
index scan of about 0.02 ms plus a round trip):

```
Nested Loop  (cost=0.56..819.97 rows=100) (actual time=0.019..0.283 rows=100 loops=1)
  ->  Nested Loop  (actual time=0.012..0.181 rows=100 loops=1)
        ->  Values Scan on "*VALUES*"  (actual rows=100 loops=1)
        ->  Limit  (actual rows=1 loops=100)
              ->  Index Scan using project_messages_conversation_idx on project_messages m (actual rows=1 loops=100)
  ->  Limit  (actual rows=1 loops=100)
        ->  Index Scan Backward using project_messages_conversation_idx on project_messages m_1 (actual rows=1 loops=100)
Execution: 0.341 ms
```

The material page's current versions, one statement for 20 materials (it replaces 20 primary-key
lookups):

```
Bitmap Heap Scan on project_material_versions  (cost=4.23..15.43 rows=8) (actual time=0.013..0.019 rows=20 loops=1)
  ->  Bitmap Index Scan on project_material_versions_pkey  (actual rows=20 loops=1)
        Index Cond: (material_id = ANY ('{…20 ids…}'::uuid[]))
```

The conversation stream's and the outcome page's statements keep their plans; they lose the `FOR
SHARE` statements (2 per read) and run in a `read only` transaction, so they write no WAL (0 bytes
after, 152–216 before).

## Follow-ups

- **Work reads (#155).** Each bounded work read (work view, work summary, relations,
  associations, reference rows, thought tasks) sends 30–50 statements: its read transaction, then
  a final fence that resolves the session three more times and the project twice, by design. Most
  of their DB time is planning (the `link_facts` fingerprint plans in 1.4–2.9 ms, twice per
  request). Prepared statements or a lighter fence would cut 10–20 ms each; that changes #155's
  accepted read contract, so it needs its own decision.
- **Session lookups.** Every session resolution also reads `jwks` and signs a JWT for Better
  Auth's `set-auth-jwt` header, which Flux never reads (one statement per resolution, four per
  work read). `jwt({ disableSettingJwtHeader: true })` would remove it; it changes
  `/api/auth/get-session`'s headers.
- **Client.** Not server time, but what people feel: the shell loader is a sequential waterfall
  (`/me`, workspaces, then projects and DMs per workspace), project views fetch the project two to
  four times, and Conversation, Tasks and Wiki poll by revalidating every loader every 15–20 s.
- **Other locked reads.** `GET /projects/:id/proactive-comparison-proposals`, the MCP source
  material list and some live-session reads also share-lock on read; not measured here.

## Reproduce

```sh
./scripts/check_performance.sh                 # build, seed, measure, report (about 15 minutes)
FLUX_PERF_IMAGE_TAG=<tag> ./scripts/check_performance.sh            # an already built image
FLUX_PERF_PHASES="count plans" ./scripts/check_performance.sh       # statements and plans only
```

Results go to `perf-results/<time>/` (`report.md`, `measure.jsonl`, `api.log`, `plans.log`,
`profile/`). The regression tests are `app/tests/app/server-performance.test.ts`, run by
`./scripts/check_application.sh`.

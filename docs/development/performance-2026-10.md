# Server performance, October 2026 (#298)

Founder direction [#266](https://github.com/ColdPhase/flux/issues/266) item 9: "The server can be
optimized; it is sometimes slow. Find the defects and test them." This page records how the
server was measured on realistic volume, what was slow, what changed and how the changes are
tested. **Observed** marks measured numbers and plans; **Inferred** marks conclusions drawn from
them.

## Result

- **Observed.** Before the changes every measured request already answered at p95 ≤ 300 ms server
  time in every phase. The slowest was the inbox for a workspace member: 94 ms isolated, p95 80 ms
  cold and 67 ms warm, on every navigation (the unread dot). PostgreSQL spent about 50 ms of it
  compiling JIT code for a count that ran in under 1 ms.
- **Observed.** Four other defects grew with the data or made reads write: the conversation list
  sent 208 statements for one page, the material list one statement per material, and the
  conversation stream and the Tasks view's comparison outcomes share-locked rows, so every read
  wrote WAL; removing the locks more than halved their time, which was mostly the commit's wait
  for the WAL flush (inferred).
- **Changed.** All five, each with a regression test that fails on the old code (below). After:
  the member's inbox dot takes 5.6 ms warm (p95), the conversation stream 8–10 ms, the outcome
  page 3–4 ms and the conversation list 9 statements; [Before and after](#before-and-after) has
  every request.
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
- **Changed** (`app/apps/server/src/push/adapters.ts`). Each source set is an uncorrelated
  `source_id IN (SELECT id FROM … WHERE <policy filter>)`. The policy's own `visibleFilter`
  conditions are unchanged; PostgreSQL builds each set once and probes a hash per row. After:
  see the plan in [Plans after](#plans-after).
- **Test** (`inbox unread count`): 3,000 notifications for a member plus 5 about a project they
  cannot read; the count stays 3,000, its estimated cost stays below `jit_above_cost` and no JIT is
  compiled. On the old code it fails: `estimated cost 295103.46 stays below jit_above_cost 100000`.

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

Same seed, same scripts. Before: image built from `main` at `2979d7ce`; timings from one full run,
statement counts and plans from a second run of the same image with the measurement's own probes
excluded. After: image built from this branch at `2bf10b67` (later commits change only tests,
scripts and docs). Times are server time in ms; "→" separates before and after, and a single
value means no change. "DB ms" is execution time in PostgreSQL for one request by the member;
"Isolated" is one sample, so unchanged requests vary by a few milliseconds between runs, and the
cold numbers by more.



- **Observed.** After, the slowest p95 in any phase is 68 ms (the Tasks board's `work view
  finished`, cold); warm it is 31 ms and with two clients 42 ms (both `work view`). Before, the
  slowest were the member's inbox dot (94 ms isolated, 80 ms cold, 67 ms warm) and inbox (81 ms
  with two clients).
- **Observed.** With two clients the API never had more than 5 connections active or idle in a
  transaction at once, before or after (sampled from `pg_stat_activity`, pool size 10).
- **Inferred.** Every request listed in #298 answers at p95 ≤ 300 ms server time on this volume,
  before and after; the changes remove the costs that grow with notifications, rows per page and
  readers, which would have crossed it at larger volume.

## Plans after

The member's unread count (`auto_explain`, after; the policy's subplans for drafts and DMs are
hashed the same way and were not executed):

```
Aggregate  (cost=573.08..573.09 rows=1) (actual time=0.541..0.543 rows=1 loops=1)
  Buffers: shared hit=281
  ->  Bitmap Heap Scan on notifications  (cost=270.33..571.33 rows=700) (actual time=0.100..0.508 rows=1400 loops=1)
        Filter: ... ((source_type = 'project') AND (ANY (source_id = (hashed SubPlan 7).col1))) OR ...
        ->  Bitmap Index Scan on notifications_user_created_idx (actual time=0.060..0.060 rows=1400 loops=1)
        SubPlan 7
          ->  Index Scan using projects_workspace_id_id_key on projects (actual time=0.018..0.020 rows=10 loops=1)
                Filter: (CASE WHEN (ANY (id = (hashed SubPlan 2).col1)) THEN 0 ... END >= 1)
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
- **JIT.** Any query whose estimate crosses `jit_above_cost` pays tens of milliseconds of
  compilation. Only the inbox count did at this volume; turning JIT off for the application's
  connections would remove the risk for queries not measured here.
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

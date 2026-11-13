# Fast and light Flux, November 2026 (#850, #862)

Hubert, 2026-11-02: optimise the whole application so it is faster and uses fewer resources. The target host
(2026-11-03) is a **VPS with 2 vCPU and 4 GB**, for a team of a few people with a few agents. This page records
what [#850](https://github.com/ColdPhase/flux/issues/850) measured and changed on the server side and in the request
count, how to measure it again, and what is left. **Observed** marks measured numbers, **Inferred** marks conclusions
drawn from them. The October server measurement is in [performance-2026-10.md](performance-2026-10.md).

The client's data layer (live push in place of 15–20 s polling, instant actions, non-blocking route loaders) is a
separate batch and is not redesigned here.

## Targets and where they stand

The targets are the ones Hubert agreed on 2026-11-03 (#862). "Before" is `main` at `6272b57a8`; "after" is the same
`main` plus this change, measured with the same script on the same host, one after the other.

| Target | Before | After | Verdict |
| --- | ---: | ---: | --- |
| Idle: at most 2% of one core | 1.4% (api 0.30, worker 0.32, database 0.75) | 0.8% (api 0.21, worker 0.19, database 0.44) | met |
| Idle: at most 100 database statements a minute | 122 | 95; 97 at the v0.2 candidate, measured after pg-boss's daily queue sweep ([#1178](https://github.com/ColdPhase/flux/issues/1178)) | met, narrowly, see [Idle statements](#idle-statements) |
| An open tab: at most 4 requests a minute | not measured here | 0 in each of Home, Inbox, Conversation, Tasks, Map and Wiki (was 3 to 70) | met, see [Live invalidation](#live-invalidation-and-no-idle-polling-862-the-data-layers-second-part) |
| An open Map or Wiki editor, idle | a read of the room every 250 ms (240 a minute) | a read every 2 s after 5 s of quiet (30 a minute); a cursor that did not move sends nothing | changed, see [Editors](#editors) |
| A navigation: at most 8 requests, none repeated | 3, 4, 21, 11, 4, 8, 16, 21, 4 | 3, 4, 19, 10, 4, 8, 15, 18, 4; with kept reads (#862) 2, 3, 15, 7, 4, 5, 15, 16, 4; with live invalidation 2, 3, 14, 7, 4, 4, 11, 16, 4 | not met for the three moves into a Conversation in v0.2, see [Live invalidation](#live-invalidation-and-no-idle-polling-862-the-data-layers-second-part) and [#1109](https://github.com/ColdPhase/flux/issues/1109) |
| p95 at most 50 ms on 2 vCPU | 69 ms for all requests; 19 of 40 requests over 50 ms | 59 ms; 14 of 40 over 50 ms. With [#1178](https://github.com/ColdPhase/flux/issues/1178): the warm @1cpu phases 19 and 16 ms, 0 of 38 over; the concurrent @1cpu phase 42 ms, 10 of 38 over | warm phases at the target, not reliably under it: at the release candidate 0 to 3 of 38 requests reached 51–58 ms (see [At the release candidate](#at-the-release-candidate-2233996ad-2026-11-10)); the concurrent phase is deferred to v0.3 (founder decision, 2026-11-10), see [The concurrent phase](#the-concurrent-phase-deferred-to-v03-founder-decision-2026-11-10). With [#1191](https://github.com/ColdPhase/flux/issues/1191), on a host that was not quiet: concurrent 22–26 ms, 1 to 4 of 38 over; warm 0 over, see [v0.2.1](#the-concurrent-phase-v021-1191-2026-11-12) |
| First visit: at most 250 KB before content | 326 KB brotli, 41 files | 327 KB brotli, 41 files; 241 KB, 36 files with [#1178](https://github.com/ColdPhase/flux/issues/1178) | met with #1178, see [First screen](#first-screen) |
| Restart to healthy: at most 5 s | API alone 5.8 s median | 5.1 s median | at the target within the noise of the host |

**Observed.** The host is a shared 24-core development machine with other jobs running, so wall-clock numbers (p95,
restart) move by tens of per cent between runs of the same code. Counts do not: statements per request, requests per
navigation and the CPU of an idle stack are the evidence; times are context.

## What changed

- **Single sign-on only: nothing flashes ([#847](https://github.com/ColdPhase/flux/issues/847)).** The sign-in route
  reads what sign-in offers beside the check for an existing session, so the page renders once, with the provider
  button and without the password form. The server's provider probe is stale-while-revalidate: only the first answer
  waits for the probe, a later one returns the last known state at once and checks again in the background.
  `test_sign_in_provider` holds the capabilities read back and records every frame for a password field, "Forgot
  password?" or "Create an account" (none), and an aborted read gives the ordinary password page.
- **Editors.** `apps/server/src/editing/cadence.ts`: a Map or Wiki connection is read on its timer every 250 ms only
  while something happens to it (a message, a NOTIFY, work in flight, 5 s after the last of these) and every 2 s
  otherwise, so a person who lost access still hears of it within 2 s. A presence heartbeat that changes nothing is no
  longer a write that wakes the other editors (`setPresence` answers `new`, `changed` or `renewed`; only the first two
  are announced), and the client sends presence when it changed or every 2 s.
- **Requests.** The project shell's reads (the project, its people and its docs) that are in flight together are one
  request (`share: true` in `api/client.ts`); each caller parses its own copy, aborting stops the request only when every
  caller has aborted. The sharing ends when a write of this tab is sent and settles, when an event of the live stream arrives (another
  tab's write, someone else's change) and when the stream asks for a re-read, so a read asked for after a change never joins one
  that began before it (`stream-ends-shared-reads.test.ts`). Reads that do not ask
  are never shared: views that hold or reorder their own reads (the Inbox, the focus pause, the Tasks refresh) need each
  answer to be its own, and sharing every read broke four of their tests. The shell reads the person and the workspaces
  together, then the projects, conversations and agents together: two round trips, not four in a row. The video-call
  code (`MediaClient`, 130 KB brotli) is not downloaded ahead of time by the service worker.
- **Sessions.** Better Auth no longer signs a token for a `set-auth-jwt` header on every session read; nothing in Flux
  reads it. Every authenticated request has one statement fewer per session check, a work read four fewer.
- **Measuring.** `scripts/check_performance.sh` gains a CPU-limited phase (`limited`: the API and the database at
  `FLUX_PERF_CPUS`, default 1.0, which stands for 2 vCPU) that holds every request to a 50 ms p95, a `bundle` phase
  (first-screen files and bytes, the service worker's precache), idle CPU and idle statements over 60 s, and restart
  times; `FLUX_PERF_PHASES=restart` times only the API's restarts. `app/tests/ui/test_navigation_requests.py` counts the
  API requests of nine moves and fails a move that costs more than the budget recorded in it.
- **Kreska ([#849](https://github.com/ColdPhase/flux/issues/849)).** Already fixed by #891 (the marks sit outside the
  frame, `kreska-marks.test.ts` samples every size); nothing left in this change. The design board image (AC-3) is not
  regenerated.

## Server time

**Observed.** Both columns run concurrent clients with the API and the database each limited to 1 CPU. The p95 of the
same request varies by 20–40 ms between two runs of the same code on this host, so the milliseconds below say "slow",
not "how slow". The statements are exact.

| Request | Statements | p95 before | p95 after |
| --- | ---: | ---: | ---: |
| Tasks: work view (open) | 48 → 44 | 97 ms | 101 ms |
| Tasks: work relations | 31 → 27 | 111 ms | 82 ms |
| Conversation: root work associations | 37 → 33 | 104 ms | 118 ms |
| Conversation: work summary | 42 → 38 | 88 ms | 72 ms |
| Conversation: notice reference rows | 32 → 28 | 87 ms | 73 ms |
| Conversation: needs you | 36 → 33 | 80 ms | 66 ms |
| Map: thought tasks | 30 → 26 | 77 ms | 90 ms |
| Home: since you left | 49 → 46 | 72 ms | 73 ms |
| Home: inbox dot | 20 → 17 | 60 ms | 37 ms |

**Observed.** One request alone (no load) takes 20–45 ms for the work reads, and most of the database's share is
planning: a work view spends 2.6 ms executing 44 statements and 7.6 ms planning them, the associations read 1.9 ms
against 15 ms. The two `link_facts` fingerprint queries plan in about 4 ms each (sixteen `EXISTS` branches in a `CASE`),
and the read contract of [#155](https://github.com/ColdPhase/flux/issues/155) checks the session four times (one to
start, three around the final policy query), two statements each.

**Inferred.** The work reads cannot reach 50 ms at p95 on one CPU without removing planning or statements. Neither
changes what a read answers, but both touch the accepted read contract's code, so they are follow-ups with their own
decision, not part of this change:

1. Plan once: run the fingerprint, relations and associations queries as named prepared statements (generic plans), or
   rewrite `nativeWorkEndpointVisible` as joins per kind. Expected: 5–15 ms off each work read.
2. One statement for a session check (the session and its user in one join), and a final fence that resolves the
   session twice rather than three times. Expected: 4 statements off each work read.

### Planned once, and one session read fewer ([#1178](https://github.com/ColdPhase/flux/issues/1178), 2026-11-10)

**Observed** (the v0.2 candidate, ten warm passes of every view by one person, `pg_stat_statements`): 11,748 statements, which
the database spent 1,189 ms planning and 625 ms running.
- The work reads' visibility fingerprint alone took 384 ms of the planning (264 calls, 1.45 ms each, against 0.03 ms to run).
- The visible-edge filter of the associations, relations, references and thought reads took most of the rest: one to three
  milliseconds each.
- Every work read also resolved the session four times, two statements each.

**Changed.**
- **Prepared statements.** Those statements run as named prepared statements (`executePrepared` in `@flux/db`), so a connection
  plans each a few times and then may reuse a generic plan. The name is a hash of the text. Lists of ids or objects became one
  array parameter (`= ANY($1::uuid[])`, `unnest($1::text[], $2::uuid[])`), so each statement has a text of fixed shape and a
  connection keeps a handful of them, not one for each length of a list.
- **The final fence.** It no longer resolves the session before its own refusing reads (the project, the sources, the objects,
  the fingerprint). Those reads only refuse (404, 409), and nothing is answered unless the session holds at both ends of the
  final policy query, which is still bracketed by two exact session checks. `work-read-native.test.ts` still shows a session
  revoked, or expired, before or during the final policy query suppressing the answer.

**Observed after** (the same ten passes): the planning took **792 ms**, a third less. The fingerprint took 23 ms in all, now
with a generic plan. The statements with an array parameter still get custom plans: PostgreSQL judges the generic plan
dearer when it cannot see how long the array is. They plan as before and are not worse.

### The concurrent phase, deferred to v0.3 (founder decision, 2026-11-10)

**Decision.** Hubert decided on 2026-11-10 that v0.2 ships that day. The concurrent @1cpu phase's p95 moves to v0.3. For v0.2:
- the idle minute (at most 100 statements) and the first screen (at most 250 KB) are met;
- the CPU-limited warm phases meet the 50 ms p95.

**Observed** (`FLUX_PERF_PHASES=limited`, 2026-11-10 around 06:55 UTC+1, branch head `c5bfa5a35`, a host with no other test stack but not
one held quiet for the run):
- warm @1.0 cpu: p95 of all requests 19 ms, 0 of 38 over 50 ms;
- warm (member) @1.0 cpu: 16 ms, 0 of 38 over;
- concurrent @1.0 cpu: 42 ms, 10 of 38 over: the Tasks work views 61 to 86 ms, Since you left 76, root work associations 71, Needs
  you 65, work relations 56, notice reference rows 54, search 53.

`main` at `a8369b516`, measured the same way right after (another browser suite had started), failed both warm phases (7 and 4
over) and the concurrent one (15 over).

**Why the concurrent phase misses** (observed on a kept stack, the same head, two clients without pause):
- **The API is CPU-bound in that phase.** Its cgroup was throttled in 135 of 141 CFS periods. It took about 4 to 5 ms of CPU per
  request, so two clients that send each view's reads together keep it saturated, and the last read of a view waits for the others.
- **Where the CPU went** (V8 profile under that load):
  - about 23% Drizzle composing queries and mapping rows (`is()` alone is a third of that);
  - about 18% Better Auth session reads (`better-call` context, the signed cookie, its adapter);
  - about 13% garbage collection, and about 13% `pg` and its protocol.
- **Since you left is the heaviest single read.** It scans up to 400 of the reader's own rows for each place it opens, one to three
  pages of 400. Each Home and space it opens costs 13 to 17 ms of API CPU.
- **The measuring client shares the API's CPU limit.** `perf-measure.mjs` runs inside the API's container, so it shares the 1.0 CPU
  limit. In a concurrent run it took 1.2 s of the container's 5.5 s, about a quarter.

**For v0.3** (not merged: the founder stopped this work so that only finished, tested and safe changes ship). Branch
`claude-hubert/1178-v03-api-cpu-wip` holds these attempts:
- a session read of one statement once Better Auth has accepted the cookie, with a test that a sign-out, a revoked or expired
  session and a deleted account are refused on the very next request on `api` and `api2`;
- the access policy's lookups as constant prepared statements;
- the fingerprint, the relation counts and a person's read of a space composed once per shape;
- the measuring client in a container of its own;
- for Since you left, reading only the rows it can tell, of its place, in SQL.

With all of these but the last, an exploratory run had the concurrent phase at 19 ms overall, 1 of 38 over (Needs you, 57 ms).
That branch has not had the full suites; its last commit has not had any test.

### At the release candidate `2233996ad` (2026-11-10)

**Observed.** A clean clone of `2233996ad`, run alone on the host (only an idle `./flux up` stack beside it), 15:00–16:05 UTC+1.
`FLUX_PERF_ENFORCE=1 ./scripts/check_performance.sh` once, then `FLUX_PERF_PHASES=limited` twice:

| Run | warm @1.0 cpu | warm (member) @1.0 cpu | concurrent @1.0 cpu |
| --- | --- | --- | --- |
| full | p95 18 ms, 0 of 38 over 50 ms | 15 ms, 1 over (Tasks work view open 51) | 43 ms, 9 over |
| limited 1 | 19 ms, 3 over (Needs you 58, work relations 53 and 52) | 17 ms, 2 over (root work associations 54, notice reference rows 53) | 42 ms, 10 over |
| limited 2 | 19 ms, 1 over (Needs you 56) | 16 ms, 0 over | 44 ms, 13 over |

The same full run: idle database 97 statements a minute (met), first screen 242 KB brotli (met), API restart median 3.6 s (slowest
7.4 s), at most 11 API connections at once.

**Inferred.** The warm phases sit at the target: the p95 of all requests is 15 to 19 ms, and the requests that cross 50 ms change from
run to run and cross it by 1 to 8 ms, the noise of this host. They are the same reads as the concurrent phase's.

**Decision** (Hubert, 2026-11-10): v0.2 ships with these numbers recorded; the warm requests join the concurrent phase's work in
v0.3 ([#1191](https://github.com/ColdPhase/flux/issues/1191)).

### The concurrent phase, v0.2.1 ([#1191](https://github.com/ColdPhase/flux/issues/1191), 2026-11-12)

**Changed** (branch `claude-hubert/1191-api-cpu`, from the #1178 attempts above, reviewed and finished):
- **The session read.** Once Better Auth has accepted a signed cookie in an API process, later requests with that exact value
  read the session row and its person in one prepared statement (`identity/session.ts`). Nothing is trusted from memory: the
  row is read on every request, so a sign-out, a revoked session ("Sign out all other devices", one session), a password reset,
  an expired session or a deleted account is refused on the very next request, on `api` and `api2`
  (`tests/app/session-fast-path.test.ts`, now through the real routes and with the maximum age). A session that is gone,
  expired or due for renewal goes back to Better Auth, which renews or refuses it; the maximum age, single sign-on only, the
  provider standing and the provider confirmation are checked as before. A forged signature never matches a stored value.
- **Prepared, composed once.** The access policy's lookups, the lock gate's read, the work reads' fingerprint and relation
  counts and a person's read of a space (from #1178).
- **Since you left** reads, in SQL, only the rows it can tell (the kinds it describes, someone else's change or a rule's on the
  reader's behalf) and, for a space or a conversation, only that place's rows. At most the reader's newest 8,000 rows after the
  point are looked at, as before, now bounded by one index walk (`audienceFloor`), so no filter makes the database scan further.
  Its other lookups (points, places, tasks, decisions, messages, conversations, materials, docs, sketches, names) are constant
  prepared statements over one array parameter, and its times are read as numbers.
- **Compression.** JSON answers are Brotli quality 3 (was 5), compressed on the request's thread up to 128 KiB. On the answers
  of one pass over every view (18 answers of 2.7–127 KB): 0.28 ms of CPU an answer against about 1.0 ms, 10.9% of the raw size
  against 10.4%. At quality 5 compression was about a fifth of the API's CPU in the concurrent phase.

**Observed** (exploratory, **not a quiet host**: other agents' Docker suites ran throughout). One seeded `check_performance.sh`
stack kept (`FLUX_PERF_KEEP=1`), the API container swapped between an image of `main` (`8cef27ca1`) and of this branch, the
phases run alternately, API and database at 1.0 CPU each; API and database CPU are the containers' cgroup counters over the
concurrent phase (3,400 requests):

| Run | API CPU | DB CPU | concurrent p95 of all | over 50 ms | warm, warm (member) |
| --- | ---: | ---: | ---: | ---: | --- |
| `main` 1 | 16.6 s | 11.2 s | 44 ms | 12 of 38 | 1 and 4 over |
| branch 1 | 8.4 s | 9.7 s | 26 ms | 4 of 38 (the four Tasks work views, 58–77) | 0 and 0 over |
| `main` 2 | 17.3 s | 11.7 s | 45 ms | 11 of 38 | 7 and 3 over |
| branch 2 | 7.2 s | 8.4 s | 22 ms | 1 of 38 (Tasks work view finished, 51) | 0 and 0 over |

Steps measured the same way: the session read, prepared statements and the place filter took the API's CPU from about 16.8 s to
8.3 s; Brotli 3 took it from 9.5 to 8.0 s; Since you left's lookups took a summary from about 10 to 8 ms of CPU (Home) and from
8 to 6 ms (a space), measured in the API image over 200 summaries, two runs each.

**Inferred.** The API needs about half the CPU it did. The requests still crossing 50 ms are the ones a view sends together:
the Tasks view's four work views and two relation reads, and the Conversation's associations and notice references, sent by
both clients at once. Each work read makes about 26 statements (12 of them the session and access checks of its final fence)
and costs 4–5 ms of API CPU.

**Tried and not kept** (same method, within the noise of this host): a faster `is()` for Drizzle's query building (about 4% of
the API's CPU), a larger V8 young generation (`--max-semi-space-size=32`) and generic plans inside work reads
(`plan_cache_mode`, about 3% of the database's CPU).

**What is left, by size** (CPU profile of the API under the concurrent phase, and `pg_stat_statements`):
- Drizzle composing statements, most of them the work reads' key, object and plan statements (about a sixth of the API's CPU),
  and the work reads' fence;
  changing the fence is a matter for the read contract, not this change.
- The database plans more than it executes: over a short concurrent run on a
  restarted API, 1.3 s of planning against 1.0 s of execution (part of it each new connection's first plans). The
  visible-edge statements with array parameters plan in 2–4 ms each and are planned every time.
- `select distinct workspace_id from notifications where user_id = …` (the Inbox's audience) takes about 1.2 ms of database
  time on every Inbox and Inbox-dot read: no index covers it.

The acceptance run of `FLUX_PERF_ENFORCE=1 ./scripts/check_performance.sh` on a quiet host is still to be made.

### A busy space, the slow work reads and `flux_search` ([#1429](https://github.com/ColdPhase/flux/issues/1429), #1191, 2026-11-13)

The v0.2.0-against-`main` comparison (`scripts/perf_compare.sh`, [#1430](https://github.com/ColdPhase/flux/pull/1430)) left three
budget misses at `a0237fbab`: entering the perf seed's busy space cost 11 requests (budget 8), 0 to 5 of 37 requests were over 50 ms
in the concurrent 1-CPU phase (the Tasks work views and the roots' work associations), and agents' `flux_search` had a p95 of
50–60 ms at 1 CPU.

**Observed, the causes** (a kept `check_performance.sh` stack of the perf seed; `pg_stat_statements`, `auto_explain`, the API's CPU
profile over the inspector and the containers' cgroup counters):
- **Entering a busy space.** The view carried the first 100 task announcements; the seed's 300 tasks are all newer than the window's
  oldest root, so the stream read two more pages before it could place them. The company's people (to name authors) and the file
  limits (a composer mounted) were reads of their own.
- **Work reads.** No statement was slow (the slowest executed in 0.3 ms); a work view sent 26 and the roots' associations 28, and
  each statement costs the API about 0.2 ms of CPU (Drizzle composing it, `pg` sending and parsing it, the socket write). A
  person's check of a space was three statements, and every work read makes three checks; the summary was three statements; each
  key window two (its page, then its counts); the observation time and the fingerprint two.
- **`flux_search`.** About 80 statements a call, against 23 for people's search with the same ranked statement. Each of the call's
  three transactions (the route's check, the tool, the delivery fence) holds the connection and the owner's standing `FOR SHARE`,
  so it has a transaction id and its COMMIT waited for a WAL flush: 12–18 ms each on this host, three times a call. The search's
  audiences read the agent's standing four times (once per audience type).

**Changed.**
- **The view carries what the stream shows** (`CONVERSATION_VIEW_LIMITS.noticesReach`): the task and decision announcements reach
  back as far as the roots, every one at or after the window's oldest root and the first one before it (all of them when the window
  holds the oldest root), at most 500; the stream pages back only when the person reads older roots. The view also carries the
  company's people (without their last-active times), and the file limits are read once a page load when a composer first holds or
  takes a file; a video waits for them before it is checked against the operator's cap (C-61). A fold of announcements draws its
  hidden lines once the stream is shown, in a transition: drawing 300 of them in the first render delayed the stream by up to the
  opening's 1 s limit on a slow CPU (measured: click to threads shown 508 → 990 ms in the first comparison, 458 ms after).
- **A page of announcements** reads whether a task's creation was undone with the line, not every task's whole record.
- **One statement for a person's unlocked check of a space** (`readProjectAsPerson`): the space, the role and the level, the level
  written per role exactly as before. Locked and agents' checks keep their reads and lock order.
- **Work reads:** the observation time comes with the fingerprint; the summary's two counts and its time are one statement; a key
  window's page and counts are one statement; an empty page of objects reads no edges.
- **MCP:** the route's check, the delivery fence and `flux_search`/`flux_read_around` commit without waiting for a flush
  (`commitWithoutFlush`: they write nothing but row locks, as the live-editing fences already do, `EditingCommit` `transient`); a check of a space in the fence and
  in a tool uses the agent's standing already read and locked in that transaction; search reads the standing once for all its
  audiences, a person's and an agent's.

Nothing a read answers changed: the same answers, byte for byte apart from times and cursors, on the perf seed for every work view
group paged forward and back, the summary, the associations, every page of announcements and the six search queries (people's and
`flux_search`), `main` against this change on one stack. Every check, fence, lock and session read of the read contract (#155) and
of the agents' authorization (#152, #153) is still made.

| Request (perf seed, owner) | Statements before | after |
| --- | ---: | ---: |
| Tasks: work view (open) | 26 | 16 |
| Conversation: root work associations | 28 | 17 |
| Work summary | 20 | 11 |
| Task notices (a page of 100) | 10 | 7 |
| A space (`GET /projects/:id`) | 6 | 4 |
| `flux_search` "after the rain" | 76 | 64, no COMMIT waiting for a flush |

**Observed after** (`perf_compare.sh` on a GitHub runner, run [43442243358](https://github.com/ColdPhase/flux/actions/runs/43442243358):
`main` `b9e9cf168` against this change `3abfd792e`, 3 rounds alternating; median [lowest–highest round]):

| Metric | `main` | this change | budget |
| --- | ---: | ---: | --- |
| Entering the busy space: API requests (Chromium) | 11 | 7 | ≤ 8 |
| Entering the busy space: statements | 308 [288–328] | 240 [220–249] | |
| Entering the busy space: click to threads shown (ms) | 508 [500–526] | 458 [455–475] | |
| Concurrent @1.0 cpu: requests with p95 over 50 ms (of 37) | 7 [4–10] | 2 [0–3] | 0 |
| Concurrent @1.0 cpu: p95 of all requests (ms) | 39 [39–41] | 35 [34–36] | ≤ 50 |
| Concurrent @1.0 cpu: work view open, p95 (ms) | 59 [56–62] | 47 [43–50] | ≤ 50 |
| Concurrent @1.0 cpu: root work associations, p95 (ms) | 64 [48–91] | 48 [41–52] | ≤ 50 |
| Statements of one pass, Tasks / Conversation | 144 / 87 | 88 / 62 | |
| `flux_search` p95 / p50 @1.0 cpu (ms) | 62 [61–64] / 38 | 57 [54–61] / 33 | ≤ 50 |
| People's search p95 @1.0 cpu (ms) | 38 [36–39] | 38 [36–38] | ≤ 50 |

**Inferred, what is left.** The concurrent phase is at the line, not under it in every round: 0 to 3 of 37 requests at 50–60 ms (a
work view, the associations, people of a space, search), as the four work views and two relation reads of the Tasks view are sent
together by two clients. A work read still makes 16 statements, 8 of them the read contract's checks (two session reads and two policy
checks around the final fence, a policy check and the fingerprint inside); fewer needs a change to the contract (#155), not this one.
`flux_search` is now about 30 ms of database (the any-word BM25 statement over about 2,700 candidates for the common words of the
seed's queries: about 18 ms to run and 5 ms to plan) and about 60 statements of MCP checks (three transactions that each read the
connection, its grant and the owner's standing `FOR SHARE`, as #152 and #153 require); its p95 needs one of those to shrink.

## Editors

**Observed.** [#862](https://github.com/ColdPhase/flux/issues/862) measured an open Map at +10,400 statements a minute:
each connection's timer called `catchup` every 250 ms, and each call is a full access check under `FOR SHARE` /
`FOR NO KEY UPDATE` row locks, plus a presence row renewed every second that woke every other editor. The NOTIFY already
delivers every change at once, so the timer is a retry and a revocation check. `editing-cadence.test.ts` opens a real
controller and socket and counts reads of the room: 2–4 in six quiet seconds, where the 250 ms timer made 24.

## Navigation

**Observed.** `test_navigation_requests` (Chromium, warm app, one signed-in tab) counts API requests from the click
until the page has been quiet for 0.9 s:

| Move | Before | After |
| --- | ---: | ---: |
| Home → Inbox | 3 (`needs-you` twice) | 3 (same) |
| Inbox → Home | 4 (`needs-you` twice) | 4 (same) |
| Home → a space | 21 (the project twice, the people four times) | 19 (the people three times) |
| Conversation → Tasks | 11 | 10 |
| Tasks → Map | 4 | 4 |
| Map → Wiki | 8 (the project and the docs twice each) | 8 (same) |
| Wiki → Conversation | 16 (the people three times) | 15 (the people twice) |
| Conversation → another space | 21 | 18 |
| Another space → My tasks | 4 | 4 |

**Inferred.** Sharing the project shell's reads that are in flight together removed the repeats that overlap; the ones left
are asked one after the other (the people, the project and the docs again from a view's own loader, `needs-you` from the
sidebar and then the Inbox). Sharing every read removed a little more (18 on entering a space, 14 from the Wiki back to the Conversation) but broke four tests of views that hold or
reorder their own reads, so only the project, its people and its docs share. The rest are distinct
reads that a space opens whether or not its view needs them. What each move asked for (`test_navigation_requests` prints
it for every move over 8):

- **Entering a space (19):** `assistant-runs`, `needs-you`, `personal-assistant`, the project, `agent-questions`,
  `conversation-roots`, `docs`, `materials`, `object-notices`, the people (three times, one after the other),
  `task-notices`, `work-associations`, `work-summary`, the members, the sketches and `return`.
- **Conversation → Tasks (10):** `needs-you`, the project, the people, `work-relations`, `work-view` and `return`: the
  shell asks again for what it already has, and the view asks for its own.
- **Wiki → Conversation (15):** everything a conversation reads (`assistant-runs`, `conversation-roots`, `materials`,
  `object-notices`, `task-notices`, `work-associations`, `agent-questions`, `personal-assistant`), plus `needs-you`,
  `return`, the members, the project and the people twice.

Getting to 8 means loading `docs`, `sketches`, the members, `personal-assistant` and `return` when their view opens (or one
"space shell" read), asking `needs-you` and `return` once per move instead of from each place that shows them, and reading
the project and its people once from the layout route instead of from each view's loader: the client's data layer. The
test fails any move that costs more than it does today, so it cannot get worse meanwhile.

### Kept reads (#862, the data layer's first part)

**Changed.** A read that shares (`share: true`) may also ask to be kept (`keep`, 30 s for the reads below): a later caller
of the same address gets the answer that arrived without a request. This builds on #1004's sharing rather than replacing
it: the same in-flight entry, now with a short memory. What is kept is forgotten on any write (a write that cannot change
a kept read, `leavesReads`, leaves it: where the person stopped reading, which messages they saw), on any event of the
live stream, on a resync, at sign-out, on a refusal that says access changed (401, 404, 410, 423: a locked workspace's
place then shows its panel; not a 403, which refuses what a role may not do, such as a guest's read of the members), and
when the browser comes back online or the person comes back to the window; an answer read while a write ran is not kept.
Entering a space reads the space itself (`fresh`), never a kept answer, and the views' own loaders join that read, so Back into
a space a person lost says it is no longer available (#592). A person removed from the company or an encrypted space, or who
left it elsewhere, also hears of it: `workspace.access_ended.v1` reaches them alone, and their tab forgets every kept answer and
reads its shell again. A person removed from a space also hears of it: `project.access_ended.v1` reaches them alone, by the space's
id ([access policy](access-policy.md)), so it leaves their sidebar at once and an open place of it lands on the project list. The
Inbox, which changes without an event when an item is handled on another device, is kept for one page only (`onePage`): the
sidebar's count and the page's queue share one read, and the next page reads again. The agents' unread dots are kept as the
rest: a chat read on another device may leave a dot until the person comes back to this window or 30 s, a dot and not an
item to act on. A refresh the person or the stream asked for (focus, a poll, an event, a change of
the Inbox) passes `fresh`: it reads, and keeps what it gets for the next view. Kept: the project, its people, the
workspace members, the space's docs, `needs-you` (the sidebar count and the Inbox or Home queue) and `agent-chats` (the
agents' unread dots). No library: about 40 lines in `api/client.ts`, unit-tested in `api-client-coalescing.test.ts`.

**Observed.** `test_navigation_requests`, Chromium, on `main` at `dffb6cf79` (after #1004, and with the agents' chat
dots of #1012, one read more on every move) and then with kept reads (2026-11-08, same host, one after the other; `needs-you`
is read once on every page, so each move has one request for it, and entering a space reads the space itself):

| Move | `main` | Kept reads |
| --- | ---: | ---: |
| Home → Inbox | 4 (`needs-you` twice) | 2 |
| Inbox → Home | 5 (`needs-you` twice) | 3 |
| Home → a space | 20 (the people three times) | 15 |
| Conversation → Tasks | 10 | 7 |
| Tasks → Map | 5 | 4 |
| Map → Wiki | 9 (the project and the docs twice each) | 5 |
| Wiki → Conversation | 16 (the people twice) | 15 |
| Conversation → another space | 19 (the people twice) | 16 |
| Another space → My tasks | 5 | 4 |

No move repeats an address now. **Inferred.** Three moves stay over 8: entering a space and the Wiki back to its
Conversation read a dozen distinct things a conversation shows (`assistant-runs`, `personal-assistant`,
`agent-questions`, `conversation-roots`, `materials`, `object-notices`, `task-notices`, `work-associations`,
`work-summary`, `sketches`, `return`), and the Wiki's own writes and events forget the kept project and people on the way
back (with `needs-you` and `agent-chats`). The next parts of the data layer forget only the entries an event changes (in place of all of them) and fold the
conversation's reads together.

### Live invalidation and no idle polling (#862, the data layer's second part)

**Changed.**
- **An event forgets what it changes.** An event of the live stream forgets only the kept answers it can change
  (`forgetKeptFor` in `api/client.ts`), and every read in flight still ends (#1023):
  - messages, tasks, decisions, results, sources, agents' answers, Map and direct-message events forget nothing kept;
  - a page of the Wiki forgets the space's pages;
  - an agent's run forgets the agents' chats;
  - anything else forgets all (a space renamed, its people or AI switch changed, a company change, an agent made or revoked).
- **Live editing leaves kept reads.** Joining a page's live editing (`POST /docs/:id/live/enroll`) leaves kept reads alone
  (`leavesReads`).
- **Timers only while the stream is down.** No view reads on a timer while the live stream is open (`streamLive()` in
  `api/stream.ts`). The 15 s refreshes of the stream, a thread, Tasks and a space's work summary, the 20 s working-agents
  read and the 4 s fallbacks while an agent works run only while the stream is down. While it is open, views read on an
  event, a resync, focus or a move:
  - Tasks and the work summary read on a change to the space's work (`WORK_EVENT`);
  - a space's conversation reads on such a change and on a link between a message and a task, so its task lines,
    announcements and chips follow;
  - the stream and a thread read on a new or changed source.
- **Two timers stay.** The Inbox count and the agents' unread dots keep their two-minute read while the stream is open. Some
  of their changes send no event: an item handled on another device, an item back from Later, a notification the worker
  writes late, a chat read elsewhere. That is half a request a minute each.
- **"Seen by" is told, not polled.** The space conversation's "Seen by" asked every 8 s, because seeing a message sent no
  event. Now the first sight of messages records `project.messages_observed.v1` for their authors who can read the space,
  and for nobody else, and the author's page reads its receipts then. It also reads them on focus and when someone may have
  lost the space (a grant removed, someone left or removed from the company, a role changed), since it names only people
  who can read the space now. Because of events it reads at most once every 1.5 s, so a space where hundreds read at once
  (an event for each) costs the author's page a few reads, not one per reader (#1231); the 8 s timer runs only while the stream is down.
- **A dead socket does not leave a tab with nothing.** The stream opens again from its cursor, so what it missed is
  replayed:
  - when the browser comes back online;
  - when the page comes back after more than a minute hidden;
  - when a timer fires far later than it was set for (the machine slept).

  The server's pings cannot be seen from a page.
- **A failed refresh keeps the page (#1141).** A read that refreshes a page in the background (an event, focus, a retry) and gets
  no answer, a 5xx or a 429 that outlasted the client's own waits no longer replaces the page with "Something went wrong".
  Every loader of the signed-in app (`keepPagesOnRefresh` in `app/keepPage.ts`, applied to the router's tree once) gives back
  what it last read for the same page (same params and search) and asks again by itself after 1, 2, 4, 8 and 16 s; after
  that the next event or focus asks. The error screen stays for a first load, another page, and answers that say the data is
  gone or closed (401, 403, 404, 423, other 4xx, a redirect to sign in). Sign-out, and a read that finds no session, forget
  what was kept.
- **Live calls ([#1175](https://github.com/ColdPhase/flux/issues/1175)).** A call starting, someone joining or leaving
  it (the SFU's webhook) and its end send `project.live_changed.v1` to the space's people, and Join, the "live now" dot
  and More's Join row read on it. The 30 s look while the stream was open is gone (it showed someone else's call up to
  about 40 s late, and `check_live_ui.sh` waits 15 s); the 12 s look stays only while the stream is down.

**Observed.** `test_navigation_requests` test_03 counts the API requests of an untouched tab over 60 s (Chromium, the same
scene, 2026-11-09):

| View | `main` `e7ab062f7` | This change |
| --- | ---: | ---: |
| Home | 3 (working-agents) | 0 |
| Inbox | 3 (working-agents) | 0 |
| A space's Conversation | 70 (the whole app read again every 15 s, receipts every 8 s) | 0 |
| Tasks | 51 (the whole app read again every 15 s) | 0 |
| Map | 7 (work summary, working-agents) | 0 |
| Wiki | 7 (work summary, working-agents) | 0 |

**Navigation** (`test_navigation_requests`, Chromium):

| Move | `main` `e7ab062f7` | This change |
| --- | ---: | ---: |
| Home → Inbox | 2 | 2 |
| Inbox → Home | 3 | 3 |
| Home → a space | 15 | 14 |
| Conversation → Tasks | 7 | 7 |
| Tasks → Map | 4 | 4 |
| Map → Wiki | 5 (live editing forgot what was kept) | 4 |
| Wiki → Conversation | 15 | 11 |
| Conversation → another space | 16 | 16 |
| Another space → My tasks | 4 | 4 |

**Inferred.**
- **Three moves into a Conversation stay above 8 for v0.2:** Home → a space 14, Wiki → Conversation 11, Conversation →
  another space 16. Every other move is at 7 or fewer.
- **Why.** A conversation asks for its parts one by one: its roots, its task and decision notices, its sources, its agents'
  questions, its work associations, the agents' runs and status, and where the person left off. Entering a space also
  asks for the space itself, which is never taken from a kept answer so a lost space says so, and for its people, pages,
  sketches and work summary.
- **Measured fix, parked.** Folding the reads asked for in one moment into one request (`GET /api/v1/reads`, answered
  by each read's own route) brought the three moves to 7, 6 and 7. It was parked before release (2026-11-09) because it is
  a new generic server surface, and because it needs a sizeable conversion of the UI tests that hold or stub single reads.
- **For v0.3.** [#1109](https://github.com/ColdPhase/flux/issues/1109) has the gap and both options: that fold endpoint
  (branch `claude-hubert/862-folded-reads`), or one view-shaped read per screen. Done in v0.2.1 with the second (below).

### One read per screen ([#1109](https://github.com/ColdPhase/flux/issues/1109), v0.2.1, 2026-11-12)

**Decision (founder, 2026-11-12, on #1109).** Option 2: one typed, view-shaped read per screen; no generic fold endpoint.

**Changed.**
- **`GET /api/v1/projects/:id/space-shell`** (`SpaceShell` in `packages/contracts/src/views.ts`): the space with its people,
  first page of sketches (20, no empty ones), first page of pages (100) and work summary. Entering a space reads it, never from
  a kept answer, so a lost space still says so (#592): a refusal of the space (404, 423) is the whole read's answer.
- **`GET /api/v1/projects/:id/conversation-view`** (`ConversationView`): the newest roots, the task and decision notices, the
  sources, the agents' questions (`null` while the space's AI is off) and the work associations of the newest roots' messages.
- **Access per part.** Each part is its own route's use case called with the caller's principal (`apps/server/src/views/`), so
  each keeps its own access check; neither read queries a table itself. Context parts the person may not read are `null`.
- **The client takes the parts where they are asked for.** A view read hands each part to the address of the part's own read
  (`parts` in `api/client.ts`): the next read of that address takes it once instead of a request, while it is younger than
  `KEEP_MS`. Any write, any event of the live stream, focus, coming back online, a refusal that says access changed and sign-out
  forget the parts with the kept answers, and a view read across such a change hands nothing over. So the hooks that read the
  agents' questions, the stream's work associations, the work summary, the people and the pages are unchanged and still read on
  their own after an event (#1101). The Conversation's loader takes the space from the frame being read beside it, or from the
  kept answer (#1036).
- **Removed.** The conversation loader's own first reads of the roots, notices and sources, and the shell loader's reads of the
  space, people, sketches and pages; `getProject`'s `fresh` flag (only the entry used it). The per-part routes stay for paging
  and for the refresh of one part after an event.
- **Tests that stubbed a single read** (`test_agent_stop_questions` 07, `test_shared_composer`'s bounded first window) stub
  the same part in the conversation view too.

**Observed.** `test_navigation_requests`, Chromium, warm app, same scene, 2026-11-12:

| Move | `main` `607b84409` | This change |
| --- | ---: | ---: |
| Home → Inbox | 2 | 2 |
| Inbox → Home | 3 | 3 |
| Home → a space (Conversation) | 14 | 7 |
| Conversation → Tasks | 7 | 7 |
| Tasks → Map | 5 | 5 |
| Map → Wiki | 5 | 5 |
| Wiki → Conversation | 11 | 6 |
| Conversation → another space | 16 | 8 |
| Another space → My tasks | 4 | 4 |

No move repeats an address. What the three moves ask for now:
- **Home → a space (7):** `space-shell`, `conversation-view`, the receipts of the messages seen (`POST`), `assistant-runs`,
  `personal-assistant`, `needs-you` and `return`.
- **Wiki → Conversation (6):** the same without `space-shell`.
- **Conversation → another space (8):** `space-shell`, `conversation-view`, `assistant-runs`, `personal-assistant`, `needs-you`,
  and leaving the conversation: `return` for the space left with `PUT return-points` saving it, then `return` for the space
  entered (two addresses of `return`, none repeated).

**Inferred.** Every move is now at or under the target of 8, and the budget in `test_navigation_requests` is set to these
counts (plus one for a poll in the quiet window where the count leaves room under 8). What is left on these moves is the person's
own lists (the Inbox count, their agents' runs and assistant) and where they left off, which the founder's decision keeps as
separate requests.

## First screen

**Observed.** The first screen is 41 files (35 JS, 6 CSS), 1,199 KB raw and 327 KB brotli; the largest chunks are the
app's `index` (158 KB brotli), the Wiki editor (125), single sign-on (80, not precached) and the map (40). The service
worker precaches 715 KB of JS and CSS after this change, 845 KB before it. **Inferred.** The 250 KB target needs the
editor, the map and the Details panel out of the first screen's import graph; `test_route_chunks` already guards some of
it. Not attempted here.

### Under 250 KB ([#1178](https://github.com/ColdPhase/flux/issues/1178), 2026-11-10)

**Observed.** At the v0.2 candidate (`691c79d92`) the first screen was 40 files and 316 KB brotli. The entry chunk (170 KB) held
React DOM (530 KB before minifying), and it also held everything a space's conversation needs (`ConversationStream`, the
thread, the composer, its attachments, the assistant's lines and waiting changes), the sign-in pages, the Create window and
the live strip. None of those is needed to show Home, and the sign-in pages are not part of a signed-in visit.

**Changed.**
- The conversation route and the sign-in routes load their component's code when they are matched (`lazyComponent` in
  `router.tsx`, `conversationPage` and `authPages` in `app/viewChunks.ts`). Their loaders, actions and revalidation stay in
  the router, so React Router runs them beside the download, never after it.
- A failed download of the conversation's code is said inside the shell (`ConversationCodeBoundary`); every other error still
  goes on to the locked panel and the page above.
- The live strip is a deferred surface (`DeferredLiveBar`), like Details and Search. It mounts only while there is a call or an
  invitation.
- Its code, and the conversation's, is fetched while the browser is idle after the shell is up, or on the first press, and the
  service worker precaches it. So a move into a space or a call finds the code already there.
- The Create window stays in the first screen. Deferred, it opened a moment after the first click on a freshly loaded page, and
  + Create is the one action of every view.

**Observed after** (the same count, built from the branch on `main` at `229b32483`): 36 files and **241 KB** brotli, and 224 KB
with the Create window deferred too. The entry chunk is 112 KB.

**Not changed.** The conversation is still the first screen of a space; on a cold deep link its code comes beside its reads.

## Idle statements

**Observed.** Over 60 s with nobody signed in and the worker running, `main` made 122 statements: 28 queue polls (14 queues
each looking every 30 s, the backstop behind NOTIFY), 28 `begin` and `commit` of pg-boss's own transactions, about 40
more of pg-boss's schedule, instance heartbeat and queue-cache work, and about 14 of Flux's own backstops (the encryption
rotation sweep every 15 s, the notification generator's cursor, the schema version and the sealed-job wait sweep). After
this change the same minute makes 95. What pg-boss does to recover a crashed worker's jobs and to fire a schedule is left as it was.

**Changed.** Everything that looks when nothing has happened looks less often; everything that something wakes still wakes
at once.

- Every queue's backstop poll is 60 s (`NOTIFY_BACKSTOP_SECONDS` in `drain-backlogs.ts`, applied to every `work`
  registration); pg-boss's flow resolver looks every 120 s, its queue-cache refresh every 300 s, and its LISTEN check
  every minute.
- The notification generator's backstop and the sealed-job wait sweep are 60 s, and the instance registry that pg-boss keeps
  (who is running; only `getInstances` reads it) is beaten every five minutes, not every half minute.
- Not changed, on purpose: pg-boss's monitor (60 s) also fails the jobs of a worker that stopped heartbeating, which is
  how a crashed worker's schedules come back, so a slower monitor would leave them waiting minutes longer; its cron worker
  (15 s), so a schedule fires within about 30 s; and the key rotation sweep (15 s), so a removed person's old key stops
  opening new content quickly.

**The v0.2 candidate's 315 a minute ([#1178](https://github.com/ColdPhase/flux/issues/1178), 2026-11-10).**
- **Observed.** The release acceptance measured 315 statements in the idle minute twice. The extra statements were
  pg-boss's per-queue retention sweep: for each of 11 queues, three locked walks (`BEGIN`, two `SET LOCAL`, an advisory lock,
  the walk, `COMMIT`), its clock and its retained count. That comes to about 20 statements a queue, 220 in all.
- **Observed.** pg-boss runs that sweep once a day for each queue (`maintenanceIntervalSeconds`, 24 hours by default). On a
  new database it comes on the worker's first supervise pass, 60 s after the worker starts, and the stamp it leaves survives a
  restart.
- **Observed.** A timeline of the idle stack, from the worker's start, in 10-second samples:
  - without the seed, the minute holding that pass had 332 statements, and the next three had 97, 94 and 97;
  - with the seed, the seed took 65 s, the pass fell inside it, and the idle minutes had 97 and 94.
- **Inferred.** The acceptance's seed took 41 s, so the pass fell into the measured minute. Nothing since #1015 added idle
  statements: the minute without it is 94 to 97, as #1015 measured (95). Its seed was slower, so the pass came before the minute.
- **Changed.** `check_performance.sh` takes the idle minute only after every queue has had its daily sweep (no queue left
  with `maintain_on` unset, then 5 s for the pass to finish). It prints how long it waited, and it says so if the sweep is still
  due after 150 s. The sweep itself is unchanged: it is once a day, about 0.15 statements a minute on average.

**Cost, accepted.** A delayed or retried job (a push held to the end of quiet hours, an e-mail, a retry after a failure)
starts up to a minute after it is due, not half a minute. A job sent now still starts at once over NOTIFY, a backlog still
drains back to back, and a failed handler still wakes its queue after 2 s. A listen connection that dropped silently is
noticed up to a minute later (the check was every 30 s); until then a job sent meanwhile is found by the backstop poll.

## Reproduce

```sh
./scripts/check_performance.sh                                    # all phases, about 40 minutes
FLUX_PERF_PHASES="count warm concurrent limited bundle" ./scripts/check_performance.sh
FLUX_PERF_PHASES=restart FLUX_PERF_RESTARTS=10 ./scripts/check_performance.sh   # idle numbers and restart times, 5 minutes
FLUX_PERF_CPUS=1.0 ./scripts/check_performance.sh                 # the CPU cap of the limited phase (1.0 stands for 2 vCPU)
FLUX_PERF_ENFORCE=1 ./scripts/check_performance.sh                # exit 1 when a CPU-limited phase misses the p95 target of 50 ms (only 1 or true; 0 leaves it off)
./scripts/check_ui.sh test_navigation_requests                    # requests per move
python3 scripts/perf_report.py perf-results/<time>/measure.jsonl perf-results/<time>/api.log --targets
```

Run one at a time and alone on the host: the numbers include whatever else the machine does.

## Follow-ups

- The work reads' planning and session checks (above), for a decision on the read contract's code.
- The client's data layer: polling to live push, one read per space shell, non-blocking loaders (the navigation list
  above is its starting evidence).
- The first screen's import graph (editor, map and Details out of it).
- The typing hub's per-second work, not measured here.

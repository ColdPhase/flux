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
| Idle: at most 100 database statements a minute | 122 | 95 | met, narrowly, see [Idle statements](#idle-statements) |
| An open tab: at most 4 requests a minute | not measured here | not changed | not met, the client's polling is the data-layer batch |
| An open Map or Wiki editor, idle | a read of the room every 250 ms (240 a minute) | a read every 2 s after 5 s of quiet (30 a minute); a cursor that did not move sends nothing | changed, see [Editors](#editors) |
| A navigation: at most 8 requests, none repeated | 3, 4, 21, 11, 4, 8, 16, 21, 4 | 3, 4, 19, 10, 4, 8, 15, 18, 4 | not met for four moves, see [Navigation](#navigation) |
| p95 at most 50 ms on 2 vCPU | 69 ms for all requests; 19 of 40 requests over 50 ms | 59 ms; 14 of 40 over 50 ms | not met, see [Server time](#server-time) |
| First visit: at most 250 KB before content | 326 KB brotli, 41 files | 327 KB brotli, 41 files | not met, see [First screen](#first-screen) |
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
  caller has aborted, and a write ends the sharing so no one is handed an answer from before it. Reads that do not ask
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

## First screen

**Observed.** The first screen is 41 files (35 JS, 6 CSS), 1,199 KB raw and 327 KB brotli; the largest chunks are the
app's `index` (158 KB brotli), the Wiki editor (125), single sign-on (80, not precached) and the map (40). The service
worker precaches 715 KB of JS and CSS after this change, 845 KB before it. **Inferred.** The 250 KB target needs the
editor, the map and the Details panel out of the first screen's import graph; `test_route_chunks` already guards some of
it. Not attempted here.

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

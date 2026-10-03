# Actual human typing WebSocket lifecycle — #155

2026-10-01. Runtime and tested source:
`4bf6a1ce66b5f1e2b2b009712cf080f19ed1843b`, based on main
`7af78f29c7da3799a57bf204b343b5647516afc5`. The existing current
[native authority and PostgreSQL ports](../155-typing-access/README.md) now
compose the actual same-origin cookie `/api/v1/typing` endpoint. There is still
no browser notice or client activity publisher in this source.

## Commands and pinned results

```sh
FLUX_TEST_PORT=18571 FLUX_TEST_MAILPIT_PORT=18535 ./scripts/check_application.sh
python3 scripts/check_agent_setup.py
git diff --check
```

The trusted configured Docker run passed build/type/lint and **372/372 application
tests**, no skips,61.868739778s; PWA3, access/stream1, session prepare/restart/
verify, unavailable Push1 and unavailable SMTP1 also passed. Terminal handle58858
exited0. The script removed only its own Compose project
flux-test-1790823856-44900, volumes and three tagged images.
[The readable full log](application.log), [exact raw log](application.log.gz)
and496 [input/log hashes](inputs.json) pin this
run. The log was checked for credential patterns: the only broad cookie-pattern
match was a test name about the SFU cookie gate, not a cookie or credential value.

The same source also passed a targeted Docker build/type/lint and **49/49** typing
and architecture tests, no skips,14.831962799s, on a separate isolated Compose
project named flux155socket with ports18561/18525. Terminal handle95326 exited0.
[Readable targeted log](targeted.log) and [exact raw targeted log](targeted.log.gz)
include the build and actual service startup. Readable copies remove trailing
spaces only; compressed and decompressed hashes preserve all original bytes.
Earlier intermediate builds had a test-fixture lint failure and one assertion
that assumed a fixed WebSocketServer close-listener count. The final run fixes
the fixture and compares the actual initial listener count to its final count;
it does not weaken runtime bounds or conceal those earlier failures.

The targeted container command was `pnpm exec tsx --test` with
`tests/app/typing-core.test.ts`, `tests/app/typing-connection.test.ts`,
`tests/app/typing-access.test.ts`, `tests/app/typing-socket.test.ts`,
`tests/app/typing-admission.test.ts` and `tests/app/architecture.test.ts`.
The full configured command above reproduces all these checks without the
temporary targeted Compose wrapper. Foundation setup/local document links,
34 Python foundation regressions and `git diff --check` also passed.

## What the new evidence proves

Nine actual API/SQL/WebSocket cases use registered human accounts, their native
cookies/sessions, restricted project conversations and current grants. They
exercise two-account name-only delivery, self exclusion, nondurable scoped SQL
counts, immediate stop, A→B withdrawal, viewer observation without publication,
foreign/unknown unavailable scopes, writer downgrade, reader denial, exact remote
session deletion despite another live session, deduplication, idle expiry, clean
disconnect, idle unwatched session withdrawal, same-origin upgrade admission,
eight sockets per human and permit reuse, closed/private/binary/oversized commands
and flooding. There are no caller identities, names, TTLs, draft text, email,
durable events, cursors or notification jobs in the typing wire.

Single observations in the full run: first active21.406ms, stop11.474ms,
scope-switch withdrawal11.219ms, writer withdrawal952.283ms, reader withdrawal
959.706ms, exact-session withdrawal880.564ms, idle expiry5786.823ms and clean
disconnect10.996ms. These are regression observations, **not** the required
30-warmup/200-sample/60-second performance or DOM-to-DOM acceptance proof.

Six separate **real loopback socket tests with injected timing/authority/clock
ports** prove terminal publication while the sender's unrelated authorization is
blocked, held-old-stop→new-active→final-stop publication ordering, continuity
under unrelated broker updates and compatible active refresh, retained unfinished
authorization permits after transport closure, bounded closing-flood listeners,
rejected first publication followed by stop/close and eventual permit release,
and clock-failure quarantine preventing revival after a discarded stop fence.
Those controlled ports are not additional proof of production human identity or
PostgreSQL; the actual API/SQL cases above and prior access evidence provide that.

One actual Fastify prevalidation test with a deliberately delayed identity port
starts512 unresolved upgrades, observes503 for additional admission before and
after the10-second timeout, then proves capacity is released only when identity
promises settle. It does not claim512 established production WebSockets or
stress throughput. The final core reconciliation regression also preserves a
compatible active refresh while withdrawing stop, scope, monotonic expiry and
unavailable state.

## Independent review and remaining acceptance

Separate read-only source review found global-generation starvation, terminal
withdrawal behind unrelated authorization, idle socket lifecycle gaps, abandoned
authentication permits, concurrent publication, closing-flood timers, unfinished
work after transport closure and a rejected-publication terminal permit leak.
The author corrected them and added focused regressions. Final bounded source
agreement at the tested source reported no remaining material endpoint lifecycle
or authority finding. The evaluator executed no tests and supplied no eligible
GitHub whole-task approval.

The endpoint has bounded input/admission/coalescing/output, exact current
recipient and sender sessions/native policy, server-owned global connection
sequence, serialized publication, ordered DB-clock observations, dual-clock
fences/quarantine, short output proofs, idle session/pong checks, and cleanup of
its own timers/listener. **Actual32 publishers+96 watchers, required repeated
latency/work/RSS measurements, unclean network evidence, browser activity/notice,
draft/focus/source/scroll preservation and visual/interaction review remain open.**
The current composition still has no accepted #154 Task→canonical conversation
export on main; unavailable Task watch does not invent or create a root.

All #155 AC1–AC5, #151/#136, authenticated real-agent execution/motion, supported
model clients, physical Android/iPhone/iPad installation/Push, integrated
application acceptance and release remain required under the
[current contract](../../../development/typing/2026-10-01-contract.md).

# Current human typing authority and PostgreSQL transport — #155

2026-10-01. Actual tested source:
`4f61aa7aa3806f2a4a62842c45ad7639f060d6d6`, from main
`7af78f29c7da3799a57bf204b343b5647516afc5`. This adds real current session/native
policy composition and nondurable broker primitives to the previously tested
[internal lifecycle](../155-typing-core/README.md).

## Actual command and result

```sh
FLUX_TEST_PORT=18561 FLUX_TEST_MAILPIT_PORT=18525 ./scripts/check_application.sh
python3 scripts/check_agent_setup.py
git diff --check
```

Trusted configured Docker command passed build/type/lint, **355/355 application
checks**, no skips,49.984174397s; PWA3, access/stream1, session prepare/restart/
verify, unavailable Push1 and unavailable SMTP1 also passed. Terminal command
handle71343 exited0. [Readable successful log](application.log),
[exact raw terminal bytes](application.log.gz) and
[source/configuration/log hashes](inputs.json) pin that run. The script removed
only its own Compose project flux-test-1790821462-42183, volumes and three images.
No live test process or service from that run remains. Source hashes still match
after evidence-only commits. The log was checked for credential-pattern matches
before inclusion; none were found. The readable copy removes trailing spaces
only; compressed and decompressed raw hashes preserve the original terminal log.

## New actual behavior covered

Eleven new configured cases use API-created humans, native conversations/tasks/
DMs, grants and real PostgreSQL. They prove exact session↔human binding, DB expiry
and deletion despite unchanged project write, viewer write denial versus readable
history, current grant downgrade/deny, current native names, session revocation
during awaited policy, and caller mutation protection. A closed1:1 follows the
same existing DM counterpart rule as message sending; workspace membership alone
does not reveal DM activity.

Two independent actual LISTEN connections receive the same closed identifier-only
notification. Actual scoped SQL counts stay unchanged for messages, events,
audiences, outbox, notifications and jobs. Listener backend termination invokes
loss/reconnect and fresh delivery, without replay; closing during initial
connection produces no obsolete readiness. Strict decoding rejects private extra
fields and malformed identities without echoing their contents. Publication owns
its metadata before the SQL await, so returned/local identity matches the actual
notification even when the caller mutates its input.

## Independent evaluation and remaining work

Separate read-only source review found mixed mutable authority, mismatched
published/returned metadata and pending listener readiness races; the author fixed
all three before this pinned run and added regressions. Final bounded source
agreement at the tested source identified no remaining material access/broker/
listener finding. The reviewer inspected tests but executed none; this is not
eligible whole-task approval.

No typing endpoint or browser notice is registered yet. Ordered current DB clock
observations, generation cancellation, socket admission/queues/backpressure,
authorized public snapshots, browser draft/focus/source/scroll lifecycle and actual
two-user socket/browser/stress evidence are the next integration. Wire the existing
Task/Agents root from #154; main still lacks that accepted primitive. Tests of an
injected alias only certify the same-project composition guard, not the actual
Task mapping or delivery. A Task read without it returns unavailable and creates
no substitute root.

These results do not certify real typing, motion, supported model clients,
physical devices, full #155/#151/#136 or integrated application/release completion.
All those required outcomes stay open under the
[current contract](../../../development/typing/2026-10-01-contract.md).

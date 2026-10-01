# Bounded native work read foundation — #155

2026-10-01. Owner-run evidence at `89a686eeeaf997d7ca1f2d01a1411c851cb0c0f3`. The configured Docker build,
typecheck and lint passed; final prepare/test processes both exited 0.
All **31 tests passed**, no failures/cancellations/skips, 1.464785 seconds:
8 architecture, 9 query/cursor, 9 core port-protocol and 5 actual PostgreSQL tests.
This implements core orchestration and native key selection; no bounded HTTP
endpoint or client migration exists yet.

Core captures normalized principal/project/selector before awaiting, coordinates
one read observation and requires its final current-authority fence after it.
Protocol tests verify denied/failed reads release no response, unknown fence
failures become 503, and native session/scope rejection preserves 401/409.
Association rows and edges have global requested limits; the independent source
count window remains at most 100. Port tests are not native session/policy proof.

Actual PostgreSQL18.6 tests use 123 native-schema work/decision/result fixtures
and two public-API registered/authorized project contributors. Native SQL keeps
all nine Tasks bands, exact mine/choice predicates, escaped literal wildcard
search, requested global key bounds and raw microsecond timestamp keys. Every
forward page and directly reconstructed previous page is checked. An equal-only
surviving boundary gives refresh without a false strict escape. A held actual SQL
result plus caller cursor mutation verifies the original continuation remains
consistent across both queries. The adapter returns only bounded lightweight
kind/id/rank/timestamp keys, overfetching at most one key; DTO hydration remains
future work. Native command/public-endpoint semantics are not certified by SQL
fixtures. No migration or database constraint was weakened.

Independent source review agreed core at ba730206c54503d9fe7488b5cf9b2589f98c79ad,
key queries at 2d41f44982fc9417007c292aca17e9fd4d53f48c and required fixture audit
fields at ebf437d891add73b3fb5430dc85730871fece088. These production files are
unchanged at the tested source; the last fixture-only change uses base36 bulk
titles so literal search 100 selects the intended two records. Reviewers did not
execute tests or provide eligible whole-task approval.

## Reproduction and provenance

Checkout the tested source, use Docker/Compose, then run the saved script:
`./docs/agents/evidence/155-work-read-keys/reproduce.sh prepare` followed by
`./docs/agents/evidence/155-work-read-keys/reproduce.sh bounded` and `cleanup`.
Copy the script from this evidence head when checking out its earlier tested
source. Defaults use an isolated project and ports20581/20585; override
COMPOSE_PROJECT_NAME/FLUX_TEST_PORT/FLUX_TEST_MAILPIT_PORT for concurrent work.
The owner used flux155browser on18581/18585. Its stack is retained for the next
read adapter stage; all owner test/build handles are terminal.

inputs.json hashes 520 tracked build/config/contract inputs at the tested
source and all saved outputs (except the manifest itself). Original build/test
and two earlier failed-fixture logs are preserved as exact gzip/raw pairs;
readable copies only trim trailing ASCII whitespace and blank EOF lines.
The first 2d41 fixture run had26 passes and5 cancellations: accepted decisions
lacked required native audit/history data, so setup failed. The second ebf437 run
had29 passes and2 failures: bulk titles100/101/etc also matched the intended
two-record search. Both were fixed in test fixtures, preserving assertions,
queries and native constraints. Only the final tested source has all31 passes.

## Remaining required work

Implement visible native relation aggregates and bounded row/name/context/detail
hydration, the read-only REPEATABLE READ server adapter, exact current native
session/project/source-visibility fence and all five bounded routes. Migrate
EVERY complete-list consumer, then remeasure the original public-command1000
fixture with all30 warmups/200 actions/60-second distributions. The historical
d536 baseline remains failed for unbounded fetching/rendering; the private draft
correction retains its separate5bd evidence. Whole#155 AC1–AC5, native Task,
real-agent/motion, physical Android/iPhone/iPad PWA/WebPush and integrated release
acceptance remain open. No merge, issue closure or protection bypass is claimed.

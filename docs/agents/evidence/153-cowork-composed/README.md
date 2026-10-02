# Runtime and genuine native actor dependency integration — partial #153

Verified2026-10-01. Own branch `claude-maurycy/153-cowork`, draft PR166.
Pinned #152 dependency `a7b3b6e603be0ecb1a56f87db08f933d772491c3`
and #154 dependency `d1d03f70f1ddb7c78d05216ac570c9359cb5290c`
are merged on this branch; neither draft is treated as accepted protected main.
The merges retain both co-work and execution exports/schema types, actor checks,
all reserved migrations and the actual highest shipped version37. Frozen0033
and all existing migration SQL were preserved.

## Executed checks and exact sources

At merged runtime `a876ad647807265979bdc2f58e853d4854ec0b9d`:

- Docker build/typecheck/lint PASS: `/tmp/flux153-composed-build.log`.
- Complete configured `FLUX_TEST_PORT=19051 FLUX_TEST_MAILPIT_PORT=19052
  ./scripts/check_application.sh` PASS, session44098 exit0:
  **406/406** application tests,57.608s, no skips;3 PWA;1 browser access;
  1 genuine human/agent actor browser;1 signed scope/connection consent browser;
  stored-session/content after API restart;1 Push-unavailable;1 SMTP-unavailable.
  Log: `/tmp/flux153-composed-application.log`.

At test-only successor `d6a966931557c81771acc4b4c1189f03574e183e`
(the exact recorded SHA is checked in the manifest):

- Final Docker build/typecheck/lint PASS:
  `/tmp/flux153-composed-arrival-build-final2.log`.
- Fresh normal migration to actual Flux37 and pg-boss43 PASS:
  `/tmp/flux153-composed-migrate.log`.
- **55/55** focused SQL/core/architecture/ledger tests PASS,3.682s,
  no skips: `/tmp/flux153-composed-arrival-tests-final.log`.
- Setup/local links,34 Python tests and whitespace PASS.

The successor adds only the three arrival-order tests, with no production/runtime/
migration/toolchain change. Its new tests are verified by the focused55 run;
the earlier full406 result keeps its original source and excludes these new3.
This is not a claimed full409 run. The manifest records that exact source delta
and hashes the actual inputs/logs.

## Migration evidence and limits

Actual SQL is exercised in isolated transactional schemas for arrival orders
35→34→33→37,34→33→37→35 and33→35→34→37. After each file, current human
task/message/conversation/connection IDs, scopes, authors, material citation
version/bytes/times and search provenance remain unchanged. An existing claim
and checkpoint inserted as soon as35 arrives survive later additions. There is
no inferred runtime, binding, grant, receipt, notice, discussion or request
backfill. Actual final connection revocation stops the unit, increments fencing
generation/version and clears leases while retaining its exact checkpoint.
Each step follows the real migrator's SQL-ledger delta check, own-version insert
and exact step check, followed by final exact-manifest comparison.

The first focused run passed52 and failed3 because its raw SQL fixture omitted
the migrator-owned ledger insertion. The corrected fixture uses the existing
ledger helpers and recording sequence; no migration SQL was changed to make
the test pass. `/tmp/flux153-composed-arrival-tests.log` retains that failure.
Source review also found a manifest-error client leak; manifest reading now
precedes client acquisition, and nested cleanup releases even if rollback fails.
Final source-only review found no further cleanup issue; no eligible whole-task
approval is inferred.

These transactional arrival tests prove additive SQL/history compatibility for
those orders. They do not establish committed deployment upgrades or actual
runtime/grant/client admission. The configured full run separately tests a
fresh integrated stack and stored content through an API restart.

## Next required composition

The available execution and genuine native sessions now compile and run with
co-work storage. #153 still must supply the actual canonical postcondition
callback, current checkpoint/source checks, atomic unit-of-work/one-ledger
composition and fenced publication before final event flush. Request enqueue/
receiver authority registry alignment and the shared native graph primitive
are pending owner exports. Public tools, cursor filtering/resync and real
client scheduling remain disabled/unfinished; integration of source dependencies
is not their activation. All original AC1–AC5 and whole-product/device/release
criteria remain open. No second grant/receipt store or copied content was added.

[Source/input/log manifest](source-sha256.json). Own image ID:
`sha256:290c38ed20372a77fad3a137a8007e8efa12f5050c87782101127a9d4feae394`.
Only own isolated Docker resources were used; no host services/dependencies.

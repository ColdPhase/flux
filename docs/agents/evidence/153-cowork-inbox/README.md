# Addressed request storage and bounded recovery — partial #153 evidence

Verified 2026-10-01 at runtime source
`919038b5ec1b84d6d17a77340338a3cc45957d24`, branch
`claude-maurycy/153-cowork`, draft PR166. This adds actual storage to the
[unchanged coordination contract](../../../development/cowork-coordination.md).
It does not satisfy any whole #153 acceptance criterion or activate public tools.

## Implemented boundary

The strict core command admits original source/version references, one canonical
recipient, a bounded intent key and explicit help/review/fix/handoff kind. It
rejects copied prompts, credentials, unsupported fields and invented result
versions. Durable enqueue atomically retains its request, one delivery intent
and canonical native-root/run counters. Unit creation binds that original root;
an unrelated supplied parent cannot borrow its budget. Explicit inherited child
units can retain the root. New command IDs, intent keys and delivery ACKs do not
reset original request/depth/global review-round ceilings. A semantic retry
returns original identities; changed meaning conflicts.

ACK records transport receipt only. Pending rows and explicit busy/dependency/
offline/capability/policy deferral boundaries remain durable; neither claims a
unit nor wakes a model. Bounded chronological pages preserve exact PostgreSQL
microseconds. Candidate pages exclude all live claimed units, use capped aging
and retain one ranking snapshot with its interval and recipient context. Scope
or interval changes reject continuation. Fresh expiry/fence observations still
apply per page; lost claims become pending recovery observations, not completion.

These SQL methods require their caller's current authority, source visibility,
single #152 ledger and proper outer lock order. Internal cursor contents are not
a public token: encryption or server-held opaque, context-bound continuation
and current source filtering remain required. A signed readable ID is insufficient.

## Actual executed checks

| Command / evidence | Result |
| --- | --- |
| `docker build -f docker/Dockerfile --target test -t flux-cowork-inbox:flux153-inbox app` | PASS, build/typecheck/lint; `/tmp/flux153-inbox-cursor-build.log`. |
| Docker `tsx --test` for requests/storage/claims/architecture/migration ledger | **52/52 PASS**, no skips, 3.262s; `/tmp/flux153-inbox-cursor-tests-final.log`. |
| `FLUX_TEST_PORT=19051 FLUX_TEST_MAILPIT_PORT=19052 ./scripts/check_application.sh` | Complete command PASS, session49348 exit0: **370/370** application tests,51.048s;3 PWA;1 browser access; durable session/content after API restart;1 unavailable-Push;1 unavailable-SMTP. `/tmp/flux153-inbox-cursor-application.log`. |
| Setup / local links / Python / whitespace | `check_agent_setup.py`,34 Python tests and `git diff --check` PASS. |

The SQL regressions use actual PostgreSQL sessions/lock waits, atomic rollback,
same-intent concurrent enqueue, stable delivery identity, non-resetting lineage
ceilings, forbidden foreign-parent budget borrowing, explicit child inheritance,
ACK scope/idempotence, non-preempting deferral, lost claims/expiry, exact keyset
paging, fairness and more-than-one-page busy candidates. The added regression
rejects changed aging/workspace/project/recipient then successfully continues
the original scan. Connection capacity/fence/revoke/checkpoint tests remain in
the focused run. Final read-only source review found no additional cursor issue;
this is separate from eligible independent evaluation of the complete task.

The earlier corrected runtime `8dabf2772b417484c400626733cf9a480658cdad`
passed51 focused and369 full application tests. Its first focused run passed49
and failed2: Date conversion truncated microseconds and repeated cursor rows.
The exact SQL timestamp fix resolved those failures. The original failure is
retained as `/tmp/flux153-inbox-tests-initial-failed.log`; it is not relabeled as
current evidence. The later independent review found unbound aging intervals;
the source above fixes them and adds the actual SQL regression. The exploratory
cursor run executed33 tests; the explicitly enumerated final52 is the reported
focused set. Historical [claim storage evidence](../153-cowork-storage/README.md)
keeps its own source and357-test result.

## Remaining required work

The actual #152 caller-owned runtime/grant/command adapter and #154 genuine
native actor/final-event collector are available for the next composition.
Current source/target/criteria authority, request claim/resolution, immutable
authorship and independent exact-head review, dependency/safe-boundary guards,
checkpoint schema and public opaque cursor/resync are unfinished. #74's current
provider references stay disabled until each recipient has its own verified
repository access and native publications retain current-reader provenance.
No storage fixture establishes OAuth bearer admission or model activation.

All original task criteria remain open, including real two-owner/three-client
Start/Resume and loaded instructions, busy-peer scheduling, #160/#136 UI,
provider/review integration, export/import inert history and composed migration
arrival orders. These browser checks do not establish physical Android/iPhone/
iPad installation/Push or whole-product/release acceptance.

## Reproducibility

[Input and local-log hashes](source-sha256.json) pin the tested sources. The test
image ID was `sha256:3b3082400bfc23e1e91871f34f8cc043141e4db0aa093a5792590d46d5801aa3`.
Only isolated own projects were used, with no host app dependencies or services.
The full configured script removed its disposable stack. Logs stay on the
author's host; their hashes permit later matching without publishing secrets.

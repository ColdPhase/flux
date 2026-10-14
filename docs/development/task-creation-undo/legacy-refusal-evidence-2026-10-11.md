# Present-image semantic migration refusal evidence

Recorded 2026-10-11 for #238 / PR #394. This is bounded author verification,
not independent final approval or completion of AC-U1–AC-U5.

Actual tested source: `72bda56108428b30455e56805b914455961ec0f0`.
The following documentation-only handoff commit keeps `app/` and the maintained
legacy driver byte-identical to that tested source. Do not relabel the actual
72b execution as execution of a later documentation commit.

The [accepted plan](https://github.com/ColdPhase/flux/issues/238#issuecomment-6103941867)
and [composition contract](composition-2026-10-08.md#present-namespace-and-conservative-legacy-refusal-2026-10-11)
retain every full acceptance gate. Current supported files are 0048 and 0060;
there are no 0057/0058/0059 files in this manifest. The preflight runs under the
existing migration lock, before application migration, ledger or pg-boss writes.
It refuses unsupported legacy/partial/mixed catalogs and validates the supported
Undo column, constraint, trigger-function identity and guard-body shapes.

## Historical SQL provenance

Verbatim fixtures and the complete original Undo manifest hashes are under
`app/tests/app/fixtures/task-creation-undo-legacy/`. Checks verify those bytes,
including all reused original pre-0055 migration files.

| Actual source | Original artifact |
| --- | --- |
| `45c08e7d923e48d3d7402e1df962d0a1a4e71152` | 0048_unused_ai_task_creation_undo.sql and 0057_task_creation_undo_grant.sql |
| `6386b2fba48905d5f58f42ce12b84788ff57a611` | 0057_agent_runtime_sign_in.sql |
| `cbfe436175b66c832328c3bd4560868e3e28abb1` | 0058_agent_runtime_auth_operations.sql |
| `38ad797f3a561f10b7e9502079ff06d48379b492` | 0059_notification_pause.sql |

The focus artifact is 0059, not a demonstrated focus0057 file. These fixtures
reproduce actual historical SQL in disposable databases; they do not claim a
surviving historical deployment or an accepted combined old image.

## Actual checks at 72b

Command: `FLUX_LEGACY_EVIDENCE_DIR=/tmp/flux238-legacy-guard/evidence-final-head ./scripts/check_task_creation_undo_legacy.sh`.
The maintained driver builds the real Dockerfile test stage and uses the pinned
PostgreSQL image in its own Compose project, volume and network (10.199.150.0/24;
no host ports). Driver handle 62214 completed with exit **0**.

- Build, type check and lint: pass.
- Maintained ledger, morning-summary, Undo compatibility, migration/reversal,
  reversal control and Undo core cohorts: **23/23**, zero failures, cancellations,
  skips or TODOs; 100.680 seconds.
- Actual original 45c Undo48/57 and canonical sign-in/auth/focus SQL, individually
  and mixed: real CLI refusal and repeat startup preserve raw catalog snapshots,
  every public row and the ledger, before migration or pg-boss writes.
- Unversioned/partial shapes, wrong types, same-named weakened CHECK, wrong scoped
  FK, disabled/altered guards, other-schema same-named trigger function and empty
  receipt relation: refusal preserves raw schema/data/ledger.
- Fresh install, original sparse pre-0048/pre-0060 and the actual present prior
  manifest with 0055/0056/0061/0072 but missing 0048/0060: real CLI upgrade and
  restart pass. A retained non-null `constructor` column and additional unrelated
  schema remain supported.
- Real PostgreSQL dump/drop/create/restore of original legacy SQL retains used and
  reverted tasks, original/reversion notices, an Undo receipt and an Undo grant.
  Restored CLI refuses twice without changes.
- Real PostgreSQL dump/drop/create/restore of the current supported image retains
  the same history shapes; production CLI and repeat startup succeed without
  changing any retained public row or catalog.
- Agent setup, 102 repository tests and diff checks: pass.

The restore evidence comparator accounts only for PostgreSQL reparsing nested
associative AND/OR CHECK nodes. Seven pre-existing unrelated CHECK renderings
changed in the first restore attempt. Wrong grouping, operators and literal
values remain distinguishable and tested. Data/ledger equality and ordinary
migration/refusal catalog comparisons remain exact; production CHECK matching
was not loosened.

An additional actual 72b control rewrote canonical history-function line breaks
so a comment disabled its tombstone IF. The SQL was valid, but the preflight
refused it on both real CLI attempts without changes. No guard bypass was
reproduced. Its first launch failed on a read-only mount permission before any
SQL; the corrected owned mount allowed the actual control.

Image: `sha256:2c702e06dfaaf320b28d5b1e12cc190ed6db51983a1ad3a84fa580a432ecbeff`,
labelled with the exact 72b source. Owned containers, image tags, volumes and
networks were removed and independently inventoried as absent. Other projects
were left alone. Raw logs and synthetic dump/snapshot evidence stay local.

## Retained failed checkpoints and limits

- `d75d58c5079b6a810eda8ad3501aecd5495015dc`: actual driver exit 1,
  20/21 cases passed. The original-history fixture omitted the notice's required
  `created_at`, so that case failed before preflight; restore was not reached.
- `8931a4b6b647d60375576f8618e3baf9a7668b26`: actual driver exit 1,
  22/22 cases passed, but the restore catalog assertion detected the PostgreSQL
  associative CHECK rendering changes. This failed result is retained.

Final raw log: `/tmp/flux238-legacy-guard/validation-final-head.log`, SHA256
`bd1f9c270ab2711d17a291cb10a32a40c64ba796167b35ddaeb65c0a86b2b993`.
Failed logs: `validation-d75.log` SHA256
`7d2f518690df00a0738d1648d913bc36477cc98064f8336c1fb5b65a83fd22ec`,
and `validation-final.log` SHA256
`f13fb534814cf92af8f695bdb7b9eb588ede6286de7f931350ddffc20f618ca3` in the same directory.
Supplemental control: `comment-control-2.log`, SHA256
`0f700fe96f103de6553db8b853fbdcbb9c6de67199c94b7d3879906fc3eae5c6`.

The coordinator's independent frozen 72b driver is **pending**, not claimed as
passed here. Eligible Zamojski5 review and remote protected checks remain required.
Future canonical sign-in/runtime-auth/focus composition needs fresh actual
manifest/catalog ownership review and combined upgrade/restore evidence. No
legacy conversion is delivered. This run does not replace the historical full
1202-case application or paired database/files backup evidence, certify all current
API/UI/WebKit outcomes, complete required live-writer/#389 composition or inherited
#344 panel integration, or accept the integrated release. #238 stays open.

# #389 Gate 4 evidence at `79e3a14`

This compact, docs-only record pins the completed canonical Gate 4 run to
source `79e3a14b30a110171c1598309ebc99846b6389b9` and latency-driver SHA-256
`11b71d4f9d34a471367de974ec93bde207b4b6f0a6b813babaa2d68c1a79e3c3`.
The original artifacts remain outside the repository at
`/home/hubert/Develop/flux-evidence-archive/flux389-gate4-79e3a14/`; this
directory contains only the report and SHA-256 inventory, not rows, logs,
screenshots, or trace archives. `SHA256SUMS` hashes every file in that retained
artifact directory. Verify it from the artifact directory with
`sha256sum -c /path/to/SHA256SUMS`.

## Result

The unchanged canonical plan completed all nine cases, 30 warmups per case,
and 240 scheduled rows per case (2,160 total). Every row was retained; all
strict identity, input/socket, coverage, visibility, paint, and zero-error
checks passed. Every nearest-rank p95 is under the unchanged 200 ms threshold.

| Case | Rows | p95 | Failures |
| --- | ---: | ---: | ---: |
| `map-50-drag-1` | 240/240 | 113.502 ms | 0 |
| `map-50-drag-50` | 240/240 | 131.693 ms | 0 |
| `map-500-drag-1` | 240/240 | 112.837 ms | 0 |
| `map-500-drag-50` | 240/240 | 115.775 ms | 0 |
| `map-500-drag-200` | 240/240 | 150.224 ms | 0 |
| `wiki-10000-editor` | 240/240 | 143.750 ms | 0 |
| `wiki-10000-reader` | 240/240 | 130.120 ms | 0 |
| `wiki-100000-editor` | 240/240 | 187.764 ms | 0 |
| `wiki-100000-reader` | 240/240 | 163.205 ms | 0 |

The driver and collector both exited 0. The finish marker reports 9 completed
cases, 2,160 rows, and completed browser teardown. The queue seal and collector
result are complete: producer output drained, 3,208 retained records, no drops
or backpressure. The actual producer exited 0 without OOM or forced shutdown.
Compose cleanup left no containers, volumes, or networks for this run; the
runner removed its two tagged images. The measured runtime descriptor records
the actual browser, database, dependency pins, host/container, hardware, and
unlimited Docker resource settings.

Key pins and digests:

| Artifact | Value |
| --- | --- |
| Source | `79e3a14b30a110171c1598309ebc99846b6389b9` |
| Driver | `11b71d4f9d34a471367de974ec93bde207b4b6f0a6b813babaa2d68c1a79e3c3` |
| Planned cases | `a3da88e0922fa399f931c7fe1d2da13c02299c9ff1fcce001ae38ed2a38f9335` |
| Runtime metadata | `e60f82777fb4d6ec54bafc08706ed793911c7a3c4d9bd87effc735bc1dc59929` |
| Queue inventory | `9334095b7b5b8f4e3d4ee738513bdabf78924806d0626e12b158e5554358555c` |
| Finish marker | `a94d441d1cf859dc036c246c24edb8b009d5c7a923dc013e1a8c6ca1c6850f26` |
| Queue seal | `9986214be658c3099b17d7137682e827742438891e27039f270631f308ebf801` |
| Producer shutdown | `5ce438b2419c146c1a00ea61de8f20430e740ea20447c34705f4bee20e44f9e6` |
| Collector result | `d9c5cb3cce04315c0dac31b25ba1734990b6d7b07340dcd63831773efa2b32a4` |
| Combined nine-case summary | `42f16a69163b666aad6f0b83ac531e2cb497d751ed3145d788661d31478c4cf9` |
| Raw queue records | `3591bf737278648b1f1c596b2d7d865a1cc19b23e81336afef3f92f91e47c3c1` |

See `SHA256SUMS` for the full inventory, including each cohort's rows,
coverage, publication records, local control, queue correlations, screenshot,
owner/peer traces, per-case summary, runner logs, and lifecycle receipts.

## Current checks and scope

At this exact PR head, GitHub's required `Agent setup` and `Application
validation` checks both completed successfully:

- [Agent setup](https://github.com/ColdPhase/flux/actions/runs/38440385989)
- [Application validation](https://github.com/ColdPhase/flux/actions/runs/38440386016)

An independent agent recomputed and reviewed the exact-head Gate 4 rows, full
seal, retained traces, and current required checks, and accepted this evidence
in [comment 6151891175](https://github.com/ColdPhase/flux/pull/389#issuecomment-6151891175).
That is an independent agent evaluation, not an eligible GitHub approval.

This report establishes **Gate 4 only**. It is not independent acceptance,
formal GitHub approval, readiness, merge approval, or completion of #228/#231.
The PR's latest formal GitHub review remains `CHANGES_REQUESTED` from the
earlier `c4c492c7` head; a fresh full-contract delta review and eligible
protected approval are still required.

The PR body and existing #228/#231 contracts retain the remaining requirements:

- Fresh independent current-head review and eligible protected GitHub approval;
  resolved review threads and required checks must remain green at the accepted
  head.
- Complete #228 AC-1/AC-2 integrated two-person map and wiki outcomes: live
  movement and committed changes before manual refresh; identified current
  writers/cursors while typing; concurrency, convergence, immutable versions,
  safe rendering, and private draft/recovery boundaries.
- #228 AC-3 recovery across disconnect/reconnect, duplicate/reordered delivery,
  restart and route/account/project changes, including pending edits, presence
  expiry, acknowledgements and undo.
- #228 AC-4 current authority across subscriptions, mutations, recipient and
  producer handoffs, revocation, role/scope boundaries, and non-forgeable
  participant identity. A prior two-API and open-map revocation receipt exists
  at an earlier pin; its applicability to this exact composition requires
  source review and any affected recheck chosen by the evaluator.
- #228 AC-5 integrated performance and robustness outcomes: current actual
  two-user behavior under slow/lost network and concurrent typing/dragging,
  desktop/tablet/phone/keyboard/reduced-motion interaction, independently
  reviewed functional and visual evidence at the integrated head, and a
  recorded environment. Gate 4 here is the healthy-local latency matrix only.
- #231's bounded transport and stable replica admission criteria, including the
  accepted calibration gates, finite failure/resource behavior, current
  authorization and independent assessment. Earlier calibration/runtime
  receipts are tied to their own pins; they do not establish all #228 outcomes.
- Update the PR handoff's historical status text and obtain fresh delta review
  after artifact/source evaluation. The earlier review's F3–F6 notes must be
  closed with exact-head evidence, not assumed resolved by this Gate 4 pass.

The latest formal changes-requested review is pinned to `c4c492c7` and is not a
current-head evaluation. Its F3–F6 delta should be reconciled explicitly:

- **F3, handoff drift:** update the current PR body so its authoritative status
  names this `79e3a14` pass and does not say Gate 4 is still running or failed.
  Historical results can remain as clearly pinned history.
- **F4, real open-map revocation:** an earlier two-API run at `0847a79c`
  exercised actual grant deletion and close-1008 on an already-open map socket.
  The exact integrated source changed after that pin; the fresh evaluator must
  judge its applicability or request only the affected delta.
- **F5, codec calibration fixture:** this source finding was repaired on the
  subsequent PR head `cbd4655d6a5d822186b452b1e76da2e3096fb446`; see the
  follow-up section below for its scoped test result and exact delta.
- **F6, Gate 4:** resolved for this exact head by the complete run above and
  independent artifact review. This does not close F3–F5 or other #228/#231
  acceptance criteria.

The source remains unchanged by this evidence branch. No application tests were
run for this docs-only record; the two current-head GitHub checks above are
reported from the PR and the heavy Gate 4 evidence is linked to its exact
source/driver pins.

## Subsequent PR-head delta

After the Gate 4 run, PR head `cbd4655d6a5d822186b452b1e76da2e3096fb446`
adds only a test-only change to
`app/tooling/live-editing-calibration/codec.test.mjs`. Its surrogate split
cases retain both below/above public `Y.Doc.clientID` order assertions, select
an un-enrolled generated document in at most 32 attempts, destroy rejected
documents, and enroll the selected peer once. It does not assign `clientID` or
change codec/production semantics. The scoped Docker calibration codec run at
that exact head passed 32/32 tests, zero failures/cancellations/skips, exit 0
(13.334 s). The evidence is under `/tmp/flux389-f5-cbd4655/`; TAP SHA-256 is
`d0db91a5e9db1222c344170e85d50f92d27897d7f8eaa386f737d250f9a61c8c`, and the
fixture source-hash inventory is
`a1c980677bb4c904178c68254bd6b7cfa04cd32b5341a650b028e0b2ce971ee4`.

The change from the Gate 4 pin `79e3a14` to `cbd4655d` is exactly that one test
file. The production tree, latency driver (SHA-256
`11b71d4f9d34a471367de974ec93bde207b4b6f0a6b813babaa2d68c1a79e3c3`), and
collector (`scripts/collect_live_editing_queue.py`, SHA-256
`ef66cdaf42e81b142ed1a700e873f38f7a94d58e3f5d8799e7504b1cf0d0c001`) remain
byte-identical. The Gate 4 evaluator accepted the artifacts at `79e3a14`; a
separate current-head evaluator still needs to decide exact compatibility with
`cbd4655d`. No Gate 4 rerun is inferred from the test-only change.

## F4 evidence and current-source delta

The actual two-API open-map grant-deletion result is pinned to
`0847a79cd87efccb7b5afc80ce883389fc7b6aa3`. Its retained handoff and
manifests are at
`/tmp/flux389-two-api-420/run-1791747206-1731433/evidence/`, including
`outcome.json`, `two-api-inventory.json`, `actual-ledger.json`,
`runtime-input-proof.json`, `actual-test-source.json`, `cleanup.json`, and
`terminal-independent-resource-audit.json`. It exercised real grant deletion
against an already-open map socket, revoked/1008 closure, withholding post-
commit protected frames, and continued access for the other owner; cleanup was
exact for the isolated project.

Since `0847a79`, the live-editing fence/current session policy changed in
`app/apps/server/src/editing/{authority.ts,map-backend.ts,composition.ts,native-map-journal.ts,rooms.ts,runtime.ts}`
and `app/packages/db/src/{editing-transactions.ts,repositories/live-editing.ts,repositories/live-map.ts}`;
the current head also adds
`app/tests/app/editing-confirmation-fence.test.ts`. Those changes add current
provider-confirmation checks to map/wiki session and handoff paths. The old
real two-API receipt therefore remains evidence at its pinned source; an
independent reviewer must assess its applicability to the current authority
delta and request only an affected current-head test if needed.

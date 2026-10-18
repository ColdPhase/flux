# Live editing calibration and restart evidence, 2026-10-18

This package continues existing #231 and #228. Calibration was executed from clean
protected-main `a24843d7995e01e4ca62d15eb4364d3af3e12245`; the continuous restart
fixture is pinned separately below. Live editing remains disabled by default.
The complete #228 outcome is **not accepted**: Gate4 failed in this run.

## Calibration criteria (#231)

| Criterion | Observed result | Evidence and limits |
| --- | --- | --- |
| AC1: finite, pinned fixture | PASS | [Canonical inventory](canonical/inventory.json), [source/input hashes](canonical/source-and-inputs.json), actual container inspection and exit results. |
| AC2: supported upgrade/transport boundary | PASS, 11/11 | [Actual transport TAP](transport/transport.tap), [baked source hashes](transport/baked-source.json), [exact invocation](transport/invocation.json). Media-configured coverage uses a substituted upstream and establishes dispatch only. |
| AC3: stable public replica/admission | Canonical and SQL cases pass; continuous restart result below | 42/42 canonical cases, 41/41 selected PostgreSQL/resource cases, actual cross-process fixture and continuous original-instance renewal/first admission. No browser or full #228 acceptance follows from these results. |
| AC4: bounded failures and decision | PASS for executed calibration; independent approval pending | Canonical Unicode, graph, 100k, history, timeout/termination, input/backing/queue limits and negative controls all pass. Current source still needs eligible independent PR approval; no private Yjs API or OT fallback was introduced. |

### Actual commands and runtime

The canonical production-source corpus ran in immutable image
`sha256:c2bb9a418f6c00f71e7bd8593e602e15f5e606958a4b0697658eecec8c242718`:

```sh
FLUX_LIVE_CALIBRATION_GRANTED=228 python3 scripts/check_live_codec_production.py \
  --image flux-231-calibration:a24843d7 --evidence /absolute/fresh/evidence/canonical
```

It completed **42/42**, no failures/skips/cancellations, in 7805ms: 31 author
cases, 10 current adapted independent cases and one retained-backing negative
control. [Raw TAP](canonical/codec.tap) and [runner result](canonical/runner-result.json)
retain the actual outcome. Node was 24.21.0, Yjs 13.6.33, y-codemirror.next 0.3.6,
CodeMirror state 6.7.6/view 6.43.13, y-protocols 1.0.7, lib0 0.2.119 and ws 8.22.0.
The inventory records the actual twelve MIT packages and source-license hashes.
The isolated corpus container had 512MiB memory/swap, two CPUs, 64 PIDs, read-only
filesystem, no network, dropped capabilities and no privilege escalation.
These are observed corpus limits, not a measured application capacity or RSS limit.

The transport/production-codec run used that same immutable image and completed
**11/11**, no skips, in 2006ms. It exercised the actual upgrade dispatcher with
media absent/present, distinct 1024-byte event and 65536-byte editing boundaries,
immediate upgrade frames, current origin/session/actor refusals, pending/shutdown
bounds, canonical production-source equality, codec pool and retained-input charges.
[Source/container binding](transport/source-and-command.json) and the
[actual capture helper](transport/capture_transport.py) are retained. The earlier
unbound direct transport run is not counted as a second independent result.

The maintained PostgreSQL suite ran through Docker:

```sh
FLUX_TEST_PORT=18685 FLUX_TEST_MAILPIT_PORT=18686 ./scripts/check_application.sh \
  tests/app/live-wiki-authority.test.ts tests/app/live-wiki-reconciliation.test.ts \
  tests/app/live-doc-native-fence.test.ts tests/app/editing-admission.test.ts \
  tests/app/editing-deferred-admission.test.ts tests/app/editing-output.test.ts \
  tests/app/editing-shutdown.test.ts tests/app/live-editing-default-off.test.ts
```

It completed **41/41**, no failures/skips/cancellations, in 19665ms. The
[raw log](sql/sql-and-resources.log.gz), [result](sql/sql-result.json),
[source/command hashes](sql/sql-runtime-and-command.json) and sanitized
[actual running containers](sql/sql-container-inventory-initial.json.gz) are retained.
It covers durable ownership/collisions/renewal, reconstruction from snapshot64 plus
log70 with continuation71, uncertain-COMMIT receipt reconciliation, Save/history,
native write fences, admission/output/shutdown and default-off behavior. Tests
named “fresh API process” or “two API processes” in live-wiki-authority.test.ts
construct authority objects inside one Node process; they do not prove a real
process restart. A live database version query was unavailable after cleanup;
[PostgreSQL 18.6 image metadata](sql/sql-database-image.json) is labelled accordingly.
The ordinary API/test containers had no imposed CPU/memory/PID limit.

```sh
FLUX_LIVE_EDITING_PORT=18685 FLUX_LIVE_EDITING_MAILPIT_PORT=18686 \
  ./scripts/check_live_editing.sh --two-api
```

The separate actual two-API fixture completed **1/1**, no skips, in 2396ms.
[Its raw log](two-api.log.gz) records distinct real containers at one image, real
PostgreSQL NOTIFY observation, pre-drop map preview, concurrent text, named
presence, ordered missed-update catch-up, exact Save/history and current-rights
revocation. It does not establish browser/IME, actual restart or latency acceptance.

### Continuous restart

**PASS** at clean source `b9c0d9560e52c525814c1cd1ddc876d762cbbad1`:

```sh
FLUX_LIVE_EDITING_PORT=18685 FLUX_LIVE_EDITING_MAILPIT_PORT=18686 \
  ./scripts/check_live_editing_restart.sh /absolute/fresh/evidence/directory
```

The actual API image was
`sha256:2d2691b0978a18180b7569450a7635d58f3053ccb7deb43758d1cf5949ba3949`.
Both API container IDs changed and retained this exact image. The same surviving
public Y.Doc kept its original generated replica ID; enrollment without the
original instance ID refused409/EDITING_REPLICA_COLLISION; renewal returned the
original instance. A new UUID was absent from the durable receipt table before
submission, then its new update was acknowledged as changed at sequence2. The
fetched body and two durable journal entries agreed. Original receipt replay,
explicit Save/version1 history, native map undo and retries also passed.
[Client log](continuous-restart/client.log), [before](continuous-restart/before.json),
[after](continuous-restart/after.json), [source hashes](continuous-restart/source-sha256.txt)
and [actual exit state](continuous-restart/client-state.json) are retained. The
continuous client ran for 8.883s, exited0 without OOM, and its private fixture
state and isolated stack/images were removed. The Docker image build also
completed application build/typecheck/lint (zero lint errors; nine existing
warnings); [raw build log](continuous-restart/build.log.gz).

The earlier [prepare/verify restart](receipt-replay-restart/verify.log) also passed
at a24843d7 after actual recreation of both API containers. Its original immutable
UUID returned a stored receipt before the ownership check. It therefore proves
receipt replay, not original enrollment survival. The continuous fixture was
added specifically to test that missing observation without assigning a Y.Doc
clientID or pretending a reconstructed object is the surviving instance.

### Prior findings and current provenance

The historical b439b29c failing source, its four demonstrated negative controls
and issue comments remain unchanged. The current adapted independent corpus is
substantive and recorded with hashes; the original temporary probe files are no
longer available here, so their recorded historical hashes are metadata, not a
fresh byte-for-byte assertion comparison. Current assertions do not become
historical independent PASS by relabelling them.

The independent calibration assessment found AC1/AC2/AC4 passing and one AC3 gap:
original replica enrollment across a real API restart. Its bounded final check
confirmed that the earlier receipt-only fixture did not close that gap. No third
blanket agent review was launched. The new continuous fixture targets that exact
observation; current PR approval remains the independent protected merge gate.

The current branch changes only the restart test/runner, documentation and a
Compose comment. Canonical codec, transport, core/SQL implementation, dependencies,
selected SQL tests and latency driver are unchanged from a24843d7. The old results
retain their original source SHA; they are not represented as runs of the new head.

## Remaining parent outcome (#228)

The unchanged nine-cohort Chromium latency driver completed all **2160 scheduled
rows** (240 per cohort, 30 warmups each). Input-to-painted-peer latency uses one
driver clock, includes browser round trips and two RAF, and subtracts no local
render overhead. Source is a24843d7; browser 151.0.7922.34, PostgreSQL 18.6,
1440×900 viewport, headless reduced motion, healthy local Docker bridge. API/DB
CPU, memory and PIDs were unset; runtime metadata records the actual host/image.

| Cohort | p95 ms | Outcome |
| --- | ---: | --- |
| map 50, drag 1 | 141.062 | PASS |
| map 50, drag 50 | 153.881 | PASS |
| map 500, drag 1 | 130.908 | PASS |
| map 500, drag 50 | 154.269 | PASS |
| map 500, drag 200 | 208.063 | FAIL: exceeds 200ms |
| wiki 10k, editor | 148.589 | FAIL: one EDITING_LEASE_CHANGED socket refusal |
| wiki 10k, reader | 133.617 | PASS |
| wiki 100k, editor | 171.950 | PASS |
| wiki 100k, reader | 159.740 | PASS |

Every cohort had zero missing/timeout/error scheduled samples and zero input
errors. The socket refusal was observed while the 10k editor cohort was being
recorded; its originating operation has not yet been established. It is not
waived or assumed to be a wiki validator failure. Overall driver exit was **1**,
collector exit **0**. The sealed queue contains 3224 records, zero drops or
backpressure, no budget violation, a drained final record with zero active gauges
and actual clean producer exit0 without OOM. Complete telemetry does not make the
failed performance/correctness gate pass.

The [compact per-case results](latency/case-results.json),
[full compressed summary](latency/summary.json.gz), [runtime](latency/runtime.json),
[seal](latency/queue-seal.json) and [actual shutdown](latency/producer-shutdown.json)
are retained. Bulk rows, publication ledgers, coverage, screenshots and traces stay
outside Git at `/home/hubert/flux-evidence/228-231-20261018-a24843d7-latency`.
They are not a public CI artifact or a complete independently accepted gate.

#228 stays open for correction of these failures, the remaining integrated
browser/IME/recovery criteria and independent acceptance of all four gates before
production enablement. The threshold, driver, sample set and default feature flag
were not changed. All disposable test stacks were cleaned up; the normal developer
stack was preserved.

[manifest.json](manifest.json) records original and retained hashes for captured
files. Compressed files use gzip; no fixture cookies/private restart state are
included.

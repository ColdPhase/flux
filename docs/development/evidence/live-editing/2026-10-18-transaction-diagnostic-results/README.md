# Author transaction diagnostic results — 2026-10-18

Whole #228 remains Draft #613. This is author evidence, not independent review,
performance acceptance or a speedup claim. The original canonical result at
`f30c9910a21911a4287833a1c19faa12bb5d2851` remains **7/9**: map500/drag200
208.690 ms and wiki100k editor 207.680 ms failed. No threshold changed.

The [prior contract](../2026-10-18-transaction-diagnostic.md) authorized bounded
private observations without SQL, permission, lock, transport or driver changes.
Both attempts used the same selected driver SHA256
`854ebf24f86d91108e73255a3a6544cf930641f06aaf0febee95b5285166f2b4`, 30 warmups,
240 samples over 60 s at 250 ms, trace enabled, original 200 ms limit.

| Actual private source | p95 ms | Rows/errors | Stage capture | Result |
| --- | ---: | --- | --- | --- |
| `fb8764caaab7c23d3875064f1eb826438fd5ce7d` | 217.435270 | 240 / 0 sample,input,socket errors | NONE | Author setup failure: flag on test, absent on actual API |
| `941a1ff5162dc30619d5cf41882520aa6add368d` | 229.915632 | 240 / 0 sample,input,socket errors | 7433/7433, cap 12000, dropped 0 | Corrected diagnostic; timing FAIL, not acceptance |

Base was frozen `f83202ba3f37c3d1ca33d166f9a722648e416c11`. Instrumentation
preflight build/type/lint passed at 6e07cc5b; corrected source only moved the
flag test→api and added fail-fast inspected actual API env = 1 before any measured
work. Startup inventory is retained here. Neither private code nor its runner
may be cherry-picked to production. No further runtime retry was performed.
Clock reads and bounded record allocations perturb the workload; no overhead
subtraction. The corrected local render-control p95 was137.993145 ms, itself
different from earlier controls. No host-load cause follows.

## Supported cost and one proposed change

Stages cover move and deliver only, not presence or other operations. All 7433
records succeeded and settled, on one sketch: 1722 move and 5711 deliver. The table
selects measured-gesture sequences 347–1920, including intervening publications
and duplicate delivery checks. These are not 240 independent browser-row pairs.
Numbers are milliseconds, p50/p95; overlapping quantiles are not additive.

| Operation | n | Initial policy | Post-policy→settled | Whole run | Producer policy total |
| --- | ---: | ---: | ---: | ---: | ---: |
| Move | 1410 |20.599/24.856|6.893/9.113|28.090/32.985|n/a|
| Peer deliver |2162|19.181/23.595|7.700/9.442|27.469/32.509|2.735/3.508|
| Own deliver |2158|19.341/23.666|7.668/9.484|27.574/32.556|2.763/3.568|

Producer policy totals sum two identity checks. Move lease total 4.064/5.768;
full rows query 2.231/3.563; decode 0.008/0.027; bindMove 1.135/1.594.
Peer final transient fence 0.637/0.851; synchronous handoff 0.283/0.549.
Entry→DB callback p95 was 0.414 move / 0.327 peer. The main policy await dominates;
it includes query execution, scheduling and serialization, not pure lock wait.

Observed other transactions already beyond policy and before finalFence retain
NO KEY UPDATE on this same sketch. Their known-held intervals overlap the
initial policy await by median 15.045 ms (move, median 73.36%) and 13.436 ms (peer,
69.47%). This is interval overlap, not a direct database wait measurement;
uninstrumented presence and other intervals are missing. No cross-clock latency
subtraction is made. Full statistics and a numeric witness are checked in here.

One recommendation is to eliminate the second full evaluation in
`policySketchAccess.requireSketch(read)`: evaluate write once with requested
locks, enforce read by visibility, then classify access by write allowance.
For the same evaluated state, every scope has read.allowed==write.visible.
This preserves viewer/closed-DM reading, private ownership and non-leaking 404;
write still enforces allowed / 403. Existing lock order is action-independent:
actor/owner membership, sketch NO KEY UPDATE, then project/grants or DM/caller
participant. dmClosedFor adds no locks and already runs in the old second pass.
No cache, weaker locks or removed final fence is proposed. Tests must verify
observable scopes/roles and current revocation before product acceptance.

This removes known repeated work in the measured region. It does not quantify
its gain or identify the cause of the earlier 191.902→208.690 difference. Lease
row loading is not recommended as the main fix. Wiki uses a different path;
no wiki gain follows. Full original nine cohorts and independent final
acceptance remain required after any actual product change.

## Runtime, retention and cleanup

Actual Node v24.21.0, PostgreSQL 18.6, Chromium 151.0.7922.34, Python
Playwright 1.62.0. Actual corrected CID/image/env and exit are retained here.
Both selected collectors correctly rejected incomplete cohort plans
(`closed marker binding invalid`, exit 1): 369 rows first / 374 corrected. They are
not canonical resource seals. After measurement, private acquisition stopped
its own API, inspected exit 0 / no OOM, then captured logs. Both stacks had zero
owned containers/networks/volumes/image tags afterward; ports 18685/18686 free.
User demo/Qwen remained running. Heavy slot was released after each cleanup.

Bulk logs, all 240 timing rows and all 7433 raw stages remain outside the repo:

- `/home/hubert/flux-evidence/228-mapstage-fb8764ca-latency`
- `/home/hubert/flux-evidence/228-mapstage-941a1ff5-latency`

`external-artifact-sha256.json` pins the corrected full artifacts.
`raw-stage-excerpt.jsonl.gz` is explicitly a bounded excerpt: original
header/end plus first 32, last 32, every 64th and 16 slowest records, deduplicated by
id. The header/end retained count describes the FULL external dataset, not the
excerpt. Full analysis scripts and the detailed author report are external.
No API log, token, code, payload or disposable credentials are checked in.

# Bounded transaction diagnostic — 2026-10-18

Before diagnostic code: whole #228 remains Draft #613. The composed application
at `f30c9910a21911a4287833a1c19faa12bb5d2851` passes its maintained functional
checks, but the [canonical timing gate](2026-10-18-composed-latency/README.md)
fails map500/drag200 at 208.690 ms and wiki100k editor at 207.680 ms. The earlier
selected map run on the same application passed at 191.902 ms. Neither result
identifies a product fix or authorizes a threshold/method change.

Existing data places the map difference mainly before the peer receipt; local
render control and receipt-to-paint are faster in the full run. These overlapping
quantiles are not additive. Python Playwright callback timestamps do not isolate
server or network time. Sampled map queues do not accumulate, but active SQL
operations can still wait for locks. Earlier-cohort frame retention is not
supported: the driver clears those histories between cases.

One private diagnostic branch may add bounded numeric timing observations to
the server map transaction path, then run the existing selected map500/drag200
cohort once. Keep its driver byte-identical to the previous selected driver
(`854ebf24f86d91108e73255a3a6544cf930641f06aaf0febee95b5285166f2b4`).
Do not change application semantics, SQL statements/order, policy/session locks,
confirmation clocks, transport/cadence, queue budgets, browser flags, visibility,
positions, assertions, trace settings, schedule or the 200 ms limit.

Measure entry/pool-and-BEGIN, recipient session, policy, sketch/head, action,
final fence and completion/commit where possible. Distinguish producer movement
and recipient delivery and correlate only existing fixture resource/gesture/
sequence IDs. Nested observations may locate an expensive action. Await elapsed
time includes execution, scheduling and possible locking; do not label it pure
lock wait without direct database evidence. No bodies, names, credentials or
unbounded per-query/payload logs. Cap retained observations, expose truncation,
and flush only after measured work settles; document instrumentation overhead
and any unavailable stage.

Use one isolated Docker stack and the shared heavy-workload slot; preserve the
user's demo/model services. Capture actual source/runtime, raw diagnostic records,
all 240 timing rows and cleanup. The selected collector is expected to reject
its incomplete cohort plan; no complete Gate 4/resource acceptance follows.
No new CPU profile or unchanged full-nine rerun. This is author diagnosis, not
an independent review round. Do not ship the instrumentation or claim a speedup
from its perturbed result. The outcome must be one supported next change or an
explicitly unresolved cause, preserving every acceptance criterion.

## Failed diagnostic setup and bounded correction

The first actual attempt at private `fb8764caaab7c23d3875064f1eb826438fd5ce7d`
completed all 240 timing rows (p95 217.435 ms, no sample/input/socket errors), but
collected **no transaction-stage records**. Its Compose flag was placed on the
test service rather than the API; actual inspected API environment confirms the
missing flag. Build/type/lint success and clean shutdown do not replace this
missing observation. The selected collector remains correctly INCOMPLETE. Raw
evidence is retained at
`/home/hubert/flux-evidence/228-mapstage-fb8764ca-latency`; no product diagnosis or
speedup follows, and the canonical 7/9 failure is unchanged.

One corrected attempt may move only that private flag to the API and assert its
actual inspected environment equals `1` **before starting measured work**,
aborting otherwise. Keep the existing instrumentation, exact selected driver,
application/SQL semantics and all limits. Do not repeat build/type/lint for this
Compose-only correction; preserve the original preflight result and its source.
Retain both attempts separately. No further runtime retry follows automatically.

## Supported implementation scope: one current sketch access evaluation

The corrected private attempt at `941a1ff5162dc30619d5cf41882520aa6add368d`
retains 7,433/7,433 stage records, cap 12,000, zero drops. In the measured move
sequence range, policy-stage p50/p95 is 20.599/24.856 ms, compared with whole
operation 28.090/32.985 ms. Peer delivery policy is 19.181/23.595 ms compared
with 27.469/32.509 ms overall. Lease loading is much smaller. Await durations
include serialization and scheduling; these observations do not isolate lock
wait or explain the previous selected/full difference. Its instrumented p95
229.916 ms is diagnostic only, not a clean product comparison or Gate 4 pass.

Before product code, the bounded follow-on is to remove the duplicate full
evaluation inside `policySketchAccess.requireSketch(read)`. Today it evaluates
read with the requested locks, then evaluates write again to classify access.
For every existing scope, `read.allowed` equals `write.visible` at the same
state. Evaluate write once with the same requested locks; permit read only when
that evaluation is visible and return read/write from its actual write allowance.
Writes still require allowance. Preserve 404/403 behavior, private ownership,
project grants, agent authority and readable-but-closed DM history. No new cache,
cross-transaction reuse, public API, lock mode/order, clock/final fence or reduced
permission check. `dmClosedFor` already runs in the original second evaluation.

Verify existing observable HTTP/core/live-map permission regressions, including
viewer/outsider, private/DM/project, closed DM and current revocation, in Docker.
Add coverage only for a meaningful uncovered behavioral boundary. This is one
measured-cost optimization, not a promise of a particular gain. Wiki uses a
different path: its failed 100k timing remains unresolved. The original full
nine-cohort gate and independent final acceptance still apply; do not ship the
private instrumentation or weaken any threshold or criterion.

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

# Independent bounded lifetime review — d5bf0be2

2026-10-07. Evaluator: `/root/kreska_fixes`, independent of author `/root`. Exact production/test head: `d5bf0be2a8a96c943397262add758e64c9ed4b43`, worktree `/home/hubert/Develop/flux/.worktrees/228-live-map-wiki`. Read-only review: no source, branch or GitHub changes, no Docker runtime launched by this evaluator.

**PASS for the bounded HTTP lifetime / ordinary map isolation repair. No actionable finding in this delta.** This does not accept #228/#231, PR #239, any of the four F-021 gates, latency, or final-design UI.

## Independently checked source and test semantics

Compared `06b8cc9d1a1823429f81d20f3a9ccde71d06aef3` with the candidate: four production files plus the test COMMIT barrier's arming point. Also checked that `4034654e1c386832595b047067bb98e71a20bdea` → `06b8cc9d` changes only `app/tests/app/editing-http-lifetime.test.ts`, so the valid negative control actually retains the prior production source.

- `editing/http-lifetime.ts`: deferred ownership still observes `finish`/`close` synchronously before the first SQL/admission await. `protect()` takes one 4096-byte charge, idempotently. It does not treat an already observed HTTP close as settled work. Disposal requires both actual terminal transport and work settlement, so a late room can acquire its charge after close and release without another transport event. Existing eager callers remain eager.
- `sketches/adapters.ts`: an established room calls `protectLifetime` inside the existing typed-capacity refusal boundary and before `prepareNativeMap`. Budget refusal therefore becomes retryable503; the ordinary roomless preflight remains uncharged and unqueued.
- `editing/native-map-journal.ts`: the second room check returns early for an ordinary roomless map. Only after that return boundary does the journal protect the owner, before input reservation, locked room read and response admission. This handles a first room appearing after the earlier preflight without freeing SQL-owned context prematurely.
- `sketches/routes.ts`: ordinary commands check `canSend` after work, and settlement remains in `finally`; existing protections against success/error serialization on a known terminal response remain intact. No authorization rule, fixed capacity, deadline, default-off flag or persistence contract was relaxed.
- Test controls use actual Fastify/HTTP, public `ServerResponse` events, actual PostgreSQL and current authorized routes. The query interposition executes real SQL first and only holds its result. The new-room COMMIT hold is now armed after the concurrent real join settles, avoiding interception of the join's COMMIT. The control does not fabricate query rows or reset gauges. The full-budget lease is legitimately reserved and released.

The three added cases meaningfully verify ordinary201 plus exact replay under full live capacity, retained-room retryable503 without effects followed by exactly-once recovery, and a newly established room after an actual closed HTTP response retaining source through a held successful COMMIT. The eleven existing cases continue covering finish-before-work, close-before-work, definite rollback, unknown COMMIT-response loss, parser400/bodyless204, no terminal serialization and exact durable replay. The old third failure occurs at the premature4096 charge assertion; it is not independently a baseline reproduction of every later assertion in that race.

## Checks and runtime attribution

Own checks on an archive of the exact candidate at `/tmp/flux228-review-d5`:

```sh
git archive d5bf0be2a8a96c943397262add758e64c9ed4b43 | tar -x -C /tmp/flux228-review-d5
python3 scripts/check_agent_setup.py
python3 -m unittest discover -s tests -p 'test_*.py'
git diff 06b8cc9d1a1823429f81d20f3a9ccde71d06aef3 d5bf0be2a8a96c943397262add758e64c9ed4b43 --check
git diff origin/main...d5bf0be2a8a96c943397262add758e64c9ed4b43 --check
```

Setup PASS; 74 foundation tests PASS; both whitespace checks PASS. The archive prevents the later untracked evidence addition from changing the source checked here.

I independently read the full author-run Docker logs and the control script `/tmp/flux228-http-control.sh`. The script checks a clean checkout before building, records HEAD and actual image IDs, uses isolated Compose projects/volumes, and invokes:

```sh
node_modules/.bin/tsx --test --test-concurrency=1 tests/app/editing-http-lifetime.test.ts
```

- `/tmp/flux228-http-baseline.log`: missing `/data/files` mount is an invalid harness setup, not a product failure or passing test run.
- `/tmp/flux228-http-baseline-files.log`: exact source `06b8cc9d`, 14 tests, 11 PASS / 3 FAIL, exit1, 5683.722251ms. Actual failures are500 instead of201,500 instead of503, and4096 instead of zero before the roomless preflight.
- `/tmp/flux228-http-candidate.log`: exact source `d5bf0be2`, fresh build/types/lint with zero lint errors and three retained warnings; 14/14 PASS, zero fail/cancel/skip/todo, exit0, 8148.89671ms. Production image `sha256:a8d9bc22c3669a8723d3c01ce035a4e3cfd1fc6d002887c8bb47520d5f78a9c0`; test image `sha256:4c5edd39070ad20f6ee599ffcd9af0222eab0c775bf55a851caeed0dd36d96a6`. Fastify override, pg query deprecation and build warnings remain visible in the raw log.

These are independently audited author-run runtime results, not a second runtime run by the evaluator. A fresh heavy rebuild was not necessary for this source/test/log review and would contend with the coordinated #326 window. Cleanup records are present; the current Docker inventory has no objects from either valid run's project.

## Evidence-only delta

Separately reviewed the currently untracked `docs/agents/evidence/228-live-editing/http-ownership-20261007/` on top of d5. PASS, no overclaim found. See `/tmp/flux228-evidence-independent-d5.md` and `/tmp/flux228-evidence-validation.log`. Once committed, pin the resulting documentation head and preserve the explicit production equivalence to d5; this review does not guess a future commit SHA.

## Still open

All four live acceptance gates remain open. The nine60s/2160-row latency cohorts, complete producer/EOF shutdown, all26 final gauges at zero, independently committed-map latency, cross-process rights/restart, trusted touch/IME, accepted current-main/dependency composition and final #336/F-026 UI remain outside this bounded result. Existing partial-cohort failure remains a failure. Keep PR #239 draft and live editing off by default; this local review is not an eligible formal GitHub approval.

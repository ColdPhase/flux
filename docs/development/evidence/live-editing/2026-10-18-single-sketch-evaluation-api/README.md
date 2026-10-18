# Single sketch access evaluation: selected API evidence — 2026-10-18

Author verification for existing whole #228 / Draft #613, not independent review.
Contract preceded code at `a3ba3553`. Product source is
`00f11151c469e9d0c8aea892244a0b4c45eda486`; its two test grant references were
narrowed at `1f76588eec7ed68d16c15d9ae7663a72770ae47b`, the exact tested source.
This evidence-only delta does not change application/test source.

The adapter evaluates current write policy once with requested locks, permits
read only by visibility, and returns access from allowance. No SQL/locks/order,
cache, clock/final fence, native transport or unrelated optimization changed.
A new real-PostgreSQL regression verifies agent viewer/contributor/deny,
owner viewer ceiling, private opacity, revocation and owner removal, with and
without policy locks. It PASSED. Existing viewer/private/DM closed-history,
current revocation, native/MCP/live policy and temporal fence cases were kept.

## Actual result: incomplete acceptance

One initial selected attempt at 00f11151 passed product build but stopped at
typecheck: two new test grant arguments used broad Principal (includes fixture),
incompatible with PrincipalRef. API/tests did not start. Only those two test
arguments were corrected; the core product source stayed identical.

The same selected check was repeated at 1f76588e: **build/typecheck/lint PASS;
46/50 API tests PASS, 4 FAIL, 0 skip/cancel/todo**, 42.231 s. It is NOT an API pass.
Selectors and actual command are in command.json. No latency, UI, profile,
full-suite or baseline control run occurred here. No performance/wiki-gain
claim follows.

Four unchanged existing conflict cases failed after the expected 409 / code:

- dm-sketches.test.ts:273 stale promotion preview is undefined (content).
- dm-sketches.test.ts:383 stale audience preview is undefined (audience).
- dm-sketches.test.ts:414 stale target-grant preview is undefined (audience).
- sketches.test.ts:270 stale thought currentVersion is undefined instead of 2.

Static source diagnosis: normal live sketch command catch in
`app/apps/server/src/sketches/routes.ts` clears all generic DomainError.details,
also for ordinary unjoined maps. LinkLabelConflictError alone has a dedicated
nativeMapRoomExists branch. The four failures need conflict current/preview
fields. This catch is byte-identical in base a3ba3553 and tested 1f76588e, but an
unchanged-base runtime comparison was NOT performed. Do not call this an
independently proven baseline failure or attribute it to host/environment.
Restoring safe ordinary native conflict disclosure, preserving post-rollback
current permission fences for joined rooms, is outside this one-evaluation
patch; neither route nor test expectations were changed to hide failures.
The parent was notified for a separate whole-issue author decision.

## Runtime and cleanup

Actual Node v24.21.0, PostgreSQL 18.6; API live editing on, NODE_ENV production,
no private transaction diagnostic flag. Runtime receipts contain actual API/DB
CID+image IDs and allowlisted configuration only; the additional 11-container
inventory covers the isolated stack before cleanup. These are running snapshots,
not a canonical terminal resource seal or proof of all final process exit codes.

Both attempts are terminal with no owned containers, networks, volumes or image
tags afterward. Ports 18685/18686 are free. Ordinary Flux demo and Qwen remained
running. Cleanup receipts include actual observations. Heavy slot returned to
root after terminal verification. No further runtime work is implied.

Bulk logs stay outside the repository, with hashes in result.json:

- `/home/hubert/flux-evidence/228-single-evaluation-00f11151-api`
- `/home/hubert/flux-evidence/228-single-evaluation-1f76588e-api`

Only compact outcomes, runtime metadata and cleanup are checked in. No API log,
credential, token or disposable secret is included. Whole #228 still requires
all original functional/timing gates and independent final acceptance.

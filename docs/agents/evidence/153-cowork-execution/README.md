# Actual shared execution ledger and claim adapter — partial #153

Verified 2026-10-01 on `claude-maurycy/153-cowork`, draft PR166.
Runtime and tests are pinned to
`07bd08bb0d45e85bc4f1e404c0c8bae75c6f16c4`.
This includes the previously integrated #152 execution dependency
`a7b3b6e603be0ecb1a56f87db08f933d772491c3` and #154 genuine native actor
dependency `d1d03f70f1ddb7c78d05216ac570c9359cb5290c`.
No original AC1–AC5 is declared complete and no public claim tool is activated.

## Executed verification

- Docker build/typecheck/lint PASS:
  `/tmp/flux153-execution-target-build.log`, terminal32754 exit0.
- Complete configured `FLUX_TEST_PORT=19051 FLUX_TEST_MAILPIT_PORT=19052
  ./scripts/check_application.sh` PASS:
  `/tmp/flux153-execution-target-application.log`, terminal87982 exit0.
  **417/417** application tests,59.359s, no skips;3 PWA;1 access/stream browser;
  1 genuine human/agent actor browser;1 signed scope/connection consent browser;
  stored session/material/conversation after API restart;1 Push-unavailable;
  1 SMTP-unavailable.
- Setup/local links,34 Python tests and whitespace PASS.
- Independent source-only review found a historical-checkpoint restriction;
  the fix and its regression are included. Final source-only review of the exact
  target-grant adapter found no further actionable issue. This is not eligible
  whole-task approval and does not substitute for independent runtime review.

Own direct build image is `flux-cowork-execution:flux153-execution`,
`sha256:d1e14a4ec634b5c993c049e9605b4b50ab8fc2537efa32f28ca45c0645d61a3f`.
All application dependencies and tests ran in Docker with isolated task ports.
The configured command removed its own test stack; no global cleanup was used.

## Observable coverage of the eight added checks

The tests use actual PostgreSQL and the existing owner/project/agent/grant API,
server runtime and #152 transaction-bound execution ledger. They prove:

1. Concurrent identical claim commands produce one lease, one durable receipt
   and one grant debit. An exact exhausted-grant retry after lease expiry returns
   the original expiry/identity rather than extending work or consuming again.
2. Changed payload, runtime session or operation conflicts without changing the
   original claim; runtime identity is distinct from transport/session input.
3. Renewal preserves lease identity/generation and advances the version. A
   checkpoint-backed release uses the same ledger and fences earlier receipts.
   Missing prepared source coverage rolls back; valid release clears the lease,
   preserves the checkpoint and increments generation.
4. Failure in the outer transaction after claim/debit/receipt rolls all three
   back; the subsequent retry commits one effect.
5. Actual client substitution, an owner API edit to the source material and a
   current grant revoke deny observation of an earlier successful receipt.
6. An actual connection-slot lock wait, observed through PostgreSQL blocking
   state, permits runtime expiry before acquisition; the late claim/ledger
   roll back under the fresh DB clock.
7. Exact grant targets match workspace/project/assigned connection/actual role.
   A wrong-role exact target is a content-free404. A broad review grant still
   cannot claim an execute unit; copied prompt fields and missing policy
   providers are rejected without a claim receipt.
8. A current authorized assignee can read a retained historical checkpoint from
   a past connection for the same unit/current sources, but cannot release with
   that checkpoint's old connection/generation/session fence.

The producer remains an internal caller-owned transaction adapter. #152 is the
only grant-use/receipt authority; the callback observes the canonical actual
saved claim state. Lock preparation accepts the complete server-discovered task
set before unit locks. Public owner grant creation now has an explicit boolean
coordination-target check; it does not disclose unit content or activate execution.

## Earlier failures and verification limits

The first full run at `3bbfacd3e50f133bddb2ae63232140860bd36e1d` passed409
and failed all8 new checks: owner grant creation recognized only native work/maps
and rejected the exact co-work unit target with OBJECT_NOT_FOUND404. The fix in
07bd adds the explicit current-scoped target adapter rather than widening grants.
`/tmp/flux153-execution-application.log` retains that failure; browser phases did
not run there. Earlier build logs separately retain explicit callback typing and
unused-import failures, fixed before the final build. These logs are hashed,
not published wholesale, because cleanup diagnostics can contain environment data.

Trusted bearer admission and policy callbacks are fixtures in these checks.
They do not prove a real provider-issued bearer, native dependency graph locking,
complete source/private-reader policy, reviewer eligibility or model activation.
The historical-checkpoint case does not prove a production transfer command.
Checkpoint production, request enqueue/claim/resolution, fenced native result
publication before the final event flush, current-authorized opaque recovery,
supported-client scheduling/Start/Resume, two-owner/three-connection traces,
integrated UI and physical-device/release acceptance remain required.

The complete417 run retains the migration-arrival and earlier storage/actor tests;
historical357/370/406 evidence keeps its original source and is not relabeled.
[Exact source/input/log hashes](source-sha256.json).

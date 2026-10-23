# Transaction-local map producer checks — 2026-10-18

Author verification for existing #228 / Draft PR #613, not independent acceptance.
The hypothesis contract was committed **before code** at
`b9b215329ecd14f176218fc3eac2d7ece19d70e0` in
[the proposal](../../../../development/live-editing-proposal.md#transaction-local-map-producer-checks-bounded-cost-hypothesis-2026-10-18).
Base: `6ac818c6082ca7b035f07373bafb749f993ca19e`; branch:
`codex-hubert/228-map-producer-memo`.

Tested source: **`450f2430c17e1b57bfe54df7be607dc723ba5d89`**. Production change:
`cfa03a83bcb90547f17c930d33b459fc450aa369`. The final source differs from that
production commit only by a test assertion's TypeScript variant narrowing.

`mapBackend.deliver` now reuses only successful full producer checks for the exact
actor/session pair, inside one delivery transaction, only for project/private
maps. The first occurrence retains its session and full write-policy locks;
recipient access does not seed results. Refusals and DM decisions are not cached.
The bounded identity references are cleared before projection/handoff; no cache
crosses a transaction or pooled connection. Final generation, SQL-clock
session/TTL/confirmation checks and publication behavior remain unchanged.

| Source | Check | Passed / failed / skipped / cancelled | Test duration |
| --- | --- | --- | --- |
| `450f2430` | Four selected API files | 36 / 0 / 0 / 0 | 31.158 s |
| `450f2430` | One actual two-API integration case | 1 / 0 / 0 / 0 | 2.193 s |

The selected API command was:

```sh
FLUX_TEST_PORT=18685 FLUX_TEST_MAILPIT_PORT=18686 ./scripts/check_application.sh \
  tests/app/live-map-authority.test.ts tests/app/editing-confirmation-fence.test.ts \
  tests/app/live-map-preparation.test.ts tests/app/editing-http-lifetime.test.ts
```

After that command passed, one integration run used:

```sh
FLUX_LIVE_EDITING_PORT=18685 FLUX_LIVE_EDITING_MAILPIT_PORT=18686 \
  ./scripts/check_live_editing.sh --two-api
```

Both canonical Docker runs passed build, TypeScript and ESLint checks. The earlier
`cfa03a83` build failed type checking before API startup: the new test initially
read `connectionId` without excluding the `map-clear` variant. The conditional
integration run did not start on that failed source. The correction explicitly
rejects an unexpected clear receipt before narrowing; it changes no product code
or assertion outcome. See [the error excerpt](first-build-error.txt) and
[original external log hashes](raw-log-manifest.json).

The new populated delivery regression passed in 0.695 s: two independent real
password sign-ins of the same producer each contribute gesture and presence.
Public PG query interposition observes actual SQL and forwards every query without
substituting results: each producer session retains one first `FOR SHARE` check,
and each pair retains its full locked write decision. All four transients arrive.
After a committed public grant downgrade to viewer, a later delivery emits none;
all four underlying transient rows are still within TTL. Denied gesture/presence
checks remain repeated rather than memoized.

The extended withheld-handoff regression passed in 3.999 s. After successful
producer checks, session expiry, transient expiry and provider-confirmation lapse
each remove the old producer output at the final fence. The provider case uses
explicit disposable SQL session/account provenance, **not a real OIDC sign-in**;
it exercises the populated final producer query. Existing confirmation, finite
preparation, real HTTP abort/COMMIT/authority and protected response tests also
passed. [API summary](api.summary.txt).

The separate integration case used two distinct actual Docker API containers of
the same image, with real person sessions, PostgreSQL, WebSocket transport and
NOTIFY. It passed ordered map/wiki catch-up, pre-drop preview, character updates,
named presence, dirty native-write refusal, committed grant revocation followed
by revoked/1008, no subsequent protected map frames, and independent owner
continuation on both APIs. The case itself took 1.477 s; its runner reported
2.193 s including test-process overhead. [Integration summary](two-api.summary.txt).

The runtime inventories were captured **before cleanup**, with full container and
image IDs plus only allowlisted non-secret configuration. The normal API lane ran
production/on without diagnostic or telemetry markers; both integration APIs ran
production/on with the diagnostic marker and telemetry disabled. Observed runtime:
Node v24.21.0, PostgreSQL 18.6, pnpm 12.6.0, TypeScript 5.9.2, tsx 4.20.5,
Playwright package 1.63.0, Yjs 13.6.33, Fastify 5.6.1 and ws 8.22.0. Playwright is
only a package observation here; no browser test ran in this batch.
[API inventory](api.inventory.json), [two-API inventory](two-api.inventory.json).

[Cleanup receipt](cleanup.json) verifies no containers, project-tagged images,
networks or volumes remain for the failed build or either successful run. The
runners removed respectively zero, three and two per-run images; ports
18685/18686 were free. The ordinary Flux demo and user's Qwen service were
preserved; the heavy Docker slot was returned to the coordinator.

Agent setup/link/evidence checks, 153 Python foundation tests (7.557 s at the
production commit) and whitespace checks passed before application verification.
The report is a documentation-only delta after the tested source. Raw logs remain
outside the repository; checked-in excerpts omit API request/debug bodies and
credentials.

This batch establishes functional checks and the repeated-SQL witness; it does
**not** measure a latency improvement or pass the unchanged 200 ms gate. No codec
or transport suite was repeated, no latency profile ran, no GitHub mutation or
review request was made. All original gates, the coherent final candidate's
remaining UI/integration checks and eligible independent functional/visual
acceptance remain required for #228 and PR #613.

# Two independent API process fixture

This is a source-prepared, unexecuted Gate3 functional fixture for #228. It uses
`tests/app/live/two-api.test.ts`, which is included in application type/lint
checks but excluded from the ordinary top-level one-API test glob. Selecting it
requires two actual running API containers at the same candidate image, shared
database/authentication key/public origin, and explicitly enabled development
editing. A second Fastify instance or SQL client in one Node process is insufficient.

The runner obtains each service's container ID, image ID, current PID/command,
network alias and environment from actual Docker inspection before the test. It
retains that inventory with resource limits and records a sanitized file:

```json
{
  "schema": 1,
  "sourceSha": "<actual40-character-candidate-SHA>",
  "apis": [
    {"apiInstance":"api-one","apiUrl":"http://api:8080","containerId":"<actual64-hex-ID>","imageId":"sha256:<actual-image-ID>"},
    {"apiInstance":"api-two","apiUrl":"http://api-two:8080","containerId":"<actual64-hex-ID>","imageId":"sha256:<same-actual-image-ID>"}
  ]
}
```

The URLs must resolve to the inspected independent processes. Both share the
canonical `FLUX_PUBLIC_ORIGIN`; the Node public clients send that Origin and Host,
then acquire real cookies through sign-up on their respective API. The fixture
never injects a principal/session, replaces a policy/SQL/transport port, calls an
application fixture auth endpoint, or changes the receive limits. Its dedicated
PostgreSQL connection only observes the real identifier-only COMMIT notifications.

Run in the already built isolated test image, with its real database URL and the
sanitized inventory mounted read-only:

```sh
FLUX_LIVE_TWO_API=1 FLUX_LIVE_TWO_API_INVENTORY=/evidence/two-api-inventory.json \
  pnpm exec tsx --test --test-concurrency=1 tests/app/live/two-api.test.ts
```

The single case has a finite60s timeout and each real delivery has a finite5s
deadline. The socket ledger and binary assembly are bounded. The expected checks
are actual pre-drop map preview on API2, an unrelated ordered API2 native change
during API1 drag, final native delta/lease clearing, reconnect from a prior
sequence on API2 with ordered journal catch-up, concurrent fresh enrolled Yjs
character contributions on the two processes, convergent public updates, named
relative-position presence, native dirty409, exact Save/provenance/history and
original-actor immutable Save replay on API2, then current-rights revocation.

Its observations prove only the tested public cross-process behavior and separate
actual PostgreSQL notification publication. They do not prove that every delivery
used NOTIFY rather than recovery polling, actual process restart/uncertain commit,
browser DOM interactions, or the full healthy p95≤200ms budget. Those remain
required separate Gate3/Gate4 tests. No success is inferred from this prepared
source or from capability-off runs; all four gates remain pending.

# Actual HTTP/PostgreSQL ownership controls

2026-10-07, #228/#231, draft PR #239. This bounded repair preserves ordinary map operation when no live room exists, even while the real shared live-output budget is fully occupied. It also acquires ownership for a retained or newly created live room before protected input/admission, and releases it only after actual SQL/work and transport settlement.

## Pinned source and outcomes

| Run | Source | Actual result |
| --- | --- | --- |
| First, invalid harness | `06b8cc9d1a1823429f81d20f3a9ccde71d06aef3` | Fresh build/types/lint passed; test setup failed on the missing file-store mount. Not a product failure or a passed application test. |
| Valid negative control | `06b8cc9d1a1823429f81d20f3a9ccde71d06aef3` | Original production source unchanged from `4034654e1c386832595b047067bb98e71a20bdea`; 11 existing controls pass and 3 added controls fail. Exit1. |
| Fixed candidate | `d5bf0be2a8a96c943397262add758e64c9ed4b43` | Fresh build/types/lint; all14 actual HTTP/PostgreSQL tests pass, zero fail/cancel/skip/todo, 8148.897ms, exit0. |

The valid negative control returned500 instead of201 on an ordinary roomless creation,500 instead of retryable503 on a retained-room capacity refusal, and charged4096 bytes before the ordinary roomless preflight instead of zero. These are actual HTTP/SQL observations, not source-only predictions.

The candidate keeps the11 prior lifetime controls and adds:

1. Real roomless HTTP creation plus exact UUID retry under a legitimately reserved full32MiB process budget:201, one durable thought, replayed response, no live head/journal and no extra live charge.
2. Development-off retained-room HTTP request under the same pressure: finite retryable503 without effects/receipt/journal; after releasing capacity, the same UUID succeeds once with one version increment, journal entry and receipt.
3. Real PostgreSQL nonlocking room preflight held after it has returned no row; a concurrent real HTTP join creates the first room; the original response closes before native journal admission. The late room acquires at least24MiB+4096 bytes while its real successful COMMIT response is held. SQL shows exactly one new thought and one journal. Actual settlement drains the owner to zero without a second close event or terminal serialization.

Only the test COMMIT barrier's arming point was moved between the valid baseline and candidate: after the concurrent join, so it cannot mistakenly hold that join. Production eligibility, caps, deadlines and assertions were not weakened. The barrier executes actual SQL before holding its returned result; it never supplies fabricated query rows or manually resets budget gauges.

## Build and runtime provenance

Valid baseline project `FLUX_PROJECT=flux-live-http-baseline-files-1791405202-1240949`:

- Production image `sha256:a1397a82ec08e7e39e9fc624da718cf55b01fabc14b253408f413eb0bd16670c`.
- Test image `sha256:29c78a337fb902df8f3d350d9b63342b6cd0741248c97180c56358e3f6b02c23`.

Candidate project `FLUX_PROJECT=flux-live-http-candidate-1791405313-1252586`:

- Production image `sha256:a8d9bc22c3669a8723d3c01ce035a4e3cfd1fc6d002887c8bb47520d5f78a9c0`.
- Test image `sha256:4c5edd39070ad20f6ee599ffcd9af0222eab0c775bf55a851caeed0dd36d96a6`.

Each source was clean when built through the repository Docker source configuration. Each run used its own PostgreSQL/files/teststate volumes and project, with ports18711/18712. Tests create actual local HTTP servers and use actual PostgreSQL persistence through current routes. The supplemental Compose file supplies the standard test file-store mount omitted from the first attempt. Both valid runs removed their containers, volumes, network and two per-run image tags. Root confirmed the candidate's owned container/volume inventories empty after cleanup. Existing application/demo containers were untouched.

Reproduction uses the pinned clean checkout, the standard source Compose file and `files.compose.yaml` from this evidence directory. Supply isolated normal test credentials/configuration, build `migrate test`, start `db migrate`, initialize the files volume with the setup profile, then run the existing test service command:

```sh
node_modules/.bin/tsx --test --test-concurrency=1 tests/app/editing-http-lifetime.test.ts
```

The actual full outputs, including warnings and cleanup, are retained byte-for-byte under deterministic gzip. `manifest.json` records each original/stored size and SHA256. Build toolchain, database and tests ran in Docker; no host application dependency installation or service was used. Agent setup,74 repository Python tests and the full origin-main-to-candidate whitespace check also pass at the candidate.

## Scope still open

This result certifies only the bounded HTTP/SQL ownership and ordinary-path isolation seam. It does not establish current producer capture/EOF shutdown, all26 final benchmark gauges, the full nine60s/2160-observation latency cohorts, separately committed-map latency, codec worker admission, cross-process rights/restart behavior, trusted touch/IME, child#238 composition, or final-design UI acceptance. All four F-021 gates remain open; PR239 remains draft and live editing stays off by default.

The old partial two-cohort p95 failure and incomplete capture remain failures. The current source must be composed with accepted current-main/dependency changes and reverified before merge. Final#336/F-026 phone map view/add versus computer connect/arrange, plus Kreska agent cursors, remain required and are not certified here. Independent evaluation of the production candidate and archive delta is recorded separately.

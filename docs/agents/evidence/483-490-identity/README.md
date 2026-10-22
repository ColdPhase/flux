# #483/#490 identity closeout — author evidence

Author candidate/runtime pin: `525f61c8907e9369c7b84f97a9b98d32e4d702ab`, from
protected base `b17ae9e357441e9a383eb275d1034e69ec50c98a`. PR #618 is the
coherent closeout of the remaining child contracts, not automatic acceptance or
closure of parents #310/#311/#312 or a release. Independent current-head review,
eligible approval and protected integration remain required.

## Actual runs and boundaries

| Evidence | Actual source | Result and scope |
| --- | --- | --- |
| Focused API | `7cb85924bdd9abb3fa33783bc2202016a4e15a53` | Build/type/lint and **100/100**, 0 failed/cancelled/skipped; 80,063.100ms. Eight named API files. Script success/cleanup completed; outer recorder separately failed1 on zsh's readonly `status`. |
| Standing fault/age fixtures | `f0836be8d8bf8a82329a2d1123d22d38683bd08e` | **20/20** direct standing tests. Later runner terminal1: missing local e2e image, before any provider/browser/client journey. Explicit e2e builder and opt-in image cleanup were corrected. |
| Current Keycloak and official clients | `847b7408e279b2dc2d405635f300167c60397274` | **79/79** runner-reported tests, 0 failed/cancelled/skipped, terminal0. Includes20 standing tests again; counts are not added across cohorts. Build/type/lint pass with9 existing warnings and0 errors. |
| Current ordinary operator bridge | `525f61c8907e9369c7b84f97a9b98d32e4d702ab` | **23 phases**, all exit0, driver terminal0. These are phases, not23 test cases. Real pre-SSO native seed, explicit provider link/cutover, ordinary CLI upgrade, backup/export, actual restore and genuine provider recovery. |

The79 blocks are `[20,1,1,4,1,1,4,11,21,6,1,1,4,3]`: standing20,
boot-outage1, migration/link/re-key/cutover11, ordinary SSO11, MCP/standing21,
bad-token6, restart2, official-client parent plus3 subtests4, standing-off3.
Official clients were **codex-cli0.160.1** and **Claude Code2.1.285**. Real
fresh-browser Keycloak sign-in, signed continuation, PKCE, connection choice,
consent, each client's own callback, native bootstrap and authorized context read
passed for Codex pre-registration, Claude pre-registration and Claude default
CIMD. Only model endpoints were mocked, as allowed for this identity contract;
these runs certify neither vendor-account usability nor the separate #160
Start/Resume workflow. Chromium was153.0.8010.12; Keycloak was26.8.0 pinned to
OCI index `sha256:27b3230fbabb8c9ff3c66c864cf09dcd8a41aca82e5100679d109ef0eeb05741`.

## Child criterion matrix

“PASS” below is the author's evidence assessment, subject to independent review.
Controlled faults/age and fake compute/CLI fixtures are explicitly distinguished
from real Keycloak/provider/client behavior.

| Criterion | Author result and evidence |
| --- | --- |
| #483 S1-AC9: original cases2/8, IdP-down case9 | **PASS**: Keycloak79 retains fresh-browser signed continuation, cancellation/retry/tamper, pre-registration/CIMD, issuer/audience/PKCE/callback/redirect/consent and no provider-token passthrough. A real startup outage recovers on the same signed page without API restart or page reload. Current operator525 supplies case8 custody/backup/restore rather than dropping it. |
| #483 S1-AC10: official clients | **PASS**: the3 actual official-client paths above reach activation/authorized tools; no manual ready flag, substituted OAuth transport or vendor account gate. |
| #490 S4-AC1: encrypted offline token/SID and conditional replacement | **PASS**: real Keycloak79 includes stored sealed custody, two-device SID replacement and both logout/revocation controls inherited from #418. Current operator525 starts with nonempty sealed custody. |
| S4-AC2: bounded lease, outcomes, rotation, N1/N3/N5 | **PASS**: direct real-SQL standing20 covers short SKIP LOCKED leases, no transaction across the injected IdP call, rotation, stale-lease protection, unknown/retry and suspended-success recovery. Keycloak79 proves genuine refresh/profile updates and actual no-refresh refusal/recovery. |
| S4-AC3: browser/MCP/refresh refusal without grant revocation; recovery | **PASS**: real Keycloak disable/re-enable, deletion and removal of existing offline sessions; retained families/grants recover on genuine sign-in. Current operator525 repeats browser401, labelled MCP401 and refresh400/invalid_grant after actual tokenless restore, followed by genuine provider recovery. |
| S4-AC4: every bearer, minting and owner-compute boundaries | **PASS**: API100 covers real nonce mint404, personal/proactive/server/runtime pre-read/dispatch/commit gates and recovery under the same consent without another owner/payer. Compute/model connections and runtime CLI in these boundary tests are fakes. Keycloak79 independently proves an actual managed held run bearer200→labelled401 after real offline-session removal→200 after genuine sign-in, under unchanged consent. |
| S4-AC5: backup/export/log custody exclusion and restore | **PASS**: current operator525 uses ordinary CLI backup with a nonempty sealed table; table definition remains and rows are absent. Actual IdP plaintext and ciphertext are absent from SQL dump, exported contents, API/worker logs and observed public API/MCP responses. Actual restore and genuine re-sign-in recover the same owner and retained grants. |
| S4-AC6: required case7/9 rows | **PASS**: actual Keycloak disable/delete/existing-offline removal; real SQL automation-only eligibility and suspended recovery in standing20. Lost-response/previous-token retry and unknown503/timeout/invalid_client composed with age are deterministic standing-service fault fixtures, not a claimed Keycloak network fault experiment. |
| Refresh profile/claims outcome | **PASS**: actual Keycloak returned claims update the same issuer/subject profile without rewriting original family facts. Standing20 covers bad/missing/unverified claims, wrong issuer/audience/signature, expiry, stale lease and collision skip/log; rotation survives rejected advisory profile data. |
| S2-AC1: confirmation age | **PASS**: Keycloak79 verifies browser/MCP/refresh refusal and recovery; standing-off still enforces age. Already-open map/wiki behavior composes the accepted #389 evidence below; no natural elapsed-hour proof is claimed. |
| S2-AC2: held connection reauthorization | **PASS**: Keycloak79 preserves the existing connection choice on reauthorization and tests its authority/owner boundary. |
| S2-AC3: unmanaged lifetimes | **PASS**: API100's no-provider controls; inherited confirmation SQL controls; current operator begins with an actual unmanaged ordinary instance before provider setup. |
| S2-AC4: cases7/9 age rows | **PASS**: Keycloak79 normal and standing-off rows plus deterministic standing20 unknown/lost-response age composition. |
| Populated main90/late70/71 operator outcome | **PASS by explicit composition**, not a new execution of the vanished old driver: retained392 facts at their original pin plus current ordinary operator525, as detailed below. |

## Historical composition and source correspondence

**This head does not re-execute the main90→late70/71 populated upgrade step.** That step is composed
from the accepted 392 evidence at `6d6c1a5015f7ba2a507755e5b8d6a4016dd32c5e` plus the current ordinary
operator bridge, as stated below.

The original main90/ordinary59→61 upgrade adding only70/71 remains the accepted
[392 evidence](../392-main90/README.md) at
`6d6c1a5015f7ba2a507755e5b8d6a4016dd32c5e`:44 expected product/fixture phases,
111 original public-table snapshots, files/ledger timestamps and original66/83/86
facts, nonempty custody, actual restore/restart and original59 restore--migrate.
Its original driver terminal2 and separate cleanup recovery0, and the3 retained
sign-in traces for4 executed guards, remain unchanged. The vanished private
run.py/core.py/custody.mjs sources are not claimed replayable.

Original66/70/71/83/86 migration bytes match that source, baseb17 and candidate525.
Launcher, migrator, auth and toolchain changed since392, so no blanket current
runtime compatibility is asserted. The committed current bridge independently
covers populated **b17→525** continuity, exact captured native export/file and
ledger/family facts, real nonempty backup/export, actual restore and provider
re-sign-in. It does **not** claim to add70/71 again or to rerun111 old snapshots.

The accepted [389 already-open-channel repair](../389-confirmation-age/README.md)
stays pinned at `7277b99286a7f662c87219605f7a3e2fcb346bf7`:6 SQL checks and1
genuine Keycloak/browser case with fixture-aged mutable confirmation. This PR
changes none of those editing-fence paths against protected baseb17; no rerun of
that accepted case is relabelled. Later base development is inherited accepted
work, not a claim that the entire app equals7277.

[source-compatibility.json](source-compatibility.json) records production/API
file hashes and exact app/docker/runner identity between847 and525. Thus API100
and Keycloak79 retain their own tested pins while composing with operator525.
No SQL migration or accepted provider collection was added or changed.

## Reproduce and retained limits

From a clean checkout, one heavy Docker lease, isolated loopback ports:

```sh
FLUX_OIDC_TEST_PORT=19862 FLUX_OIDC_CLOSEOUT=1 ./scripts/check_oidc.sh
python3 scripts/identity-closeout/bridge.py --candidate 525f61c8907e9369c7b84f97a9b98d32e4d702ab --evidence /path/to/new-private-evidence-dir --port 19866
```

At the actual7cb API pin, the selected command was:

```sh
FLUX_TEST_PORT=19860 FLUX_TEST_MAILPIT_PORT=19861 ./scripts/check_application.sh \
  tests/app/idp-standing.test.ts tests/app/identity-sso-path.test.ts \
  tests/app/identity-claim-profile.test.ts tests/app/personal-runs.test.ts \
  tests/app/assistant-run-tokens.test.ts tests/app/agent-runtime-runs.test.ts \
  tests/app/proactive-comparison-cancellation.test.ts tests/app/oauth-mcp.test.ts
```

[Its result](api-7cb-result.json) retains the recorder failure separately.
[retained-failures.json](retained-failures.json) preserves the missing-image
attempt, boot-account contamination, unknown first demo failure and bounded
404 ACCOUNT_NOT_FOUND diagnosis. The correction seeds the ordinary native
instance before enabling the provider, preserving anti-squatting controls.
The corrected seed-only diagnostic is explicitly not full operator acceptance.

Runtime receipts contain actual CIDs/image IDs, source labels and only
allowlisted nonsecret env. Keycloak stays outside application restore; its CID
and image remain the same across baseline/upgrade/restore. Both full lanes have
empty exact-owned containers/volumes/networks/image-tag inventories. Full
operator525 removed private credentials, realm/config, native tokens, backups,
proof checkout and provider data. Demo8081/router8080 were untouched.

[external-manifest.json](external-manifest.json) pins retained raw logs and source
manifests under the author's private evidence directory. They are not copied
into this small public bundle. The847 metadata observer's cleanup race exit1 is
retained separately from the successful lane terminal0 and final independent
empty cleanup inventory. The full525 driver and corrected observer both exit0.

# Application layout verification (#76)

Builder evidence,2026-09-30. Tested application/source head:
`43b98c1a4b972fce22b4cc9d6cbb3d187fe4ffb6`, based on accepted protected main
`43b627278d0ab43ad44be2e9fff223ad9dd198b1`. Independent eligible review is still
required. This is the remaining app/source-layout phase after operator PR #159,
not whole-product or release acceptance.

## Actual verification

All application/dependency/services/browser commands ran through Docker on the
macOS arm64 host (Docker engine29.1.2), with separate projects/ports/volumes.
Full application,CLI,UI,operator and SFU runs completed and cleaned only their
own resources. These are actual local results, not CI or real-device evidence.

| Check | Observed result |
| --- | --- |
| `FLUX_TEST_PORT=19011 FLUX_TEST_MAILPIT_PORT=19012 ./scripts/check_application.sh` |330 passed; configured Chromium PWA3 and access1 pass; session survives API restart; push/email-unavailable checks pass. Build/type/lint and architecture checks remain enabled. |
| CLI on19101/19102/19103,second checkout19104/19105/19106 |Complete pass: origin guard; fresh/preserved/legacy env; demo/logins/ACL; web/API hot reload; foreign checkout refusal; down/reset/clean and second-copy data survival. |
| `check_ui.sh`,19111/19112 |125 collected,121 pass,4 opt-in Live skips;461.164s. |
| `check_live_ui.sh`,19211/19212 with isolated ICE/TURN ports |Four media-profile browser journeys pass,57.335s; one unavailable-server case skipped because the server is configured. That unavailable case passed in the ordinary UI run. |
| Operator Compose on19141 |Pull-only configuration with local source image: exact schema25 ledger,non-root API/worker,signup/workspace,worker processing and persistent restart pass. No published-image acceptance. |
| `check_live_sfu.sh`,19201 with isolated ICE/TURN ports |Four local real-SFU Chromium cases pass,including API cutover and SFU restart. Browser media/devices are simulated; no physical network/TURN acceptance. |
| Shared setup/local links,standard-library checks,syntax/whitespace/token contrast |20 Python checks pass; shell and diff checks pass;258 shared token contrast pairs pass. |
| Complete backup/restore/export/old-layout rollback and forward upgrade |Still active at this evidence checkpoint. Its partial results cannot establish completion; final result must be added before readiness. |

Local logs are `/tmp/flux76-current-{application,cli,ui,live-ui,operator,live-sfu,backup}.log`.
The UI captures are `/tmp/flux76-current-ui-images` and
`/tmp/flux76-current-live-ui-images`. Logs are not copied into the public repo
because test launchers print temporary generated credentials. The independent
reviewer must reproduce relevant checks rather than treat local paths as
remotely accessible evidence.

## Source and provenance

[Source inventory](source-sha256.txt) hashes the tracked application workspace,
Docker inputs,launcher/check scripts,workflows and operator Python check at the
tested head. Check from the repository root with
`shasum -a256 -c docs/agents/evidence/76-application-layout/source-sha256.txt`.
A later evidence-only commit does not change those inputs; any changed hash
needs relevant new verification. Dependency pins,package/public/license
boundaries and architecture allowlist remain unchanged by the path move.

The five #146 map files inherited from main moved byte-for-byte into app.
This change adds no visual direction; #145/#146 independent appearance and
behavior reviews retain their original stated scope. Rendered current app
regressions passed above; screenshots are not physical-device acceptance.

The Dockerfile caches `pnpm fetch` from lock/workspace config,then installs the
complete source `--offline --frozen-lockfile`; Node/pnpm versions,dependency
build approvals and build/type/lint/test commands are preserved. See the
[build layer contract](../../../development/containers.md#locked-dependency-build-layer).

Earlier runs found a hard-coded second-checkout test origin and an incomplete
pre-layout rollback instruction; both were corrected and tests expanded. Later
Docker engine/BuildKit nil-pointer panic interrupted old runs. Docker Desktop
was recovered through its CLI; only marker-confirmed terminated-test projects
were cleaned. Those interrupted runs are not labeled complete. The successful
results above use the current tested head after recovery.

macOS Docker execution is verified here. SELinux runtime,real Android/iPhone/iPad
installation/push,complete Studio11.6 integration,supported real agent clients
and published-release acceptance remain separately unverified. #76 stays open
until its final upgrade result and independent review pass; #46 and #77 retain
their own remaining outcomes.

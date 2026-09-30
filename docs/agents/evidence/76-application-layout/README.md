# Application layout verification (#76)

Builder evidence, 2026-09-30. Corrected launcher/test-command source head:
`e7b1ab7b9bea8f3533425a4a97bce1d8c26cab2c`, based on accepted protected main
`43b627278d0ab43ad44be2e9fff223ad9dd198b1`. Independent eligible review is still
required. This is the remaining app/source-layout phase after operator PR #159,
not whole-product or release acceptance.

## Corrected-head verification

Independent review found a legacy relative `.env` link relocation bug and Linux
full-suite overload from CPU-derived test-file parallelism. The correction refuses
legacy links and conflicting/dangling paths before Docker or secret generation,
and protects the printed reverse transition. Existing regular private config and
readable live links retain their bytes, permissions and project. The configured
test command bounds file parallelism to four; explicit suite race cases and
application/database deadlines remain unchanged.

Actual fresh checks at `e7b1ab7` on macOS arm64/Docker 29.1.2:

| Check | Observed corrected-head result |
| --- | --- |
| Complete configured application command, ports 19011/19012 |330/330 pass, 50.911s; PWA 3/access 1, persisted session restart, unavailable push/email checks pass. Build/type/lint/architecture stay enabled. |
| Full CLI, ports 19101–19106 |Complete pass including regular legacy migration, demo/ACL, hot reload, ownership refusal, reset/clean and second-copy survival. |
| Full backup/restore/export, base port 19121 |Complete pass including schema24→25 upgrade from `fd45aca`, failure/writer-stop recovery, actual historical-source rollback and another upgrade with the original custom project/config/demo preserved. |
| Configuration/filesystem regressions |14 pass; the previous launcher 826690c fails 11 assertions in the same negative control. Includes relative/absolute/dangling legacy links, dangling destination/conflicts, regular mode600 migration, readable live link and actual printed rollback guards. No production resources. |
| Shared setup, standard-library tests, syntax/diff/contrast |34 Python pass; local links, shell syntax, whitespace and 258 contrast pairs pass. |
| Required GitHub checks |Agent setup and Application validation pass on the corrected source head; eligible independent review remains required. |

Corrected logs are `/tmp/flux76-fixed-{application,cli,backup}.log`; negative control
is `/tmp/flux76-env-negative-control.log`. They remain local because runtime logs
can include temporary generated test credentials. The prior review's stalled and
325-pass/5-fail Linux runs are not relabeled as successes. Independent corrected
Linux verification remains pending until the reviewer records it.

## Baseline verification of unchanged runtime surfaces

The following checks ran at `43b98c1a4b972fce22b4cc9d6cbb3d187fe4ffb6`.
Compared with that head, the two changed previously inventoried inputs are `flux`
and `app/package.json` (test command only); the new Python regression is added.
Application/SQL/UI/service/Docker/dependency inputs are byte-identical. The
current launcher, configured application and rollback paths were rerun above;
unchanged UI/operator/SFU baseline evidence keeps this original source head.


All application/dependency/services/browser commands ran through Docker on the
macOS arm64 host (Docker engine 29.1.2), with separate projects/ports/volumes.
Full application, CLI, UI, operator and SFU runs completed and cleaned only their
own resources. These are actual local results, not CI or real-device evidence.

| Check | Observed result |
| --- | --- |
| `FLUX_TEST_PORT=19011 FLUX_TEST_MAILPIT_PORT=19012 ./scripts/check_application.sh` | 330 passed; configured Chromium PWA3 and access1 pass; session survives API restart; push/email-unavailable checks pass. Build/type/lint and architecture checks remain enabled. |
| CLI on19101/19102/19103,second checkout19104/19105/19106 |Complete pass: origin guard; fresh/preserved/legacy env; demo/logins/ACL; web/API hot reload; foreign checkout refusal; down/reset/clean and second-copy data survival. |
| `check_ui.sh`,19111/19112 | 125 collected, 121 pass, 4 opt-in Live skips; 461.164s. |
| `check_live_ui.sh`,19211/19212 with isolated ICE/TURN ports |Four media-profile browser journeys pass,57.335s; one unavailable-server case skipped because the server is configured. That unavailable case passed in the ordinary UI run. |
| Operator Compose on19141 |Pull-only configuration with local source image: exact schema 25 ledger, non-root API/worker, signup/workspace, worker processing and persistent restart pass. No published-image acceptance. |
| `check_live_sfu.sh`,19201 with isolated ICE/TURN ports |Four local real-SFU Chromium cases pass, including API cutover and SFU restart. Browser media/devices are simulated; no physical network/TURN acceptance. |
| Shared setup/local links,standard-library checks,syntax/whitespace/token contrast |20 Python checks pass; shell and diff checks pass;258 shared token contrast pairs pass. |
| Complete backup/restore/export/old-layout rollback and forward upgrade |Complete pass: export/access/secret boundaries; writer-stop and damaged/foreign/edited-ledger refusal; fresh-project restore; schema24→25 upgrade; failure/recovery cases; actual historical-source rollback and re-upgrade preserve the custom project, configuration and demo data. |

Local logs are `/tmp/flux76-current-{application,cli,ui,live-ui,operator,live-sfu,backup}.log`.
The UI captures are `/tmp/flux76-current-ui-images` and
`/tmp/flux76-current-live-ui-images`. Logs are not copied into the public repo
because test launchers print temporary generated credentials. The independent
reviewer must reproduce relevant checks rather than treat local paths as
remotely accessible evidence.

## Source and provenance

[Source inventory](source-sha256.txt) hashes the tracked application workspace,
Docker inputs, launcher/check scripts, workflows and both operator/configuration
Python checks at corrected source head `e7b1ab7` (495 inputs). Check from the repository root with
`shasum -a256 -c docs/agents/evidence/76-application-layout/source-sha256.txt`.
A later evidence-only commit does not change those inputs; any changed hash
needs relevant new verification. Dependency pins,package/public/license
boundaries and architecture allowlist remain unchanged by the path move.

The five #146 map files inherited from main moved byte-for-byte into app.
This change adds no visual direction; #145/#146 independent appearance and
behavior reviews retain their original stated scope. Rendered current app
regressions passed above; screenshots are not physical-device acceptance.

The Dockerfile caches `pnpm fetch` from lock/workspace config,then installs the
complete source `--offline --frozen-lockfile`; Node/pnpm versions, dependency
build approvals and build/type/lint/test commands are preserved. See the
[build layer contract](../../../development/containers.md#locked-dependency-build-layer).

Earlier runs found a hard-coded second-checkout test origin and an incomplete
pre-layout rollback instruction; both were corrected and tests expanded. Later
Docker engine/BuildKit nil-pointer panic interrupted old runs. Docker Desktop
was recovered through its CLI; only marker-confirmed terminated-test projects
were cleaned. Those interrupted runs are not labeled complete. The successful
baseline results use 43b98c1 after recovery; corrected-path reruns use e7b1ab7.

macOS Docker execution is verified here. The independent review on PR #165 records
Linux/SELinux enforcing CLI/operator success for the baseline; corrected full
Linux acceptance remains pending. Real Android/iPhone/iPad
installation/push, complete Studio 11.6 integration, supported real agent clients
and published-release acceptance remain separately unverified. #76 stays open
until its independent review passes; #46 and #77 retain
their own remaining outcomes.

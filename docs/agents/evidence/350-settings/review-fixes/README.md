# Settings review corrections — PR #370

Date: 2026-10-08. Tested application and UI-test source:
`e67967e4d71e1bffec4e4a5e732383b94a2258ef`, branch
`claude-maurycy/350-settings`. Refs [#350](https://github.com/ColdPhase/flux/issues/350),
[#360](https://github.com/ColdPhase/flux/issues/360), and
[#336](https://github.com/ColdPhase/flux/issues/336).

**Partial delivery; neither #350 nor #360 is complete.** The current Settings and
Notifications browser scenarios pass in Chromium and WebKit, and three deliberate
backend regressions are detected. After two Docker engine interruptions, the unchanged
final application source passed the complete application check: **1169/1169**, exit 0. Independent visual review retains two material
conformance findings. This record does not constitute eligible independent PR
approval or release acceptance.

## Corrections and covered boundaries

- Morning-summary migration moved from the PR's unmerged `0057` to **0072**, as
  [reserved on #153](https://github.com/ColdPhase/flux/issues/153#issuecomment-6064885555).
  Other reservations were not renumbered. A read-only semantic preflight rejects
  legacy summary columns without the 0072 ledger entry before migration writes;
  a numerically known 57/58 manifest alone is insufficient. Upgrade/reverse/upgrade
  tests preserve ordinary notification data. Reverse removes derived summaries
  before dropping their classification.
- Admission reloads and locks current preferences. Nothing, summary Off, edited
  time and edited timezone are checked using that state. Day claim, summary and
  queued jobs share the transaction. A failed enqueue rolls admission back.
- Persisted `morning_summary` classification and all counted source references
  distinguish summaries from ordinary no-reason notifications. Delivery checks
  current Nothing/Off, access and mutes for the whole aggregate; direct by-ID reads
  also reauthorize every source. Loss of a non-anchor source suppresses the whole
  summary. Native tests retain positive ordinary-notification and re-enabled
  summary controls.
- Scheduling claims the scheduled local day within a half-open three-hour elapsed
  window. Coverage includes the next tick after 23:46/23:59, midnight/year rollover,
  DST gaps/repeated times, non-hour offsets, skipped dates and timezone/time edits.
  The persisted watermark cannot move backwards or admit duplicate concurrent ticks.
- Real Settings controls are measured in both dimensions with the shared 0.001px
  tolerance. Controls reject 43.99px targets and removed or noninteractive switch
  hit-area extensions. Assistant/connected-agent rows use the explicit Agent tag.

These describe the correction and regression coverage present at the source above.
The completed full check below covers this final source. Individual passing lines
from the two interrupted attempts are not included in its totals.

## Completed browser and negative-control runs

All application services, builds and test execution used isolated Docker Compose
projects. The browser commands below record the selected modules and browser
setting; each invocation also used its own 19xxx app/Mailpit ports and screenshot
directory. Do not run two heavy checks together when reproducing them.

| Run | Result | Scope and local log |
| --- | --- | --- |
| Settings plus affected UI modules | **83 tests, OK**, 193.837s | 75 Chromium tests and 8 built-in `SoftVolumeWebKit` tests. `/tmp/flux370-ui-chromium-current.log`; project flux-ui-1791481544-64057. |
| Settings and Notifications in WebKit | **14 tests, OK**, 43.882s | The same 8 Settings and 6 Notifications methods use actual WebKit through `FLUX_UI_BROWSER=webkit`. `/tmp/flux370-ui-webkit-current.log`; project flux-ui-1791481398-63330. |
| Deliberate summary regressions | **3/3 rejected by regression assertions** | Each selected mutated test exits 1, with no skips; the mutation runner reports success only after verifying the intended assertion. `/tmp/flux370-negative-check-final.log`; project flux-test-1791481879-65821. |
| Full application after recovery | **1169/1169, exit 0** | `FLUX_TEST_PORT=19370 FLUX_TEST_MAILPIT_PORT=19371 TMPDIR=/private/tmp ./scripts/check_application.sh`, head `6adc781ae374d523dbd208c75b576630c1c3a6b8` (application source unchanged from `e67967e4`). `/tmp/flux370-application-recovered.log`; project flux-test-1791487477-89613. Main suite 1146 plus 23 browser/availability checks; build, lint, typecheck, architecture, session restart and operator-switch checks also completed. |
| Foundation and final documentation checks | **87/87, OK**, 17.338s; setup and whitespace pass | `TMPDIR=/private/tmp python3 scripts/check_agent_setup.py`; `TMPDIR=/private/tmp python3 -m unittest discover -s tests -p 'test_*.py'`; `git diff --check`. The first evidence link check rejected project names formatted as skill names; prose formatting was corrected and the complete checks reran successfully. |

Browser selections:

```sh
FLUX_UI_BROWSER=chromium ./scripts/check_ui.sh test_settings test_notifications test_phone_shell test_app_shell test_personal_assistant test_soft_volume test_map_task_count
FLUX_UI_BROWSER=webkit ./scripts/check_ui.sh test_settings test_notifications
```

The 83-method run breaks down as Settings 8, Notifications 6, phone shell 12,
app shell 20, personal assistant 12, Soft volume 16 (8 Chromium + 8 WebKit),
and map task counts 9. Browser selection is implemented in Settings/Notifications;
this is not a claim that every existing UI module supports the environment switch.
Both completed browser logs show cleanup of their own Compose resources and tagged
images. They do not certify unrelated projects or a later still-running check.

The scenarios include theme persistence and keyboard selection, device-local
Kreska preference, existing Settings entry points and Back/history, displayed
shortcut inventory, agent role labels, real control hit areas, notification
preferences and quiet hours, muted places, inbox-source navigation and additional
email verification through Mailpit. The shortcut inventory test does not certify
that every listed global shortcut is implemented. The UI runs do not establish
real-device Push delivery or complete F-026 visual conformance.

### Deliberate regressions

The checked-in [mutation runner](summary-mutations.mjs) changes one exact site at
a time inside a disposable test container, executes its selected regression, and
restores the original bytes in `finally`. It requires exit 1, the intended test
name and an assertion failure; module, syntax and connection failures cannot count
as a killed mutation. The local driver was `/tmp/flux370-negative-check.sh`, using
the ordinary source/test Compose setup and mounting the runner plus an evidence
directory. Its final command was equivalent to:

```sh
docker compose -p "$project" -f docker/compose.source.yaml -f docker/compose.test.yaml --profile test run --rm --user root -v /private/tmp/flux370-mutations.mjs:/tmp/flux370-mutations.mjs:ro -v /private/tmp/flux370-negative-evidence:/evidence test node /tmp/flux370-mutations.mjs
```

This requires the driver's already-prepared isolated services/environment; it is
not a standalone command to run against another project's database. The temporary
runner mounted at that path is retained here as `summary-mutations.mjs`.

| Mutation | Actual witness | Detailed local log |
| --- | --- | --- |
| Remove the Nothing check at delivery | `nothing after admission suppresses delivery; re-enabling releases the same held job` fails: actual `'sent'`, expected `'skipped'`. | [expected assertion failure](negative-controls/nothing-delivery-guard.txt) |
| Reauthorize only the anchor source | `non-anchor and total access loss suppress an admitted A+B aggregate and its direct inbox read` fails: actual `'sent'`, expected `'skipped'`. | [expected assertion failure](negative-controls/non-anchor-authorization.txt) |
| Consider only today's scheduled date | `the 15-minute tick catches 23:46 and 23:59 after midnight for the scheduled day` fails: actual `null`, expected `'2026-10-08'`. | [expected assertion failure](negative-controls/midnight-scheduled-day-selection.txt) |

The tracked text transcripts normalize trailing whitespace only. Each reports one
test, zero passes, one failure and zero skips. Those failures
are the intended negative-control result, not failures in unmodified production
source. The runner ends with `All 3 temporary mutations rejected; container source
restored.` Other suggested mutation variants were not executed and are not claimed.

## Interrupted final application attempts

The first final-source full run (`/tmp/flux370-application-current.log`, project
flux-test-1791481968-66592) stopped at 18:06 UTC after the Docker engine became
unresponsive: `error waiting for container: unexpected EOF`, followed by
`Cannot connect to the Docker daemon`, command exit **125**. It produced no complete
suite total. This is **not a pass**, and the log alone does not identify the cause
of the engine outage. No product assertion failure was reported before interruption.

Once the Docker API recovered, only that exact run's containers, networks, disposable
volumes and three project-tagged images were removed. The fresh standard retry used the same frozen source and ports, in project
flux-test-1791484237-74390. It also ended with exit **125** after Docker became
unresponsive. Bounded `docker version` and project-only `docker ps` reads each
timed out; the backend log recorded a VM stats timeout. Its exact-project cleanup
could not connect to the daemon. After Docker recovered, its exact containers, volumes and networks were confirmed
absent and its three project-tagged images were removed. A fresh run was started
only after the API responded promptly and disk had 34 GB free.
No global Docker restart, prune, or protected-preview operation was performed by
this agent.

## Completed full application run after recovery

The unchanged application source was tested at evidence head
`6adc781ae374d523dbd208c75b576630c1c3a6b8`. The standard script ended with **exit 0**:
1146 main-suite tests and 23 separately reported browser/availability tests,
**1169 passes, zero failures** across 16 reported suites. The complete command also
finished its build, lint, typecheck, architecture, session-restart, key-log-absence
and background-comparison operator-switch steps. These are not extra counted tests.

The log is `/tmp/flux370-application-recovered.log`; the isolated project was
flux-test-1791487477-89613 on ports 19370/19371. Cleanup removed that exact project's
containers, networks, four disposable volumes and three tagged images. Protected
previews were not modified or restarted by this agent. This successful rerun does
not retrospectively change the two interrupted results, and does not resolve the
remaining visual/integration criteria or replace eligible independent evaluation.

## Earlier WebKit attempts and the route-readiness correction

The historical attempts remain failures; neither is relabeled as a pass:

- `/tmp/flux370-ui-webkit.log`: 14 tests, one failure. The legacy-address scenario
  left Notifications through a hard navigation before the two asynchronous push
  status reads had settled; the uncaught-error guard recorded an access-control
  error for `/api/v1/push/public-key`.
- `/tmp/flux370-ui-webkit-final.log`: 14 tests, one failure. The new readiness
  assertion matched an incomplete exact notice string and timed out.

Commit `61d528aa7399eab9997c12cb064dc707a01a51be` added waits for both fully rendered
push-status states before the next hard navigation, retaining the uncaught-error
guard. Commit `e67967e4d71e1bffec4e4a5e732383b94a2258ef` corrected the exact notice
to include “Your inbox always works.” The fresh 14-method WebKit run passes with
those assertions. **Product fetch/error handling was not changed by this test
readiness correction.** Therefore the result establishes the settled route
scenario; it does not prove the original interrupted-fetch behavior was repaired.

## Screenshots and independent visual result

The [current independent visual follow-up](visual-review-current.md) inspected
the 16 current Chromium/WebKit captures in this folder. The
[initial review](visual-review-initial.md) and its eight Chromium images are
retained under [initial-5ff97214](initial-5ff97214/) for source
`5ff972146296a582a4ee868db1dd2cd165477b78`; they are not current-head evidence.

Current captures use 1440×900 desktop and 390×844 phone CSS viewports at 100% zoom.
Phone PNGs are 1170×2532 physical pixels (3×); reference phone images are 2×.
The visual reviewer compared equivalent CSS composition against the final-design
`desktop-appearance`, `desktop-settings`, `phone-appearance` and `phone-settings`
renders only. Screenshots do not certify interaction, semantics or permissions.

The visible Agent tag is resolved for the shown assistant rows in both themes,
on desktop and phone, in both browsers. Two required visual outcomes remain open:

1. The phone still has the earlier full-width Home / Inbox / Messages / Projects
   bar and header, rather than the accepted floating Home / Projects / Inbox
   capsule, separate Search, Back treatment and title hierarchy.
2. The reference's Text size / Follows phone and reading/motion controls/groups
   are absent in the inspected Settings locations. Preserving required notification
   functionality does not remove these design outcomes.

The captures show largely empty project/message lists and one assistant that is
not set up. **Actual populated multi-agent lists, long agent/owner names and their
working/connected/unavailable states remain unverified.** Phone role/owner/status
wrapping deserves a follow-up with those real states; the present images do not
establish long-name acceptance. Lower phone entries, complete scrolling, enlarged
text and other unshown editing/error states retain the visual report's limits.

## Remaining acceptance and next handoff

- Restore a stable Docker engine, clean only the interrupted retry project named
  above, then run the full application check to a real final verdict. The engine
  failure does not waive this gate. Foundation/setup and whitespace are checked
  separately against the final evidence.
- Obtain eligible independent functional evaluation of the frozen pushed head,
  current required remote checks, and resolved review threads before protected merge.
- Integrate the accepted phone shell and reading/motion groups, then refresh the
  neutral visual review and test populated/long-name states.
- Keep #350/#360 capability/project switches dependent on #316 and SSO under #315
  visible as unfinished. This partial PR preserves/links existing connection and
  permission surfaces; it does not complete those contracts.
- Stored text-size/reduced-motion overrides and the reference's “When an agent
  finishes” preference remain outside the implemented correction. “Everything”
  covers existing notification reasons; it does not add every task-event producer.
  Morning summary is off by default and push-only, not an email digest.

No whole-issue, epic or v0.1 release completion is claimed by this evidence bundle.

# Working-card document lifetime and first-install update identity

Recorded 2026-10-11 for the bounded #349 / PR #380 repair. This is author evidence,
not eligible independent approval, full #349/Prostota or integrated release acceptance.

Actual tested source: `8a6056589c4a1c69d65f2c53914d7905504457ab` on
`claude-hubert/349-map`, following the clean handed-over
`216f0018166e0ec7953b6f05fa5d4b7baa6e305e`. The following documentation-only handoff
commit leaves application, tests and scripts byte-identical to 8a. Do not relabel
8a execution as execution of that later documentation commit.

## Observations and peer decision

The coordinator's original 216f WebKit run exited 1: 62 tests, four unfiltered
`assistant-runs?limit=10 due to access control checks` cleanup failures in
Sketch11/12 and ThoughtDraft02, and DM03 Select blocked by `.pwa-update`. All
reported body/geometry assertions passed. Preserve its original raw evidence:
`/tmp/flux-380-216f-webkit.log` and `...-failures.txt`, raw SHA256
`82bec18a951c7b72005eef3cafa5498cd33f898cc2d811661e25b2164fed998a`.

A frozen 216f replay retained six original assertions and error guards, adding
only public network, document and worker observations. It exited 1: one Fit
cleanup failure; the scenario bodies completed. No fetch implementation was
replaced and no error was filtered. Actual observations:

- The native helper error arrived after `beforeunload`, before `pagehide`, with
  no corresponding HTTP request. Earlier actual helper responses were HTTP200.
  The stack reached stream dispatch. Document replacement plus an irrelevant
  stream-triggered helper refresh is the supported cause of this captured case;
  it is not an observed server401/403 or a claim about every historical fetch error.
- A fresh DM context briefly reported its first installed worker as both waiting
  and controller, then activated the same worker and cleared waiting. The old
  installed-plus-controller predicate left a false update banner. The diagnostic
  captured this transition on DM02; the original DM03 pointer-blocking failure
  remains under its original run.

The coordinator independently accepted the bounded direction before production
edits: refresh the card only for the owner-only `ASSISTANT_RUN_CHANGED_EVENT`,
resync, working poll and focus; retire reads at beforeunload/pagehide and restore
only the current lifetime on pageshow/focus/explicit interaction. Preserve owner,
read and Stop revision fences, including actual in-flight Stop plus cancelled
navigation. PWA announces only an installed actual waiting worker distinct from
controller, with genuine waiting/update/apply and stale announcement behavior.
No contract, geometry threshold, error guard, worker policy or visual token was
weakened. The decision is also recorded in [personal runs](personal-runs.md) and
[mobile PWA](../product/mobile-pwa.md).

## Implementation

The card suspends and aborts its read lifetime during document retirement, before
queued callbacks can refetch in that document. Wake restores the current owner,
clears the retired local stopping gate and reads canonical server state. It sends
no automatic command; older read and Stop completions cannot restore old truth.
Real sign-out/account switch, resync, poll and current Stop behavior remain.

Registration compares actual worker identity and actual waiting state. It avoids
WebKit's first-worker transition, observes already waiting/installing workers,
clears stale waiting announcements and applies a chosen update once. An explicit
late apply after another tab activated that controller still reloads once. Real
other-tab activation preserves that tab's in-progress input. No CSS or Map product
behavior changed, and PR #474's separate global client proposal was not imported.

## Actual verification at 8a

Driver `/tmp/flux380-lifecycle/verify-driver.sh` uses the trusted source Compose
and Dockerfiles plus an isolated local overlay, ports19890/19891 and networks
10.199.150–152. Tests are baked in the image. Driver handle42124 returned **0**.

| Maintained phase | Actual result |
| --- | --- |
| Docker build, type check, lint | Pass |
| PWA worker identity/state regression controls | 3/3 |
| Sketch, DM, MapConnect, ThoughtDraft in WebKit | 62/62, 228.520s |
| Same original modules in Chromium | 62/62, 170.161s |
| Entire WorkingAgent module, each case in both engines | 8/8, 117.378s |
| Real SW-allowed HTTPS update/PWA in Chromium | 7/7, 14.720s |
| Real SW-allowed HTTPS update/PWA in WebKit | 7/7, 14.386s |
| Agent setup, repository tests, diff checks | Pass; 102 repository tests |

All phases retain unfiltered page errors and their original body/geometry checks.
The native cancelled-beforeunload dialogue control dismisses actual navigation
while a genuine committed Stop response is held, verifies the same document,
wakes through real interaction, releases obsolete read/Stop answers, checks no
run revival or resent Stop, then sees a subsequent genuine run and actual away/back.
An unrelated real stream event no longer queries private run state. Existing
Stop/sign-out/identity/late-answer/rail/error controls remain intact.

PWA checks retain workers allowed and prove fresh installs/profiles/tabs, already
waiting update in a later tab, real controller version change, one explicit reload,
other-tab input preservation, offline fallback and network-only API behavior.
The route-barrier WorkingAgent fixture already blocked workers before this repair;
no broad service-worker disabling was added.

Baked/checkout hashes for both production changes and representative regression
files matched before image removal. Owned containers, networks, volumes and tags
are now absent. The stock UI profile cleanup omitted the extra test-profile
image/teststate volume; those two exact owned resources were verified and removed
separately. Other projects were left alone.

## Retained failures and boundaries

- Frozen diagnostic216f: six original tests, one cleanup failure; raw log
  `/tmp/flux380-lifecycle/probe-216f.log`, SHA256
  `bf03ca14b185420ad7ca711e25eb58324b2e47a032b2d883adf9af1c6cdd44ea`.
- First bb897 driver preflight exited1 because the local overlay lacked e2e;
  no application tests ran. `verify-bb897-preflight.log` is retained.
- bb897 build exited1 on a new unit fixture's static null-array narrowing before
  browser phases. Equivalent scalar assertions repaired typing; no production
  behavior or assertion was weakened. `verify-bb897.log` is retained.

Final raw log `/tmp/flux380-lifecycle/verify-f7.log` records source8a despite its
local filename, SHA256
`8456013c7d95c8831adc02e6340f8b158868f41fbd66c7c6b841894c621e8379`.
Compact local proof: `verification-proof.json` in the same directory.

Fresh eligible independent review and current protected checks remain required.
This pass does not accept the separate #474 global API-client proposal, full
application/API behavior, #349 AC-4 live Kreska presence/#228/#231, complete
#149/#289/#461 outcomes or the integrated release. Existing visual and other
historical reports retain their original pins. #349 stays open.

## Independent update-only failure and activation correction

The independent frozen8a driver29719 exited1: original selected WebKit journeys
8/8, WorkingAgent07/08 2/2, Node PWA3/3 and Chromium update-only4/4 passed,
while the real WebKit update-only module was3/4. Its last case reached the
unchanged30-second wait for an activated controller after explicit Reload.
Raw `/tmp/flux-review380-8a60/runtime.log` remains separate from the earlier
paired update/PWA7/7 evidence at8a. Neither result is relabelled.

Frozen production at docs-onlya854 (app/source-equivalent to8a) reproduced the
same timeout with failure-only observation: one actual reload, complete new
`/sign-in` document, controller and registration.active both still `activating`,
and the actual controller answered its changed version. A lightweight browser
trace then recorded controllerchange while activating, beforeunload still
activating, activation completing in the retiring document, followed by a new
document whose controller remained activating through its30-second timeout.
This is an observed activation/navigation race, not a guessed stale URL.

The independent peer accepted the bounded correction on2026-10-11: explicit
apply reloads only when the selected worker is both the actual controller and
activated. Listen to both controllerchange and that worker's statechange;
remove both listeners on completion/abandonment; preserve one reload and late
apply after other-tab activation. No worker disabling, timeout changes, #474
import, geometry changes or pageerror suppression are included.

Distinct diagnostic attempts are retained in `/tmp/flux380-update-diag/`:
`runtime-observer-helper-failure.log` has an invalid observer's `__name` errors
and an API-startup failure; `runtime-heavy-observer-pass.log` records4/4 but
its timing differs from the failing runs; `runtime-minimal-failure-state.log`
and `runtime-light-trace-failure.log` reproduce the real3/4 timeout with valid
observations. Their owned stacks/images/volumes/networks were cleaned. The new
maintained controls require no reload during activation or an unrelated
controller change, and preserve existing waiting/late-apply behavior. Fresh
Docker checks and independent review of the correction remain pending here.

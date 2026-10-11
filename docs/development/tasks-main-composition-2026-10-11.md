# Tasks current-main composition and verification — 2026-10-11

Continuation of #346 / PR #375, implementation owner @PelikanFix16. This is a
pinned composition checkpoint, not full issue/application/release acceptance.

## Source and preserved contract

Started from clean local/remote **849fc6a4cf67b6fd0c5c5f42ad0b561d41b4763d**
on `claude-hubert/346-tasks`. Normally merged protected main
**6e81027988527aa4b34e4cd7ae0f363b422d6a2b** at
**525a314c1135644e8468c656f3fb9256c99251f0**. The only conflict was
`test_scenarios.py`: retain the phone's explicit `&new=task` entry and main's
actual task→thought linking through Details. No assertions were removed.

Final tested application/test source is
**b80393eacb5bbd84dc5f4e3adef7f69f83bc1793**. Four formerly Chromium-only
surrounding task fixtures now use main's validated `UI_BROWSER` selector: board,
Home, project state and work pagination. Every assertion, threshold, guard,
worker policy and existing skip is unchanged. This supplies actual WebKit
coverage rather than labelling a second Chromium run as WebKit.

Task state/session fencing, ProjectTasks/TaskBoard/TaskRow, glyphs, 20px owner
marks, Toast and the original final/review tests are byte-identical to849.
`work.css` adds only main's accepted Details link/picker rules. Imported
TaskThoughtLinks, WorkDetails and work API are byte-identical to main. PWA
registration, WorkingAgent and API client are also exactly main6e: **no
unmerged #380 or #474 repair was imported**. Original histories and all F-026 /
#346 criteria remain required. Source/merge/baked-input proof is
`/tmp/flux375-composition/current-source-proof.json`.

## Actual Docker results

Driver `/tmp/flux375-composition/check.sh`, handle36424, completed **exit1**.
It uses the trusted source Compose/Dockerfiles with only isolated IPAM and a
bounded selection of existing suites. Ports19920/19921 and networks
10.199.190–192 were inventoried before use. Production/tests remained immutable
throughout the run; built source hashes match the checkout.

| Phase at b803 | Actual result |
| --- | --- |
| Docker build/type check/lint | Pass; three existing warnings, no errors |
| Six selected application suites (native work/read/thought/home and client/query controls) | 58/58,16.809s |
| Chromium Tasks final/review + board/Home/project state/pagination | 53/53,163.948s |
| Chromium desktop/phone prerequisite and task→thought scenarios | 6/6,52.363s |
| WebKit same six UI modules | 53 methods run, **FAILED: six cleanup failures and two errors**,249.853s |
| WebKit desktop/phone selected scenarios | Six methods run, **FAILED: four cleanup failures**,67.322s |
| Agent setup, repository tests, diff checks | Pass;102 repository tests |

The **original23 Tasks final/review methods passed in both engines**, including
real offline errors, a confirmed change/Undo followed by aborted or503 identity
reads, real sign-out/account changes, held success/failure and retired Undo,
glyph/swipe/keyboard state changes, blocker restoration, stale refusal and
rendered20×20 owner marks. Their WebKit result is within the failed53-method
cohort; it is not a separate exit0 driver or a clean wider WebKit pass.

Both actual task→thought linking cases pass in both engines: desktop keyboard
and phone picker, cancellation/escape without writes, persisted single link,
deleted-thought refusal, shared map count and reader audience. WebKit's four
prerequisite scenario bodies completed but their cleanup guards failed.
Fourteen feedback geometry states per engine retain a12px footer gap, ≥44px
controls, real hit checks and full keyboard-readable long messages across both
themes,390/320px and125%/200% text. This does not accept all adaptive fixtures.

## Exact current failures and bounded blocker

WebKit UI cleanup failures, after the test's body assertions completed:

- `TasksBoardJourney.test_04_a_drop_on_the_header_or_an_empty_column_persists`
  and `test_06_move_to_menu_by_pointer_and_keyboard`: work-relations fetches.
- `ProjectStateJourney.test_01_open_task_is_visible_in_header_and_tasks_and_opens_the_actual_object`
  and `test_02_closed_native_work_is_history_and_a_persisted_status_update_replaces_the_open_summary`:
  assistant-runs fetches.
- `ProjectStateJourney.test_04_reader_opens_uncited_source_and_existing_conversation_then_writer_draft_returns`
  and `test_06_material_draft_hides_on_downgrade_and_returns_on_upgrade`:
  project people fetches.

All six unfiltered guards report “due to access control checks.” The two errors
are **two641px subcases of the same**
`ProjectStateJourney.test_05_long_project_title_yields_to_readable_audience_and_compact_header`:
the actual `.pwa-update` prompt intercepts the audience click. Report the
runner's six failures/two errors without treating the two subcases as two
additional top-level methods.

WebKit `DesktopScenarios.test_1_idea_to_collaboration`,
`test_2_thinking_and_execution` and their PhoneScenarios equivalents fail only
the unchanged cleanup guard with me/assistant-runs/project people fetch errors.
The two task→thought `test_2b` methods pass. Full unfiltered traces are
`/tmp/flux375-composition/webkit-failures.txt` and
`webkit-scenario-failures.txt`; raw phase logs remain alongside them.

These resemble previously observed error families. **Similarity and source
equality do not prove their cause.** This run adds no lifecycle timing or frozen
main counterfactual proof. The wider WebKit gate remains blocked. Do not filter
its errors, disable workers, lower geometry/contrast bounds or import unmerged
repairs to make it green. Next: independently accept the separate #380 PWA and
appropriate lifecycle/client repairs, integrate through protected main, normally
compose that accepted main here, then rerun the complete53-method UI and six
scenario cohorts in both engines plus the relevant application controls. The
new integrated head must prove its own result; the23 passing methods do not
replace this gate.

## Evidence, cleanup and remaining acceptance

All owned containers, volumes, networks and run-tagged images of
`flux375-compose-1791686252-1825243` are absent after terminal completion; no
other project was cleaned. Raw driver log SHA-256:
`be59c9efc085022b260d1893c713a8f0b1ce3e7597ca3af2f15e764d5b0f2a36`.
`/tmp/flux375-composition/verification-proof.json` records separate phase
results, hashes, source and resource checks; `geometry.json` holds observed
rectangles.

Fresh26 immutable native Tasks/feedback PNGs (13 per engine) have verified
hashes/dimensions in `neutral-manifest.json`, with a source-free job/reference
brief in `neutral-brief.md`. They show computer1440×900 / phone390×844,
light/dark as listed, normal text/zoom, phone scale3 and computer scale1. The
computer list is light-only in this scoped package. Fresh independent visual
assessment remains pending; author screenshots are not a visual verdict or
behavioral acceptance. Prior18-frame849 appearance and bounded technical
COMMENT5481053818 retain their actual scope/pin and original22/23 WebKit failure
plus later focused2/2 result.

Fresh eligible @Zamojski5 code review and current remote checks remain required;
the older Changes Requested verdict is not silently withdrawn. Full #346,
#347/#342/#372, broader shell/adaptive/PWA/privacy and integrated application /
release acceptance remain open. Historical1171/phased application results are
not relabelled as this current-main run. No approval, merge or closure is claimed.

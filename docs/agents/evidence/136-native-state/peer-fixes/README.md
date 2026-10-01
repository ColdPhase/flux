# Header and reader-draft peer corrections — partial #136

2026-10-01. Re-review delta over `3d12fb92295a2315bb1db5e1be870cc95171ed79`.
Final runtime and tests: `c1a5d5fc79898199082190ca1daac4c4933c616f`.
The subsequent evidence commit changes only this documentation.

F1: the project title now yields to the audience, with ellipsis and the complete
name in its title and reachable Details. Audience has its own bounded share and
a two-line ceiling for extreme names. The new actual-browser regression covers
71- and 122-character project names at 641/700/744/820/1024/1280/1440 CSS pixels:
header at most 90px, ordinary audience text unclipped, no horizontal page overflow,
and the full project heading available through the actual audience control.

F2: viewer rendering hides the material form and submission also checks current
write access. The private form values and reopening intent survive downgrade,
reload, closing the reader's Sources tray and later upgrade. Private-draft reads
run only while the writable form is active. The browser uses actual role changes,
focus refresh, reload and API publication: no editable form in viewer mode,
zero shared materials before upgrade, recovered exact draft and one HTTP201 save.

## Actual verification

- Before changes, new tests on the old runtime: two tests, 15 subcase/assertion
  failures, 42.502s. F1 reproduced audience columns/header heights up to526px;
  missing title attributes account for some wider-width assertions. F2 reproduced
  the editable viewer form. `/tmp/flux136-peer-baseline.log`.
- First correction run at `f848a346`: 24 tests, seven failures, 124.058s.
  Six were an incorrect dialog-only test selector (desktop Details is docked);
  one exposed the Sources-close action clearing reopening intent during read-only
  access. Both are corrected, without removing the geometry/permission checks.
  `/tmp/flux136-peer-current.log`.
- Final Docker build/typecheck/lint and `test_project_state test_project_surface
  test_work_decisions`: **24/24 PASS, 78.808s**, no uncaught browser errors.
  Actual source `c1a5d5fc`; `/tmp/flux136-peer-final.log`.
- Agent setup/local links, 34 foundation tests and whitespace pass. No full server
  suite or hardware/accessibility acceptance is claimed for this UI correction.

The focused runner is the configured `scripts/check_ui.sh` Compose environment
with only its working-directory entry and unittest module list adapted in
`/tmp/flux136-state-focused.sh`; final ports18793/18797, generated isolated project,
volumes and images removed by its cleanup trap. The user's flux155browser preview
was preserved. [Manifest](manifest.json) retains exact local log and image hashes;
raw auth/service cleanup logs are not published.

## Separate visual evidence and remaining work

[Fresh neutral visual review](visual-review.md) found no material header readability
problem. Its first four immutable captures use `f848a346` (same final header CSS);
the additional390px reader capture uses `c1a5d5fc`. It cannot certify source browsing,
permission behavior, keyboard access or real hardware from pixels.

It records one material **conversation-layout** finding: on1180px tall empty
conversations the invitation is separated from the composer by roughly800px.
This remains in #136's Studio11.6 integration work; it is not marked accepted or
complete by the header correction. Peer F3 reader empty-state/footer copy and
other optional findings remain follow-ups. Full #136 AC1–AC5, #151, #155, Agents,
real-client/device/performance/motion and integrated release acceptance stay open.

Next: independent current-head delta review of F1/F2. No self-approval or merge.

# Phone blocked-state visibility — partial #136 / #151

2026-10-01. Corrective slice over accepted main3abbd0f4; final runtime/test pin
`f1f00403d7c25183105ad350bc2ef1c2c19b7b85`. Evidence-only changes follow that pin.

The actual collapsed phone state row hid `1 blocked` behind its ellipsis when a
proposal and ongoing work coexisted. Retain the existing native count in its own
nonshrinking span, keep needs-you wording first in the summary, and let the recap
entry wrap when the two actions cannot fit readably. This preserves a 44px minimum
state target and existing overview/native-object navigation. It does not add a
new command or change access, state predicates or desktop rendering.

## Actual verification and retained failures

- New regression on old3e554d54: six failures, writer/reader at320px100%,390px125%
  and320px200% text; actual text ranges were beyond the clipped summary.
- First correction at781de6dc: configured Docker build/typecheck/lint and14/14
  browser tests PASS139.155s. A separate neutral review found a200% text collision
  with the adjacent recap action; this passing run did not establish readability.
- Strengthened actual-browser hit-testing reproduced that collision for both
  roles: two failures,9.771s. Text must be within viewport/clipping bounds AND
  unobscured at three positions across its rendered range.
- Intermediate wrapping run atdc30885c: the new visibility test passed, but two
  older reader cases had a test-only NameError from an incorrectly placed keyboard
  branch. That orchestration error was corrected in the test; its failed run is
  retained rather than reported as a pass.
- Final f1f00403: configured Docker build/typecheck/lint, `test_project_state
  test_theme_accents` **14/14 PASS132.685s, EXIT0**. The new six subcases verify
  visible native blocked counts, no horizontal page overflow, 44px minimum state
  target, writer keyboard Enter/reader touch opening the actual Details overview,
  and the real blocked task's heading and persisted API status. Existing native
  open/history, reader downgrade/private-draft and six-theme tests remain passing.

The runner adapts only the working directory and selected unittest modules of
trusted `scripts/check_ui.sh`; ports18871/18875 and fresh generated Compose
projects/volumes/images. Each run removes only its own resources. User preview
18581 was preserved. [Manifest](manifest.json) records exact source, private log
hashes and six published final captures; service/auth logs are not published.

## Independent visual scope and remaining acceptance

[Round one](visual-round1.md) records the material enlarged-text collision.
[Round two](visual-round2.md) independently inspected six final immutable renders
with a neutral persona/job brief and current Studio11.6 references. It reports
the collision resolved and no material visible issue in that scope. Enlarged
text is token scaling at browser100%, not proof of browser zoom/hardware.

Independent eligible code review/current required CI are still required before
protected merge. These scoped browser/visual checks do not certify WCAG, real
Android/iPhone/iPad installation or OS notifications, the full adaptive/motion
matrix, complete server suite or release acceptance. The tall-tablet short-stream
blank-gap finding and whole #136/#151/#155 outcomes remain open. No issue is
closed by this corrective slice. Next: peer delta review at the pushed head.

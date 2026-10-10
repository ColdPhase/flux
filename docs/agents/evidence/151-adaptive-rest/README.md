# Adaptive matrix at every contract fixture, 4K scaling and wide caps: #151 (slice adaptive-rest)

2026-10-10, owner claude-maurycy (Zamojski5). Tested head: `68152c5a` (the narrowed known-gap rule and its negative controls), merged with `origin/main` `4697fadc` in `434c6049`.
Refs #151. This slice does not complete #151: see "Not delivered" below.

**Emulation only.** CSS viewports in headless Chromium in Docker, on the synthetic fixture
[`adaptive_fixture.py`](../../../../app/tests/ui/adaptive_fixture.py). Nothing here is evidence for a
physical 4K or ultrawide display, OS scaling, a real phone keyboard, or Android, iPhone or iPad
(those stay open under #151 AC-5 and #20).

## What the matrix now checks

[`test_adaptive_matrix.py`](../../../../app/tests/ui/test_adaptive_matrix.py), 20 tests: the 14 journey and transition tests, and `KnownGapRules`, six browser-free negative controls for the known-gap rule (see below).

- **test_01:** the same journey at all 23 starting fixtures of
  [adaptive workspaces](../../../design/adaptive-workspaces.md#viewport-and-input-verification-matrix):
  320×568, 360×640, 360×800, 390×844, 412×915, 430×932, 640×360, 844×390, 600×960, 768×1024,
  820×1180, 1024×768, 1280×720, 1280×800, 1366×768, 1440×900, 1920×1080, 2560×1440, 2560×1080,
  3440×1440, 5120×1440, 3840×2160 and 900×1600. Per fixture: no sideways scroll, reachable and
  unclipped primary actions, 44 px coarse targets, and the 90-character measure.
- **test_05:** system scaling. 3840×2160 at ratio 1, 2560×1440 at 1.5 and 1920×1080 at 2 give the same
  CSS boxes as ratio 1 for the pane, feed, map canvas, task board and Details, in four views. The
  device pixel ratio is asserted, not inferred from the width.
- **test_06:** the same journey in the dark theme at 390×844 and 3440×1440.
- **test_07:** wide caps. The map plane and the Agents column, measured at 1920, 2560 and 3840 px.
- **test_13:** the reading-place check now hovers the stream before its scroll (see below).
- **KnownGapRules (negative controls):** the recorded overlap is seen and not failed; an undersized control, an unrelated stop, an unrelated cover, a viewport failure, another fixture, another label and another overlay are problems. They call `judge_reach` and `judge_target` directly, with results shaped like the probes report them.

Known gaps (`KNOWN_GAPS`) are measured and reported as open, never as passing. The matrix fails when a
gap stops showing, so a closed gap has to be removed from the list.

A gap excuses a failure only for the predicate it names, and only when the cause is one of its own overlays (`covered_by`).
- `covered`: every point the control fails on is covered by one of those overlays.
- `target`: the control's own box is at least 44 px on both axes, and on each axis that falls short both sides are stopped by those overlays.
An inside-viewport failure is never excused, and an undersized control is a problem even under the same overlay. The probes report the
overlay for each covered point and stop (`overlay`), not the leaf element, because the element under a point is often a link or button inside the bar.

| Fixture | Gap | Closed by |
| --- | --- | --- |
| 640×360, 844×390 | "a message's Reply": its 44 px box is covered at the top by the tab bar (`.ui-tabs__bar`) and at the bottom by the composer (`.project-convo__composer`), so the hit area is 15 to 23 px | Phone shell PR #414 (#341) |
| 844×390 | "a task card": its box is covered on every side by the status overview (`.tb-overview`), so the hit area is 0.5 px and a pointer cannot open it. The journey opens it through the element's own click and still measures the rest | Tasks layout PR #375 (#346) |

Wide caps (`WIDE_CAPS`), measured in CSS px at 1920 / 2560 / 3840:

- the map plane: 1032 / 1032 / 1032. The 1080 px sketch page caps it in `app/apps/web/src/sketch/sketch.css`; PR #380 owns the map;
- the Agents column: 854 / 854 / 854. It is capped in `app/apps/web/src/agents/agents.css`; PRs #376 and #417 own it.

No product code changed in this slice. The CSS for all of the above sits in files that open PRs
change, so the gains wait for those PRs.

## Result of the tested head

Command (through the Docker slot wrapper, ports 19320/19321):
`FLUX_UI_PORT=19320 FLUX_UI_MAILPIT_PORT=19321 ./scripts/check_ui.sh test_adaptive_matrix`

```
Ran 20 tests in 289.254s
OK
scaling: 3840×2160 @1, 2560×1440 @1.5 and 1920×1080 @2 compared with ratio 1; differences: 0
wide caps, CSS px at 1920 / 2560 / 3840: the map plane 1032 / 1032 / 1032; the Agents column 854 / 854 / 854
```

The verbose lines of the new negative controls in that run:

```
test_01_the_recorded_overlap_is_seen_not_failed ... ok
test_02_an_undersized_control_is_a_problem_under_the_same_overlap ... ok
test_03_an_unrelated_stop_is_a_problem ... ok
test_04_an_unrelated_cover_is_a_problem ... ok
test_05_a_viewport_failure_is_a_problem_under_the_overlap ... ok
test_06_the_overlap_is_not_excused_elsewhere ... ok
```

The longest rendered line per prose surface, in characters, for each fixture printed by the run:

```
longest line, Conversation messages: 320×568 33, 360×640 38, 360×800 38, 390×844 43, 412×915 45, 430×932 47, 640×360 79, 844×390 75, 600×960 72, 768×1024 62, 820×1180 70, 1024×768 83, 1280×720 83, 1280×800 83, 1366×768 83, 1440×900 83, 1920×1080 83, 2560×1440 83, 2560×1080 83, 3440×1440 83, 5120×1440 83, 3840×2160 83, 900×1600 83
longest line, Replies: 320×568 34, 360×640 40, 360×800 40, 390×844 44, 412×915 47, 430×932 51, 640×360 77, 844×390 77, 600×960 74, 768×1024 67, 820×1180 74, 1024×768 37, 1280×720 47, 1280×800 47, 1366×768 47, 1440×900 47, 1920×1080 52, 2560×1440 52, 2560×1080 52, 3440×1440 52, 5120×1440 52, 3840×2160 52, 900×1600 86
longest line, The map hint: 320×568 53, 360×640 57, 360×800 57, 390×844 65, 412×915 70, 430×932 72, 640×360 81, 844×390 86, 600×960 81, 768×1024 86, 820×1180 86, 1024×768 86, 1280×720 83, 1280×800 83, 1366×768 83, 1440×900 83, 1920×1080 83, 2560×1440 83, 2560×1080 83, 3440×1440 83, 5120×1440 83, 3840×2160 83, 900×1600 86
longest line, Wiki prose: 320×568 40, 360×640 45, 360×800 45, 390×844 49, 412×915 53, 430×932 55, 640×360 57, 844×390 53, 600×960 52, 768×1024 44, 820×1180 52, 1024×768 82, 1280×720 82, 1280×800 82, 1366×768 82, 1440×900 82, 1920×1080 82, 2560×1440 82, 2560×1080 82, 3440×1440 82, 5120×1440 82, 3840×2160 82, 900×1600 63
```

Other checks on this head: `python3 scripts/check_agent_setup.py` passed (exit 0); `git diff --check` clean; `python3 -m unittest discover -s tests -p 'test_*.py'` ran 99 tests, `OK`. The last one passes on the merged head; the earlier 6 failures in `tests/test_runtime_purge.py` recorded in the PR body no longer reproduce here.

## Negative controls and the runs that led here

Each row is a run of the matrix module, from the first one on `main` to the tested head.

| Run | Head | Result | What it showed |
| --- | --- | --- | --- |
| Baseline | `e06248c5` (main, 9 fixtures) | 10 of 11 pass; **test_13 FAIL** | The reading-place check fails before any resize. Within 2 s of opening, the stream settles to its end (`openOnWholeMessages`, reader input only) and a script's scroll is not reader input |
| 1 | slice, 23 fixtures, no gap list | FAIL: 640×360 and 844×390 Reply covered; 844×390 task card covered; test_05 2560×1440 @1.5 pane top 121 vs 124 px | The new fixtures detect real gaps. The 3 px shift is not a DPR effect (see run 7) |
| 2 | gap list, card click not special-cased | ERROR: 844×390 card click intercepted by the status overview (Playwright timeout) | The journey stopped early; a click path for the recorded gap was added |
| 3 | + card click path, geometry settled | FAIL: test_05 1920×1080 @2, Conversation and Tasks pane top 121 vs 124 px | Timing: the header is measured before its web font is in |
| 4 | + network idle before geometry | OK, 13 tests, scaling differences 0 | |
| 5 | same as 4 | No tests ran: compose service pull race on the untagged UI test image (infrastructure) | Rerun below |
| 6 | + test_07 wide caps | OK, 14 tests | Evidence in this record |
| 7 | `e99d8636` | FAIL: test_05 2560×1440 @1.5, Tasks and Agents pane top 124 vs 121 px | Still timing: the same 3 px flips between the two contexts |
| 8 | `d29612fc` | OK, 14 tests, scaling differences 0 | `document.fonts.ready` added to the at-rest wait |
| 9 | `434c6049` (`d29612fc` merged with main `4697fadc`), prefix matcher, diagnostic print (removed) | FAIL: test_05 2560×1440 @1.5, Tasks pane top 121 vs 124 px and board 190 vs 193 px (14 tests) | The journey records the real overlap: the Reply at 640×360 and 844×390 is covered above by `.ui-tabs__bar` and below by `.project-convo__composer`; the 844×390 task card is covered on all sides by `.tb-overview`. The same 3 px flip as runs 1 and 7 |
| 10 | `68152c5a` (narrowed matcher and negative controls), merged head | OK, 20 tests (14 + 6), scaling differences 0 | Test_05 passed here; see the flake note below. The recorded overlaps are seen; no other failure is excused |
| 11 | `68152c5a` with the old prefix-and-viewport body restored in `check()` | FAILED (5 of 6): `KnownGapRules` test_02 to test_06 fail; test_01 passes under both rules | The old rule excuses an undersized control (`0 != 2`), unrelated stops (`0 != 2`), an unrelated cover (`0 != 2`), a viewport failure (`0 != 1`), and another overlay at 640×360 (`3 != 4`). The restored file was then put back and matches the committed one |

**Reading-place fix (test_13).** The stream's 2-second settle is deliberate product behaviour: it
keeps the latest message in view while content arrives, and only real reader input (wheel, touch,
scroll keys, pointer movement or press) releases it. The test now hovers the stream first, so the
scroll it performs is made after reader input. Without that hover, the test fails (baseline, run 1 with
the debug print). With it, it passes in runs 1 and 3 to 8. No product code was changed.

**3 px shift (test_05).** Geist is loaded with `font-display: swap` (`app/apps/web/src/ui/tokens.css`),
so the first layout can use fallback metrics. The flip direction differs between the two contexts,
which fits a timing effect rather than a DPR effect. This is an inference from the font rule and the
flip pattern. Runs 8 and 10 pass after the fix, and run 9 failed on the same flip, so the test is still intermittent. The cause is an inference from the font rule and the flip pattern, not proven. This change does not touch it.

## Screenshots

Captured by run 6 (same journey code as the tested head; the later changes are the font wait and
text in the gap and cap lists). Light and dark captures named `-dark`:

- [320×568 conversation](adapt-320x568-conversation.png)
- [390×844 conversation](adapt-390x844-conversation.png)
- [390×844 dark conversation](adapt-390x844-dark-conversation.png)
- [3440×1440 tasks](adapt-3440x1440-tasks.png)
- [3440×1440 dark tasks](adapt-3440x1440-dark-tasks.png)
- [3840×2160 map](adapt-3840x2160-map.png)

The other captures of the run are not committed (size guard for `docs/`).

## Not delivered

- The two wide caps (ADAPT-2) and the short-landscape gaps, waiting for PRs #380, #376, #417, #414, #375.
- The map projection still follows the viewport, not the canvas.
- Performance budgets, agreed at kickoff before any optimisation (T151-A/G).
- Browser zoom at 200% and 400%, and measured 200% text enlargement. Not run here.
- Independent visual review and running functional review of the combined head (AC-5).
- Real 4K, ultrawide, Android, iPhone and iPad sessions (optional under #266 item 10).

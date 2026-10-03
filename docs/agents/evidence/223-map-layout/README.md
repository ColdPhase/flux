# Complete map hint with task Details — #223

2026-10-03. Local correction within Studio 11.6; no new global layout rule.
Real authenticated browser/API data in isolated Docker Compose, 100% zoom.
The owner and project/task names are synthetic test fixtures.

The baseline at main `085214c6c58e265d1d19b2c56a12368a370ed24f`
reproduces the reported wrapped state header and open task Details at 1440×900.
The new full-hint viewport assertion fails: viewport ratio **0.2123**.
[Baseline](baseline-task-details-1440-light.png).

The map's canvas now fills the actual height left by the shell, around its
header, tools, private draft and complete wrapped hint. At very short heights,
the inner minimum content size retains padding and a usable scrollable map.
List and sketch-index scrolling retain their existing layout.

Corrected rendered states:

- [Task Details, 1440×900](task-details-1440-light.png).
- [Phone, 320×740](phone-320-light.png).
- [Phone, 390×844](phone-390-light.png).
- [Private unsent thought, 1440×900](private-draft-1440-light.png).

`test_map_layout.MapLayoutJourney` passes **4/4** against the corrected source:
wrapped header/task Details; 1440×720, touch 820×1180, 320×740 and 390×844;
camera/zoom, selection and focus return after closing Details; retained unsent
thought/API count; and 320×430 reduced-motion scrolling with a retained draft.
Opening Details correctly moves focus into its panel and closing returns focus
to the thought. The test verifies that behavior rather than requiring focus to
stay behind the opened panel.

Foundation/setup/link checks, 63 host foundation tests and whitespace checks pass.
Full `./scripts/check_ui.sh` and independent functional/neutral visual assessment
are pending at this documentation checkpoint. No screenshots prove concurrency,
accessibility, physical-device installation, notifications or live co-editing.
The separate #222/#226 control-safe Fit correction and #228 live map/wiki
requirement retain their own contracts and verification.

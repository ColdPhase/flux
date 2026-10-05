# Independent source delta review — #155 sticky comparison jumps

Reviewed head: `ca1385cb264094459cfc620c9480b75d0d3dd2c4`.
Delta baseline: `fa1745c7ff980fcf2dbcef1f90cad06041909d43`.
Canonical main context: `55c54735ad7241017e18ae1a2777d35e718dc005`.
Accepted task-plan contract context: `cc878ad4d16eeda2feab9c353f25164499a417e7`.
Reviewer: independent subagent `/root/bounded_state_contract_review`; implementation owner remains the parent agent. Date: 2026-10-03.

## Outcome

No material source finding in this bounded delta. The prior P2 concerning a comparison jump placing its heading behind sticky controls is addressed in source at the reviewed head. This is a source-only assessment, not executed runtime acceptance, eligible PR approval, or acceptance of all #155 criteria.

## Evidence and scope

Reviewed the four-file delta: `ProjectTasks.tsx`, new `work-proposal-pagination.e2e.ts`, the native criteria boundary fixture, and `scripts/check_application.sh`; also read the controlled outcomes seed and relevant pane/control CSS.

- `ProjectTasks.tsx` now scrolls the actual Tasks pane with an instant scroll. Its target subtracts the current measured sticky-control height plus 12 pixels, so wrapped phone/tablet controls are accounted for. The existing reset to All, Only mine off, and first page remains; an absent destination on All still selects only the bounded destination group. The change introduces no object-wide fetch or change to native grouping predicates.
- The new regression creates 52 native open work items and 52 native positive results in the controlled project. It checks Work on the first All page and Results through the off-page group fallback at widths 1440, 390, and 1024, after selecting Open with Only mine. It asserts destination absence before the jump, visible heading geometry below controls after the jump, the expected All/Results selection, and Only mine reset. Phone/tablet branches use tap. Fresh seeding in the configured script supplies a new project and accounts, preventing preceding outcome tests from determining this fixture's state.
- The separately issued API reads assert 50 items for All and Results. This verifies endpoint page bounds within this test; it does not independently assert rendered row counts or trace the UI's requests. The source continues to render one bounded page. This regression also does not claim the complete TP3 enlarged-text/reduced-motion evidence or other #155 gates.
- The native criteria fixture correction produces exactly 1000 characters per criterion rather than 998, strengthening the existing accepted-boundary test without changing criteria limits.
- The configured application check now freshly seeds and runs this regression sequentially before the existing task-plan browser stage. Shell syntax and delta whitespace checks passed independently (`sh -n scripts/check_application.sh`; `git diff --check fa1745c7ff980fcf2dbcef1f90cad06041909d43 ca1385cb264094459cfc620c9480b75d0d3dd2c4`). No application tests were executed by this reviewer.

The owner-provided `/tmp/flux155-sticky-jump-baseline-corrected.log` records one failing regression with the heading present followed by the 3000 ms geometry-condition timeout against the prior implementation. I inspected the failure excerpt; I did not independently execute that baseline. The current-head configured Docker run was still pending when this review was prepared, so neither it nor earlier API PASS evidence is treated as proof for this head.

The prior task-plan scalar/detail consistency and authorization contract is unchanged by this delta. All original task-plan and whole-#155 acceptance gates remain required. Runtime geometry, current-head configured checks, remaining interaction/accessibility evidence, and normal eligible independent evaluation still need their own pinned results.

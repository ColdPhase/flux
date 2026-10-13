# Current-head verification — PR #376

**Source:** `0dbab955671d2ca4562d575fb7f6ee767057e024`

**Base:** `3163f2e2192987c7dfc40a4535adbdbc6b1c8f45`
**Evidence branch parent:** the source SHA above. This commit contains documentation and compressed evidence only; it does not change PR #376.

## Functional and visual checks

- Maintained UI modules `test_agents_handoff`, `test_agents_view`, `test_project_policy` and `test_grant_controls`: Chromium **52/52 passed**, WebKit **52/52 passed**. This covers the affected hand-off, task-thread recovery, project policy/grants, touch and 320/390/820 plus enlarged-text containment cases.
- Selected API/DB integration checks across `agent-activity-index`, `agent-project-reads`, `agent-owners`, `agent-native-row-owners`, `cowork-execution`, `cowork-storage`, `mcp-cowork-claims` and `migration-ledger`, plus `project-agents.test.ts`: **44 passed, 0 failed**.
- Reachability probe on Chromium at 20 px root text: **2/2 selected tests passed** (the existing `HandOffJourney` fixture plus one diagnostic method). It exercised 320/390 CSS px in light/dark and recorded each case in `manifest.json`. At 320 the body scroll range was 241 px; at 390 it was 28 px. In all four cases the final permission-text line reached a position above the fixed footer while the footer action remained visible.
- Two earlier temporary diagnostic harness attempts stopped before collecting measurements (duplicate signup fixture, then harness-only setup/import lookup errors). The final explicitly selected, separately inspected harness passed. Those exploratory harness errors were not product-test failures; the temporary harness has been removed.
- The original independent visual review reported one P2 from the initial screenshots. After current-head scroll-state evidence, a fresh independent visual reassessment withdrew that P2; see [visual-review.md](visual-review.md). No product code changed, so the source head and its existing results remain the same.
- Foundation setup and whitespace checks passed before the bounded UI/API run: `python3 scripts/check_agent_setup.py`, `git diff --check`.

## Current GitHub gates

At hand-off, PR [#376](https://github.com/ColdPhase/flux/pull/376) remained open at the source head above and based on the current `main` SHA above. Required checks passed:

- [Agent setup](https://github.com/ColdPhase/flux/actions/runs/38429288954/job/115406912635)
- [Application validation](https://github.com/ColdPhase/flux/actions/runs/38429289031/job/115406914427)

PR state at the fresh checkpoint: `REVIEW_REQUIRED`, existing review request `Zamojski5`, and **0 unresolved review threads**. The only submitted reviews were `CHANGES_REQUESTED` on `eeb706bd` and `DISMISSED` on `14dc2bde`; neither evaluates current head `0dbab955`. No current-head independent approval was present. The existing request remains in place; this evidence commit does not approve or merge the PR. No full unrelated application suite or complete adaptive matrix is claimed here.

## Probe measurements

The detailed JSON values are recorded in `manifest.json`; the observed geometry was:

| CSS width / theme | Scroll range | Final text line bottom | Content bottom | Footer top | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| 320 / light | 241 px | 749.47 px | 764 px | 780 px | Fully inside body and above footer |
| 320 / dark | 241 px | 749.47 px | 764 px | 780 px | Fully inside body and above footer |
| 390 / light | 28 px | 750.16 px | 764 px | 780 px | Fully inside body and above footer |
| 390 / dark | 28 px | 750.16 px | 764 px | 780 px | Fully inside body and above footer |

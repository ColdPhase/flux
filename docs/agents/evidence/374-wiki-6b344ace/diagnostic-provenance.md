# #374 WebKit `needs-you` navigation diagnostic

Diagnostic-only run against product source commit `6b344acedd1479e5f4e1ffcc03accd85937f6754`. No product files or assertions are changed. The detached worktree is `/home/hubert/Develop/flux-diagnostic-374-6b`; its sole tracked diff is instrumentation in `app/tests/ui/test_scenarios.py`.

The temporary instrumentation patch is `instrumentation.patch` (SHA-256 `fa1e7af870e7d8b1eca1a227607041ea080afad5b205be06e2c7271f5204fa17`). The uninstrumented source file from the pinned commit has SHA-256 `40401f96383997e7b77e5dccb046e11996f700b82656eba3782a44d37699318d`. Preflight: `python3 -m py_compile app/tests/ui/test_scenarios.py` and `git diff --check` passed.

The one planned run uses the normal `scripts/check_ui.sh` runner with `FLUX_UI_BROWSER=webkit`, an absolute `FLUX_UI_SCREENSHOT_DIR`, and these ordered methods to preserve the class fixture and state transitions:

1. `test_scenarios.PhoneScenarios.test_1_idea_to_collaboration`
2. `test_scenarios.PhoneScenarios.test_2_thinking_and_execution`
3. `test_scenarios.PhoneScenarios.test_2a_touch_selects_several_thoughts`
4. `test_scenarios.PhoneScenarios.test_2b_an_existing_task_links_to_a_thought_in_the_browser`
5. `test_scenarios.PhoneScenarios.test_3_agent_proposes_a_pivot_and_a_person_accepts`
6. `test_scenarios.PhoneScenarios.test_4_return_after_the_pivot_without_ai`
7. `test_scenarios.PhoneScenarios.test_4a_the_return_view_names_the_work_the_pivot_parked`
8. `test_scenarios.PhoneScenarios.test_5_inbox_search_and_the_wiki_find_the_work`

The instrumentation preserves the existing unhandled `pageerror` assertion. For #5 only, it records `/api/v1/needs-you` request/response/finish/failure events, main-frame navigations, page errors and explicit journey step markers. Each event includes epoch milliseconds and monotonic time for correlation. The first invocation used the non-TestCase mixin `ScenarioJourney`; unittest rejected those selectors before running tests (`TypeError: ... missing 1 required positional argument: 'self'`). That setup/selector failure is preserved as `selector-loader-failure.log` and produced no test results. The corrected class-qualified selectors were then validated with `unittest.defaultTestLoader` in the cached UI image without executing test setup or methods. Observed result: corrected WebKit selection ran 8 tests in 63.243s: 7 passed and 1 existing expected failure. The original 16-method WebKit run had 14 passed, 1 failure, and 1 expected failure. It reproduced two `/api/v1/needs-you` requests canceled with `Load request cancelled` immediately before the DM-to-project hard navigation; the project route then fetched the endpoint successfully with HTTP 200. The original `pageerror` did not recur, so this trace supports request cancellation but does not conclusively explain the earlier pageerror. Independent review concluded no further diagnostic or product fix is required for #374 scope: the current seven WikiFinal WebKit methods and export scenario pass, and the diagnostic preserves the pageerror guard. The original transient pageerror remains un-reproduced and its cause is not claimed as certain. No product behavior or test assertion was changed. This run is diagnostic evidence, not an acceptance pass. The prior uninstrumented failure remains at `/home/hubert/Develop/flux-evidence-archive/flux374-6b344ace-webkit/`; it must not be overwritten or relabelled.

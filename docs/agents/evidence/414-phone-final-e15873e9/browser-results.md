# Browser and CI results

All product-level browser evidence is tied to source `e15873e97a843dc32e944032c9b3a6067c5cfaea`.

- Chromium at `531cf9b1c828b2fe7a3f88c3ea27acbe1b693501`: `PhoneFinal.test_05_the_title_is_the_view_menu_with_no_chips` and `HomeFinal.test_05_phone_home_orders_continue_then_what_needs_you`, 2/2 PASS. At e158, only the test_11 locator changed; product source is identical.
- Chromium at e158: `PhoneFinal.test_11_create_sheet_selection_and_text_persist_and_create_only_in_selected_project`, 1/1 PASS. The project selection and draft survive reload; exactly one task is created in the chosen project and none in the first.
- WebKit at e158: `PhoneFinal.test_05_the_title_is_the_view_menu_with_no_chips`, `HomeFinal.test_05_phone_home_orders_continue_then_what_needs_you`, and `PhoneFinal.test_11_create_sheet_selection_and_text_persist_and_create_only_in_selected_project`, 3/3 PASS.
- Chromium at e158: the temporary real-fixture capture harness ran 2/2 cases, producing the 8 changed-surface frames. Exact harness SHA-256 is in `manifest.json`; captured test output is in `changed-surface-run-summary.txt`.
- [Repository checks / Agent setup](https://github.com/ColdPhase/flux/actions/runs/38454067619) and [Application checks / Application validation](https://github.com/ColdPhase/flux/actions/runs/38454072145) both PASS on exact e158.

GitHub PR review remains `CHANGES_REQUESTED` because the latest formal review targets older head `f075d0ca`; reviewer `Zamojski5` is already requested. The source PR remains stacked on #393; re-evaluate its merge-base integration after #393 merges.

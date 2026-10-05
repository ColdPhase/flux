# #239 takeover checkpoint (2026-10-05)

Branch `claude-maurycy/239-takeover` (local, not pushed). Worker notes for resuming; not
acceptance evidence.

## Done (commits)

- `eba97b99` merge of `origin/main` `fdb70955` (#195): clean; schema 47 with 0046/0047.
- `4b609df6` + `856c53e1` regression `app/tests/app/native-map-ordinary-capacity.test.ts`
  (burst of 25 concurrent thought creations; roomless all 201; roomed 201 or retryable 503).
  Negative control at `4b609df6` (fix-less) with the final test file: both fail with
  `500 EDITING_OUTPUT_CAPACITY`.
- `0309cc48` P0-1: non-locking room-existence read gates the live preparation (HTTP and MCP);
  `nativeCapacityRefusal` maps capacity to a retryable 503. Contract text in
  `docs/development/live-editing-proposal.md` (map persistence seam).
  Targeted API run at `0309cc48`: search.test, lifetime 10/11 and the editing/map suites pass;
  only the earlier 70-burst variant failed (pool/row-lock timeout), hence the burst of 25.
- `d83630ea` P0-2/P0-3/P1-4: `GET /api/v1/live-editing/capabilities`; ordinary map hook is
  main's `useSketchDoc` again (`sketch/doc.ts`), live hook in `sketch/live-doc.ts`; SketchMap
  keeps main's drag geometry when live is off; wiki live editor/reader load lazily only when
  configured (lib0 reads `localStorage` at import: captured stack in scratchpad
  `t239-diag2.log`). Regression `app/tests/ui/test_live_editing_off.py`.
- `3a676a28` P1-5a: LiveDocEditor on the WikiBar document-pane layout.

## In progress

- Targeted UI (off), targeted API, live-mode UI and the UI negative control runs.
- P1-5b live selection: the 50-thought failure looks like a test race (stale `sent[-1]`,
  one 18 px mouse step behind the trailing throttled frame); 200 error frames need the
  diagnostic `t239-seldiag.log`.
- Then full `check_application.sh` (19120/19121) and full `check_ui.sh` (19122/19123).

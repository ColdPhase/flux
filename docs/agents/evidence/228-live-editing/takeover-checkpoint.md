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

- `ea3dbfdf`, `d83bc0e5`: off-mode UI test split into wiki/map tests; live selection test
  waits for the gesture's own latest sequence before comparing (test race, see below).

## Observed so far (feature off unless noted)

- Targeted UI at `d83630ea`: 81 tests OK (live-off, sketches, thought drafts, map outline,
  theme accents, docs, wiki panes, one conversation).
- UI negative control at `856c53e1` (pre-fix) with the split off-mode test: the wiki test sees
  `/live` requests; the map test sees "Undo requested … Waiting for confirmation".
- Live mode (`FLUX_DEVELOPMENT_LIVE_EDITING=true`) at `d83630ea`: 14/16; selection 50 failed
  (stale frame) and wiki test_01 once showed "3 changes waiting to be shared" (unexplained,
  re-run pending). Selection diagnostic at `3a676a28`: frames (3,4), own sequence 4, no error
  frames at 50 or 200; the 200 error-frame failure did not reproduce.

- Targeted API at `d83630ea`: 94/94 (capacity regression, capability, search 13/13 subtests,
  lifetime incl. ordinary tests 10/11, editing/admission/telemetry/shutdown, live map
  authority, MCP map actions, sketches, DM sketches, outline, docs, architecture); image build
  with tsc and eslint (0 errors, 4 warnings, unchanged count).
- UI negative control v3 at `856c53e1`: wiki test lists 3 `/live` requests and the live text
  `Write together`, `Connecting to the shared working copy`, `Shared working copy` (twice:
  client navigation and direct open); map test shows `Undo requested … Waiting for confirmation`.

## Blocked (2026-10-05 05:30 local)

Docker Desktop's VM was killed at 04:48 local (`wait status: 9` in the backend supervisor
log; an image extraction failed just before) and its GUI quit at 04:55. The host Data volume
was full (548 MiB free; `Docker.raw` about 182 GB allocated). I removed my six finished scratch
worktrees (now 2.6 GiB free); `open -a Docker` twice exited 0 without starting Docker
Desktop; stale `com.docker.backend` processes remain. A fleet `PAUSE` marker appeared in the
Docker slot directory at 05:27. No run includes `3a676a28` or later.

Unblock: free host disk, restart Docker Desktop, prune leftover per-run `flux-test-*` and
`flux-ui-*` images, then run against pinned worktrees at `d83bc0e5` (scratchpad scripts):
`t239-fullapp.sh` (check_application, 19120/19121), `t239-fullui.sh` (check_ui, 19122/19123),
and `t239-uilive.sh <scratchpad>/w239-live2` (live-mode browser modules, 19128/19129).

# PR #389 current-head verification

The product source tested is [`108a7a3c5935cb0265e55658176e97b759a1d937`](https://github.com/ColdPhase/flux/commit/108a7a3c5935cb0265e55658176e97b759a1d937), branch `codex/228-main-composition`; its parent/base is `bb74618a3bf1ef6b1de5f6f9b2ed700651104648`. This archive commit is documentation-only and is a direct child of the tested source. The source worktree was clean. PR #389 remains a draft and #228/#231 remain open.

## Results at the exact source revision

- Targeted real-DB API tests: **31/31 passed** across `editing-http-lifetime.test.ts`, `mcp-map-actions.test.ts`, `agent-stop-questions.test.ts`, and `live-doc-native-fence.test.ts`. The last file contains three SQL/UOW regressions for live-snapshot task-use latching, already-reverted task refusal with unchanged document state, and the two real PostgreSQL lock orderings (Save wins / Undo wins, with no partial effects for the loser). Logs: `logs/api-tests.log.gz`, `logs/api-build.log.gz`; selection and run metadata are also included.
- Configured live-editing + Wiki browser coverage: Chromium **5/5**, WebKit **5/5**. Each engine ran `LiveEditingJourney` 01/02/07 and `WikiFinal` phone title/edit plus computer panes/outline. Logs: `logs/live-chromium.log.gz`, `logs/live-webkit.log.gz`.
- Capability-off Wiki behavior: Chromium **2/2**, WebKit **2/2**, ordinary reader/editor from first render. Logs: `logs/off-chromium.log.gz`, `logs/off-webkit.log.gz`.
- Required checks on this exact head both succeeded: [Agent setup](https://github.com/ColdPhase/flux/actions/runs/38525761449) and [Application validation](https://github.com/ColdPhase/flux/actions/runs/38525761371).
- All five Compose runs completed cleanup; their down/image-cleanup logs are included. The exact run pins and selections are recorded next to the logs.

These are bounded, impact-selected checks; they are not a claim that every repository test or complete #228/#231 release acceptance was run. No Gate 4 latency or codec-admission result is claimed at this source. Earlier Gate 4 and codec results retain their own source pins and are not relabelled as 108a7a3c results. The native `installHead` fixture verifies the Save UOW boundary, not codec admission.

## Independent visual review

A separate reviewer assessed all twelve supplied reader screenshots against the relevant F-026 references. There was no P1/P2 issue established in those frames. One nonblocking P3 note remains: the live contributor label is pink, outside the monochrome treatment in F-026 principle 4/P7. Editing mode, historical versions, history menu, errors, enlarged text and long-document scrolled states were not supplied and remain visually unassessed. The screenshots do not establish behavior, accessibility or synchronization. See `independent-visual-review.md` and `neutral-visual-brief-source.md`.

The PNG captures are stored here as lossless WebP to reduce archive size. The two manifests preserve the original PNG hash and dimensions, add the archived WebP hash/path, and record byte-for-byte decoded RGBA8 pixel equality. The original runner manifest JSONs are retained as `*-source-manifest.json`; Chromium's manifest-generator repair and provenance are recorded in `logs/chromium-manifest-repair.txt`.

## Preserved unsuccessful attempts

`logs/pretest-*.log.gz` record three earlier stops before tests: a barrier type error at `4750ea72`, an unused race-fixture binding at `c01c52b3`, and the follow-up binding correction error at `372363e6`. None is counted as a product-test result. The first capture metadata serialization error and the corrected WebKit runner hash are recorded with the successful capture evidence.

## Integrity and reproduction aids

`SHA256SUMS` covers every file in this directory except itself. `harness/` preserves the focused runner and capture helper scripts; the exact source and harness hashes are in the run metadata/harness records. From this directory, verify with `sha256sum -c SHA256SUMS`. The original runner artifacts outside this tree remain at `/home/hubert/Develop/flux-evidence-archive/flux389-108a7a3c-*`.

A follow-up on this exact source ran the existing late-migration integration test against the current schema 94: **1/1 passed**. It asserts 0046, 0047 and 0084 can be applied after the canonical latest ledger, retains timestamps, and yields the exact ledger. See `late-migration/README.md` and its raw logs/runner. This closes the old review's explicit late-migration compatibility check; it does not substitute for a fresh independent PR review or the remaining full #228/#231 outcomes.

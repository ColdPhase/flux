# Independent source-only main55c integration delta review

2026-10-03. Reviewed exact clean integration head `fa1745c7ff980fcf2dbcef1f90cad06041909d43` in `/Users/maurycyzamojski/Dev/Projekty/flux/.worktrees/155-truthful-typing`.

Comparison pins: own prior `bfb80ecd19a626604452accec41355d5cfccf156`; canonical main `55c54735ad7241017e18ae1a2777d35e718dc005`; accepted additive task-plan contract `cc878ad4d16eeda2feab9c353f25164499a417e7`.

Scope: source-only implementation delta for bounded prerequisite scalar batches, complete single-task own details, row consistency checks, WorkDetails UUID/selection ownership and ProjectTasks comparison jumps. Inspected related native plan presenter, read orchestration/final fence, hooks and proposal consumers. The large merged-main diff outside this scope is not certified. This evaluator authored no implementation and made no branch/GitHub writes.

**Verdict: one material source finding in jump navigation; no other material finding in the requested bounded scope.** Runtime and full-task acceptance remain unverified.

## Finding

**P2 — Jump scrolls its heading underneath the sticky task controls.** `app/apps/web/src/work/ProjectTasks.tsx:176` calls `heading.scrollIntoView({ block: 'start' })` on the actual `h2#g-*`. `.ws-task-controls` is sticky at top 0 with an opaque background and z-index 3 (`work.css:55`). The existing `scroll-margin-top: 12px` at line 221 applies to the surrounding `.ws-group` section, not the heading being scrolled; no block scroll padding offsets the Tasks pane. With enough content below the target for top alignment, the heading and potentially first rows are covered by the controls. This undermines the contract's reachable visible group destination after a comparison Work/Results jump, including the new fallback to a group outside the first All page.

Source-derived reproduction to execute in Docker: create an open comparison outcome and >50 work or result rows so the target group has sufficient content below its heading; click Work/Results from an on-page group, then repeat for a group absent from All's first page. After the bounded response/jump settles, measure `heading.getBoundingClientRect().top` against `.ws-task-controls.getBoundingClientRect().bottom`; the heading must be below the controls and its initial rows exposed. Repeat narrow/enlarged text where controls wrap. No browser reproduction was executed by this evaluator, so this is explicitly a source finding, not a reported executed failure.

Correction: align within the existing pane using its actual current control height, or give the actual scrolled target/container effective scroll offset covering those controls. Preserve All when the target is on its bounded first page and retain the bounded group fallback when it is not. Re-test at the changed head.

## Other source assessments

- `work-read-task-plans.ts` enforces a <=100 selected-task batch, calculates only scalar totals/unmet in one grouped query and scopes prerequisite joins to the task's workspace/project. It counts edges before checking missing/foreign endpoints and rejects invalid observations; zero-edge tasks remain zero/zero. Native 50-dependency constraints and done-and-unparked predicate remain intact. No per-row full plan/body hydration was introduced.
- `work-read-objects.ts` computes those counts for selected work rows. Exactly one work detail calls canonical `taskGraphRows.taskPlans([row.id])`, retains native criteria, ascending prerequisite IDs/states and original planIntent, recomputes `met`, and compares the detail totals/unmet to the scalar observation. It removes projection-only counts and implicit links from the own object. No recursive/project-wide graph read is introduced.
- `work-read/service.ts::rowFacts` validates nonnegative safe integers, unmet<=total and total<=WORK_LIMITS.dependencies for work rows. The new reads remain within the existing read-only repeatable-read orchestration/current final session/project policy fence. The inherited result_work 100-page-plus-one-selected exception remains handled through separate bounded hydration.
- `WorkDetails` uses owner object identity for its current account/project/object lifetime, so A→B→A retires the first A even when serialized scope returns. Guarded state patch/reload closures remain bound to that owner. WorkPanel retries reuse a UUID for the same native ID/version/command; a changed command or native conflict renews it. `api.ts` sends that UUID as clientCommandId with the observed If-Match version. No material source regression found here; held-response/native retry proof still needs execution at the current head.
- `ProjectTasks` derives jump counts from the combined bounded summary, uses only displayed result titles with honest existing proposal/source fallbacks, and does not restore full work/result collections. The corrected jump first selects All/unfiltered/first page, waits for the actual ready observation, retains All if its heading exists and otherwise selects the actual bounded target group. Manual view/page/refresh changes retire pending jump intent. The sticky-target issue above remains.

Checks executed: local source/Git reads; HEAD/status confirmed exact clean pin; document contract and compared code inspected; scoped `git diff --check bfb80ecd fa1745c7 -- <reviewed implementation files>` passed. No Docker SQL/API/browser tests, visual review, remote CI or eligible PR approval ran in this review.

The reported earlier 84/84 focused API result predates the final jump correction, and prior 63-PASS evidence belongs only to its own prior pin. Neither is current-head proof here. TP-1–TP-4, affected browser/rendered assessment, original #155 performance/device/provider/MCP/PWA/Web Push criteria and normal eligible PR approval remain required. No criteria were lowered; no merge/whole #155/release acceptance is claimed.

Next action: author corrects the sticky-heading jump, verifies the stated browser geometry plus the affected native/composed/selection flows sequentially after the peer Docker run, then hands off the changed pin for independent evaluation.

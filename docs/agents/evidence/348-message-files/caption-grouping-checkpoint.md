# Caption and native-reference grouping checkpoint

Date: 2026-10-08. Refs #348 and #336, PR #369. Base application head:
`0dd31f13dd6f4aa8b27ad61b28d90f1123f40812`.

This delta addresses the two additional visual findings from
[the independent review](https://github.com/ColdPhase/flux/pull/369#issuecomment-6056831515):
descriptive captions above photos, and native task cards outside the message bubble.
**It is an implementation checkpoint, not a passed behavioral or visual review.**

## Source changes

- Shared `MessageContent` places the existing photo/grid above its descriptive
  caption. One actual bubble contains body, non-photo file rows, link previews
  and native object references where those consumers already expose them.
- Conversation roots/replies, ThreadRoot, Details and Agents use the shared
  presentation; pending-message consumers keep the same photo-before-caption
  order. Photo-only empty surfaces are hidden. Existing text-only presentation,
  authenticated byte reads, PhotoContext actions, permission predicates and native
  association reads are preserved in the source delta.
- Existing text selectors now select the inner paragraph, while surface geometry
  and outline checks select the real outer bubble. Counts and access assertions
  are retained.
- New browser coverage uses actual source-linked task fixtures for root, thread
  root and reply cards; it checks caption placement across consumers and the
  absence of an empty padded bubble below a captionless photo. DOM mutation
  controls restore the two former layouts, require assertion failure, then restore
  the current layout. Both layout mutation controls executed successfully in the Chromium file-message module during the affected UI run below.

A separate source assessment inspected the frozen 21-file code/test delta and
found no actionable new defect. Its `git diff --binary` SHA-256 was
`ba5b3c95ede5d5dd3490079ed36d1f1a1c5038ce6742ca2d997791e81ad4e114`.
This is not eligible independent PR approval, type checking, or visual evidence.

## Verification boundary

At application head `d5c99322412b4906e082e554963a326a5c021312`, the standard
Compose build/typecheck/lint completed and the affected UI run executed **146 tests:
144 passed, 2 failed** (388.027s; `/tmp/flux369-ui-current.log`). Its nine file-message
methods passed, including actual access revocation and the caption/reference DOM
mutation controls. This is not an all-green affected suite.

The failures were the caption assertion in `test_work_decisions` still searching
for a paragraph outside the new bubble, and the existing `test_project_surface`
assertion checking the row shadow after the moving highlight took over that paint.
The source corrections keep the exact caption/persistence assertion and measure
the visible raised highlight, its alignment and containment. A deliberate removed
shadow must fail the latter assertion. An independent source review found no
weakened requirement; the corrected modules now pass **29/29**,53.002s, including the removed-shadow negative control.

Repository setup/link and whitespace checks pass after these test-only changes.
The earlier 87/87 foundation result belongs to the implementation checkpoint;
it is not a new application result. No product byte-fetch behavior was changed.

Actual WebKit and the two corrected Chromium modules ran sequentially
through the original Compose setup; source is still `d5c99322` plus only the two
reviewed test changes. The temporary adapter verifies the original file-message
module hash, selects the real WebKit engine, preserves assertions and captures
full viewports plus sanitized file/decode diagnostics. Early archive-adapter setup
attempts ran **zero tests** and were cleaned up; their interruption is not a pass.
The log is `/tmp/flux369-current-targeted.log`. Actual WebKit26.5 executed **8 tests:
7 passed,1 failed**,49.469s. Its file bytes/access revocation, desktop/phone both themes,
caption/reference negative controls, offline presentation and touch-size guard pass.
The photo-actions method's interaction assertions finished, but its page-error guard
reported a work-reference-rows access-control error during navigation; that remains
unresolved, not suppressed. The composer DataTransfer/drop method was explicitly
outside this bounded WebKit run. Both runs used flux-ui-1791489577-6980, cleaned its
own resources, and made no product changes.

The earlier WebKit missing-photo report is not resolved. Normal loaded-image
captures show positive natural dimensions, but the new offline full-viewport
capture visibly contains a broken photo. The limited visual review below records
that failure and the own-message caption alignment gap. Its reviewer had prior
implementation context, so this is not the required fresh-context acceptance gate.
Full application checks, fresh independent visual acceptance and Hubert's eligible
current-head approval remain required. No global Docker restart or protected-preview
action occurred.

## Next validation

Run serially in an isolated Compose project, with unique 19xxx ports and at least
12 GB free disk:

1. `./scripts/check_ui.sh test_file_messages test_shared_composer test_instant_send test_agents_view test_work_details test_work_decisions test_adaptive_matrix test_app_shell test_one_conversation test_project_state test_project_surface`.
2. Execute the file-message scenarios in actual WebKit, preserving assertions and
   collecting DOM/network evidence for the reported missing-photo case. This head's
   fixture is Chromium-only; an unset or ignored browser environment variable is
   not WebKit coverage.
3. `./scripts/check_application.sh` to a complete real exit/result.
4. Capture fresh full-viewport light/dark evidence and request a neutral independent
   visual evaluation against F-026 §6. Obtain Hubert's eligible current-head
   functional review and required remote checks before protected merge.

Remaining #348 criteria, missing card/metadata/progress outcomes and integrated
acceptance remain open. No whole-issue or release completion is claimed.

## Captured visual failure and next repair

The [limited visual review](caption-grouping-current/visual-review-limited.md) and
18 actual WebKit full-viewport captures and six inspected Chromium captures are retained in
[the current evidence folder](caption-grouping-current/). This reviewer had prior
implementation context from preparing the wrapper, so this is explicitly **not a
fresh-context visual acceptance gate**. It found a material visible failure:
[offline WebKit](caption-grouping-current/offline-1440-full-1440x900-webkit.png)
shows the pending image as a grey/broken-image tile, while the caption starts far
left of its photo. The equivalent Chromium offline capture also shows the alignment
gap. Normal loaded photos have visible pixels; that does not discharge offline
behavior. The existing offline test checks waiting text and a visible blob element,
not successful decode, so its green result is insufficient for this criterion.

Next repair: add an offline decode/visible-photo control and check own-message
photo/caption alignment, then repair the product and rerun both browsers. Keep the
page-error guard: a separate fixture issue likely comes from loading the project
and immediately hard-navigating before reference rows settle. Source tracing finds
abort/catch fencing in the read store, not proof of an authorization denial. Let
that scenario open its intended surface directly; rerun before claiming this
fixture diagnosis confirmed. Do not filter the error string or call it fixed yet.

A complete application check is running at committed test/evidence head
`1cc086f20f7ea8bd5690e69e26e90a5b2b6623a0`; its runtime source remains `d5c99322`.
Log: `/tmp/flux369-application-current.log`. No final total is claimed until it exits.

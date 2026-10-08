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
  the current layout. These controls have **not been executed** yet.

A separate source assessment inspected the frozen 21-file code/test delta and
found no actionable new defect. Its `git diff --binary` SHA-256 was
`ba5b3c95ede5d5dd3490079ed36d1f1a1c5038ce6742ca2d997791e81ad4e114`.
This is not eligible independent PR approval, type checking, or visual evidence.

## Verification boundary

Completed on this checkpoint: `git diff --check`, repository setup/link checks,
and 87/87 repository foundation tests (18.178s, with `TMPDIR=/private/tmp`).
These do not execute or validate the application runtime. **No application build, lint, typecheck, browser tests, full
application tests, mutation execution or new rendered screenshots are claimed.**

The local Docker engine disappeared during two preceding standard full runs of
PR #370, both ending with exit 125. Bounded Docker version/status reads also timed
out. Heavy execution is parked until a stable engine is available. No global
restart or protected-preview operation has been performed by this agent.

The earlier WebKit missing-photo failure remains **undiagnosed and unresolved**;
the byte-fetch path was not changed speculatively. Existing screenshots and prior
head test counts in this folder do not certify this new layout.

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

# Task feedback ResizeObserver delivery

2026-10-16. Follow-up to #526 in PR #528; independent diagnosis is recorded at
https://github.com/ColdPhase/flux/pull/528#issuecomment-6206033593.

The full Tasks WebKit run at `2ab3d31` failed test 13 cleanup with two
`ResizeObserver loop completed with undelivered notifications.` page errors.
Independent test 01 + 13 controls reproduce the same errors on the pre-#539
`16f7866` baseline and on `2ab3d31`; this is not a new Board retention failure.
The observer registered by `useTaskFeedback` observes `.pane-scroll` and calls
its layout update synchronously. That update changes the observed pane's own
margin and height during ResizeObserver delivery. The diagnostic captures
height 402/margin 68 becoming height 470/empty margin, and height 702/margin 68
becoming height 402/margin 368. Other observed targets did not change.

The bounded repair coalesces resize-triggered writes into the next animation
frame, and cancels a pending callback on teardown. The layout effect still
reserves feedback space immediately when observation/feedback changes. No
page-error filtering, sleeps, timeout changes, or assertion changes were made.

Author WebKit test 01 + 13: 2 tests / 12.968s, assertions and cleanup OK.
Log: `/home/hubert/flux-evidence/539/resize-fixed.log`; numeric wrapper exit and
Compose cleanup are recorded separately in `resize-fixed.exit`. This run uses
`2ab3d31` plus the exact feedback-only patch subsequently committed with this
record. Full-module and final integrated gates remain pending.

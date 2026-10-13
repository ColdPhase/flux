# Phone-shell finding scope audit

The independent visual report is preserved verbatim in `independent-visual-review.md`. It identifies the phone conversation shell in the question-card frame as a required mismatch with F-026: legacy project view chips and a persistent bottom tab bar remain visible. This packet does not relabel that report as an overall phone visual pass.

The mismatch is inherited from #417's base, not introduced by #417. Comparing PR source `dd01f6f667ca9d4253f36f5eedf46cb135bd54ee` with its exact base `fe4e08f0d6ece3e3b2f6ec5482e7826ab2bfec0b` shows no changes to `app/apps/web/src/app/AppLayout.tsx` or `app/apps/web/src/ui/Tabs.tsx`; both are byte-identical to base. `AppLayout.tsx` explicitly says the phone keeps its state line and view chips until the #341 header lands; its phone `BottomNav` remains present.

The owning shell contract is [issue #341](https://github.com/ColdPhase/flux/issues/341), especially AC-3 (no view-chip rows) and AC-4 (full-screen conversation, tab bar hidden). Its implementation is the still-open [PR #414](https://github.com/ColdPhase/flux/pull/414), head `e15873e97a843dc32e944032c9b3a6067c5cfaea`, stacked on #393 and not yet part of main at the time of the #417 capture. #417's own issue #347 asks for the phone conversation header Stop and agent question card; it does not own the shared project shell.

This is a known upstream integration gate, not a #417 implementation regression. The #417 merge does not complete #341 or #347. The fresh visual finding remains valid until #414 is integrated and the phone conversation is reviewed on the integrated head.

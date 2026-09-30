# Independent planning review — Studio 11.1

Date: 2026-09-30. Reviewer: separate `v111_contract_review` agent, fresh context,
read-only; not the intake author. This is independent planning evidence under
`flux-plan-task`, **not an eligible GitHub approval** or production acceptance.
Source: `../provenance.json`; production main `3cd91d798a8767ba8a87ceecde98b49f76aed15a`,
PR #145 `3f02e8668a5f636a02188b1ced9438cfea0bd8d6`, PR #146
`2366243120bdc25f2fea25244ab47670f0156254`.

Verdict: accept the intake with explicit reconciliation and preserve active work.

- Accept Mint / Sky / Copper and independent light/dark selection as the next
  bounded refinement target after #135. Copper broadens the small menu with a
  warm alternative; this is design reasoning, not measured preference or proof
  of visual superiority. Preserve #135's existing criteria/evidence. Migrate
  old single choice into both slots, Iris→Sky, unknown→Mint; system theme selects
  the resolved slot. Final production colors/states still require contrast and
  independent visual/interaction checks. Follow-up: #148.
- Extend #134 with draft-before-save creation and protected inline edits (#149).
  Its `add()` currently writes “New thought” immediately and cancellation retains
  it. Existing inline editing already supports multiline/IME/Enter/Escape;
  preserve that work and add F2/discoverable edit, no records before commit,
  failure/conflict recovery and view-switch continuity.
- Preserve #134's personal ID-only outline over authorized existing links.
  The prototype's stored/inferred `outlineParent` and parent picker that also
  creates a shared relation do not amend production grouping semantics.
- Preserve #133's explicit-only “I have the context” baseline; prototype visit
  updates on navigation conflict with that accepted behavior.
- Keep draft/scroll/camera/focus continuity and phone task navigation in #136;
  avoid another overlapping shell writer. Keep #133 closed, #134/#135 scope and
  ownership intact, and gate final #136 appearance/draft acceptance on #148/#149.
- Label 58 DOM passes and 84 contrast pairs as supplied claims. Only the audit
  and HTML were provided; associated scripts/logs/screenshots were not.

A second read-only content pass accepted the exact #148/#149 task drafts, the
reference README and the reconciliation record with no blocking findings. The
reviewer confirmed dependencies, migration, cancellation/failed-write recovery,
#133/#134 boundaries and the distinction between supplied claims and new
evidence. Eligible GitHub review of the documentation PR remains required.

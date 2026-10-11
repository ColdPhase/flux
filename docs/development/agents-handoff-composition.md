# Agents hand-off: current-main composition

**Accepted bounded implementation contract, 2026-10-11.** This amendment applies
to the existing [PR #376](https://github.com/ColdPhase/flux/pull/376), parent of
[issue #347](https://github.com/ColdPhase/flux/issues/347). The coordinator
independently accepted the source composition plan before production changes.
Planning acceptance supplies no runtime, visual, or merge approval.

Compose parent `c3a378b2a7adba00e5a24f25ebd6b729bf17e523` with accepted main
`6e81027988527aa4b34e4cd7ae0f363b422d6a2b` by a normal merge on the existing
`claude-hubert/347-agents-handoff` branch. Preserve all main capabilities and the
parent's [Prostota](../design/final/README.md) P9/S12 implementation. Do not import
the independently owned Stop/questions or Agents follow-up branches.

## Required composition outcomes

- **C-1 — Connection facts survive.** Main's scoped `currentWork` and open
  `requests` remain visible in the P9 agent row and selected detail. Preserve the
  connection's availability, pending/claimed/paused work state, and each request's
  sender, owner, task, state and reason. Connection work takes precedence over the
  bounded native owner-task fallback in both the text and working/Kreska state;
  pending and paused work cannot inherit a working face from an older task.
- **C-2 — Existing navigation and hand-off survive.** An authorized current-work
  task outside the first choice page opens through the existing scoped native
  read and thread path. Narrow panes preserve Back/forward, wide panes preserve
  side-by-side context, and cross-project/inaccessible targets reveal no thread.
  Preserve the two hand-off steps, the panel's preset agent and task choice,
  bounded pagination and retry, drag and task-detail entries, task version and
  idempotency. A confirmed hand-off persists its native owner and changes no grants.
- **C-3 — Only admitted policy text changes.** The policy row reads exactly:
  “Agents read and propose; people accept. Assistants also edit for their owner,
  with Undo.” Keep the existing policy toggle and static Can text. This follows
  the [authenticated founder comment](https://github.com/ColdPhase/flux/issues/347#issuecomment-6086290338).
  AST-3.5/AST-10.8 assistant admission and permission behavior remain A7 follow-ups.
- **C-4 — Preserve main's verification and migrations.** Retain both changelog
  entries, main's audience helpers and all clean merges. Update only the two newly
  merged adaptive expectations from “Working together” to “Agents”; retain every
  #454 guard. Migration 0062's forward bytes and schema version 72 stay unchanged.

## Evidence required before merge

Exercise actual Chromium and WebKit hand-off/view journeys with explicit,
validated browser selection. Cover pending/claimed/paused work and requests,
current targets beyond the first page, native owner/grant persistence, and
permission/navigation negative controls. Run the appropriate complete application
checks through Docker and the repository setup/whitespace checks. Capture the
drawn desktop/phone views in both themes for a fresh, neutral visual evaluation.
Tie every count and result to the tested current head; older 132-test and
portable 252-test runs are historical evidence only.

Issue #347 remains partial: AC-3/AC-4, Message, richer A7 behavior and integrated
acceptance stay open. The changed head needs fresh independent source/runtime/
visual evaluation and eligible approval before protected-main merge. The author
cannot approve this change, and planning acceptance does not reuse an old review.

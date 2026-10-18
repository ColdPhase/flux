# Preserve ordinary map conflict responses — 2026-10-18

Before code: whole #228 remains Draft #613. The selected
[single-evaluation API check](2026-10-18-single-sketch-evaluation-api/README.md)
passes build/type/lint and 46/50 API cases. Four established assertions fail:
native version conflicts lack `currentVersion/current`, and three stale DM
promotion cases lack the required fresh `preview`. Status/code remain 409.
Do not weaken those assertions or call this complete verification.

The catch in `sketches/routes.ts` clears every DomainError's details in the
enabled lane, even when that native map has no established live room. The
route is byte-identical before the single-pass policy change; no runtime
baseline control was performed. The existing LinkLabelConflict path already
preserves ordinary roomless errors. Default production availability in #613
makes the missing ordinary error contract a required correction in this PR.

For a known sketch ID with no current live room, preserve the original ordinary
DomainError and details, without creating a room/journal. If a room appeared,
retain existing protected/sanitized live behavior. Keep capacity refusal handling,
current authority/session fences, label conflict protection and all budgets.
Do not newly disclose live-room versions, private placement titles or promotion
audiences after a rolled-back transaction without their required authority.
No generic permission bypass, new public contract, cadence or threshold change.

Verify the same selected API set and unchanged four conflict assertions after
this bounded correction. Add a roomless error negative control only if existing
coverage does not establish no room/journal creation; preserve failures and
actual source/runtime. Existing live current-revocation/fence checks must stay
passing. This is author completion of the whole issue, not another review round.

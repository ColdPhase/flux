# Independent actor / deferred-event assessment — issue154, draft PR164

Date:2026-10-01 Europe/Warsaw. Evaluator `/root/review165_cli`; implementation owner PelikanFix16. Applied `flux-review-task`. Read-only clean detached checkout `/tmp/flux-review-154-actors`; no production edits, GitHub approval or merge. Accepted contracts are issue154 AC1–AC5, `docs/development/task-discussions.md`, the independent actor design record and the deferred-event design accepted before implementation.

## Pins and verdict

**PASS for the bounded genuine-actor/deferred-event implementation; whole issue154 remains UNVERIFIED and draft.** The99 affected Docker integration checks ran at `8f4a7892e0dcb1cc42ada6bd3ecad8918b9fcb9f`. The actual Chromium/independent restart checks ran at `2093a8ca69a5eb3523c80ef9eb466fce75324051`; the exact8f→2093 delta is one browser fixture with4 response-wait lines, no production code change. Diff saved separately. This report does not accept a later layout-integrated head without relevant verification.

PR164 remote snapshot remains4f708987429de971d4414d608f0a767fed73e91c/draft at capture; its successful old CI does not certify these local commits. Root will push/integrate the actor head and retain all original acceptance requirements. Eligible independent GitHub approval remains separate from this subagent assessment.

## Bounded criteria and evidence

| Criterion | Result and observed evidence |
| --- | --- |
| Real trusted identity, correlated wire variants, unchanged human payloads | PASS. Agent root is nullable human field plus exact tagged agent ID/name; human replies retain string authorId with no extra author object. Normal conversation get/list, task root/window and receipt returns agree. Client author nomination rejected. Identical human/agent display name remains distinguishable in current browser, Search/Returns/digest. |
| DB actor invariants and history retention | PASS. Real PostgreSQL exactly-one actor, foreign-workspace FK and restrictive historical agent FK cases; actual duplicate per-agent command insertion rejected in independent harness. Existing human/source/time/sequence/fingerprint/search rows compared across33/37 without backfill. |
| Kind-scoped retries, collisions and first-writer serialization | PASS. Real simultaneous human/two-agent first sends, including identical textual human/agent ID and command UUID, retain distinct message IDs and one root/sequence1–3. Uppercase agent/command retry, changed payload/task/operation conflict and bounded root reads pass. Fresh Node/DB process after actual API restart replays the same agent root without a new event. |
| Current rights and genuine historical readers | PASS. Grant loss rejects both new contribution and exact receipt replay; actual global agent revocation also rejects replay. Authorized reader retains unchanged historical root/author/time after both. |
| Affected reader integrations | PASS for exercised paths. Bounded helper DB facts include genuine agent rows; normal conversation/list, exact agent Search, schema-valid export, notification facts, Return question/grouped/digest integrations pass. Agent context marker in processor source audited; actual external-model/client execution is not certified. |
| Actual worker audience/author semantics | PASS. Independent real worker emits an addressed agent question and separate pure mention with `Casey Human (agent)` label. Owning the agent creates no extra notification for its sequence1 root; later real human participation remains distinct. |
| Deferred final event storage and atomicity | PASS. Two genuine contributions have canonical IDs before stream lock, all current-state audiences prepare before first event insert, pre-flush grant removal affects both, explicit flush promise is reused, closed session rejects further actions, replay emits no event. Premature flush while an admitted async action is active rejects before closure. Real outer exceptions before/after flush roll back binding/messages/sequence/search/events/derived outbox. |
| Current actual browser behavior | PASS. Mounted independent fixture uses `Casey Human` for both human owner and agent while retaining current2093 application source. Real human reply waits for HTTP201 before persisted read; exact actor/root/time, reload deduplication, no agent DM link, human link and1280/390 authorized reader history pass. |
| Separate neutral visual assessment | UNVERIFIED by this evaluator. Actual2093 screenshots and neutral brief delivered for a fresh visual reviewer; screenshots alone are not behavioral/accessibility/device acceptance. |
| Actual153 coordination receipt/session/lease integration | UNVERIFIED. Current tests simulate outer failure and final audience change, not a real153 resolution/claim/durable receipt/outgoing-intent flow.152 authenticated operation/class/audience and current grants must still precede domain effects/replay. |

## Commands and provenance

- Docker build/type/lint plus12 affected integration files with test-file concurrency3: **99/99 PASS**, no skipped/failed cases. Within-test race/security cases and production deadlines unchanged. Runner `/tmp/flux154-independent-actors-8f4a789.sh`, log `/tmp/flux154-independent-actors-8f4a789.log`. This bounded command did not run the entire application/architecture/PWA suite; root's broader checks remain separately attributed.
- Fresh2093 Docker build/type/lint + actual actor Chromium: **1/1 PASS** in2.803s; screenshot files below. The overall runner later failed only my independent harness's incorrect expected reason (`mention` instead of existing higher-priority addressed `question`); that attempt is retained as EXIT1. Log `/tmp/flux154-independent-browser-restart-2093a8c.log`.
- Corrected independent restart-only retry: **EXIT0**, fresh process/API restart, exact root/receipt/history, kind-safe identical names, SQL uniqueness, Search/Return/digest, actual worker question+pure mention, no fabricated owner notification, grant/global revocation and unchanged old rows. Also existing session/material/linked-conversation restart passes. Runner `/tmp/flux154-independent-restart-2093a8c-retry1.sh`, log `/tmp/flux154-independent-restart-2093a8c-retry1.log`.
- All run-owned Docker projects/volumes/image tags cleaned through supported scoped cleanup. No peer worktree/resource edits. External harnesses were mounted under `/app/tests` only; no production checkout mutation. The same-name browser fixture changes only an agent fixture display name.

Earlier ac1527 build failed on missing SearchRowRecord.author; fixed at2ae9bfa, whose98 affected integration checks passed. Earlier browser fixture invalid-email setup and optimistic-before-commit read were corrected by the owner. Those failed attempts retain their original pins/status and are not relabeled passes. The final source/data paths and fresh tests above account for each finding.

## Original issue criteria remain open

AC1 current ordinary task notices and human/agent text commands have relevant evidence, but whole-entry-point/API/helper/MCP/import acceptance is not complete. AC2 text/real material citations and one canonical sequence are tested; attachment-only, blocker, result and public-handoff publication remain required. AC3 current text/outer-event rollback and no partial state pass; recoverable staged files/shared drafts and safe unused-AI task undo remain required. AC4 actual historical forward rows pass; compatible guarded pre-use reversal/refusal after agent/file use and pending migration composition orders remain required. AC5 current conversation/API/DB/browser evidence passes; integrated136 Conversation/Tasks/Map/Agents shared identity/drafts, all entry types and actual supported MCP clients remain required.

No physical Android/iPhone/iPad installation/push, provider/release or whole application acceptance is inferred. Do not approve or merge whole PR164 from this bounded report.

## Visual handoff and next action

Actual screenshots: `/tmp/flux154-independent-actor-ui/agent-root-desktop.png` and `mixed-authors-reader-1280.png` are1280×900; `mixed-authors-reader-390.png` is390×900, Chromium100% zoom. All tied to2093a8c. Neutral fresh-review brief: `/tmp/flux154-actor-visual-brief.md`. Independent accepted deferred-event design: `/tmp/flux154-deferred-events-design-peer.md`.

Root should complete/integrate the accepted layout and remaining154 outcomes, preserve pins and obtain relevant fresh checks plus neutral visual/eligible peer review before full acceptance. Full logs may include generated test credentials; retain private and publish only sanitized summaries.

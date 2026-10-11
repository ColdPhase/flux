# Task agent threads — #400 / F-018 CW-2

**Status:** planning contract accepted 2026-10-11 by [independent review](https://github.com/ColdPhase/flux/issues/400#issuecomment-6103349693). Proposal SHA256 `a0341987fe6c02461f8e95859bc3d6a38ff7e5e567464f054b6f92b29000029d`; exact full-body SHA256 `414f9817c9a530681e55963294eac66913265b26855822c724cccb2b386ac370`.

Implementation starts from main `056be60f77996d938ee682663bf3a56f0d7a6d7b`, branch `codex/400-agent-threads`, owner PelikanFix16 and independent evaluator Zamojski5. This accepts planning and the partial increment below, not code, the public EXT-1 transition, full #400 or release delivery. All parent criteria and named remaining gates stay open until actual pinned evidence and independent acceptance.

The exact accepted issue contract follows. Its previously proposed wording is superseded only as planning status by the acceptance above.

**Founder direction (Hubert, 2026-10-09):** agent-to-agent conversation lives only in the Agents tab. Contract: the CW-2 revision in #399 (`docs/product/cowork-workflow.md`). Durable requests, their states and the no-loss rules are unchanged.

**Outcome.**
- Agents talk about work in one **agent thread per task**, opened from the project's Agents tab.
- Every person who can read the task can read the thread. People with the normal project write permission can post; viewers remain read-only. The thread grants no additional task, project, agent or private-source authority.
- People's conversations, task threads, Home and Inbox show only one-line outcome notices that link to the agents' thread.
- No agent work message is lost, hidden or duplicated.

**Acceptance criteria**
- **AC-1 Storage.**
  - Migration `0082_agent_threads` (additive, with a reverse):
    - `project_conversations.space text not null default 'people' check (space in ('people','agents'))`;
    - `project_conversations.work_id uuid null references project_work_items(id)`;
    - `check ((space='agents') = (work_id is not null))`;
    - a unique partial index on `(work_id) where space='agents'`.
  - `FLUX_SCHEMA_VERSION` equals the highest numbered migration actually present, including 0082. The reserved file remains `0082_agent_threads`; no second reservation. The reverse refuses while an agents-space conversation exists and leaves the schema ledger to the existing reversal runner.
  - The thread is created on the first post; concurrent first posts create one thread.
  - Its audience is the task's project, under the same current access checks as the task.
- **AC-2 Quiet for people.**
  - Agent threads are excluded from conversation lists, unread counts, "Since you left", Home, Inbox counts and push.
  - Exception: a question or request addressed to a person still reaches that person's "Needs you".
  - Search includes them, labelled `Agents' thread · #12`.
  - Export includes them through an additive field (O-010 EXT-2).
- **AC-3 MCP.** New tools require the O-010 EXT-1 snapshot/compatibility gate; all requirements below remain open until implemented and independently accepted:
  - `flux_post_agent_thread {projectId, taskId, body, clientCommandId, replyToMessageId?}`, under `conversation.reply`;
  - `flux_get_agent_thread {taskId, beforeSequence?, afterSequence?}`, under `flux.context.read`, at most 50 messages per page;
  - `flux_ask_question` accepts the agent thread.
  - **Refusal:** an agent's `flux_reply_in_conversation` into a people's conversation returns `AGENT_THREAD_REQUIRED`, unless it replies to a person who addressed that agent. Results, proposed decisions and questions to people stay allowed.
  - Before introducing that refusal, @Zamojski5 must explicitly accept the EXT-1 compatibility/version transition. Until then preserve existing contract-1 reply behavior for people conversations. Adding a new tool alone does not authorize rejecting an existing tool call; the required final refusal is deferred, not removed.
- **AC-4 Requests as cards** (needs the #153 request tools).
  - Each help, review, fix or hand-off request shows as a card read from the durable record: kind, sender → recipient, target (task, PR and short SHA, or result version), and the state in plain words.
  - Until #153 exposes these tools, AC-4 stays visibly pending.
- **AC-5 Outcome notices.** One line composed from records, never model-written; several in a row fold together. The notices:
  - result card + `See the agents' thread`;
  - `Codex finished #12 · review passed (Claude Code)`;
  - `Claude Code is blocked on #14: <blocker>`;
  - `Claude Code asks Ada about #14 · Answer`.

  Plans, progress, agent-to-agent replies, claims and heartbeats never appear in people's views.
- **AC-6 Agents tab.** The final design's components, no new screen.
  - The thread opens in the detail panel (computer) or the sheet (phone), from the agent's Now card, its row, the Requests row, or the task Details link `Agents' thread · N messages`.
  - Composer placeholder: `Write to the agents…`.
  - A person's message notifies only the people it mentions.
- **AC-7 Playbook `flux.cowork` 1.4.0** (#160).
  - Agents write work talk with `flux_post_agent_thread`, and read the thread from the recorded sequence on resume.
  - One message per meaningful step.
  - **Server loop guard:** at most 5 consecutive agent messages without a person's message, a new artifact version or a request state change (`AGENT_THREAD_TURN_LIMIT`).
- **AC-8 History.** Existing agent messages stay where they are.
- **AC-9 Evidence.**
  - Docker app tests:
    - the migration: fresh, upgrade, reverse and refusal;
    - one thread under concurrent first posts;
    - access: a non-reader gets 404, and a viewer can read but not post;
    - exclusions and inclusions;
    - `AGENT_THREAD_REQUIRED`;
    - the turn limit;
    - notice composition;
    - idempotent retries.
  - UI tests at 1440×900 and 390×844, light and dark, with negative controls.
  - The #396 real-client harness with a mock model, for Claude Code and Codex.

**Dependencies:**
- the #347 Agents tab fix PR (`claude-hubert/347-agents-tab-fixes`);
- #153 for AC-4 and the review verdicts;
- #160 for AC-7;
- #154's actor-aware contribution;
- O-010 EXT-1/EXT-2.

**Migration:** `0082` is already reserved for #400 in #153 ([reservation](https://github.com/ColdPhase/flux/issues/153#issuecomment-6088489482)); preserve it. The highest-file schema rule applies during composition.

**Ownership:**
- Storage, API, notices and UI: @PelikanFix16.
- AC-4 request cards: @Zamojski5 under #153.
- Each part's evaluator is the other.

**Out of scope:** model-written "Catch me up" summaries, moving old messages, and a separate list of active threads.


**Role/privacy clarification proposed for independent acceptance.** Posting uses the same current project write check as ordinary conversation posting. Non-readers get 404; viewers get a read-only thread and 403 on posting; contributors/managers may post only while their current access permits it. Agent effects also require the current connection, owner, selected-project scope, native operation/class grant and source checks. The actual task determines the project/workspace/audience; a caller-supplied mismatched project cannot redirect or broaden the post. Task-targeted posts participate atomically in the shared task-use/Undo lock and usage latch, including composition with pending #238/#394; do not introduce a parallel usage flag or bypass their ordering. Revocation applies before paging, counts, snippets and effects. Shared agent threads do not copy private helper prompts/output, DMs, recipient-only request packets or private GitHub outbox facts. A referenced request/artifact needs its own current-reader check before projecting title/ID/SHA/version/body; inaccessible facts are not manufactured or declassified. Quiet thread messages do not create project unread or follower notifications. Existing AC-6 explicit human mentions may address only current authorized task readers and notify only those recipients; questions/requests keep the existing Needs-you path. History and native authorship remain intact.

**First implementation increment (partial; not full #400 acceptance).** Storage and normal access, quiet read/event projections, search/export and a reusable thread panel/sheet reached from task Details. Use the existing final-design composer/detail surfaces; no new thread-list screen. The task Details entry can be delivered independently of #417; the Now/agent/Requests entry points remain pending its accepted integration. Existing actor-aware conversation primitives provide human/agent authorship; no new #153 request store or request-publication authority. No public MCP registration/old-tool refusal or #160 playbook edit in this increment. Before any agent writer becomes reachable in the new agents space, AC-7’s server five-turn guard and authoritative human/artifact/request resets must be verified. Otherwise every new-space agent write path stays explicitly fail-closed, including existing generic reply endpoints targeting that space. Human storage/UI may proceed under normal project write; existing people-space v1 reply behavior stays unchanged. Generic existing replies retain people-conversation behavior. New internal endpoints/component seams do not certify AC-3 public transport or AC-7 supplied instructions. All nine parent criteria remain requirements and the issue stays open.

**Acceptance for this increment, mapped to the full criteria.**
- AC-1/AC-8: fresh/upgrade/default-people preservation, one thread under concurrent first posts, exact human/agent authors, same-key same-input retry, changed-input conflict, no GET/open/render writes, reversal success before agent threads and refusal afterward, no history rewrite, exact migration ledger. Test mismatched project/task pairs and derive permissions from the locked real task. Race first/retried post against unused-task Undo with the shared lock/latch: post-winning use prevents Undo; Undo-winning removal prevents any new thread/message; rejected/rolled-back posts leave no usage latch or partial write. Verify the composed #238/#394 integration before its acceptance.
- AC-1/AC-2/AC-6/AC-9: live contributor/viewer/non-reader plus revoked reader/writer checks on API, paging, thread counts and UI; same task/project audience; no private-source or recipient-only metadata disclosure. Task Details opens one existing detail panel or phone sheet, viewer has no active composer, writer can post and recover a refused/retried draft.
- AC-2/AC-9: three progress posts leave people lists, roots, unread/Since-you-left, Home/Inbox and push unchanged; search finds only currently visible thread messages with `Agents’ thread · #12`, with counts/ranking/page limits after access. Legitimate explicit human mentions/questions reach only their currently authorized recipients. Do not fabricate review outcomes from unexposed request records.
- AC-2/AC-9/EXT-2: an additive `agentThreads` field in export format 1, same REPEATABLE READ snapshot and project.manage/no-store contract, unchanged legacy conversations/history and bundle identifiers. Update the existing v1 snapshot only for additive output changes, retain old-reader compatibility tests and export privacy/file checks; stop for a peer decision if the actual diff is breaking.
- AC-7/AC-9 safety before agent exposure: exercise every new-space agent writer, including generic reply paths. Either verify five turns, refusal of the sixth, authoritative resets and concurrent/idempotent retry behavior, or prove all those agent paths fail closed without an effect. Never treat an unfinished playbook adapter as permission for an unlimited agent loop.
- AC-6/AC-9: real Docker Chromium/WebKit at 1440×900 and 390×844, light/dark, with negative controls and a separate neutral visual review for the new task-Details thread view. No simulated readiness of #153 cards, review notices, playbook 1.4 or real supported clients.

**Still required after this increment.** AC-3 new MCP tools/question integration and explicit accepted legacy-reply version transition; AC-4 durable request cards and production #153 response/publication adapters; AC-5 complete record-composed outcome/review notices; AC-6 Now/agent/Requests row entry integration with #417; AC-7 playbook 1.4/resume/real instruction loading plus the server turn guard across authorized writers and authoritative human/artifact/request resets; AC-9 real Claude Code and Codex post/read journeys using the #396 harness, with current #460/#470 compatibility limits stated. The complete application, integrated privacy/revocation and release gates remain open. No requirement is counted done by this proposal.

## Implementation checkpoint — 2026-10-11 (partial, not acceptance)

The isolated branch is `codex/400-agent-threads`, owned by PelikanFix16. The initial PR must be stacked on `claude-hubert/238-unused-ai-undo` (#394), whose composed dependency pin is `e1173082fc0707d57b13b2b882f3870023b1e1ae`. Its shared task-use/Undo helper is consumed through normal merge, not copied. Protected-main merge remains blocked on #394's independent acceptance/merge and the current increment's independent code/visual review. The whole #400 issue stays open.

Actual application/test pin `b2bbfaadfae7451b85403d63e49f81b5671a1c6e`:

- Docker's trusted build/type/lint passed, with three existing hook warnings. The test image matched all 1,132 tracked application files byte for byte.
- 23/23 selected API/export/extension-contract tests passed. The 13 thread cases include concurrent first posts, idempotent retry/conflict, actual-task/project scope, viewer/non-reader/revoked access, read-only repeatable-read count/page/actor/file consistency under a real intervening post and grant revocation, closed OAuth agent replies plus unchanged v1 people replies, upgrade/reversal/history/ledger controls, three quiet progress posts, authorized mention/no unauthorized recipient, export/legacy-reader controls, both forced orders of the real shared post↔Undo lock race and complete rollback of thread/message/event/use latch.
- 2/2 Chromium and 2/2 WebKit browser tests passed. Each engine exercised 1440×900 and 390×844, genuine contributor/viewer accounts, task-Details entry and return focus, private draft retention, actual posting, light/dark rendering, an exact message beyond the latest 50, an intercepted real stored acknowledgment with the exact command/receipt retry, a real 403 restoring text, viewer downgrade and denied access. The route-barrier browser contexts explicitly block service workers; these are not PWA-delivery tests.
- The export classifier reported exactly three additive format-1 changes: `agentThread` definition, `agentThreads` property and its required-field guarantee. Every previous schema definition/property stayed identical. EXT-1's current snapshot still passes; no public tool/version/reply behavior is changed.

Earlier attempts remain separate: `2a81c0d6b0b02b991526475004cb7118020ed53a` had 32/32 API/migration/canonical-discussion checks; the next selected cohort had 40/42, with a wrong test-fixture preference HTTP method and the expected additive export snapshot update. Both were corrected before the 23/23 result above. Two intermediate new-UI builds stopped at type/lint issues before executing any tests; they are not successful runs. Broader search/returns regression checks passed in that 40/42 attempt, with no later search/returns source changes. No full application/release, physical device, real vendor account or complete #400 pass is claimed.

Local evidence (also described in the PR handoff): `/tmp/flux-400-increment.log`, `/tmp/flux-400-b2-source-equivalence.json`, `/tmp/flux-400-compose-equivalence.json`, `/tmp/flux-400-renders/manifest.json` and `/tmp/flux-400-neutral-visual-brief.md`. The scoped driver used the trusted `check_application.sh` setup/build/cleanup and original source/test Compose configuration, only selecting the four maintained API suites and the two engine invocations of `agent-threads.e2e.ts`. Test-only IPAM uses 10.197.240/241/242.0/24; normalized Compose configuration is equal after removing only IPAM. Ports19830/19831 and tagged volumes/images/networks are isolated and cleaned after the terminal run.

Remaining full-outcome gates: AC-3 public post/get/question tools and an independently accepted EXT-1 compatibility/version transition; AC-4 request/artifact cards and their own-reader privacy projections (#153); AC-5 one-line outcome notices; the other AC-6 Now/agent/Requests entry points (#417); AC-7's authoritative five-turn guard/resets, playbook1.4/instructions and actual supported-client delivery (#160 and current client contracts); corresponding full AC-8/AC-9 integration/privacy/PWA evidence. All agent writer paths into the new space stay closed until the guard is verified. Native agent authorship is supported by storage but no new-space agent execution is exposed or simulated as delivery. Separate neutral visual and independent code evaluation of this partial increment are pending.

### Appearance corrections and new UI evidence

Independent appearance review of the b2 capture required two corrections: preserve the author/content column and keep the compact composer at the bottom of the thread surface. The earlier refused WebKit capture showed history only and could not certify that state. No visual pass was granted. The author corrected only `AgentThread.tsx`, `work.css` and its maintained E2E file; every API/core/DB/contract/API-test file is byte-identical to the passed b2 checkpoint.

Actual new UI/source pin `ddbe446a335d5bd091a28c3905445450f0dc0060` passed the trusted Docker build/type/lint (same three existing warnings) and **3/3 Chromium plus 3/3 WebKit**. The original functional scenarios remain, now joined by actual bounds/alignment/action checks with short and long persisted history, a capped multiline private draft, genuine file select/upload/post/download, 1440×900, 390×844, narrow touch 320×568 and a reduced visible viewport 390×480. The latter is a short viewport check, not a physical keyboard claim. The 32 px avatar and the 12/10 px author/content gap are measured in the rendered app. Composer textarea/actions stay inside the visible surface, without blank space underneath; first/last history and the long field remain separately reachable. Draft/refusal/retry, viewer/revocation and old v1 behavior are preserved. The route-barrier contexts still explicitly block service workers. New captures show the actual refused draft/notice/action in both engines.

Attempts remain distinct: the first ce1 UI attempt built successfully but Chromium 0/3 stopped at a new test helper's browser-realm `__name` error (WebKit not run). The b209 attempt had Chromium 2/3; its geometry observation caught the incoming sheet transform before the entrance finished (WebKit not run). The ddbe helper waits for the **real** sheet animation to finish, with product motion and the same geometry/assertion bounds intact; narrow 320 uses the actual mobile/touch context. The resulting 3/3-per-engine run terminated with driver exit 0. No earlier failing attempt is relabelled as success.

New local evidence: `/tmp/flux-400-ui-layout-v3.log`, `/tmp/flux-400-ddbe-source-equivalence.json` (all 1,132 tracked app files match the actual image; unchanged backend/API-test groups explicitly verified), `/tmp/flux-400-layout-renders-v3/manifest.json` (18 PNGs, metadata only) and `/tmp/flux-400-ddbe-neutral-visual-brief.md`. All owned stacks, volumes, networks, tagged images and the extra hash-check container from the attempts are cleaned. The latest source requires a new neutral visual evaluation and eligible independent code review; the b2 review and exact 99's earlier lightweight CI/255 portable tests do not approve it. Every full-outcome/dependency gate above remains open.

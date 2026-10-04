# Retained unused AI-task creation Undo (#238)

Accepted contract and independent assessment are preserved verbatim beside this record. Parent #154 remains open. Migration0048 is reserved by child #238;0045 files,0046 wiki and0047 maps retain their existing owners.

## Source composition before implementation

Author: PelikanFix16 on `codex-hubert/238-unused-ai-undo`, dedicated checkout `.worktrees/238-unused-ai-undo`. Initial source b37d808f31f661d8cec2f57190304d390eca56b7 (ready PR229) remains unchanged. This child merges current main7f103e7f325750448ad8c6a080f0bfac8a218968 and exact PR1668655a3cacf44ca53219481ae611ae8c1e126d88c. Composition commit: **e2ff3a01a0cea1091b85d3169e5cca714e4ef76f**, tree **413fdebff4a8def410e1aa32a320c8e1028cf942**. Incorporating166 does not establish independent acceptance of that source. Main's account-scoped remembered navigation, touch Enter, project access and policy changes coexist with229's chronological stream/shared composer/files. The only166 conflict combined the schema imports;0035 coordination,0044 policy and0045 files coexist, maximum45. No old migration is edited.

## Writer and lock inventory (implementation targets)

Every persisted target joins the caller's transaction. Order: current authority → durable command/material/source → connection slots → sorted project graphs → one complete sorted task set → coordination/conversation/domain rows → one final all-audience event batch. `taskUseRows(tx)` provides the common lifecycle check and monotonic latch; it performs no authorization, transaction, event flush or independent commit. Latches are written only for successful effects, so transaction rollback removes them. Reads, receipt observation, ACK and drafts never mark use. No historical row is inferred unused.

| Writer | Complete task set | Required persisted effect |
| --- | --- | --- |
| Work create | all existing work sources/related/prerequisites | mark existing targets; own baseline links/notice/plan stay creation provenance |
| Work update/dependency replace | own task plus previous and replacement prerequisites and relevant finish prerequisites | latch changed task and all removed/new dependency targets |
| Result | linked work plus finish prerequisites | result publication and canonical contributions |
| Discussion/conversation reply | bound task plus any referenced work | actual authored text/file/blocker/result/handoff |
| Generic object links | both work endpoints | saved related/source/about/affects link |
| Decisions/pivots | all affected/still-applies/park task IDs | proposal/acceptance/parking |
| Wiki save | previous and replacement work mentions | saved document version and links |
| Private helper/proactive | every persisted work context/reference/target | run/proposal/reference creation; no public private content |
| GitHub | every PR/work binding target | saved binding, no new target to a tombstone |
| Live sessions/presentations | all work anchors/targets | saved session/presentation/native contextual use |
|153 units/claims | units, lineage, all work sources across involved projects | unit creation and claim/renew/release effects |
|153 requests/checkpoints | unit, lineage, source/target work | successful enqueue/checkpoint; read/replay/ACK unchanged |

## Required integration and evidence gates

Live-editing228 source is not composed yet. Its author must use this common seam; no complete integrated acceptance is claimed before its exact source and writer races are exercised. Baseline admission requires coverage of every actual writer of the tested composition. New writers must join this seam before task targeting is enabled. Actual Docker API/SQL/race/UI/notification/migration/restart/paired-restore checks and independent head-specific review remain required. Physical-device evidence is never inferred from phone viewports.

## Exact shared persistence interface

`taskUseRows(tx: DbExecutor)` is exported by `@flux/db`. The supplied executor must be the caller's already-open transaction. `prepare(ids: readonly string[]): Promise<TaskUseFence>` reads project identities without row locks, locks each distinct `flux.task-graph:<projectId>` in ascending order, then locks every distinct task ID in ONE ascending pass. It rejects any missing or creation-reverted task. `lockPrepared(ids)` performs only that one task pass; its caller must already hold the complete graph/material/connection set, so it never reacquires an upstream lock after tasks. Do not call `prepare` after any task or coordination row lock. Gather removed/replacement dependency or document targets, all unit/lineage tasks and all typed work sources/targets BEFORE either method. Existing graph owners use `lockPrepared` exactly once after their complete preparation.

The returned fence has readonly `ids` and `projectIds`, and `mark(ids?: readonly string[]): Promise<void>` (defaults to all retained IDs). `mark` accepts only IDs in that exact fence and writes the monotonic first-use timestamp without acquiring another task set. Call it after the successful persisted effect and before events; failures must escape so the caller rolls everything back. Replayed observations and pure ACK never call it. Identity existence and active lifecycle are rechecked under the retained task locks. This interface supplies no actor authority or grant. Undo takes the same graph/task fence but deliberately does not mark use.


## First implementation checkpoint (unverified)

The author has implemented additive0048 lifecycle/baseline/monotonic-use/receipt storage, the native Undo command and exact agent operation, committed proposal-use provenance, cache-replay reversion checks, history projection, active consumer filtering, notifications and Details UI. The common retained fence is integrated into current work/dependency/decision/result/link/discussion, saved doc references/source sections, helper dispatch/commit, proactive reservation/context, PR-link and live session/admission/presentation writers.153 unit storage replaces its original task pass at the accepted preparation callback, carries the fence into successful saves/checkpoints, and provides a reusable fenced unit insert; request enqueue accepts the caller's retained fence or prepares before domain rows for isolated storage callers. Public153 request/unit creation/checkpoint orchestration is still disabled in the admitted source and remains a future writer integration gate, not runtime evidence.

`prepareReferencedTaskUse(tx, projectId, refs)` is exported by `@flux/db` as a companion to the unchanged `taskUseRows` shape. It retains the known project graph before discovering typed work/result/decision/message/conversation/PR associations and taking one `lockPrepared` pass. It never scans arbitrary JSON. Current authorization/material/connection providers must run before it; the session/run/unit/document writer retains the returned fence and marks only actual successful effects. Co-work callers already owning the complete graph/task fence pass it explicitly rather than re-preparing. The unchanged seam SHA256 is b293ff4ea70045d0937246d0a6e62901af570f942a1476d6426205569938c3b0; the independent source assessment is recorded in the adjacent `seam-review.md`.

Actual Docker compilation, lint, schema application and regression/race/browser checks have not run. The machine's serial heavy-Docker slot is reserved by the root coordinator; #239's new editing writers must be composed and tested against this interface. This checkpoint does not close any acceptance criterion or establish that all writer families are runtime ready. Baselines must not be admitted as complete historical proof until the final composed writer coverage is independently verified.

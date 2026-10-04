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

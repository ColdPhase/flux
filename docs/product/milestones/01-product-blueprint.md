# Milestone 1 — Decisions that enable implementation

## Final design — F-026 (2026-10-07)

The [final design "Prostota"](../../design/final/README.md) is the only UI and UX on the
computer and the phone. It is a founder direction: agents implement it as drawn and do not
re-decide it. [#336](https://github.com/ColdPhase/flux/issues/336) lists the implementation
issues. It governs every appearance or placement statement in this brief.

## Required additions — F-016 (2026-09-30)

[Local MCP co-work](../mcp-cowork.md) governs the new feature. Flux owns the single task/thread, GitHub supplies PR/CI facts through project
bindings (#74), several external agents may belong to one person, and standing
owner grants allow cooperation without routine approval prompts. Keep the
embedded helper, existing Node stack, tenant/project access and review gates.

The [delivery table](../mcp-cowork.md#delivery-and-evidence--co-5) maps connection,
co-work, task-thread and motion/presence slices. #336 owns the UI, #151
phone-to-ultrawide and #149 map drafts. Required evidence includes
real two-owner/three-connection work, task/PR/result review, no duplicate backlog,
revocation/reconnect, deterministic board rules/manual override, two-user typing,
all no-AI journeys and F-015/#20 device gates. Active owners and reviews stay;
independent ready work continues while dependencies finish. Earlier direction
below is historical where superseded. No production completion is claimed here.

Status: **agents decide and proceed**. Read the complete
[foundation](../FLUX-FOUNDATION.md) and the later [founder delegation](../autonomy.md).
There is no founder acceptance step for product, stack or implementation scope; the UI and
UX are the founders' final design (F-026).
The later [creative collaboration direction](https://github.com/ColdPhase/flux/issues/44)
governs the three integrated creative scenarios. The appearance is the
[final design](../../design/final/README.md); use its screens and rules for work.
Do not restart visual exploration.

The later [F-015 adaptive-workspace requirement](../../design/adaptive-workspaces.md)
adds smart small-phone through 4K/ultrawide layouts and familiar cross-device
workflows. #151 in milestone 2 implements it with #336; concrete compositions
and performance budgets are independently reviewed without reopening the stack.

Preserve and resume #8 (segment/persona) and #9 (own-AI feasibility), their accepted
research criteria, branches and evidence. Replace their old request for a founder
decision with an agent decision and independent peer evaluation. Do not recreate
the tasks or renegotiate unchanged criteria after a restart.

## Produce decisions and usable artifacts

- Select the first segment/persona and defensible USP hypotheses using evidence.
- Establish product vocabulary and integrated human/agent journeys.
- Apply the final design and independently review the result on realistic UI.
- Select architecture, stack, access/data boundaries and extension contracts.
  Start with a concise decision sufficient for the next real coding tasks.
- Determine feasible own-AI paths, preserving uncertainty and provider constraints.
- Maintain the implementation specification, full-product coverage matrix and
  dependency order, including installation, validation and final delivery.

The independent peer accepts significant decisions and the agents record them in
the decision register. They choose the best-supported practical solution and move
to implementation. Research can continue alongside coding where it is independent.

## Handoff to implementation

The [working-application milestone](02-working-application.md) is already
authorized. Create and assign its first coding tasks immediately after their
specific architecture/interface decisions are recorded. Both workers may select
ready tasks across the roadmap; milestone 1 does not have to close first.

Use Docker/Compose for experiments and application tooling. Keep PR Actions light
and reserve release packaging for the completed application. Record blockers,
ask the peer for help, and continue other work.

Close this milestone after its decision artifacts are consistent and independently
reviewed. Its closure is an intermediate checkpoint; continue through the
application milestones until the full product is verified and delivered.

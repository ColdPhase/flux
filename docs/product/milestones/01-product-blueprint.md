# Milestone 1 — Flux product blueprint

Status: **authorized preparation of proposals**. Entry point: the corresponding
GitHub milestone and this brief. Source: the complete
[founder foundation v0.2](../FLUX-FOUNDATION.md). No application stack, first
release scope, palette, or commercial promise is accepted by this brief.

## Outcome

Turn the founder's ambition into a coherent, evidence-backed product direction
and an executable proposal for the first working release. Preserve the full
ambition; define sequencing and dependencies rather than building an unrelated
demo. Founders accept the significant choices identified in the
[decision register](../decisions.md) as recommendations become reviewable.

## Work that agents may create

Workers create bounded issues inside this milestone, assign one implementation
owner and an independent evaluator, and agree on criteria in the issue comments.
Start with a small number of useful parallel outcomes, then split work when a
real dependency or verification need appears. Reuse existing issues/PRs.

| Outcome | Required evidence |
| --- | --- |
| Primary segment, persona, and USP hypotheses | Concrete situations and alternatives, dated sources, disconfirming evidence, founder decision request |
| Product language and integrated journeys | People and agents, conversation-to-result continuity, return/handoff, private/shared state, failure and no-AI behavior |
| Visual direction and working-view proposals | Comparable realistic variants, density observations, independent visual findings, separately reported interaction checks |
| Architecture and extension proposal | Compared stack options, domain/access/data boundaries, collaboration, jobs/recovery, Docker/Compose development and CI, deployment/update/export costs |
| Own-AI feasibility matrix | External agent vs embedded runtime vs API/local modes, primary sources, date, authentication, billing and capability limits |
| First release proposal | Coherent scope, dependencies, observable acceptance scenarios, candidate validation/packaging pipeline, unresolved decisions and owners |

This list defines outcomes, not an obligation to create one issue per row. One
worker integrates the vocabulary and cross-document decisions; that role does
not remove independent review or grant authority over founder decisions.

## Autonomy and boundaries

- Research, task creation/assignment, negotiation, local prototypes needed for
  comparison, documentation PRs, review, and in-scope corrections are authorized.
- Use the shared workflow and preserve source/evidence provenance. Do not treat
  uncertain claims in the imported foundation as fresh verified research.
- Proposals may include experiments but must distinguish them from production
  implementations. Preserve the existing prototype unless a task calls for change.
- Founder business choices, license changes, paid commitments, production data,
  live deployment, and publishing an application release are outside this scope.
- PR approval may come from the eligible independent peer. Merging follows the
  manifest and existing GitHub rules. A favorable review is not founder adoption
  of a proposed stack, product promise, or palette.
- Application tooling/services/tests use [Docker/Compose](../../development/containers.md),
  with isolated task data and no host installation of PostgreSQL or Redis.
- Try to resolve blockers together. Record attempts and the unblock condition
  in the affected issue, park it, and continue independent work. Return after
  new evidence and before final acceptance; required work cannot be silently dropped.

## Acceptance

Every outcome above has an artifact, author, independent review, dated evidence,
and clearly marked decisions. The materials agree on terminology and do not
claim that proposed features already exist. Founders record decisions needed for
the first release; unresolved optional ideas stay visible without blocking it.

The resulting application milestone has an accepted scope, verification plan,
delivery formats, and the authority needed for implementation. Required checks
and build/package commands are introduced with the actual stack and exercised
before becoming release gates. Closing this planning milestone does not mean
that the Flux application is finished or released.

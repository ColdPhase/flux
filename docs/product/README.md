# Product direction

Flux is an open source, self-hostable workspace in which people and agents can
keep conversations, decisions, work, and results connected. Human collaboration
must remain useful when AI is unavailable. The ambition is a global product,
starting with innovators and developing toward enterprise use.

## Source of truth

[FLUX-FOUNDATION.md](FLUX-FOUNDATION.md) is the **complete founder-supplied Polish
document**, version 0.2, 27 September 2026. It is preserved as supplied, including
its dated research notes. Importing it does not independently verify those notes.
Recheck changing provider capabilities, commercial terms, and technical sources
when a task depends on them. The book, conversations, and visual references
mentioned there are not all included in this repository; do not claim to have
read or seen an unavailable source.

Read the full foundation when first joining the project. Later, load this short
guide, the [decision register](decisions.md), and only the relevant sections.
Public engineering documents and new product copy should be in English. The
Polish foundation remains the original source, not a second competing roadmap.

## Current authority

The [later founder delegation](autonomy.md) authorizes agents to choose and accept
product, stack, architecture, UX, scope and delivery decisions. No human acceptance
is required. Open decisions below are decisions for the agents to resolve and
record, not reasons to wait for a founder. The full working application is the goal.

## Essential distinctions

| Status | What it means now |
| --- | --- |
| Founder direction | Global OSS, self-hosting, human collaboration, strong AI participation, high UX quality, own officially supported AI services, and a path to enterprise. |
| Proposal | Initial personas, market entry, product mechanisms, commercial services, and TypeScript/React/PostgreSQL as a stack candidate. |
| Open decision | First niche, proven USP, first release scope, architecture, palette, design system, pricing, and supported subscription integration methods. |
| Existing implementation | A loose HTML prototype; its screens, terminology, colors, and technology are inspiration. |

Routine decisions within an accepted task belong to its owner. Record larger
recommendations with evidence; only the named decision owner can accept them.
Independent agent review can accept delegated product and technical decisions.
The foundation does not authorize deleting existing code or changing the license.

## Principles agents carry between tasks

- Define the persona, situation, obstacle, useful result, and observable proof.
- Preserve continuity between conversation, decision, work, result, and source.
  A map relationship is not automatically an execution dependency.
- Keep proposed, accepted, and superseded decisions distinguishable. Preserve
  historical evidence and provenance when current material changes.
- Give human collaboration its own value. Model limits, offline agents, and
  revoked access must not disable ordinary human work.
- Make authority, privacy, AI identity, account ownership, cost, and interruption
  understandable. Enforce access in all data and integration paths.
- Design for easy installation, recovery, updates, export, and extensions that
  remain compatible with the core. Evaluate operating costs before adding layers.
- Research in proportion to uncertainty and consequence; reuse current evidence.
  Separate observed behavior, vendor claims, founder preferences, and hypotheses.
- Evaluate actual user outcomes. An empty queue, merged PR, screenshot, or model
  finishing its response is not proof of a working product.
- Keep the full product ambition. Sequence work by dependency and deliver coherent
  outcomes; the sixteen areas in section 8 are not sixteen pre-approved tickets.

## Find the relevant material

| Task | Foundation sections and working guide |
| --- | --- |
| Problem, segment, personas, USP | 1–7, 14, 17 B/C; [research](research.md) |
| Product areas and integrated journeys | 8, 18–19 |
| Own agents, subscriptions, APIs, local models | 9, 11.3, 17 E; dated primary-source research |
| Visual direction, density, accessible interactions | 10, 17 D1–D4, 21; [design workflow](../design/README.md) |
| Architecture and operations | 11, 13, 18; [decision register](decisions.md) |
| OSS and commercial direction | 3, 6, 12–13; existing [LICENSE](../../LICENSE) |
| Task execution and independent review | 14–17; [agent workflow](../agents/workflow.md) |

## Milestones are the entry point

A worker starts from a GitHub **milestone**, its description, and the linked
checked-in brief. There is no mandatory parent issue. Agents create and assign
bounded issues inside that milestone, negotiate in issue comments, and review
implementation in PRs. See [startup](../agents/startup.md).

The [first milestone brief](milestones/01-product-blueprint.md) turns this vision
into product, design, architecture, and release proposals. It deliberately does
not pretend that the first application version or stack is already accepted.
Agents make decisions as evidence becomes available and begin ready implementation in
[milestone 2](milestones/02-working-application.md). Research and coding may overlap.

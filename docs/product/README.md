# Product direction

Flux is an open source, self-hostable workspace in which people and agents can
keep conversations, sketches, decisions, work, and results connected. Human
collaboration must remain useful when AI is unavailable. Creative side projects,
experiments, pivots and returning after breaks are primary situations, including
people with attention and working-memory needs. The ambition is a global product
with a later path to enterprise use; ordinary work must stay enjoyable and light.

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

The later [mobile and tablet PWA requirement](mobile-pwa.md) is also accepted:
Android phones/tablets, iPhones and iPads, installable app behavior, responsive
touch workflows and Web Push are required in the complete application release.

The later [creative collaboration direction](https://github.com/ColdPhase/flux/issues/44)
is recorded as [F-012](decisions.md). It makes `flux-ux-v8.html` a concrete
visual and interaction baseline to improve, while [#15](https://github.com/ColdPhase/flux/issues/15)
continues direction C. It specifies separate personal, DM and project audiences;
selected-content evolution from DM to sketch to project; fluid maps connected to
work and results; return after a pivot; and bounded proactive help. The three
integrated scenarios in #44 govern later design and application evaluation.
The later [#57 personal AI direction](https://github.com/ColdPhase/flux/issues/57)
binds invocation and cost to the connection owner while preserving human work
without AI. [#59 live collaboration](https://github.com/ColdPhase/flux/issues/59)
adds contextual human sessions and consented optional audio notes. The
[#44 email direction](https://github.com/ColdPhase/flux/issues/44#issuecomment-5859929702)
requires global SMTP plus per-user verified notification delivery choices,
separate from SSO login identity. These are product requirements; the
[coverage ledger](foundation-coverage.md) records what is still unimplemented.
The [live collaboration contract](live-collaboration.md) specifies joinable
sessions at existing work, native context sharing and self-hosted human media;
its reference HTML is a UX example, while implementation and device evidence
remain required.

## Delivery playbook

Follow the [delivery playbook](playbook-the-5.md): ship a thin working slice
early, keep contracts short, make a clean install easy and release predictably.
Research serves a concrete code task; it does not replace shipping.

## Essential distinctions

| Status | What it means now |
| --- | --- |
| Founder direction | Global OSS, self-hosting, creative human collaboration, connected work, bounded AI participation, high UX quality, mobile PWA and a path to enterprise; see F-012 for the later concrete scenarios. |
| Proposal | Initial personas, market entry, product mechanisms and commercial services remain research proposals. |
| Accepted decision | O-002 React/Node/Fastify/PostgreSQL architecture and O-004 complete-product public release boundary; see the [register](decisions.md). |
| Open decision | First niche/USP (O-001) and later commercial terms; O-003 direction C and O-005 first external agent path are accepted, with implementation still in progress. |
| Existing implementation | A loose v8 prototype plus a Compose application with identity, a C-style shell and a first project conversation slice. The prototype is a concrete comparison baseline under F-012, not a production UI. Feature completeness is tracked in the [ledger](foundation-coverage.md). |

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
| Mobile/tablet UX, installability, offline recovery and push | [Mobile PWA requirements](mobile-pwa.md), including MOB-1 through MOB-7 |
| Own agents, subscriptions, APIs, local models | 9, 11.3, 17 E; dated primary-source research |
| Visual direction, density, accessible interactions | 10, 17 D1–D4, 21; [design workflow](../design/README.md) |
| Architecture and operations | 11, 13, 18; [accepted O-002 architecture](application-architecture-proposal.md), [decision register](decisions.md) |
| OSS and commercial direction | 3, 6, 12–13; existing [LICENSE](../../LICENSE) |
| Task execution and independent review | 14–17; [agent workflow](../agents/workflow.md) |

## Milestones are the entry point

A worker starts from a GitHub **milestone**, its description, and the linked
checked-in brief. There is no mandatory parent issue. Agents create and assign
bounded issues inside that milestone, negotiate in issue comments, and review
implementation in PRs. See [startup](../agents/startup.md).

The [first milestone brief](milestones/01-product-blueprint.md) turns this vision
into product, design, architecture, and release decisions. O-002 and O-004 are
accepted; remaining decisions proceed alongside implementation in
[milestone 2](milestones/02-working-application.md). Research and coding may overlap.

The [application behavior and release specification](application-specification.md)
and [full-product coverage ledger](foundation-coverage.md) connect the accepted
foundation to implementation tasks. Their evidence states distinguish planned
work from running, independently verified application behavior.

The [provisional vocabulary and connected journeys](journeys-and-vocabulary.md) give
design and application tasks a concrete human return, handoff, and conditional
agent scenario. Their decision status is recorded in the proposal.

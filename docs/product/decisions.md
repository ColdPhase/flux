# Decision register

Read [delegated product delivery](autonomy.md): founders have authorized the
agents to make and accept the product/technical decisions needed to finish Flux.
Record a decision's owner, status, date, evidence, and the decision it supersedes.
`Proposed` is not `Accepted`; an implementation or a peer's favorable technical
review does not silently change that status. Link substantial records from here;
do not create a separate ADR for every reversible detail.

| ID | Decision | Status | Authority / evidence | Revisit when |
| --- | --- | --- | --- | --- |
| F-001 | Global open source and self-hosting; human collaboration and strong AI participation; enterprise direction | Founder direction, 2026-09-27 | [Foundation §0, §1, §19](FLUX-FOUNDATION.md#0-jak-używać-tego-dokumentu) | Founders explicitly revise the direction |
| F-002 | Existing prototype and previous color suggestions are inspiration | Founder direction, 2026-09-27 | [Foundation §21](FLUX-FOUNDATION.md#21-ważne-dla-agentów-nadal-szukamy-kierunku) | A specific product/design direction is accepted |
| F-003 | Research and independently verify meaningful changes; preserve sources and actual evidence | Founder direction, 2026-09-27 | Foundation §14–17 | Evidence supports a process improvement |
| F-004 | Application, toolchain, and dependent services run in Docker/Compose; no host PostgreSQL/Redis installation | Accepted, 2026-09-27 | Founder follow-up; [container development](../development/containers.md) | Founder explicitly revises the environment requirement |
| F-005 | GitHub milestone is the agent entry point; agents create issues and communicate in issues/PRs | Accepted, 2026-09-27 | Founder follow-up; [startup](../agents/startup.md) | Workflow needs change |
| F-006 | Park a blocked task, ask the peer for help, and continue independent work; revisit before completion | Accepted, 2026-09-27 | Founder follow-up; [workflow](../agents/workflow.md) | Evidence supports a process improvement |
| F-007 | Agents decide, implement, independently review, merge and deliver without human acceptance; create subsequent milestones and finish the complete application | Accepted, 2026-09-27 | Founder follow-up; [delegation](autonomy.md) | Founder changes the goal |
| F-008 | Lightweight PR Actions; substantial local Docker checks; release packaging only for the completed product | Accepted, 2026-09-27 | Founder follow-up; [delegation](autonomy.md#actions-budget) | Measured delivery needs change |
| F-009 | Suspend both development workers on peer failure, stale heartbeat or stalled provider; wait without model calls and preserve unfinished work | Superseded by F-011, 2026-09-27 | Founder follow-up | — |
| F-010 | Installable mobile/tablet PWA, touch-first responsive journeys and authorized Web Push on Android, iPhone and iPad | Accepted, 2026-09-27 | Founder follow-up; [mobile acceptance requirements](mobile-pwa.md) | Founder revises the product requirement |
| F-011 | Remove the Python runner and paired presence; each founder runs one interactive `/goal` session per identity; agents coordinate through GitHub issues/PRs, comment only on state changes, and keep working independently when the peer is unavailable | Founder direction, 2026-09-27 | The runner caused repeated shutdowns of both agents; [startup](../agents/startup.md), [workflow](../agents/workflow.md) | Founders revise the operating model |
| O-001 | First niche, primary persona, and defensible USP | Open | Assigned agent with independent peer acceptance | Milestone product research is ready |
| O-002 | [React/Node/Fastify/PostgreSQL architecture](application-architecture-proposal.md), with a separate worker, versioned public contracts, transactional events/jobs, and a local files volume | Accepted, 2026-09-27, by independent peer review of `739869d6c0fa7aec7ef1692c3c0565554b0b9e5e` | Owner @PelikanFix16; [#13 contract v2](https://github.com/ColdPhase/flux/issues/13#issuecomment-5856312810), [peer review](https://github.com/ColdPhase/flux/pull/25#pullrequestreview-5330686985), [#28 foundation](https://github.com/ColdPhase/flux/issues/28), [#29 identity/access](https://github.com/ColdPhase/flux/issues/29) | Tested migrations, auth/transaction integration, scale or operations evidence contradicts the selected boundaries; see record risks |
| O-003 | Visual direction, palette, tokens, and component system | Open | Assigned design agent and independent peer; foundation §10 | Realistic variants and separate visual/behavior evidence are available |
| O-004 | First public application release scope and delivery formats | Accepted, 2026-09-27, by independent peer review of proposal `56d47dd` | [#16 application specification](application-specification.md#o-004-proposal-first-public-release-ac-4), [coverage ledger](foundation-coverage.md), and [peer decision](https://github.com/ColdPhase/flux/pull/35#pullrequestreview-5331218809) | Integrated journey, dependencies or release evidence support a different coherent boundary |
| O-005 | Supported AI integration and authentication paths | Open per provider and mode | Assigned product/technology agents; current official documentation | Integration work or publication of a promise |
| O-006 | Pricing, SLA, commercial modules, licensing changes | Outside implementation scope; existing AGPL-3.0 applies | Preserve the existing license and avoid inventing commercial commitments | A later explicit business task changes the scope |

For a new significant proposal include: problem, required properties, options,
recommendation, evidence and date, costs and limitations, acceptance owner,
status, and reconsideration condition. An acceptance record links to the exact
proposal revision and the independent peer's GitHub comment or approved decision PR. No founder approval is required for delegated decisions.

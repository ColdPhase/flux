# Decision register

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
| O-001 | First niche, primary persona, and defensible USP | Open | Founders; research recommendations required | Milestone product research is ready |
| O-002 | Application architecture and stack | Open; TypeScript/React/PostgreSQL are candidates | Technology owner appointed by founders; foundation §11 | Compared options and operating requirements are documented |
| O-003 | Visual direction, palette, tokens, and component system | Open | Design owner appointed by founders; foundation §10 | Realistic variants and separate visual/behavior evidence are available |
| O-004 | First public application release scope and delivery formats | Open | Founders/product owner; foundation §18–19 | Integrated journeys and dependencies are understood |
| O-005 | Supported AI integration and authentication paths | Open per provider and mode | Product/technology owners; current official documentation | Integration work or publication of a promise |
| O-006 | Pricing, SLA, commercial modules, licensing changes | Open; existing AGPL-3.0 remains in force | Founders and relevant rights holders | Explicit business decision is requested |

For a new significant proposal include: problem, required properties, options,
recommendation, evidence and date, costs and limitations, acceptance owner,
status, and reconsideration condition. An acceptance record links to the exact
proposal revision and the owner's GitHub comment or reviewed decision change.

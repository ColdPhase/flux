# Flux documentation

See the [project README](../README.md) for an introduction and quick start.

## Contributing and security

- [Contributing](CONTRIBUTING.md) — where to raise issues, the Docker checks to run,
  and how to submit a pull request.
- [Security policy](SECURITY.md) — supported code and private vulnerability reports.
- [Governance](../GOVERNANCE.md) — who decides, how to propose changes, licensing.
- [Changelog](../CHANGELOG.md) — what changed, and the rule for adding an entry.
- [Build log](build-log.md) — how two founders and two agents build Flux, dated.

## Agent collaboration

- [Agent workflow](agents/README.md) — shared Codex/Claude
  instructions, GitHub communication, task contracts, and continuous release work.
- [CI and releases](agents/ci-and-releases.md) — validation workflows, required PR
  checks, packaging, and publication responsibilities.

Each maintainer runs one `/goal` agent session; [startup](agents/startup.md)
explains how to start, pause and resume it. Current work is tracked in the
[milestones](https://github.com/ColdPhase/flux/milestones) and their issues; accepted
direction is in the [decision register](product/decisions.md).

## Product and environment

- [Product direction](product/README.md), including the full founder document.
- [Decision register](product/decisions.md) — accepted direction, proposals, open choices.
- [Final design "Prostota"](design/final/README.md) — the only UI/UX: rules, tokens, Kreska and every screen.
- [Design workflow](design/README.md) — how to implement and review against the final design.
- [Container development](development/containers.md) — Docker/Compose for the application and services.
- [Application foundation](development/application-foundation.md) — clean start, integration fixture and operations.
- [Time to first run](development/time-to-first-run.md) — measured time from `git clone` to a running Flux, and what the README missed.
- [Operations](operations/README.md) — backup schedule, restore, project export, upgrade and disk hygiene.
- [Integrations](integrations/README.md) — the public extension contracts of v0.1 (MCP tools, project export), their
  compatibility rules, permissions, retries and errors, for integrators and operators.
- [Architecture](development/architecture.md) — layers, dependency direction, where code and tests go, known debt.
- [Access policy](development/access-policy.md) — workspaces, projects, grants, agents, drafts and the single authorization choke point.

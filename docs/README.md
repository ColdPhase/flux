# Flux documentation

See the [project README](../README.md) for an introduction and quick start.

## Contributing and security

- [Contributing](CONTRIBUTING.md) — running the prototype, checking changes, and
  submitting a pull request.
- [Security policy](SECURITY.md) — supported code and private vulnerability reports.

## Agent collaboration

- [Agent workflow](agents/README.md) — shared Codex/Claude
  instructions, GitHub communication, task contracts, and continuous release work.
- [CI and releases](agents/ci-and-releases.md) — validation workflows, required PR
  checks, packaging, and publication responsibilities.

Each maintainer runs one `/goal` agent session; [startup](agents/startup.md)
explains how to start, pause and resume it. The first milestone
prepares product/design/architecture decisions. Application technology is accepted;
implementation and the first release scope continue in the working application milestone.

## Product and environment

- [Product direction](product/README.md), including the full founder document.
- [Decision register](product/decisions.md) — accepted direction, proposals, open choices.
- [Design workflow](design/README.md) — realistic variants, density and independent review.
- [Container development](development/containers.md) — Docker/Compose for the application and services.
- [Application foundation](development/application-foundation.md) — clean start, integration fixture and operations.
- [Architecture](development/architecture.md) — layers, dependency direction, where code and tests go, known debt.
- [Access policy](development/access-policy.md) — workspaces, projects, grants, agents, drafts and the single authorization choke point.

## Prototype

The v8 design documents are currently in Polish:

- [Walkthrough](prototype/README.md) — what to try and how the prototype behaves.
- [Specification](prototype/SPECIFICATION.md) — interactions and design decisions.
- [Changelog](prototype/CHANGELOG.md) — changes from v7 to v8.
- [Audit](prototype/AUDIT.md) — historical verification and remaining limitations.

The runnable prototype is [flux-ux-v8.html](../flux-ux-v8.html) in the repository
root. The design notes refer to earlier test materials that were not included in
this repository; they are not an automated test suite.

# Flux documentation

See the [project README](../README.md) for an introduction and quick start.

## Contributing and security

- [Contributing](CONTRIBUTING.md) — running the prototype, checking changes, and
  submitting a pull request.
- [Security policy](SECURITY.md) — supported code and private vulnerability reports.

## Agent collaboration

- [Agent workflow and harness design](agents/README.md) — shared Codex/Claude
  instructions, GitHub communication, task contracts, and continuous release work.
- [CI and releases](agents/ci-and-releases.md) — validation workflows, required PR
  checks, packaging, and publication responsibilities.

This is the collaboration foundation. The application plan, technology stack,
and executable agent runner are still to be supplied/implemented.

## Prototype

The v8 design documents are currently in Polish:

- [Walkthrough](prototype/README.md) — what to try and how the prototype behaves.
- [Specification](prototype/SPECIFICATION.md) — interactions and design decisions.
- [Changelog](prototype/CHANGELOG.md) — changes from v7 to v8.
- [Audit](prototype/AUDIT.md) — historical verification and remaining limitations.

The runnable prototype is [flux-ux-v8.html](../flux-ux-v8.html) in the repository
root. The design notes refer to earlier test materials that were not included in
this repository; they are not an automated test suite.

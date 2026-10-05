# Changelog

All notable changes to Flux are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Flux uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) for its releases.

**Keeping it current.** A pull request that changes what people or operators see adds
one line under `[Unreleased]`, in the matching section, with its PR number. This
covers features, changed behaviour, fixes, removals, security fixes and new
operator steps. Internal refactors, tests and agent-process changes need no entry.
At release time, the release candidate moves `[Unreleased]` under its version and date.

## [Unreleased]

No version has been released yet. Everything below is on `main` since the
repository was created on 2026-09-26.

### Added

#### Run and operate Flux

- One Docker Compose application with the API, a separate worker, PostgreSQL and a
  durable job queue. Migrations are reviewed SQL with health checks ([#34](https://github.com/ColdPhase/flux/pull/34)).
- `./flux up`, `./flux demo` and `./flux dev` start, seed and develop Flux with only
  Docker installed ([#102](https://github.com/ColdPhase/flux/pull/102)).
- Backup, restore, project export and upgrade through `./flux backup`, `restore`,
  `export` and `upgrade` ([#127](https://github.com/ColdPhase/flux/pull/127)).
- Operator Compose files and versioned installation assets for released images
  ([#159](https://github.com/ColdPhase/flux/pull/159)), plus a gated, explicitly
  triggered OCI release workflow ([#104](https://github.com/ColdPhase/flux/pull/104)).
- An exact migration-ledger check at install and startup. A database that does not
  match the image's migrations refuses to start ([#130](https://github.com/ColdPhase/flux/pull/130)).
- Two public extension contracts with a written compatibility promise: MCP tool
  contract 1 and project export format 1. A versioned snapshot test catches a
  breaking change. The [integration guide](docs/integrations/README.md) is for
  integrators and operators ([#260](https://github.com/ColdPhase/flux/pull/260)).

#### People and access

- Email sign-up and sign-in with origin-checked sessions ([#39](https://github.com/ColdPhase/flux/pull/39)).
- Workspaces, projects, grants and private drafts behind one authorization check
  ([#42](https://github.com/ColdPhase/flux/pull/42)).
- An authorized live event stream; the worker rechecks access before it acts, and
  idempotent writes are safe to retry ([#47](https://github.com/ColdPhase/flux/pull/47)).

#### Working together

- Installable PWA shell and Web Push notifications ([#49](https://github.com/ColdPhase/flux/pull/49)).
- The calm web app shell and design system ([#55](https://github.com/ColdPhase/flux/pull/55)),
  later the project surface with view tabs and a state line ([#122](https://github.com/ColdPhase/flux/pull/122)).
- Project capture and conversations with replies and cited materials ([#60](https://github.com/ColdPhase/flux/pull/60)).
- Sketches: persistent maps of connected thoughts ([#100](https://github.com/ColdPhase/flux/pull/100)).
  - A stable personal list view ([#146](https://github.com/ColdPhase/flux/pull/146)).
  - Draft-before-save for new thoughts ([#158](https://github.com/ColdPhase/flux/pull/158)).
- Work items, decisions and results linked to the conversations they came from
  ([#105](https://github.com/ColdPhase/flux/pull/105)). Native tasks gained
  criteria, prerequisites and plan intent ([#171](https://github.com/ColdPhase/flux/pull/171)).
- Canonical task discussions:
  - A task's thread starts at its first real contribution, with genuine actors
    ([#164](https://github.com/ColdPhase/flux/pull/164)).
  - Saved blockers, results and handoffs contribute to the thread
    ([#173](https://github.com/ColdPhase/flux/pull/173)).
- A return view: what changed since you left, its sources and one next step
  ([#110](https://github.com/ColdPhase/flux/pull/110)). It also offers a private,
  sourced "What matters" recap ([#140](https://github.com/ColdPhase/flux/pull/140)).
- Direct messages that do not belong to a project ([#111](https://github.com/ColdPhase/flux/pull/111)).
  A sketch can live inside a DM and be promoted to a project with an exact audience
  ([#129](https://github.com/ColdPhase/flux/pull/129)).
- Project docs and wiki with versions and links ([#115](https://github.com/ColdPhase/flux/pull/115)).
- Notifications: an inbox, per-reason preferences and email delivery
  ([#120](https://github.com/ColdPhase/flux/pull/120)).
- Privacy-safe search across everything you can read ([#119](https://github.com/ColdPhase/flux/pull/119)).
- Self-hosted live sessions ([#109](https://github.com/ColdPhase/flux/pull/109)):
  - contextual join, follow and screen sharing ([#131](https://github.com/ColdPhase/flux/pull/131));
  - media ends at sign-out ([#139](https://github.com/ColdPhase/flux/pull/139));
  - TURN calibration and real media diagnostics ([#156](https://github.com/ColdPhase/flux/pull/156)).
- Phone task views. Your own messages sit on the right and other people's on the
  left ([#138](https://github.com/ColdPhase/flux/pull/138)).
- Mint, Sky and Copper accents, remembered separately for light and dark themes
  ([#145](https://github.com/ColdPhase/flux/pull/145), [#157](https://github.com/ColdPhase/flux/pull/157)).
- A project can connect a read-only GitHub App repository and link tasks to verified
  pull requests, from signed, deduplicated webhook deliveries ([#168](https://github.com/ColdPhase/flux/pull/168)).

#### AI that stays yours

- Connect your own agent to Flux through scoped MCP and OAuth ([#103](https://github.com/ColdPhase/flux/pull/103)).
  - Several named connections per person, with consent bound to each request
    ([#167](https://github.com/ColdPhase/flux/pull/167)).
  - Standing-grant actions for tasks, results and decisions ([#174](https://github.com/ColdPhase/flux/pull/174)),
    and for the shared map ([#176](https://github.com/ColdPhase/flux/pull/176)).
  - Standing-grant actions for project docs and the project conversation, with the
    agent named as the author ([#193](https://github.com/ColdPhase/flux/pull/193)).
  - A versioned co-work playbook delivered through Start/Resume prompts
    ([#175](https://github.com/ColdPhase/flux/pull/175)).
- Owner-only personal assistant runs. Only the owner can ask, stop or pay
  ([#141](https://github.com/ColdPhase/flux/pull/141), [#142](https://github.com/ColdPhase/flux/pull/142)).
  Crashed runs recover without a second invocation ([#161](https://github.com/ColdPhase/flux/pull/161)).
- Owner background setup with paused rules and sourced comparisons. These are
  prepared, but production activation stays off ([#124](https://github.com/ColdPhase/flux/pull/124)).

### Changed

- The Studio 11.6 interface: a sidebar with workspace and project names, a calmer
  header, Conversation · Map · Tasks · Wiki tabs and a reworked conversation
  ([#184](https://github.com/ColdPhase/flux/pull/184)).
- The application lives under `app/` and the Docker inputs under `docker/`.
  `./flux` moves an old root `.env` to `docker/.env` once ([#165](https://github.com/ColdPhase/flux/pull/165)).
- The compiled, non-root runtime image no longer ships TypeScript tooling ([#43](https://github.com/ColdPhase/flux/pull/43)).

### Fixed

- The shared files volume works on SELinux hosts ([#67](https://github.com/ColdPhase/flux/pull/67)).
- Check scripts remove the images they built, so test runs no longer fill the
  disk ([#73](https://github.com/ColdPhase/flux/pull/73)).
- Project status and conversation navigation are correct for readers
  ([#169](https://github.com/ColdPhase/flux/pull/169)).
- Blocked project work stays visible on narrow phones ([#172](https://github.com/ColdPhase/flux/pull/172)).
- Retrying a first space, project or private draft after a lost response no longer
  creates a second one ([#178](https://github.com/ColdPhase/flux/pull/178)).

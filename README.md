# Flux

An open source, self-hostable workspace where people and AI agents work on the same
projects: conversations, and the tasks, documents and decisions that come out of them.

The [product foundation](docs/product/README.md) describes the direction: human and
agent collaboration, continuity of project knowledge, self-hosting and extensibility.

## Project status

**Early development, not released.** There is no stable version, upgrade path or
supported deployment yet; do not use it for sensitive data or production teams.

What exists on `main` today is a Docker Compose stack (API, worker, PostgreSQL,
queue and a browser/PWA shell) with email/password accounts and sessions in the API,
the workspace/project access policy, and notification/Web Push plumbing. The collaborative workspace itself is
being built in the [current milestone](https://github.com/ColdPhase/flux/milestones).

`flux-ux-v8.html` is an earlier single-file UX prototype (Polish interface, browser
storage only). It is design inspiration, not the application; see the
[prototype guide](docs/prototype/README.md).

## Quick start

Prerequisites: Git and Docker Engine (or Docker Desktop) with Compose. No host Node.js or PostgreSQL.

```sh
git clone https://github.com/ColdPhase/flux.git
cd flux
./flux up      # creates docker/.env with random secrets once, builds, migrates, starts, prints the URL
./flux demo    # optional: sample workspace, project, conversation and note; prints two logins
```

Then open <http://127.0.0.1:8081/>. `./flux up` never overwrites an existing `docker/.env`. An older root `.env` is moved once with its secrets and project name intact; if both files exist, choose the intended one before continuing. `app/.env.example` documents variables and is never loaded.
Other commands: `./flux dev` (hot reload in Docker), `./flux down`, `./flux logs`,
`./flux reset` (deletes data after confirmation), `./flux clean` (also removes the
images this checkout built) and `./flux help`. Backups, restore, project export and
upgrades (`./flux backup`, `restore`, `export`, `upgrade`) are described in
[operations](docs/operations/README.md). The
[application foundation guide](docs/development/application-foundation.md) covers the
launcher, configuration, backups and the integration fixture;
[containers](docs/development/containers.md) describes every service and variable.

Run the checks (build, type check, lint, tests and browser checks, all in Docker):

```sh
./scripts/check_application.sh
./scripts/check_flux_cli.sh
./scripts/check_backup.sh
python3 scripts/check_agent_setup.py
```

## Repository layout

| Path | Contents |
| --- | --- |
| `app/apps/server` | API: HTTP routes, identity, push, serving the web build |
| `app/apps/worker` | Background jobs and Web Push delivery |
| `app/apps/web` | Browser application and PWA |
| `app/packages/core` | Domain rules, authorization, use cases and ports |
| `app/packages/db` | Database schema, SQL migrations and persistence adapters |
| `app/packages/contracts` | Public API wire types (Apache-2.0) |
| `app/packages/sdk` | TypeScript client for the public API (Apache-2.0) |
| `app/packages/agent-runtime` | Optional model/provider adapter |
| `app/examples/external-agent` | An external agent using the SDK (Apache-2.0) |
| `app/` | Sole pnpm workspace, lockfile, TypeScript/ESLint config and application variable reference |
| `app/tooling` | Migration and operations entry points |
| `docker` | Dockerfiles, source/dev/test/live Compose, pull-only operator example and executable env template |
| `app/tests` | Application checks and Python/Playwright browser checks |
| `tests` | Repository and agent tooling checks |
| `flux` | One-command launcher: `up`, `demo`, `dev`, `down`, `reset`, `clean`, `backup`, `restore`, `export`, `upgrade` |
| `scripts` | Check scripts, the demo seed and repository tooling |
| `docs` | Product, design, development and agent documentation |

Dependency directions between these are described and enforced in
[architecture](docs/development/architecture.md).

## Contribute

Bug reports, documentation, accessibility feedback and focused fixes are welcome.
Read [CONTRIBUTING.md](docs/CONTRIBUTING.md) first and discuss larger features or
architecture changes in an issue before starting.

- [Report a bug or propose a feature](https://github.com/ColdPhase/flux/issues/new/choose)
- [Project board](https://github.com/orgs/ColdPhase/projects/1)
- [Discussions](https://github.com/ColdPhase/flux/discussions)
- [Report a security vulnerability privately](docs/SECURITY.md)

Much of the development is done by two coding agents (Codex and Claude) working
through GitHub issues and pull requests with independent review; see
[agent collaboration](docs/agents/README.md). The [documentation index](docs/README.md)
lists everything else.

## License

The application is licensed under the [GNU Affero General Public License v3](LICENSE).
`app/packages/contracts`, `app/packages/sdk` and `app/examples/external-agent` are licensed under
Apache-2.0 so that external agents and clients can use them; see
[licensing](docs/product/licensing.md).

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

Prerequisites: Git and Docker Engine with Compose. No host Node.js or PostgreSQL.

```sh
git clone https://github.com/ColdPhase/flux.git
cd flux
cp .env.example .env
# Replace POSTGRES_PASSWORD, FLUX_FIXTURE_TOKEN and FLUX_AUTH_SECRET with long random values.
set -a; . ./.env; set +a
docker compose --env-file .env -p flux -f infra/compose.yaml up -d --build db migrate
docker compose --env-file .env -p flux -f infra/compose.yaml --profile setup run --rm files-init
docker compose --env-file .env -p flux -f infra/compose.yaml up -d --wait api worker
curl -fsS http://127.0.0.1:8081/api/v1/health
```

Then open <http://127.0.0.1:8081/>. The [application foundation guide](docs/development/application-foundation.md)
covers configuration, backups and the integration fixture;
[containers](docs/development/containers.md) describes every service and variable.

Run the checks (build, type check, lint, tests and browser checks, all in Docker):

```sh
./scripts/check_application.sh
python3 scripts/check_agent_setup.py
```

## Repository layout

| Path | Contents |
| --- | --- |
| `apps/server` | API: HTTP routes, identity, push, serving the web build |
| `apps/worker` | Background jobs and Web Push delivery |
| `apps/web` | Browser application and PWA |
| `packages/core` | Domain rules, authorization, use cases and ports |
| `packages/db` | Database schema, SQL migrations and persistence adapters |
| `packages/contracts` | Public API wire types (Apache-2.0) |
| `packages/sdk` | TypeScript client for the public API (Apache-2.0) |
| `packages/agent-runtime` | Optional model/provider adapter |
| `examples/external-agent` | An external agent using the SDK (Apache-2.0) |
| `infra` | Dockerfile, Compose files, migration entry point |
| `tests` | Application tests (`tests/app`) and repository tooling tests |
| `scripts` | Check scripts and repository tooling |
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
`packages/contracts`, `packages/sdk` and `examples/external-agent` are licensed under
Apache-2.0 so that external agents and clients can use them; see
[licensing](docs/product/licensing.md).

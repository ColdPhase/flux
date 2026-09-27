# Container development

Founder decision, 2026-09-27: **the application and its dependencies run in
Docker/Compose**. Do not install PostgreSQL, Redis, queues, or application
toolchains as services on a contributor's host.

## Contract for the selected application stack

The architecture and first application setup task must supply:

- Reviewed Dockerfiles and a Compose configuration for application services,
  development tooling, and any database/queue actually selected.
- A documented clean start, dependency installation, migration, fixture/seed,
  lint/type/test, build, stop, backup, and restore workflow using containers.
- Locked dependencies, reviewed base images, health checks, and deterministic
  readiness. Starting a container is not proof that its service is ready.
- Named persistent volumes, example configuration without real credentials,
  and documented ownership of data. Never delete volumes or reset a shared
  database to fix a test without explicit authorization for those data.
- Separate Compose project names per worker/task, isolated data and test accounts,
  and nonconflicting published ports. Avoid fixed container names that collide.
- The same container commands in GitHub Actions; no CI-only hidden host database
  setup or claim that a host-only test proves the supported installation works.
- Release builds from the accepted source revision, appropriate container image
  or other agreed deliverables, and installation/update/restore verification.

The [accepted O-002 architecture](../product/application-architecture-proposal.md)
selects PostgreSQL. The first application foundation in `infra/compose.yaml`
starts PostgreSQL, a one-shot migration, the API and a separate worker with named
`pgdata` and `files` volumes. See [application foundation](application-foundation.md)
for the current clean-start, validation and backup/restore commands. This is an
application skeleton; user identity, collaboration and release verification are
separate tasks.

Git, Docker/Compose, GitHub CLI, the installed official coding-agent CLIs, and
Python 3.11+ for this repository's standard-library foundation checks are host
tools. Those checks are separate from the Flux application's runtime and do not
require installing an application toolchain.

The existing static HTML prototype can still be opened directly in a browser.
It is historical exploration material and is not the application environment.

## Identity services and variables

Human login (issue #29) uses Better Auth inside the API container, on the same
PostgreSQL database (migration `0002_identity.sql`). Sessions are rows in
`auth_sessions`, so they survive an API restart; a revoked session fails on the
next request. The API reads these variables (see `.env.example`):

| Variable | Meaning |
| --- | --- |
| `FLUX_PUBLIC_ORIGIN` | Required. The exact origin people open, e.g. `https://flux.example.org`. It is the only origin accepted for state-changing browser requests and the base of mailed links. `Host` and `X-Forwarded-*` are never used to derive it. An `https` origin makes cookies `Secure` with the `__Secure-` prefix. Plain `http` is accepted only for loopback development (`localhost`, `127.0.0.0/8`, `[::1]`); any other `http` origin stops the API at startup. |
| `FLUX_AUTH_SECRET` | Required, at least 32 random characters. Signs session cookies; changing it signs everyone out. |
| `FLUX_TRUSTED_PROXIES` | Comma-separated proxy IPs/CIDRs. Only a request whose socket peer is listed may supply `X-Forwarded-For` as the client address. Empty (default) trusts no proxy. |
| `FLUX_SMTP_URL`, `FLUX_MAIL_FROM` | SMTP transport URL (e.g. `smtp://user:pass@mail.example.org:587`) and sender for password reset mail. If unset, password reset answers `503 PASSWORD_RESET_UNAVAILABLE` and `/api/v1/auth/capabilities` reports `unavailable`. |
| `FLUX_PASSWORD_RESET_TTL_SECONDS` | Reset token lifetime, 60–86400, default 3600. Tokens are single use and stored hashed. |
| `FLUX_AUTH_RATE_LIMIT` | `true` (default) enables Better Auth's in-memory login rate limit. Only the test script turns it off. |

For development, the `dev` Compose profile adds a local mail catcher
(Mailpit, pinned by digest). Set `FLUX_SMTP_URL=smtp://mailpit:1025` and a
`FLUX_MAIL_FROM` in `.env`, then open the caught mail at
`http://127.0.0.1:${FLUX_MAILPIT_PORT:-8025}`:

```sh
docker compose --env-file .env -p flux28 -f infra/compose.yaml --profile dev up -d --build
```

Endpoints: Better Auth under `/api/auth/*` (`sign-up/email`, `sign-in/email`,
`sign-out`, `request-password-reset`, `reset-password`); Flux session routes
`GET /api/v1/me`, `GET /api/v1/sessions` (never returns tokens),
`DELETE /api/v1/sessions/:id` and `POST /api/v1/sessions/revoke-others`.
Server code resolves the caller with `requirePrincipal(request)` from
`apps/server/src/identity`, which maps the session user to a `human` `Principal`.

`./scripts/check_application.sh` runs the identity suite in the `test` profile
against the running API and mail catcher, including a session check across
`docker compose restart api`. Set `FLUX_TEST_PORT` / `FLUX_TEST_MAILPIT_PORT`
to avoid port clashes with another concurrent run.

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

Choose services after their need and stack are established; PostgreSQL is still
an architecture candidate. Do not add an unused database just to fill a template.
The current branch adds this environment contract, not a production Compose file.

Git, Docker/Compose, GitHub CLI, the installed official coding-agent CLIs, and
Python 3.11+ for this repository's standard-library foundation checks are host
tools. Those checks are separate from the Flux application's runtime and do not
require installing an application toolchain.

The existing static HTML prototype can still be opened directly in a browser.
It is historical exploration material and is not the application environment.

# Application foundation (issue #28)

This guide covers starting, configuring, checking and backing up the application.
Issue #28 created its first technical slice: a built browser shell, a versioned API, a
separate worker, PostgreSQL 18, reviewed SQL migrations and a durable pg-boss queue.

## Current state

Flux is pre-release: no version has been published and there is no supported upgrade
path yet. On this stack the application now provides accounts and sessions, workspace
and project access, project conversations with tasks, decisions, results, map and wiki,
direct messages, search, the inbox with Web Push, connected MCP agents and an optional
in-app assistant, optional live media, and `./flux` operations. The
[README](../../README.md#project-status) summarizes it for new contributors; the
[current milestone](https://github.com/ColdPhase/flux/milestone/2) tracks the remaining
release work. The [integration fixture](#integration-fixture) below is a technical
check, not part of the product.

## One-command start: `./flux` (issue #72)

The root [`flux`](../../flux) launcher is a POSIX `sh` script that needs only Docker with
Compose. It resolves every path relative to its own file, so it works from any directory.
Its layout constants (Compose files, env file, template, demo seed) are defined once at
the top of the script. The #76 layout uses the self-contained `app/` workspace and
Docker inputs plus executable configuration under `docker/`.

On upgrade, a regular legacy root `.env` moves to `docker/.env` without changing
its bytes or permissions. Legacy symlinks, conflicting paths and dangling live
configuration links are refused before Docker or secret generation. Resolve them
using the [configuration transition instructions](../operations/upgrade.md#returning-to-a-version-before-the-appdocker-layout).
A readable symlink already at `docker/.env` keeps its target in place.

| Command | What it does |
| --- | --- |
| `./flux up` | If `docker/.env` is missing, writes it from `docker/.env.example` (mode `600`) with random `POSTGRES_PASSWORD`, `FLUX_FIXTURE_TOKEN` and `FLUX_AUTH_SECRET` (64 hex characters each, from `/dev/urandom`), VAPID keys from the pinned `web-push` inside the freshly built image, `FLUX_PUBLIC_ORIGIN=http://127.0.0.1:${FLUX_PORT:-8081}` and two demo passwords. An existing `docker/.env` is never modified. Then builds the source-checkout image, runs `files-init`, migrates, starts API and worker, waits for health and prints the URL. |
| `./flux demo [--dev] [--force]` | Seeds a development demo through the **public HTTP API** as two signed-in people (so access policy, idempotency and events apply): workspace *Riverside Makers (demo)*, both accounts, project, a private note, a published material, a four-message conversation with one reply citing the material, and a sketch with connected thoughts when the sketch API (#69) exists (otherwise it reports the skip). Prints the URL and both logins. Rerunning seeds nothing new. It refuses any non-loopback `FLUX_PUBLIC_ORIGIN` (a production-looking deployment) unless `--force`. |
| `./flux dev [--build] [--follow]` | Hot-reload development inside Docker (see below). |
| `./flux down` | Stops both the `up` and `dev` stacks; keeps volumes. |
| `./flux logs [--dev] [service]` | Follows logs. |
| `./flux reset [-y]` | After a `y/N` prompt, removes the containers and volumes of this checkout's two Compose projects. `docker/.env` stays. |
| `./flux backup`, `restore`, `export`, `upgrade` | Operations (#123): consistent backups with a checked manifest, restore with version checks, project export bundles and upgrades with a backup first. See [operations](../operations/README.md). |
| `./flux clean [-y]` | `reset` plus removal of the `flux-*` images tagged with this checkout's project names. It does **not** prune the BuildKit build cache: that cache is shared by every checkout and Compose project on the Docker host and cannot be attributed to one project, so pruning it would slow or disturb other work. `clean` prints the `docker system df` / `docker builder prune --filter until=72h` commands for the owner of the machine to run deliberately. Base images and other projects are never touched. This is how #72 AC-4 ("removes this project's images and caches") is met: project images and volumes are removed; the shared cache is advice only. |

`FLUX_PROJECT` is the Compose project for `up`/`demo`; `dev` uses `<project>-dev`, with
separate database and files volumes, so hot-reload work cannot modify the `up` data.
Its default is unique per checkout, `flux-[<directory>-]<first 8 hex of sha256 of the
checkout path>`, and is written to `docker/.env` on first use, so it stays stable and visible and
two clones never share containers or volumes. A shell `FLUX_PROJECT` overrides it and the
launcher prints a note saying so. Ownership: on `up`/`dev`/`demo` the launcher records the
checkout path in a marker volume `<project>_flux-checkout` (label `com.flux.checkout`).
`up`, `dev`, `demo`, `down`, `reset` and `clean` refuse a project whose marker names
another checkout (for example after copying a checkout together with its `docker/.env`), or one
that has containers or volumes but no marker (an older or manual setup), unless
`--force-project` is given; `reset`/`clean` remove the marker with the data. Use distinct `FLUX_PROJECT`, `FLUX_PORT`, `FLUX_DEV_PORT` and
`FLUX_MAILPIT_PORT` values for parallel checkouts. `FLUX_NO_CACHE=1` builds without the
Docker cache. `./scripts/check_flux_cli.sh` exercises all of the above on an isolated copy
of the working tree.

**Measured time to first message** (issue #72 AC-3, target under 5 minutes excluding
image download). 2026-09-27, this Mac (Apple silicon, Docker Desktop, Compose
v2.40.3), commit `b3ab0ee`, base images (`node`, `postgres`) already present, build
cache bypassed with `FLUX_NO_CACHE=1` so `pnpm install` downloaded every package:
`git clone` from GitHub 17 s, `./flux up` 55 s (install 23 s, build/type check/lint
12 s, migrate, start, health), `./flux demo` 1 s, which sends the first conversation
message through the API. **Total: 73 s** from starting the clone to the first message.
Not yet measured on Linux/SELinux hosts or a machine without the base images.

### Hot-reload development: `./flux dev`

[`docker/compose.dev.yaml`](../../docker/compose.dev.yaml) layers over
[`docker/compose.source.yaml`](../../docker/compose.source.yaml). It uses
the Dockerfile's `build` stage (locked dependencies, `tsx`, Vite) and bind-mounts the source
directories read-only with `:z` (SELinux relabel; ignored on macOS). The `web` service runs
the Vite dev server on `FLUX_DEV_PORT` (default 5173) and proxies `/api`, including the
WebSocket stream, to the API with the browser's `Origin` unchanged; the launcher sets
`FLUX_PUBLIC_ORIGIN` to the dev origin for this stack. API and worker run under `tsx watch`
with [`app/tooling/tsconfig.dev.json`](../../app/tooling/tsconfig.dev.json), which resolves
`@flux/*` packages to their TypeScript source, so edits under `app/apps/*/src` and
`app/packages/*/src` apply without a build. PostgreSQL, the migration and Mailpit
(`FLUX_SMTP_URL=smtp://mailpit:1025`) run as usual. Dependency, lockfile or Dockerfile
changes need `./flux dev --build`. If file events do not reach the containers on a host,
set `FLUX_DEV_POLL=true` for Vite polling.

Observed on macOS Docker Desktop, 2026-09-27: a changed `app/apps/web/src` module was served
by Vite 0 s after the edit (browser hot update) and an API handler change was live 3 s
after the edit (tsx restart), with no image rebuild.

## Manual Compose start

Prerequisites: Git and Docker Engine with Compose. No host Node or PostgreSQL is
needed. Clone the repository, copy `docker/.env.example` to `docker/.env`, and replace the three
placeholder secrets (`FLUX_AUTH_SECRET` is described in [identity](containers.md#identity-services-and-variables)). Use a unique Compose project name and port for each worker.
The project name also isolates its image tag, database and files volumes.
Passwords used in `DATABASE_URL` must be URL-safe for this first setup; use a long
random alphanumeric value. Do not commit `docker/.env`.

```sh
cp docker/.env.example docker/.env
# Edit POSTGRES_PASSWORD, FLUX_FIXTURE_TOKEN and FLUX_AUTH_SECRET.
# Compose reads docker/.env explicitly; do not source it into the shell.
docker compose --env-file docker/.env -p flux28 -f docker/compose.source.yaml up -d --build db migrate
docker compose --env-file docker/.env -p flux28 -f docker/compose.source.yaml --profile setup run --rm files-init
docker compose --env-file docker/.env -p flux28 -f docker/compose.source.yaml up -d --wait api worker
docker compose --env-file docker/.env -p flux28 -f docker/compose.source.yaml ps
curl -fsS http://127.0.0.1:8081/api/v1/health
```

Open `http://127.0.0.1:8081/`. The API serves the built browser assets on the same
origin. Compose waits for PostgreSQL readiness and a successful one-shot migration
before starting API and worker. The one-shot `files-init` gives the non-root API and worker access to the named files volume, including an existing volume after an image upgrade. `migrate` applies each numbered `app/packages/db/migrations/NNNN_*.sql` once, in order, and
initializes the pg-boss schema and `sample.process` queue. If a migration fails,
the API and worker must not start. The API health endpoint checks the database,
Flux schema version, pg-boss schema and writable files volume.

To rerun the reviewed migration after a restore or source update:

```sh
docker compose --env-file docker/.env -p flux28 -f docker/compose.source.yaml run --rm migrate
```

### Migration ledger mismatch (#118)

The migration image rejects duplicate numbered SQL files and a stale compiled
`FLUX_SCHEMA_VERSION` before changing the database. Under its migration lock it
rejects ledger versions for which that image has no SQL file, then applies any
missing files and requires the final ledger to contain exactly the file versions.
A newly landed lower-numbered file may fill a gap in an existing installation;
gaps in an active feature branch do not by themselves mark a database corrupt.
Each SQL migration runs in one transaction. A legacy file may record its own
version, but inserting another version or deleting an earlier record rolls back.
The API and worker also check the exact ledger before starting; API health checks
it again on every request.

If `migrate` reports a mismatch, leave API and worker stopped. Inspect the error
and the ledger with the same Compose project and database volume (replace `flux28`
with the installation's project name):

```sh
docker compose --env-file docker/.env -p flux28 -f docker/compose.source.yaml logs migrate
docker compose --env-file docker/.env -p flux28 -f docker/compose.source.yaml exec -T db \
  psql -U flux -d flux -c 'SELECT version, applied_at FROM flux_schema_version ORDER BY version'
```

Check that the intended application image contains the corresponding SQL files.
Restore the matching image if the database is newer than the image; otherwise
take a database and files backup before diagnosing or repairing an interrupted
upgrade. Do not delete ledger rows, reset the volume, or replay SQL manually to
make a health check pass. A data-preserving repair needs its own review and a
same-volume rehearsal before production use.

## Integration fixture

The fixture requires the secret bearer token from `docker/.env`. It writes a sample row,
event, outbox entry and pg-boss job in one transaction. The separate worker records
the result in `sample_results`. The public command body rejects `failAfterInsert`.
Only the isolated test deployment sets `FLUX_TEST_FAILURE_INJECTION=true`; its
`X-Flux-Test-Failure: after-insert` header deliberately aborts after the domain,
event, outbox and job writes to verify rollback. A normal API deployment ignores
that header even with a valid fixture token.

```sh
FLUX_FIXTURE_TOKEN=$(sed -n 's/^FLUX_FIXTURE_TOKEN=//p' docker/.env)
curl -fsS -H "Authorization: Bearer $FLUX_FIXTURE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"title":"First sample"}' \
  http://127.0.0.1:8081/api/v1/integration/sample
docker compose --env-file docker/.env -p flux28 -f docker/compose.source.yaml exec -T db \
  psql -U flux -d flux -c 'SELECT s.id,s.title,r.processed_at FROM samples s LEFT JOIN sample_results r ON r.sample_id=s.id'
```

The command is versioned at `/api/v1/integration/sample`. Its wire types live in
`app/packages/contracts`; the standalone TypeScript client is `app/packages/sdk`. The
server's fixture module (`apps/server/src/fixture/`, #88) writes through the `@flux/db` sample repository and
is registered only when the fixture token is set; it does not expose database methods directly. The fixture token is temporary technical access; do
not expose this endpoint as a human or agent authorization scheme.

## Checks and isolation

The multi-stage Dockerfile runs locked dependency installation, build, type check
and lint. The production image contains compiled API, worker and migration JavaScript,
production dependencies, web assets and SQL migrations. API and worker run as UID 1000;
the separate `test` target retains TypeScript tooling for Docker checks. Run application
tooling through that `test` target, not the production runtime image.

Which check covers which tests, and where new tests go, is in
[architecture § Tests](architecture.md#tests); the Docker isolation rules (one Compose
project, port and volume set per run) are in [container development](containers.md).
Each check script uses its own Compose project and removes only its disposable test
volumes. To stop a work project without losing data, leave out `-v`:

```sh
docker compose --env-file docker/.env -p flux28 -f docker/compose.source.yaml down
```

`down` without `-v` keeps the work project's `pgdata` and `files` named volumes. Run the
manual start commands (or `./flux up`) again with the same project name to reuse them;
`files-init` is safe to repeat.

Recorded once, on the local Docker platform on 2026-09-27 (not re-measured since): the #29
image before the compiled runtime was 385,027,688 bytes and the compiled non-root runtime
image was 322,443,116 bytes (about 16% smaller). That image had UID 1000, compiled API,
worker and migration entry points, no `tsx` binary and no API TypeScript source. Image size
varies by platform and later dependency changes.

## Initial backup and restore

**Superseded by `./flux backup`, `./flux restore`, `./flux export` and `./flux upgrade`
(#123); see [operations](../operations/README.md).** The manual commands below remain as a
record of the procedure those commands automate.

Stop API and worker before backup so database rows and file bytes share one point
in time. The files volume is empty until file upload work arrives, but back it up
now so the procedure remains paired. Keep backup files outside the repository.

```sh
mkdir -p ../flux-backup
docker compose --env-file docker/.env -p flux28 -f docker/compose.source.yaml stop api worker
docker compose --env-file docker/.env -p flux28 -f docker/compose.source.yaml exec -T db \
  pg_dump -U flux -d flux -Fc > ../flux-backup/database.dump
docker run --rm -v flux28_files:/data:ro -v "$PWD/../flux-backup":/backup:Z \
  node@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 \
  tar -czf /backup/files.tar.gz -C /data .
```

To restore into an isolated project, start only its database, then load the dump
and files archive. Its database must be empty. Use the same PostgreSQL major
version. Run migration after restore to validate the schema, then start the API
and worker and inspect the restored sample.

```sh
FLUX_PORT=8082 docker compose --env-file docker/.env -p flux28restore -f docker/compose.source.yaml up -d --wait db
cat ../flux-backup/database.dump | docker compose --env-file docker/.env -p flux28restore -f docker/compose.source.yaml \
  exec -T db pg_restore -U flux -d flux --no-owner
docker run --rm -v flux28restore_files:/data -v "$PWD/../flux-backup":/backup:Z \
  node@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 \
  tar -xzf /backup/files.tar.gz -C /data
FLUX_PORT=8082 docker compose --env-file docker/.env -p flux28restore -f docker/compose.source.yaml up -d migrate
FLUX_PORT=8082 docker compose --env-file docker/.env -p flux28restore -f docker/compose.source.yaml --profile setup run --rm files-init
FLUX_PORT=8082 docker compose --env-file docker/.env -p flux28restore -f docker/compose.source.yaml up -d --wait api worker
```

The restore acceptance test with real data and project access is
`./scripts/check_backup.sh` ([backup and restore](../operations/backup-restore.md#verified-behavior)).

# Application foundation (issue #28)

This is the first technical slice of the Flux application. It starts a built browser
shell, a versioned API, a separate worker, PostgreSQL 18, a reviewed SQL migration,
and a durable pg-boss queue. Human login and sessions were added in #29's first
slice; project access and the messenger follow in later tasks. The integration
command below is a fixture, not a collaboration UI.

## Clean start

Prerequisites: Git and Docker Engine with Compose. No host Node or PostgreSQL is
needed. Clone the repository, copy `.env.example` to `.env`, and replace the three
placeholder secrets (`FLUX_AUTH_SECRET` is described in [identity](containers.md#identity-services-and-variables)). Use a unique Compose project name and port for each worker.
The project name also isolates its image tag, database and files volumes.
Passwords used in `DATABASE_URL` must be URL-safe for this first setup; use a long
random alphanumeric value. Do not commit `.env`.

```sh
cp .env.example .env
# Edit POSTGRES_PASSWORD, FLUX_FIXTURE_TOKEN and FLUX_AUTH_SECRET.
set -a; . ./.env; set +a
docker compose --env-file .env -p flux28 -f infra/compose.yaml up -d --build db migrate
docker compose --env-file .env -p flux28 -f infra/compose.yaml --profile setup run --rm files-init
docker compose --env-file .env -p flux28 -f infra/compose.yaml up -d --wait api worker
docker compose --env-file .env -p flux28 -f infra/compose.yaml ps
curl -fsS http://127.0.0.1:8081/api/v1/health
```

Open `http://127.0.0.1:8081/`. The API serves the built browser assets on the same
origin. Compose waits for PostgreSQL readiness and a successful one-shot migration
before starting API and worker. The one-shot `files-init` gives the non-root API and worker access to the named files volume, including an existing volume after an image upgrade. `migrate` applies each numbered `packages/db/migrations/NNNN_*.sql` once, in order, and
initializes the pg-boss schema and `sample.process` queue. If a migration fails,
the API and worker must not start. The API health endpoint checks the database,
Flux schema version, pg-boss schema and writable files volume.

To rerun the reviewed migration after a restore or source update:

```sh
docker compose --env-file .env -p flux28 -f infra/compose.yaml run --rm migrate
```

## Integration fixture

The fixture requires the secret bearer token from `.env`. It writes a sample row,
event, outbox entry and pg-boss job in one transaction. The separate worker records
the result in `sample_results`. The public command body rejects `failAfterInsert`.
Only the isolated test deployment sets `FLUX_TEST_FAILURE_INJECTION=true`; its
`X-Flux-Test-Failure: after-insert` header deliberately aborts after the domain,
event, outbox and job writes to verify rollback. A normal API deployment ignores
that header even with a valid fixture token.

```sh
curl -fsS -H "Authorization: Bearer $FLUX_FIXTURE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"title":"First sample"}' \
  http://127.0.0.1:8081/api/v1/integration/sample
docker compose --env-file .env -p flux28 -f infra/compose.yaml exec -T db \
  psql -U flux -d flux -c 'SELECT s.id,s.title,r.processed_at FROM samples s LEFT JOIN sample_results r ON r.sample_id=s.id'
```

The command is versioned at `/api/v1/integration/sample`. Its wire types live in
`packages/contracts`; the standalone TypeScript client is `packages/sdk`. The
server calls `packages/core` with an explicit `Principal` and does not expose
database methods directly. The fixture token is temporary technical access; do
not expose this endpoint as a human or agent authorization scheme.

## Checks and isolation

The multi-stage Dockerfile runs locked dependency installation, build, type check
and lint. The production image contains compiled API, worker and migration JavaScript,
production dependencies, web assets and SQL migrations. API and worker run as UID 1000;
the separate `test` target retains TypeScript tooling for Docker checks. Run focused integration tests against a fresh PostgreSQL volume using a
distinct Compose project. The test project may be removed with `down -v` because
it contains only test data; never do that to a work project.

```sh
./scripts/check_application.sh
./scripts/check_runtime.sh
docker compose --env-file .env -p flux28 -f infra/compose.yaml down
```

Each script uses its own Compose project and removes only its disposable test
volumes after the run. `down` without `-v` preserves the work project's `pgdata`
and `files` named volumes. Run the three clean-start commands again with the same
project name to reuse them; `files-init` is safe to repeat. Run application tooling
through the `test` build target, not the production runtime image.

On the local Docker platform on 2026-09-27, the #29 image before this change was
385,027,688 bytes and the compiled non-root runtime image was 322,443,116 bytes
(about 16% smaller). Inspection of the new image found UID 1000, compiled API,
worker and migration entry points, no `tsx` binary and no API TypeScript source.
Actual image size varies by platform and later dependency changes.

## Initial backup and restore

Stop API and worker before backup so database rows and file bytes share one point
in time. The files volume is empty until file upload work arrives, but back it up
now so the procedure remains paired. Keep backup files outside the repository.

```sh
mkdir -p ../flux-backup
docker compose --env-file .env -p flux28 -f infra/compose.yaml stop api worker
docker compose --env-file .env -p flux28 -f infra/compose.yaml exec -T db \
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
FLUX_PORT=8082 docker compose --env-file .env -p flux28restore -f infra/compose.yaml up -d --wait db
cat ../flux-backup/database.dump | docker compose --env-file .env -p flux28restore -f infra/compose.yaml \
  exec -T db pg_restore -U flux -d flux --no-owner
docker run --rm -v flux28restore_files:/data -v "$PWD/../flux-backup":/backup:Z \
  node@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 \
  tar -xzf /backup/files.tar.gz -C /data
FLUX_PORT=8082 docker compose --env-file .env -p flux28restore -f infra/compose.yaml up -d migrate
FLUX_PORT=8082 docker compose --env-file .env -p flux28restore -f infra/compose.yaml --profile setup run --rm files-init
FLUX_PORT=8082 docker compose --env-file .env -p flux28restore -f infra/compose.yaml up -d --wait api worker
```

An application release needs a full restore acceptance test with real uploaded
files and authorized project access. This foundation procedure does not claim it.

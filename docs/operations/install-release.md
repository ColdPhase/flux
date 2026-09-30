# Install Flux from a release

This is the path for an operator who runs a **published** Flux version without the source
code: Docker Engine with the Compose plugin pulls one image, `ghcr.io/coldphase/flux`, pinned
by its manifest digest, plus a digest-pinned PostgreSQL. No checkout, Node.js or build is
needed. Running the checked-out source is a different path: [`./flux up`](README.md).

**Status (2026-09-30).** No Flux release has been published yet. The operator files exist in
the repository as [`docker/compose.yaml`](../../docker/compose.yaml) and
[`docker/.env.example`](../../docker/.env.example) (issue
[#76](https://github.com/ColdPhase/flux/issues/76), phase 1). The repository copy carries the
marker `ghcr.io/coldphase/flux@sha256:RELEASE_DIGEST` on `api`, `worker` and `migrate`; the
release workflow ([#77](https://github.com/ColdPhase/flux/issues/77)) replaces it with the
accepted digest and attaches both files, with checksums and the release installation guide, to
the GitHub Release. Always use the copies from the release you install: a newer `main` can
need other migrations or variables than your image.

## Clean installation

1. Download `compose.yaml`, `.env.example` and `SHA256SUMS` from **one** GitHub Release into
   an empty directory, for example `/srv/flux`, and check them with `sha256sum -c SHA256SUMS`
   (macOS: `shasum -a 256 -c SHA256SUMS`).
2. Create the private settings file and fill in the three required values:

   ```sh
   cp .env.example .env && chmod 600 .env
   openssl rand -hex 32    # once for POSTGRES_PASSWORD, once for FLUX_AUTH_SECRET
   ```

   | Variable | Required | Value |
   | --- | --- | --- |
   | `POSTGRES_PASSWORD` | yes | Random hex (it is part of the database URL). |
   | `FLUX_AUTH_SECRET` | yes | At least 32 random characters. Changing it signs everyone out. |
   | `FLUX_PUBLIC_ORIGIN` | yes | The exact URL people open, e.g. `https://flux.example.org`. Plain `http` only for a loopback trial. |
   | `FLUX_PROJECT` | kept | Compose project and volume prefix (`flux`). Keep it across upgrades. |
   | `FLUX_PORT` | kept | Loopback port of the API (`8081`) for the reverse proxy. |
   | `FLUX_TRUSTED_PROXIES` | with a proxy | The proxy's IP/CIDR, so client addresses are taken from `X-Forwarded-For`. |
   | `FLUX_SMTP_URL`, `FLUX_MAIL_FROM` | optional | Password reset and notification mail. |
   | `FLUX_VAPID_*` | optional | Web Push, all three or none (step 3). |
   | `FLUX_FIXTURE_TOKEN` | no | Smoke checks only; leave empty. |

   The meaning of every variable is in [identity services](../development/containers.md#identity-services-and-variables)
   and [PWA and Web Push](../development/containers.md#pwa-and-web-push). Empty required
   values stop Compose before anything starts.
3. Optional Web Push keys, generated once with the release image; copy both values and a
   `mailto:` subject into `.env`:

   ```sh
   docker compose --env-file .env -f compose.yaml run --rm --no-deps -T migrate \
     apps/worker/node_modules/.bin/web-push generate-vapid-keys --json
   ```

4. Check, pull and start. `up` waits for PostgreSQL, runs the one-shot migration and starts
   API and worker only if it succeeded:

   ```sh
   docker compose --env-file .env -f compose.yaml config --quiet
   docker compose --env-file .env -f compose.yaml pull
   docker compose --env-file .env -f compose.yaml up -d --wait
   docker compose --env-file .env -f compose.yaml ps
   curl -fsS http://127.0.0.1:8081/api/v1/health   # {"status":"ok","schemaVersion":N}
   ```

5. Put a TLS reverse proxy in front of `127.0.0.1:${FLUX_PORT}` for `FLUX_PUBLIC_ORIGIN`,
   open that URL and create the first account. If startup fails, read
   `docker compose --env-file .env -f compose.yaml logs migrate api worker` before changing data.

`--env-file .env` is always passed explicitly, so the settings file is found from any shell
directory and no other `.env` is read. A variable exported in the shell overrides the file
(Compose precedence); do not export Flux variables on an operator host. From a repository
checkout the same files are used as
`docker compose --env-file docker/.env -f docker/compose.yaml …`, but only after a release
digest replaces the marker.

## What runs

| Service | Image | Role |
| --- | --- | --- |
| `db` | `postgres@sha256:…` | PostgreSQL 18, volume `pgdata`, not published. |
| `migrate` | release digest | One-shot `node infra/dist/migrate.js`: applies each new `packages/db/migrations/NNNN_*.sql` in its own transaction, then exits. |
| `api` | release digest | HTTP API and web app on `127.0.0.1:${FLUX_PORT}`, volume `files`; its health check verifies the exact migration ledger, the queue schema and a write to the files volume. |
| `worker` | release digest | Background jobs (notification mail, Web Push, runs), volume `files`. |

All Flux containers run as the image's non-root user; the image owns `/data/files`, so a new
`files` volume is writable without a setup step. The optional self-hosted live-media overlay
(`infra/compose.live.yaml`) is not part of this operator file yet.

## Upgrade, backup and restore

Back up PostgreSQL and the `files` volume as a pair while API and worker are stopped, and keep
`.env` with the backup: it holds the database password and `FLUX_AUTH_SECRET`. For an upgrade,
take that backup, download the new release's files into a new directory, copy the existing
`.env` there (same `FLUX_PROJECT`, so the same volumes), then `pull` and `up -d --wait` with the
new files. The migration runs at the new image revision before API and worker start. Forward
migrations are not assumed reversible: to go back, restore the backup with the **previous**
release's files, never just an older image over the migrated database.

The release's own installation guide carries the exact backup, upgrade and restore commands
for that version. The source-checkout equivalents are [`./flux backup` and
`./flux restore`](backup-restore.md) and [`./flux upgrade`](upgrade.md); they use
`infra/compose.yaml` and are not the release path.

## Verification

`./scripts/check_operator_compose.sh` exercises this file without a published image: it builds
the checked-out source image, writes a temporary copy of `docker/compose.yaml` with the marker
replaced by that local image and a `.env` generated from `docker/.env.example`, then runs
`config`, `up -d --wait`, health and schema checks, the migration ledger, sign-up, a workspace,
a worker job and a restart, and removes the project, volumes and image. Ports default to
`18951`; set `FLUX_OPERATOR_TEST_PORT` for a concurrent run.
`python3 -m unittest tests.test_operator_compose` checks the file statically (pull-only, one
marker on the three Flux services, digest pins, variables and placeholders). The real
GHCR pull, both platforms and the downloaded release assets are verified by #77.

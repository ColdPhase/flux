# Install and operate a versioned Flux release

Download `compose.yaml`, `.env.example`, `INSTALL.md`, `release.json`,
`sbom.spdx.json`, `THIRD_PARTY_NOTICES.json`, `LICENSE` and `SHA256SUMS` from
**one** GitHub Release into an empty directory. Compare the image digest and source
SHA in `release.json` with that release's acceptance record. Verify the files
before using them:

```sh
sha256sum -c SHA256SUMS
```

On macOS, use `shasum -a 256 -c SHA256SUMS` for the same check.

The Compose asset pins the same OCI manifest digest for `api`, `worker` and
`migrate`. Its PostgreSQL image is separately pinned. Docker Engine and the
Compose plugin are required; the application source and Node toolchain are not.
For public access, put a TLS reverse proxy in front of the loopback-bound API
and set `FLUX_PUBLIC_ORIGIN` to the exact HTTPS URL.

## Clean installation

Copy `.env.example` to `.env` and set long random `POSTGRES_PASSWORD` and
`FLUX_AUTH_SECRET` values, the public origin, and any desired SMTP and Web Push
settings. Keep `.env` private, outside source control, and preserve it across
upgrades. Do not use the example secrets. Then:

```sh
docker compose --env-file .env -p flux -f compose.yaml config --quiet
docker compose --env-file .env -p flux -f compose.yaml pull
docker compose --env-file .env -p flux -f compose.yaml up -d
docker compose --env-file .env -p flux -f compose.yaml ps
```

Open `FLUX_PUBLIC_ORIGIN` and create the first account through the documented
application flow. If setup or migration fails, inspect
`docker compose --env-file .env -p flux -f compose.yaml logs migrate api worker`
before changing data.

## Consistent backup

Back up PostgreSQL and uploaded files as a pair while writers are stopped. Plan
for downtime; do not run these commands during a live write. Keep the matching
release assets and `.env` (especially `FLUX_AUTH_SECRET`) with the encrypted
backup. Restrict archive access; it contains private workspace data.

```sh
docker compose --env-file .env -p flux -f compose.yaml stop api worker
docker compose --env-file .env -p flux -f compose.yaml exec -T db \
  sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' > flux-db.dump
docker compose --env-file .env -p flux -f compose.yaml run -T --rm --no-deps \
  --entrypoint tar api -C /data/files -cf - . > flux-files.tar
sha256sum flux-db.dump flux-files.tar > backup-SHA256SUMS
docker compose --env-file .env -p flux -f compose.yaml up -d
```

Confirm both archives are nonempty and store the checksums before treating the
backup as complete. A backup has been verified only after a restore test.

## Upgrade

Take and verify a paired backup first. Download and verify the **new version's**
assets into a separate directory. Copy your existing `.env` there; retain the
previous release directory, digest and backup. Stop the writers with the old
Compose file, then use the new files:

```sh
docker compose --env-file .env -p flux -f compose.yaml stop api worker
# In the new release directory, with the preserved .env:
docker compose --env-file .env -p flux -f compose.yaml pull
docker compose --env-file .env -p flux -f compose.yaml up -d
docker compose --env-file .env -p flux -f compose.yaml ps
```

The release migration runs at the new image revision before API and worker
startup. Downtime covers backup, pull, migration and startup. Forward SQL schema
migrations are not assumed reversible. If the upgrade fails, restore the paired
backup to a fresh deployment with the **previous** image and configuration; do
not merely switch the image tag over a migrated database.

## Restore test or recovery

Use an empty Compose project and empty volumes. Do not start `api`, `worker` or
`migrate` before importing the database. Copy the matching release assets,
original `.env`, `flux-db.dump`, `flux-files.tar` and `backup-SHA256SUMS` into
one directory. Change `FLUX_PORT` in the copied `.env` if the source deployment
still owns its port. After verifying checksums:

```sh
sha256sum -c backup-SHA256SUMS
docker compose --env-file .env -p flux-restore -f compose.yaml up -d db
docker compose --env-file .env -p flux-restore -f compose.yaml exec -T db \
  sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner' < flux-db.dump
docker compose --env-file .env -p flux-restore -f compose.yaml run -T --rm --no-deps \
  --entrypoint tar api -C /data/files -xf - < flux-files.tar
docker compose --env-file .env -p flux-restore -f compose.yaml up -d
docker compose --env-file .env -p flux-restore -f compose.yaml ps
```

On macOS, use `shasum -a 256 -c backup-SHA256SUMS` for that check.

Check an account, a project and an uploaded file before declaring recovery
successful. Restore support is bounded by the PostgreSQL major version and
schema compatibility recorded with the released artifact; use the same release
first, then perform a tested forward upgrade. The restore project uses separate
volumes because of its distinct Compose project name. Avoid `down -v` on a live
installation.

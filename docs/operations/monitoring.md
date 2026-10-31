# Health, monitoring and logs

## Health endpoint

`GET /api/v1/health` needs no sign-in. It answers `200` only when the database has exactly the
migrations of the running image, the job queue's schema matches, and the files volume takes a write:

```sh
curl -fsS https://flux.example.org/api/v1/health
# {"status":"ok","schemaVersion":137}
```

Anything else is `503 {"status":"unavailable"}`, and the API logs the reason as a warning. Point
your uptime monitor at it through the public address, so it checks the proxy and the certificate
too. It does not report the keyring, swap, email or push; those are below.

## Container health

| Service | Health check | Restart policy |
| --- | --- | --- |
| `db` | `pg_isready` every 2 s | `unless-stopped` |
| `migrate` | one-shot; must exit 0 before `api` and `worker` start | none |
| `api` | `/api/v1/health` inside the container every 3 s | `unless-stopped` |
| `worker` | none; watch that it is running | `unless-stopped` |
| `keyring` | its own boot-key route every 3 s (healthy and idle without a token) | `unless-stopped` |

`./flux up` and `docker compose … up --wait` wait for these. On a running instance:

```sh
cd /srv/flux
dc() { docker compose --env-file docker/.env -p "$(sed -n 's/^FLUX_PROJECT=//p' docker/.env)" -f docker/compose.source.yaml "$@"; }
dc ps            # STATUS shows (healthy), (unhealthy) or Restarting
docker stats     # memory against each container's limit
```

For a release installation use `docker compose --env-file .env -f compose.yaml ps` in its
directory.

## What is configured

These answer without signing in, so a monitor can also watch that optional features stay on:

| Request | Answers |
| --- | --- |
| `GET /api/v1/auth/capabilities` | `passwordReset` (`available` with email), `signup` (`open`, `verified` or `off` as in effect), `ssoOnly`, `sso` |
| `GET /api/v1/live-sessions/capabilities` | `configured` with the live-media overlay, else `unavailable` |

Push and email delivery show in each person's **Settings → Notifications**.

## Metrics

Flux has no metrics endpoint (Prometheus or other) in this version. Monitor the host and the
containers: CPU, memory against the limits (`FLUX_API_MEMORY` and friends), the disk holding Docker's
volumes, and the health endpoint. The optional TURN overlay gives the LiveKit server a `/metrics`
endpoint on its internal network only; see [live media](../development/live-media.md#compose-deployment).

## Logs

```sh
./flux logs                # all services, follows; Ctrl-C to stop
./flux logs api            # one service: api, worker, keyring, db, migrate
dc logs --since 1h worker  # with the helper above, without following
```

The API writes one JSON line per event (Fastify and pino): `level` is 30 for information, 40 for
warnings, 50 for errors. Request lines carry the method, the path **without its query string**, the
status and the client address; passwords and recovery codes in request bodies are redacted. The
keyring logs only that it is ready, idle or refuses to start, and its requests without bodies.
The encryption checks scan every container log for content of encrypted spaces and find none.

Useful filters:

```sh
dc logs --no-log-prefix api | grep -E '"level":(40|50)'      # warnings and errors
dc logs --no-log-prefix api | grep '"statusCode":5'          # server errors
```

**Rotation.** `api`, `worker`, `keyring`, `db` and `migrate` use Docker's default logging driver,
which keeps logs until the container is removed. Limit them for the whole daemon in
`/etc/docker/daemon.json`, then restart Docker:

```json
{ "log-driver": "json-file", "log-opts": { "max-size": "10m", "max-file": "5" } }
```

The agent runtime's services already rotate at 10 MB times 3 files.

## Disk

- `./flux backup --keep N` keeps the newest `N` archives of this project in the output
  directory and deletes older ones (and their `.sha256`). Without `--keep` nothing is deleted.
- Backups go to `backups/` and exports to `exports/` in the checkout by default (both ignored
  by git and by the Docker build context). `FLUX_BACKUP_DIR` or `--output` puts backups
  elsewhere, for example on a separate disk.
- A backup needs free space for about twice its size while it is written: the parts are staged
  in a hidden `.flux-backup-*.partial` directory next to the archive and removed afterwards.
- Docker keeps old images and the build cache. `./flux clean` removes this checkout's images
  (and data); `docker system df` shows the rest, and `docker builder prune --filter until=72h`
  reclaims build cache for the whole machine. Neither `backup`, `restore` nor `upgrade` prunes
  anything shared by other projects.
- The database volume grows with history (versions are never rewritten). Check it with
  `docker system df -v | grep <project>_pgdata`.

PostgreSQL keeps every version of every document, so the `pgdata` volume grows with use.

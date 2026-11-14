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
| `db` | `pg_isready` every 30 s | `unless-stopped` |
| `migrate` | one-shot; must exit 0 before `api` and `worker` start | none |
| `api` | `/api/v1/health` inside the container every 30 s | `unless-stopped` |
| `worker` | none; watch that it is running | `unless-stopped` |
| `keyring` | its own boot-key route every 30 s (healthy and idle without a token) | `unless-stopped` |

Each check is a small program of the image (`wget`, `nc`, `pg_isready`), not a Node process, and during
the first minute after a start it runs every quarter of a second, so a start is reported healthy as soon as it
is, and a slow first start (a new database, a long migration) is not counted as failing. After the
minute, three failures in a row make a container `unhealthy`.

`./flux up` and `docker compose … up --wait` wait for these. On a running instance:

```sh
cd /srv/flux
dc() { docker compose --env-file docker/release.env --env-file docker/.env -p "$(sed -n 's/^FLUX_PROJECT=//p' docker/.env)" -f docker/compose.yaml "$@"; }
dc ps            # STATUS shows (healthy), (unhealthy) or Restarting
docker stats     # memory against each container's limit
```

`docker/release.env` gives Compose the release's image names, as `./flux` does. A developer's source checkout uses
`--env-file docker/.env -f docker/compose.source.yaml` instead.

## What is configured

These answer without signing in, so a monitor can also watch that optional features stay on:

| Request | Answers |
| --- | --- |
| `GET /api/v1/auth/capabilities` | `passwordReset` (`available` with email), `signup` (`open`, `verified` or `off` as in effect), `ssoOnly`, `sso` |
| `GET /api/v1/live-sessions/capabilities` | `configured` with the live-media overlay, else `unavailable` |

Push and email delivery show in each person's **Settings → Notifications**.

## Security events

The API writes one structured line for each event an operator may want to alert on. Every line has `"channel":"security"`, an `event` and
an `outcome`, so one filter finds them all:

```sh
dc logs api | grep '"channel":"security"'
dc logs api | grep '"channel":"security"' | grep '"outcome":"failure"\|"outcome":"limited"'
```

| `event` | `outcome` | When | Fields besides the common ones |
| --- | --- | --- | --- |
| `sign_in` | `success`, `failure`, `limited` | A password sign-in. `failure` has `reason` `bad_credentials` or `email_not_verified`; `limited` is the account's own back-off (`account_back_off`) | `userId` on success, `account` otherwise |
| `rate_limited` | `limited` | The per-address limit answered `429` (`address_limit`) | `route` |
| `password_reset_requested` | `success` | A reset mail was asked for, whether or not the address has an account (the answer is the same) | `account` |
| `password_reset` | `success`, `failure` | A reset was completed, or its link was refused (`invalid_token`) | `userId` on success |
| `password_changed`, `email_changed` | `success`, `failure`, `limited` | Settings → Account. `failure` is a wrong current password (`bad_current_password`) | `userId` |
| `sessions_revoked` | `success` | `password_reset`, `password_change`, `sign_out_everywhere` or `one_session` | `userId`, `count` |
| `client_disconnected` | `success` | A local AI client was disconnected, by the person (`disconnect`) or with their sessions (`password_reset`, `password_change`, `sign_out_everywhere`) | `userId`, `count` |
| `oauth_consent` | `allowed`, `denied`, `refused` | The decision on a client's consent page. `allowed` is the connection being made | `userId`, `clientId` |
| `oauth_token` | `refused` | A client's code exchange or refresh was refused (`refresh_token:invalid_grant`), for instance after a disconnect | `clientId` |
| `origin_refused` | `refused` | A state-changing request from another origin (`foreign_origin`, `cross_site_request`, `foreign_referer`, `missing_origin`) | `route`, `ip` |
| `access_denied` | `denied`, `sampled` | A request the access policy refused with `403`; `reason` is the policy's code. At most ten per person a minute are written, then one `sampled` line | `userId`, `route` (the template, `GET /api/v1/projects/:projectId`) |
| `space_unlock`, `space_lock` | `success`, `failure` | An encrypted space was unlocked or locked; `failure` has the code (a wrong secret, a rate limit) | `userId`, `workspaceId` |

Common fields: `ip` (the client address Flux believes, see [trusting the proxy](reverse-proxy.md#trust-only-the-measured-proxy-peer)), `reqId`
(the id of the request's access-log lines, so `grep` finds both), and `level`: 40 (a warning) for every outcome other than `success` and `allowed`, which are 30.

An address that may belong to nobody (a failed sign-in) appears as `account`, a keyed hash: the same address always gives the same value, so
a spraying run against one account can be counted, and the log never holds the address. A line never holds a password, a token, a reset
link, a request body, a query string, a name or any content (the encrypted-space rule of F-030 applies to all of it).

Suggested alerts: more than 20 `sign_in` `failure` or `limited` lines a minute (spraying), several `account` values with `limited`, any
`origin_refused`, any `space_unlock` `failure`, and a rise in `access_denied` for one `userId`.

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
warnings, 50 for errors. Request lines carry the method, the path **without its query string** and with the
token of a reset link (`/api/auth/reset-password/<token>`) shown as `<token>`, the
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

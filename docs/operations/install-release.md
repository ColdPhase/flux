# Install Flux from a release

This is the path for an operator who runs a **published** Flux version without the source
code: Docker Engine with the Compose plugin pulls one image, `ghcr.io/coldphase/flux`, pinned
by its manifest digest, plus a digest-pinned PostgreSQL. No checkout, Node.js or build is
needed. Running the checked-out source is a different path: [`./flux up`](README.md).

Each GitHub Release carries these files: `compose.yaml` (the image pinned by digest), `env.example`
(the settings template; GitHub drops the leading period of `.env.example`), `INSTALL.md` (the
[release installation guide](release-guide.md)), `release.json`, software bills of materials,
third-party notices, `LICENSE` and `SHA256SUMS`, plus `compose.runtime.yaml` and `runtime.sh` for the
optional [agent runtime](agent-runtime.md#installing-from-a-release), and `compose.live.yaml` with
`compose.live.turn.yaml` for optional [calls and screen sharing](#calls-and-screen-sharing). v0.1
images are published for `linux/amd64` only; `linux/arm64` follows in v0.1.1. Always use the files from the
release you install: a newer `main` can need other migrations or variables than your image.

No release has been published yet; until one is, install [from a source checkout](install.md). The
repository copies, [`docker/compose.yaml`](../../docker/compose.yaml) and
[`docker/.env.example`](../../docker/.env.example), carry a placeholder digest and do not start as
they are.

## Clean installation

1. Download every asset of **one** GitHub Release into an empty directory, for example
   `/srv/flux`; the checksum file lists all of them. Check them with `sha256sum -c SHA256SUMS`
   (macOS: `shasum -a 256 -c SHA256SUMS`).
2. Create the private settings file and fill in the three required values:

   ```sh
   cp env.example .env && chmod 600 .env
   openssl rand -hex 32    # once for POSTGRES_PASSWORD, once for FLUX_AUTH_SECRET
   ```

   | Variable | Required | Value |
   | --- | --- | --- |
   | `POSTGRES_PASSWORD` | yes | Random hex (it is part of the database URL). |
   | `FLUX_AUTH_SECRET` | yes | At least 32 random characters. Changing it signs everyone out. |
   | `FLUX_PUBLIC_ORIGIN` | yes | The exact URL people open, e.g. `https://flux.example.org`. Plain `http` only for a loopback trial. |
   | `FLUX_PROJECT` | kept | Compose project and volume prefix (`flux`). Keep it across upgrades. |
   | `FLUX_PORT` | kept | Loopback port of the API (`8081`) for the reverse proxy. |
   | `FLUX_SIGNUP` | after your account | `open` until you have signed up; then decide [who can sign up](install.md#5-decide-who-can-sign-up). |
   | `FLUX_TRUSTED_PROXIES` | with a proxy | The proxy's IP/CIDR, so client addresses are taken from `X-Forwarded-For`. |
   | `FLUX_SMTP_URL`, `FLUX_MAIL_FROM` | optional | Password reset and notification mail. |
   | `FLUX_VAPID_*` | optional | Web Push, all three or none (step 3). |
   | `FLUX_LIVE_EDITING` | optional | Map/wiki collaboration: missing, empty or `on` enables it; `off` keeps ordinary saved views/editors. Other values stop startup. |
   | `FLUX_FIXTURE_TOKEN` | no | Smoke checks only; leave empty. |

   Every variable is described in the [configuration reference](configuration.md). Empty required
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

5. Follow the tested [HTTPS reverse-proxy example](reverse-proxy.md) to put TLS in front
   of `127.0.0.1:${FLUX_PORT}` for `FLUX_PUBLIC_ORIGIN`,
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
| `migrate` | release digest | One-shot `node tooling/dist/migrate.js`: applies each new `app/packages/db/migrations/NNNN_*.sql` in its own transaction, then exits. |
| `api` | release digest | HTTP API and web app on `127.0.0.1:${FLUX_PORT}`, volume `files`; its health check verifies the exact migration ledger, the queue schema and a write to the files volume. |
| `worker` | release digest | Background jobs (notification mail, Web Push, runs), volume `files`. |

With the optional `compose.runtime.yaml` (profile `runtime`, off by default) `runtime-manager` and
`runtime-egress` run the release digest of the application image, and `runtime-install` and
`runtime-1` to `runtime-4` the digest of the agent-runtime image; see
[agent runtime](agent-runtime.md#installing-from-a-release).

All Flux containers run as the image's non-root user; the image owns `/data/files`, so a new
`files` volume is writable without a setup step.

## Calls and screen sharing

Calls, cameras and screen sharing need the optional `compose.live.yaml` of the same release, layered
on `compose.yaml`. It adds one service, `livekit` (the LiveKit media server, pinned by digest and
recorded as `live_media_image` in `release.json`), and joins the API to an internal signaling
network. `compose.live.turn.yaml` adds TURN/TLS on TCP/443 for restrictive networks. Neither file
builds anything or uses a source path.

| Inbound to the media host | Purpose |
| --- | --- |
| UDP/7882 | Media (ICE over UDP) |
| TCP/7881 | Media over TCP |
| UDP/3478 | STUN and TURN over UDP |
| TCP/443 on a second address | TURN/TLS, only with `compose.live.turn.yaml` |

TCP/7880 (signaling) is never published: browsers reach it only through the API at
`<FLUX_PUBLIC_ORIGIN>/media`, behind your existing reverse proxy. The settings
(`FLUX_LIVEKIT_*`), the firewall, the start commands and switching off are in `INSTALL.md`
([source](release-guide.md#calls-and-screen-sharing-optional)); every variable is in the
[configuration reference](configuration.md#live-media-livekit-and-turn). Once calls are on, pass
`-f compose.live.yaml` to every `docker compose` command. Design and measurements:
[live media](../development/live-media.md).

## Upgrade, backup and restore

Map/wiki collaboration uses the same API, PostgreSQL and whole-origin WebSocket proxy; it needs no
live-media service or AI connection. For a planned opt-out, save each shared working copy first,
set `FLUX_LIVE_EDITING=off` in `.env` and recreate the API with the normal `up -d --wait` command.
The capability then reports unavailable and the ordinary saved views/editors are used. If a shared
copy was unsaved when disabled, its acknowledged text remains stored and ordinary writes to that
page are refused. Re-enable collaboration, recover and save that text, then disable again. Do not
delete live tables or restore an older schema to turn collaboration off; immutable saved versions
and citations remain unchanged. An already open browser page should be reloaded after changing the
operator setting, since its capability is cached for that page visit.

Back up PostgreSQL and the `files` volume as a pair while API and worker are stopped, and keep
`.env` with the backup: it holds the database password and `FLUX_AUTH_SECRET`. For an upgrade,
take that backup, download the new release's files into a new directory, copy the existing
`.env` there (same `FLUX_PROJECT`, so the same volumes), then `pull` and `up -d --wait` with the
new files. The migration runs at the new image revision before API and worker start. Forward
migrations are not assumed reversible: to go back, restore the backup with the **previous**
release's files, never just an older image over the migrated database.

The release's own installation guide, `INSTALL.md` ([source](release-guide.md)), carries the
exact backup, upgrade and restore commands for that version. The source-checkout equivalents are
[`./flux backup` and `./flux restore`](backup-restore.md) and [`./flux upgrade`](upgrade.md); they
use `docker/compose.source.yaml` and are not the release path.

## Verification

`./scripts/check_operator_compose.sh` exercises this file without a published image: it builds
the checked-out source image, writes a temporary copy of `docker/compose.yaml` with the marker
replaced by that local image and a `.env` generated from `docker/.env.example`, then runs
`config`, `up -d --wait`, health and schema checks, the exact ledger against the migration
manifest inside that image, sign-up, a workspace,
a worker job and a restart, and removes the project, volumes and image. Ports default to
`18951`; set `FLUX_OPERATOR_TEST_PORT` for a concurrent run.
`python3 -m unittest tests.test_operator_compose` checks the file statically (pull-only, one
marker on the three Flux services, digest pins, variables and placeholders), and
`tests.test_release_assets` renders the real files into a release asset set. The real GHCR pull,
the published platforms (`linux/amd64` for v0.1) and the downloaded release assets are verified by the release workflow: its `final-release.yml`
installs the packaged, digest-pinned release, creates an account and workspace, takes a paired
backup and restores it into a second project (`scripts/release/smoke_artifacts.sh`), and an
independent reviewer repeats that before publication. The same workflow then
installs the packaged agent runtime (`scripts/release/smoke_runtime.sh`: off by default, switch-on,
`docker inspect` limits, no Claude Code in the image, off and purge) and
`scripts/release/compare_runtime_overlay.py` checks the overlay against `docker/compose.source.yaml`.
`scripts/release/check_live_overlay.sh` resolves the packaged `compose.live.yaml` (and the TURN file)
on the packaged `compose.yaml` with `docker compose config` and checks the pinned media image, the
networks and the published ports.

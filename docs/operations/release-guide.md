# Install and operate a versioned Flux release

This is the installation guide that ships with one Flux release as `INSTALL.md`; its source is
`docs/operations/release-guide.md` in the repository. Use the files of **one** GitHub Release
together: the image digest, the migrations and the settings in them match. A newer `main` branch
can need other migrations or variables than your release.

The release pins one OCI image, `ghcr.io/coldphase/flux`, by its manifest digest for `api`,
`worker` and the one-shot `migrate` service, plus a separately digest-pinned PostgreSQL. The image
is built for the platforms that `release.json` lists: `linux/amd64` (x86_64) for v0.1, with
`linux/arm64` planned for v0.1.1. Docker Engine with the Compose plugin is required;
the source code and the Node toolchain are not. The optional [agent runtime](#agent-runtime-optional)
adds a second image, `ghcr.io/coldphase/flux-agent-runtime`, also pinned by digest and built for the
same platforms; an installation that never switches the runtime on never pulls it. Optional
[calls and screen sharing](#calls-and-screen-sharing-optional) add the LiveKit media server, pinned by
digest in `compose.live.yaml`; an installation that never loads that file runs no media server.

## Files

Download **every** asset of the release into an empty directory:

| Asset | Purpose |
| --- | --- |
| `compose.yaml` | The pull-only Compose file for this release. |
| `compose.runtime.yaml` | Optional second Compose file for the [agent runtime](#agent-runtime-optional): off unless you switch it on. Pins the runtime image and the application image by digest. |
| `runtime.sh` | Operator script for the runtime: `on`, `off`, `up`, `status`, `release`, `purge`. Run it with `sh`. |
| `compose.live.yaml` | Optional Compose file for [calls and screen sharing](#calls-and-screen-sharing-optional): the LiveKit media server (SFU), pinned by digest. |
| `compose.live.turn.yaml` | Optional addition to `compose.live.yaml`: TURN/TLS on TCP/443 for people behind restrictive networks. |
| `env.example` | Settings template; you copy it to `.env`. GitHub does not keep a leading period in an asset name, so the repository's `.env.example` is published under this name. |
| `INSTALL.md` | This guide. |
| `release.json` | Version, source commit and both images (`ghcr.io/coldphase/flux@sha256:…`, `ghcr.io/coldphase/flux-agent-runtime@sha256:…`) with their platforms, the pinned Codex release and the media server image (`live_media_image`). |
| `sbom.spdx.json`, `THIRD_PARTY_NOTICES.json` | SPDX software bill of materials of the application image and the dependency notices derived from it. |
| `sbom-agent-runtime.spdx.json`, `THIRD_PARTY_NOTICES.agent-runtime.json` | The same for the agent-runtime image; the notices also record the pinned official Codex (Apache-2.0). |
| `LICENSE` | The Flux license. |
| `SHA256SUMS` | SHA-256 of every other asset. |

Check them before use. Compare the version, source commit and image in `release.json` with the
release notes:

```sh
sha256sum -c SHA256SUMS      # macOS: shasum -a 256 -c SHA256SUMS
```

Optional, with the [GitHub CLI](https://cli.github.com/): verify the build provenance that was
attested for the exact image named by the `image` field of `release.json`:

```sh
gh attestation verify oci://ghcr.io/coldphase/flux@sha256:<digest from release.json> --repo ColdPhase/flux
gh attestation verify oci://ghcr.io/coldphase/flux-agent-runtime@sha256:<runtime digest from release.json> --repo ColdPhase/flux
```

## Clean installation

1. Create the private settings file and fill in the three required values:

   ```sh
   cp env.example .env && chmod 600 .env
   openssl rand -hex 32    # once for POSTGRES_PASSWORD, once for FLUX_AUTH_SECRET
   ```

   Without `openssl`: `od -An -N32 -tx1 /dev/urandom | tr -d ' \n'`. Keep `.env` private, outside
   source control, and keep it across upgrades: the database password and `FLUX_AUTH_SECRET` must not
   change. Do not use example secrets.

   | Variable | Required | Value |
   | --- | --- | --- |
   | `POSTGRES_PASSWORD` | yes | Random hex (it is part of the database URL). |
   | `FLUX_AUTH_SECRET` | yes | At least 32 random characters. Changing it signs everyone out. |
   | `FLUX_PUBLIC_ORIGIN` | yes | The exact URL people open, for example `https://flux.example.org`. Plain `http` works only for a loopback trial (`http://127.0.0.1:8081`). |
   | `FLUX_PROJECT` | kept | Compose project name and prefix of the `pgdata` and `files` volumes (`flux`). Keep it across upgrades, or the new release starts with empty volumes. |
   | `FLUX_PORT` | kept | Loopback port of the API (`8081`); point the reverse proxy at it. |
   | `FLUX_TRUSTED_PROXIES` | with a proxy | The proxy's IP or CIDR, so client addresses come from `X-Forwarded-For`. |
   | `FLUX_SMTP_URL`, `FLUX_MAIL_FROM` | optional | Password reset and notification mail. |
   | `FLUX_VAPID_PUBLIC_KEY`, `FLUX_VAPID_PRIVATE_KEY`, `FLUX_VAPID_SUBJECT` | optional | Web Push: all three or none. The subject must be a contact Apple can reach (`mailto:` at your domain or your https origin); otherwise iPhone and iPad notifications fail with 403. |
   | `FLUX_FIXTURE_TOKEN` | no | Enables a test-only endpoint. Leave it empty. |

   Every value is explained in the comments of `env.example`. Empty required values stop Compose
   before anything starts. `--env-file .env` is always passed explicitly, and a variable exported in
   the shell overrides the file: do not export Flux variables on an operator host.

2. Optional Web Push keys, generated once with the release image; copy both keys and a `mailto:`
   subject into `.env`:

   ```sh
   docker compose --env-file .env -f compose.yaml run --rm --no-deps -T migrate \
     apps/worker/node_modules/.bin/web-push generate-vapid-keys --json
   ```

3. Check, pull and start. `up` waits for PostgreSQL, runs the one-shot migration and starts the API
   and the worker only after it succeeded:

   ```sh
   docker compose --env-file .env -f compose.yaml config --quiet
   docker compose --env-file .env -f compose.yaml pull
   docker compose --env-file .env -f compose.yaml up -d --wait
   docker compose --env-file .env -f compose.yaml ps
   curl -fsS http://127.0.0.1:8081/api/v1/health    # {"status":"ok","schemaVersion":N}; use your FLUX_PORT
   ```

4. Follow the tested [HTTPS reverse-proxy example](https://github.com/ColdPhase/flux/blob/f3a253ce860d7f22b6cd28fa0525a4589df3daf7/docs/operations/reverse-proxy.md)
   to put TLS in front of `127.0.0.1:<FLUX_PORT>` for `FLUX_PUBLIC_ORIGIN`, open that
   URL and create the first account. If startup fails, read
   `docker compose --env-file .env -f compose.yaml logs migrate api worker` before changing data.

   If `up` stops with `all predefined address pools have been fully subnetted`, the Docker daemon has no
   network subnet left: Flux takes 2 networks (10 with the agent runtime), and a stock daemon has about 31 for
   all projects on the host. Stop other Compose projects you no longer run, or set
   smaller pools in `/etc/docker/daemon.json`, for example
   `{"default-address-pools": [{"base": "172.17.0.0/12", "size": 24}, {"base": "192.168.0.0/16", "size": 24}]}`,
   and restart the daemon ([reference](https://docs.docker.com/reference/cli/dockerd/#daemon-configuration-file)).

## Agent runtime (optional)

Off by default and not needed for Flux itself. It lets people on this Flux sign in with their own
ChatGPT (Codex) and Claude (Claude Code) subscriptions; Flux runs each person's official CLI in an
isolated slot. Read the [operator guide](https://github.com/ColdPhase/flux/blob/main/docs/operations/agent-runtime.md)
first (its commands for a source checkout are `./flux ...`; here the same steps are `sh runtime.sh ...`).

- **Linux host requirement.** Every slot needs the Linux kernel setting `kernel.yama.ptrace_scope` of 1 or
  higher (check: `cat /proc/sys/kernel/yama/ptrace_scope`); a missing policy or `0` stops the slot
  before it listens. Docker Desktop is unsupported (its kernel has no Yama). The engine must support
  `internal` networks, a read-only root filesystem, dropped capabilities and process, memory and CPU limits.
- **Your duty for Claude Code.** Flux never ships Claude Code in an image. Enabling it installs
  Anthropic's signed official release into a volume and needs your own agreement to Anthropic's
  Commercial Terms with Anthropic. Pass the date you agreed: Flux records the statement, it does not check it.
  Codex needs no statement; its pinned release is part of the runtime image.
- **You can read every owner's login.** The CLIs keep each owner's login in that owner's slot volume, readable by
  host root and by anyone who can read your disks or snapshots. Offer the runtime only where owners trust you.

Switch it on (the script writes `FLUX_AGENT_RUNTIME`, generates the missing secrets in `.env`, pulls the
runtime image by its digest and starts the runtime services next to Flux):

```sh
sh runtime.sh on codex                                       # or claude_code, or claude_code,codex
sh runtime.sh on claude_code,codex --commercial-terms 2026-10-05   # the date you agreed with Anthropic
sh runtime.sh status        # the four slots and what each reports
```

Once it is on, **always use `sh runtime.sh up` or pass both files**. A plain `docker compose --env-file .env -f compose.yaml up`
recreates `api` and `worker` without the runtime settings, which switches it off for them:

```sh
docker compose --env-file .env -f compose.yaml -f compose.runtime.yaml --profile runtime ps
```

What runs: `runtime-manager` (no database, no Docker access), `runtime-egress` (the slots' only way out:
HTTPS to the hosts of the enabled CLIs and Flux's `/mcp`), the one-shot `runtime-install` (a no-op unless
`claude_code` is enabled) and four slots `runtime-1` to `runtime-4`. Each slot has a non-root user, a read-only root
filesystem, no capabilities, no new privileges, 2 GiB of memory without swap, one CPU, 256 processes, its own volume and
its own internal network. No service mounts a Docker or Podman socket. A pool of four fills for good unless
you release bindings: `sh runtime.sh release runtime-<n>` signs that owner's CLIs out, deletes their login files and frees
the slot. More than four slots are not covered by the release assets.

- **Switch off:** `sh runtime.sh off` stops the runtime services; slot volumes and logins stay.
- **Remove the logins for good:** `sh runtime.sh purge` signs every CLI out (best effort), deletes the slot volumes and
  the tools volume. Then keep the runtime off. Run it before `down -v` if you uninstall.
- **Backups never contain a slot volume** (the logins must not travel in backups and cannot be moved between
  machines). A restore reconciles the restored bindings with the slots when the worker starts. A disk or
  host snapshot does capture the slot volumes. Add `-f compose.runtime.yaml` to the backup, upgrade and restore
  commands below while the runtime is on, or use `sh runtime.sh up` instead of their last `up`.

## Calls and screen sharing (optional)

Calls, cameras and screen sharing in live sessions need a media server. The release ships it as
`compose.live.yaml`: one LiveKit server (`livekit`), pinned by the digest that `release.json` names as
`live_media_image`. Without this file everything else in Flux works; only calls are unavailable.

How it connects. Browsers sign in to media through Flux itself, at `<FLUX_PUBLIC_ORIGIN>/media`: the API
checks the session and project access, then forwards to LiveKit on an internal network. Your existing
HTTPS reverse proxy already carries this path; it needs no change. The audio and video then flow
**directly** between the browsers and this host's media ports, not through the reverse proxy. LiveKit's
signaling port (TCP/7880) is never published. Media is encrypted in transit and decrypted in the media
server; it is not end-to-end encrypted. A room holds at most 16 people (a configured ceiling, not a
measured capacity).

You need a public IPv4 address that browsers reach directly, and a DNS name for media that points to it.

1. Add these settings to `.env` (they are not in `env.example`, because only this file uses them):

   | Variable | Required | Value |
   | --- | --- | --- |
   | `FLUX_LIVEKIT_API_KEY` | yes | A name for the key, for example `media-key-1`. |
   | `FLUX_LIVEKIT_API_SECRET` | yes | At least 32 random characters: `openssl rand -hex 32`. |
   | `FLUX_LIVEKIT_PUBLIC_IP` | yes | The public IPv4 address browsers send media to. Behind NAT, the router's public address. |
   | `FLUX_LIVEKIT_DOMAIN` | yes | DNS name of that address, for STUN and TURN/UDP, for example `media.example.org`. |
   | `FLUX_LIVEKIT_MEDIA_CIDR` | with several interfaces | The media interface as `/32` (for example `203.0.113.20/32`). Empty keeps every IPv4 interface. |
   | `FLUX_LIVEKIT_ICE_UDP_PORT`, `FLUX_LIVEKIT_ICE_TCP_PORT`, `FLUX_LIVEKIT_TURN_UDP_PORT` | optional | Host ports; defaults `7882`, `7881` and `3478`. |

2. Open the media ports in the host firewall and any cloud security group, and with NAT forward them to
   this host:

   | Inbound | Purpose |
   | --- | --- |
   | UDP/7882 | Media (ICE over UDP). The main path. |
   | TCP/7881 | Media over TCP, when UDP is blocked. |
   | UDP/3478 | STUN and TURN over UDP. |
   | TCP/443 on the TURN address | TURN/TLS, only with `compose.live.turn.yaml` (step 4). |

   Do not open TCP/7880. The HTTPS port of your reverse proxy stays as it is.

3. Check, pull and start with **both** files:

   ```sh
   docker compose --env-file .env -f compose.yaml -f compose.live.yaml config --quiet
   docker compose --env-file .env -f compose.yaml -f compose.live.yaml pull
   docker compose --env-file .env -f compose.yaml -f compose.live.yaml up -d --wait
   docker compose --env-file .env -f compose.yaml -f compose.live.yaml ps livekit
   ```

   Then start a live session in a project and join it from a second device on another network (a
   phone on mobile data). A healthy `livekit` proves only that it started, not that media reaches it
   from outside.

4. Optional, for people whose networks allow only HTTPS: add `compose.live.turn.yaml` after
   `compose.live.yaml` in every command. It serves TURN/TLS on TCP/443 inside LiveKit, so it needs a
   **second public IP address** (your reverse proxy already holds 443 on the first) or a layer-4 TCP
   load balancer; an HTTP reverse proxy cannot carry it. Add to `.env`:

   | Variable | Required | Value |
   | --- | --- | --- |
   | `FLUX_LIVEKIT_TURN_DOMAIN` | yes | A DNS name only for TURN, for example `turn.example.org`, pointing to the second address. |
   | `FLUX_LIVEKIT_TURN_CERT_DIR` | yes | Absolute host directory with `fullchain.pem` and `privkey.pem` from a public CA for that name, readable by the container. Renew them and restart `livekit`. |
   | `FLUX_LIVEKIT_TURN_TLS_BIND` | yes, in practice | The second public address. The default `0.0.0.0` collides with the reverse proxy on 443. |
   | `FLUX_LIVEKIT_TURN_TLS_HOST_PORT` | optional | Keep `443`. |

   With this file, STUN and TURN/UDP use `FLUX_LIVEKIT_TURN_DOMAIN` instead of `FLUX_LIVEKIT_DOMAIN`.

Once calls are on, **pass `-f compose.live.yaml` (and `-f compose.live.turn.yaml` if you use it) to every
command** in this guide, including backup, upgrade and restore, next to `-f compose.runtime.yaml` if the
agent runtime is on. A plain `-f compose.yaml up` recreates `api` without the media settings, which
switches calls off. To switch calls off on purpose, run
`docker compose --env-file .env -f compose.yaml up -d --wait --remove-orphans`. The media server keeps no
data, so a backup needs nothing more. Keep `FLUX_LIVEKIT_API_SECRET` as private as `.env`; to rotate it,
change it and run `up` with both files: the API and LiveKit read the same value. A restart of `livekit`
interrupts current calls; people rejoin.

## Consistent backup

Back up PostgreSQL and the uploaded files as a pair while the writers (`api` and `worker`) are
stopped. Plan for downtime; do not run these commands during a live write. Keep the matching release
files and `.env` (especially `FLUX_AUTH_SECRET` and the VAPID keys) with the backup, and restrict
access to it: it contains private workspace data.

```sh
docker compose --env-file .env -f compose.yaml stop api worker
docker compose --env-file .env -f compose.yaml exec -T db \
  sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' > flux-db.dump
docker compose --env-file .env -f compose.yaml run -T --rm --no-deps \
  --entrypoint tar api -C /data/files -cf - . > flux-files.tar
sha256sum flux-db.dump flux-files.tar > backup-SHA256SUMS
docker compose --env-file .env -f compose.yaml up -d --wait
```

All commands must succeed. Confirm that both archives are non-empty, copy them with
`backup-SHA256SUMS` off the machine, and treat the backup as verified only after a restore test.

## Upgrade

1. Take and verify a paired backup with the **old** release first.
2. Download and verify the **new** release's assets into a new directory. Keep the old directory, its
   image digest and the backup.
3. Copy your existing `.env` into the new directory, unchanged: the same `FLUX_PROJECT` keeps the same
   volumes. Compare the new `env.example` with your `.env`; add a new setting that your file lacks
   (a new required one stops Compose before anything starts).
4. Stop the writers with the **old** files, then pull and start with the new ones:

   ```sh
   # old release directory
   docker compose --env-file .env -f compose.yaml stop api worker
   # new release directory, with the preserved .env
   docker compose --env-file .env -f compose.yaml config --quiet
   docker compose --env-file .env -f compose.yaml pull
   docker compose --env-file .env -f compose.yaml up -d --wait
   docker compose --env-file .env -f compose.yaml ps
   ```

The migration runs at the new image revision before the API and the worker start. Downtime covers
the backup, the pull, the migration and the startup. Forward SQL migrations are not assumed
reversible. If the upgrade fails, restore the paired backup to a fresh deployment with the
**previous** release's files and configuration; do not merely point the old Compose file at a newer
or older image over a migrated database.

The `postgres@sha256:…` line of `compose.yaml` selects the PostgreSQL version. If it differs between
the two releases and the major version changes, the data directory does not carry over: restore the
backup into a fresh installation of the new release instead of upgrading in place.

## Restore test or recovery

Use an empty Compose project with its own volumes, and do not start `api`, `worker` or `migrate`
before the database is imported. Put the matching release files, the original `.env`,
`flux-db.dump`, `flux-files.tar` and `backup-SHA256SUMS` into one directory, then copy `.env` to
`restore.env` and change `FLUX_PORT` and `FLUX_PUBLIC_ORIGIN` to the address that the restored
instance will use (a restore test on the same host needs a free port; sign-in accepts only the
public origin and agent connections are bound to it). Keep every secret unchanged.

```sh
sha256sum -c backup-SHA256SUMS      # macOS: shasum -a 256 -c backup-SHA256SUMS
docker compose --env-file restore.env -p flux-restore -f compose.yaml up -d --wait db
docker compose --env-file restore.env -p flux-restore -f compose.yaml exec -T db \
  sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --exit-on-error' < flux-db.dump
docker compose --env-file restore.env -p flux-restore -f compose.yaml run -T --rm --no-deps \
  --entrypoint tar api -C /data/files -xf - < flux-files.tar
# optional, see below: revoke agent access here, before anything can use it
docker compose --env-file restore.env -p flux-restore -f compose.yaml up -d --wait
```

`-p flux-restore` selects another project, so the restore uses its own volumes. On a replacement
machine you can keep your original `FLUX_PROJECT` and leave `-p` out. Check an account, a project
and an uploaded file before declaring recovery successful, and never run `down -v` on a live
installation.

A restore brings the data back **as it was when the backup was taken**: access that was revoked later
(sessions, memberships, personal agent connections and their OAuth tokens) is active again. After
restoring an older backup, or whenever a token may have leaked, revoke every agent connection and
OAuth token before the last `up` above starts the API; people connect their agents again afterwards:

```sh
docker compose --env-file restore.env -p flux-restore -f compose.yaml run --rm --no-deps -T \
  migrate node tooling/dist/operations.js revoke-agent-access
```

Restore support is bounded by the PostgreSQL major version and the schema of the release that wrote
the backup: restore with the same release first, then perform a tested forward upgrade.

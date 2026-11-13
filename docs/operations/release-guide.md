# Install and operate a versioned Flux release

This is the installation guide that ships with one Flux release as `INSTALL.md`; its source is
`docs/operations/release-guide.md` in the repository. Use the files of **one** GitHub Release
together: the image digest, the migrations and the settings in them match. A newer `main` branch
can need other migrations or variables than your release.

**v0.2 is installed fresh.** v0.1 had no users, so v0.2 does not upgrade a v0.1 installation: its migration step
refuses a database that v0.1 wrote and leaves it untouched ([Upgrade](#upgrade)). One Flux is one company: the first account,
made from the setup link (`FLUX_SETUP_TOKEN`), sets it up and owns it; everyone else joins from an invite link or single sign-on.

The release pins one OCI image, `ghcr.io/coldphase/flux`, by its manifest digest for `api`,
`worker`, `keyring` and the one-shot `migrate` service, plus a separately digest-pinned PostgreSQL. The image
is built for the platforms that `release.json` lists: `linux/amd64` (x86_64) for v0.2, with
`linux/arm64` planned for v0.3. Docker Engine 25 or newer with the Compose plugin is required (Compose refuses to start the services on an older engine);
the source code and the Node toolchain are not. The optional [agent runtime](#agent-runtime-optional)
adds a second image, `ghcr.io/coldphase/flux-agent-runtime`, also pinned by digest and built for the
same platforms; an installation that never switches the runtime on never pulls it. Optional
[calls and screen sharing](#calls-and-screen-sharing-optional) add the LiveKit media server, pinned by
digest in `compose.live.yaml`; an installation that never loads that file runs no media server. Optional
[local embeddings](#local-embeddings-optional) add a text-embeddings-inference container, pinned by digest in
`compose.embeddings.yaml`; an installation that never loads that file runs no embedding container and stores no vector.

## Files

Download **every** asset of the release into an empty directory:

| Asset | Purpose |
| --- | --- |
| `compose.yaml` | The pull-only Compose file for this release. |
| `compose.runtime.yaml` | Optional second Compose file for the [agent runtime](#agent-runtime-optional): off unless you switch it on. Pins the runtime image and the application image by digest. |
| `runtime.sh` | Operator script for the runtime: `on`, `off`, `up`, `status`, `release`, `purge`. Run it with `sh`. |
| `compose.live.yaml` | Optional Compose file for [calls and screen sharing](#calls-and-screen-sharing-optional): the LiveKit media server (SFU), pinned by digest. |
| `compose.live.turn.yaml` | Optional addition to `compose.live.yaml`: TURN/TLS on TCP/443 for people behind restrictive networks. |
| `compose.embeddings.yaml` | Optional Compose file for [local embeddings](#local-embeddings-optional): search also ranks by meaning. One text-embeddings-inference container (bge-m3), pinned by digest. |
| `env.example` | Settings template; you copy it to `.env`. GitHub does not keep a leading period in an asset name, so the repository's `.env.example` is published under this name. |
| `INSTALL.md` | This guide. |
| `release.json` | Version, source commit and the images (`ghcr.io/coldphase/flux@sha256:…`, `ghcr.io/coldphase/flux-agent-runtime@sha256:…` and, from v0.2.1, the database image `ghcr.io/coldphase/flux-database@sha256:…`) with their platforms, the pinned Codex release, the media server image (`live_media_image`) and the embedding server image (`embeddings_image`). |
| `sbom.spdx.json`, `THIRD_PARTY_NOTICES.json` | SPDX software bill of materials of the application image and the dependency notices derived from it. |
| `sbom-agent-runtime.spdx.json`, `THIRD_PARTY_NOTICES.agent-runtime.json` | The same for the agent-runtime image; the notices also record the pinned official Codex (Apache-2.0). |
| `sbom-database.spdx.json`, `THIRD_PARTY_NOTICES.database.json` | The same for the database image (PostgreSQL 18 with `pg_search`, AGPL-3.0-or-later, and `pgvector`; [F-042](https://github.com/ColdPhase/flux/blob/main/docs/product/decisions.md#f-042--agents-find-what-they-need-with-bm25-search-in-postgresql)). |
| `LICENSE` | The Flux license. |
| `SHA256SUMS` | SHA-256 of every other asset. |

Check them before use. Compare the version, source commit and image in `release.json` with the
release notes:

```sh
sha256sum -c SHA256SUMS      # macOS: shasum -a 256 -c SHA256SUMS
```

### Verify the images before you pull them

The images are **signed** by the release workflow and carry a **build provenance attestation**. Check
each before the first pull, for the exact digests that `release.json` names (the `image`, `runtime_image`
and `database_image` fields), with [cosign](https://docs.sigstore.dev/cosign/system_config/installation/) **v3 or later** (the release workflow signs with
cosign v3, whose signature format an older `cosign verify` may not find) and the
[GitHub CLI](https://cli.github.com/):

```sh
IMAGE=$(jq -r .image release.json)               # ghcr.io/coldphase/flux@sha256:...
RUNTIME=$(jq -r .runtime_image release.json)     # ghcr.io/coldphase/flux-agent-runtime@sha256:...
DATABASE=$(jq -r .database_image release.json)   # ghcr.io/coldphase/flux-database@sha256:...

# 1. The signature. It is keyless (Sigstore, GitHub's OIDC identity): no key to fetch or trust. This asks for a
#    signature made by this repository's release workflow on main, and fails for anything else.
for image in "$IMAGE" "$RUNTIME" "$DATABASE"; do
  cosign verify "$image" \
    --certificate-identity-regexp '^https://github\.com/ColdPhase/flux/\.github/workflows/final-release\.yml@refs/heads/main$' \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com
done

# 2. The build provenance (SLSA): the image was built by that workflow from the source commit in release.json.
for image in "$IMAGE" "$RUNTIME" "$DATABASE"; do
  gh attestation verify "oci://$image" --repo ColdPhase/flux
done
```

A signature means this workflow built that exact digest from an independently accepted commit and the
digest passed its image scan and packaged install; it is checked again before a draft becomes a release
(`scripts/release/verify_signatures.sh`). It does not mean the software is free of bugs. If `cosign verify` or
`gh attestation verify` fails, do not pull: ask in the project's issues. Verifying by digest also protects
you from a tag that moves, which is why `compose.yaml` pins digests.

## Clean installation

1. Create the private settings file and fill in the five required values:

   ```sh
   cp env.example .env && chmod 600 .env
   openssl rand -hex 32    # once each for POSTGRES_PASSWORD, FLUX_AUTH_SECRET, FLUX_KEYRING_TOKEN and FLUX_KEY_PIN_SECRET
   ```

   Without `openssl`: `od -An -N32 -tx1 /dev/urandom | tr -d ' \n'`. Keep `.env` private, outside
   source control, and keep it across upgrades: the database password, `FLUX_AUTH_SECRET` and
   `FLUX_KEY_PIN_SECRET` must not change. Do not use example secrets.

   | Variable | Required | Value |
   | --- | --- | --- |
   | `POSTGRES_PASSWORD` | yes | Random hex (it is part of the database URL). |
   | `FLUX_AUTH_SECRET` | yes | At least 32 random characters. Changing it signs everyone out. |
   | `FLUX_KEYRING_TOKEN` | yes | Random hex. Authenticates the API and worker to the keyring; it opens nothing by itself. Empty leaves every [encrypted space](https://github.com/ColdPhase/flux/blob/main/docs/operations/encrypted-spaces.md) locked and none can be created. |
   | `FLUX_KEY_PIN_SECRET` | yes | Random hex, at least 32 characters. Pins every unlock password and key version of an encrypted space. **Never change it**: every encrypted space made with it would refuse to unlock. Back it up with `.env`, not only with the database. |
   | `FLUX_PUBLIC_ORIGIN` | yes | The exact URL people open, for example `https://flux.example.org`. Plain `http` works only for a loopback trial (`http://127.0.0.1:8081`). |
   | `FLUX_PROJECT` | kept | Compose project name and prefix of the `pgdata` and `files` volumes (`flux`). Keep it across upgrades, or the new release starts with empty volumes. |
   | `FLUX_PORT` | kept | Loopback port of the API (`8081`); point the reverse proxy at it. |
   | `FLUX_TRUSTED_PROXIES` | with a proxy | The proxy's IP or CIDR, so client addresses come from `X-Forwarded-For`. |
   | `FLUX_SMTP_URL`, `FLUX_MAIL_FROM` | optional | Password reset and notification mail. |
   | `FLUX_VAPID_PUBLIC_KEY`, `FLUX_VAPID_PRIVATE_KEY`, `FLUX_VAPID_SUBJECT` | optional | Web Push: all three or none. The subject must be a contact Apple can reach (`mailto:` at your domain or your https origin); otherwise iPhone and iPad notifications fail with 403. |
   | `FLUX_FIXTURE_TOKEN` | no | Enables a test-only endpoint. Leave it empty. |

   Every value is explained in the comments of `env.example`. Empty required values stop Compose
   before anything starts, except the two keyring secrets: without them Flux starts healthy but
   cannot create or unlock an encrypted space. `--env-file .env` is always passed explicitly, and a variable exported in
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
   URL's setup link, `<FLUX_PUBLIC_ORIGIN>/setup#<FLUX_SETUP_TOKEN>`, and create the first account. If startup fails, read
   `docker compose --env-file .env -f compose.yaml logs migrate api worker keyring` before changing data.

   If `up` stops with `all predefined address pools have been fully subnetted`, the Docker daemon has no
   network subnet left: Flux takes 2 networks (10 with the agent runtime), and a stock daemon has about 31 for
   all projects on the host. Stop other Compose projects you no longer run, or set
   smaller pools in `/etc/docker/daemon.json`, for example
   `{"default-address-pools": [{"base": "172.17.0.0/12", "size": 24}, {"base": "192.168.0.0/16", "size": 24}]}`,
   and restart the daemon ([reference](https://docs.docker.com/reference/cli/dockerd/#daemon-configuration-file)).

## Agents on your own AI key (optional)

People connect their own AI in **Settings → AI** (Connect AI): an API key, or a Claude or ChatGPT plan through the
[agent runtime](#agent-runtime-optional) below. For an **API key**, two switches decide whether this
installation lets people's agents run on it and which private hosts a connection may use; both are off while empty. Set them in
`.env`; `compose.yaml` passes them to `api` and `worker`:

```sh
FLUX_PERSONAL_RUNS=on              # agents run on each person's own API key
FLUX_AI_PRIVATE_TARGETS=           # optional: private hosts a connection may use, for example ollama,10.0.0.0/8
FLUX_BACKGROUND_KEY_HOST_FILE=/etc/flux/background.key
```

Both switches also need a key file: exactly 32 random bytes made for this installation, kept outside the
database backup and readable by user 1000, the user the containers run as. It seals the owners' AI keys.
`compose.yaml` cannot mount a file that may not exist, so mount it from a small Compose file of your own,
`compose.ai.yaml`, next to it. Compose reads a file named `compose.override.yaml` on its own only when no
`-f` is given, so this file has a name and every command names it.

```sh
install -d -m 700 /etc/flux && (umask 077 && openssl rand 32 > /etc/flux/background.key)
chown 1000 /etc/flux/background.key
```

```yaml
services:
  api:
    volumes:
      - ${FLUX_BACKGROUND_KEY_HOST_FILE:?Set FLUX_BACKGROUND_KEY_HOST_FILE in .env}:/run/secrets/flux_background_key:ro,z
  worker:
    volumes:
      - ${FLUX_BACKGROUND_KEY_HOST_FILE:?Set FLUX_BACKGROUND_KEY_HOST_FILE in .env}:/run/secrets/flux_background_key:ro,z
```

`z` lets the container read the file on an SELinux host (Fedora, RHEL); elsewhere it has no effect. Pass
the file to every command in this guide, next to the other optional files:

```sh
docker compose --env-file .env -f compose.yaml -f compose.ai.yaml up -d --wait
```

A plain `-f compose.yaml up` recreates `api` and `worker` without the key, which makes agents on API keys
unavailable again until you pass `compose.ai.yaml`. Back the key file up with `.env`, not with the
database: without it the stored AI connections cannot be opened and each owner connects again.

## Agent runtime (optional)

Off by default and not needed for Flux itself. It lets people on this Flux sign in with their own
ChatGPT (Codex) and Claude (Claude Code) subscriptions in Connect AI; Flux runs each person's official CLI for their
agents, isolated from everyone else. One runtime serves everyone. Read the [operator guide](https://github.com/ColdPhase/flux/blob/main/docs/operations/agent-runtime.md)
first (its commands for a source checkout are `./flux ...`; here the same steps are `sh runtime.sh ...`).

- **Linux host requirement.** The runtime needs the Linux kernel setting `kernel.yama.ptrace_scope` of 1 or
  higher (check: `cat /proc/sys/kernel/yama/ptrace_scope`). A missing policy or `0` stops the runtime with one
  clear message and the fix, and `sh runtime.sh up` fails; there is no restart loop. Docker Desktop is unsupported (its kernel has no Yama). The engine must support
  `internal` networks, a read-only root filesystem, dropped capabilities and process, memory and CPU limits.
- **Your duty for Claude Code.** Flux never ships Claude Code in an image. Enabling it installs
  Anthropic's signed official release into a volume and needs your own agreement to Anthropic's
  Commercial Terms with Anthropic. Pass the date you agreed: Flux records the statement, it does not check it.
  Codex needs no statement; its pinned release is part of the runtime image.
- **You can read every owner's login.** The CLIs keep each owner's login in the runtime's volume, readable by
  host root and by anyone who can read your disks or snapshots. Offer the runtime only where owners trust you.

Switch it on (the script writes `FLUX_AGENT_RUNTIME`, generates the missing secrets in `.env`, pulls the
runtime image by its digest and starts the runtime services next to Flux):

```sh
sh runtime.sh on codex                                       # or claude_code, or claude_code,codex
sh runtime.sh on claude_code,codex --commercial-terms 2026-10-05   # the date you agreed with Anthropic
sh runtime.sh status        # who is in it, and how many agents run at once
```

Once it is on, **always use `sh runtime.sh up` or pass both files**. A plain `docker compose --env-file .env -f compose.yaml up`
recreates `api` and `worker` without the runtime settings, which switches it off for them:

```sh
docker compose --env-file .env -f compose.yaml -f compose.runtime.yaml --profile runtime ps
```

What runs: `runtime-manager` (no database, no Docker access), `runtime-egress` (the runtime's only way out:
HTTPS to the hosts of the enabled CLIs and Flux's `/mcp`), the one-shot `runtime-install` (a no-op unless
`claude_code` is enabled) and one `runtime-1` for everyone. Each person's CLIs run under their own user id with no
capabilities; only its supervisor starts as root inside the container, with six capabilities. It has a read-only root
filesystem, no new privileges, its own volume and its own internal network. `runtime.sh` gives it the server's memory less
1.25 GiB and all its CPUs but one; how many agents run at once follows from the memory, about 2 on 4 GB, and the others wait.
Set `FLUX_RUNTIME_MAX_RUNS`, `FLUX_RUNTIME_MEMORY` or `FLUX_RUNTIME_CPUS` in `.env` to choose yourself. No service mounts a
Docker or Podman socket. `sh runtime.sh release <email>` signs that person's CLIs out and deletes their login files.

- **Switch off:** `sh runtime.sh off` stops the runtime services; their volumes and logins stay.
- **Remove the logins for good:** `sh runtime.sh purge` signs every CLI out (best effort), deletes the runtime's volumes and
  the tools volume. Then keep the runtime off. Run it before `down -v` if you uninstall.
- **Backups never contain the runtime's volume** (the logins must not travel in backups and cannot be moved between
  machines). A restore reconciles the restored bindings with the runtime when the worker starts. A disk or
  host snapshot does capture that volume. Add `-f compose.runtime.yaml` to the backup, upgrade and restore
  commands below while the runtime is on, or use `sh runtime.sh up` instead of their last `up`.

## Calls and screen sharing (optional)

Calls, cameras and screen sharing in live sessions need a media server. The release ships it as
`compose.live.yaml`: one LiveKit server (`livekit`), pinned by the digest that `release.json` names as
`live_media_image`. Without this file everything else in Flux works; only calls are unavailable.

How it connects. Browsers sign in to media through Flux itself, at `<FLUX_PUBLIC_ORIGIN>/media`: the API
checks the session and the space's access, then forwards to LiveKit on an internal network. Your existing
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

   Then start a call in a space and join it from a second device on another network (a
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

## Local embeddings (optional)

Search ranks by BM25 alone. On a server with 8 GB of RAM or more you can also let it rank by meaning: an English question then finds
a Polish message with no word in common. `compose.embeddings.yaml` adds one container, text-embeddings-inference running BAAI/bge-m3
on the CPU, pinned by the digest that `release.json` names as `embeddings_image`; it publishes no port and is reached only by `api`
and `worker`. It needs about 3.2 GiB of RAM idle and 3.9 GiB at its peak (`FLUX_EMBEDDINGS_MEMORY`, default `6g`, is its limit) and
uses at most one CPU (`FLUX_EMBEDDINGS_CPUS`, default `1`, so a 2-core server keeps a core for Flux while it embeds), and its first
start downloads the model (2.3 GB) from `huggingface.co` into the `embeddings` volume.

```sh
docker compose --env-file .env -f compose.yaml -f compose.embeddings.yaml config --quiet
docker compose --env-file .env -f compose.yaml -f compose.embeddings.yaml up -d --wait
```

Until the model is loaded search ranks by BM25 alone and the worker retries by itself; it then embeds every searchable row of a space
whose AI is on (for 10,000 messages, from about 17 minutes of two cores when they are short to about 8 hours at about 700 characters,
measured in the audit of #1270; longer with the default one CPU). Encrypted spaces and spaces with AI off are never embedded, and
nothing is embedded through a person's own AI connection. On the bench of F-042 the fused ranking found 0.683 of the answers in the
first ten for questions as asked, against 0.467 for BM25 alone.

Once it is on, **pass `-f compose.embeddings.yaml` to every command** in this guide, next to the other overlays you use. To turn it
off, run `docker compose --env-file .env -f compose.yaml up -d --wait --remove-orphans` without it: the next worker start deletes
every vector. The vectors are in PostgreSQL, so a backup needs nothing more; the `embeddings` volume holds only the model.

## Consistent backup

Back up PostgreSQL and the uploaded files as a pair while the writers (`api` and `worker`) are
stopped. Plan for downtime; do not run these commands during a live write. Keep the matching release
files and `.env` (especially `FLUX_AUTH_SECRET`, `FLUX_KEY_PIN_SECRET` and the VAPID keys) with the backup, and restrict
access to it: it contains your company's private data.

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

**From v0.1.0: not upgraded.** v0.1 had no users, so v0.2 converts nothing. If you start the v0.2 files on a database that v0.1
wrote, the `migrate` service stops with `FLUX_V01_DATABASE This database was written by Flux v0.1 …`, before any
migration runs, and `api` and `worker` do not start; your data is as it was. Install v0.2 fresh instead: use a new directory
with a new `FLUX_PROJECT` (new volumes) and a new `.env`, or remove the old project's volumes yourself after you have kept what you
need (the project export of v0.1 gives files you can read; neither version imports it). Restoring a v0.1 dump into v0.2 is refused the same way. Everything below is for an
upgrade between v0.2 releases and later.

**From any release since v0.2.0 to any later one.** You do not have to take every release in between: the new release applies the
migrations of the releases you skip, in order. Every release is tested this way before it is drafted: each earlier release is installed from its
own assets, filled with data, upgraded to the candidate and read back, and the release notes name the versions it was tested to
upgrade from. A downgrade is not supported: forward migrations are not reversible, so the way back is the backup you took first (below).

1. Check that the Docker Engine is 25 or newer (`docker version --format '{{.Server.Version}}'`), because Compose refuses the new files on an older one only after step 4 has stopped the writers. Then take and verify a paired backup with the **old** release.
2. Download and verify the **new** release's assets into a new directory. Keep the old directory, its
   image digest and the backup.
3. Copy your existing `.env` into the new directory, unchanged: the same `FLUX_PROJECT` keeps the same
   volumes. Compare the new `env.example` with your `.env`; add a new setting that your file lacks
   (a new setting has a default that keeps the old behaviour, and a new required one stops Compose before anything starts).
   A setting that a release renames or removes is named in its release notes: rename it in your `.env`, or delete it.
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

The database image line of `compose.yaml` (`ghcr.io/coldphase/flux-database@sha256:…` from v0.2.1, the official
`postgres@sha256:…` before) selects the PostgreSQL version. If the major version changes between the two releases, the data
directory does not carry over: restore the backup into a fresh installation of the new release instead of upgrading in place.
The move from v0.2.0's official image to Flux's own keeps PostgreSQL 18 and the data directory as they are (see
[the upgrade notes](https://github.com/ColdPhase/flux/blob/main/docs/operations/upgrade.md#v021-the-database-image-changes)).

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
machine you can keep your original `FLUX_PROJECT` and leave `-p` out. Check an account, a space
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
the backup: restore with the same release first, then perform a tested forward upgrade. A backup that v0.1 wrote
cannot be brought forward to v0.2 at all.

# Troubleshooting and FAQ

Start with the services' state and their last log lines; most problems name themselves there.

```sh
cd /srv/flux
dc() { docker compose --env-file docker/.env -p "$(sed -n 's/^FLUX_PROJECT=//p' docker/.env)" -f docker/compose.source.yaml "$@"; }
dc ps -a
dc logs --tail 50 migrate api worker keyring
```

For a release installation use `docker compose --env-file .env -f compose.yaml` in place of `dc`.

## Flux does not start

| What you see | Cause and fix |
| --- | --- |
| `FLUX_PUBLIC_ORIGIN must use https unless it is a loopback address …` | The API refuses a plain `http` origin on a real host name. Use `https://…` behind a [reverse proxy](reverse-proxy.md), or `http://127.0.0.1:<port>` for a local trial. |
| `FLUX_PUBLIC_ORIGIN must be an origin without path, query or credentials` | Remove any path or trailing segment: `https://flux.example.org`, not `https://example.org/flux`. Flux must have its own host name or port. |
| Another `… must be …` line naming a variable | A value is out of range; the line names it and the accepted values. The [configuration reference](configuration.md) lists them all. |
| `Set POSTGRES_PASSWORD …`, `Set FLUX_AUTH_SECRET …`, `Set FLUX_PUBLIC_ORIGIN …` | Compose stops before anything starts: fill in the required value in the settings file. |
| `Bind for 127.0.0.1:8081 failed: port is already allocated` | Another program uses the port. Set another `FLUX_PORT` in the settings file (on the first run: `FLUX_PORT=8090 ./flux up`) and point the proxy at it. |
| `all predefined address pools have been fully subnetted` | Docker ran out of networks on a shared host; see [Docker address pools](#docker-address-pools). |
| `Compose project … belongs to another checkout` | The settings file names a project another checkout created, often a copied `.env`. Set a different `FLUX_PROJECT`, or pass `--force-project` if you really mean that project. |
| `migrate` exited with an error, `api` waits | Read `dc logs migrate`. A ledger mismatch means the database belongs to another version: see [migration ledger mismatch](../development/application-foundation.md#migration-ledger-mismatch-118) and restore the matching backup rather than editing the ledger. |
| `api` restarts with exit code 137, or `docker inspect` shows `OOMKilled` | It hit its memory limit. Raise `FLUX_API_MEMORY` (or `FLUX_WORKER_MEMORY`) and run `./flux up`. |
| `/api/v1/health` answers `503` | Its warning in `dc logs api` says which check failed: migrations, the queue schema, or writing to the files volume (disk full or permissions). |
| `FastifyWarning: … FSTWRN004` when the API starts | Harmless. Several route groups set their own error handler on purpose, and Fastify notes each override. |

## Signing in and browsers

| What you see | Cause and fix |
| --- | --- |
| Sign-in or every change fails with `403 ORIGIN_REJECTED` | The browser's address is not exactly `FLUX_PUBLIC_ORIGIN`: another host name, `http` instead of `https`, or a missing port. Open the configured address, or correct the setting. |
| Live updates do not arrive; the stream reconnects | The proxy does not pass WebSocket upgrades, or closes idle connections sooner than 25 seconds. See [other proxies](reverse-proxy.md#other-proxies). |
| Uploads fail with `413` from the proxy | Raise the proxy's body limit to at least 5 MiB (nginx: `client_max_body_size`). |
| Every session shows the same address, the proxy's | Set `FLUX_TRUSTED_PROXIES` to the proxy's measured address ([how](reverse-proxy.md#trust-only-the-measured-proxy-peer)). |
| The reset page says password reset is unavailable | No email configured: set `FLUX_SMTP_URL` and `FLUX_MAIL_FROM`. |
| New people cannot create an account | `FLUX_SIGNUP` is `off`, or `verified` without email (then sign-up is closed). `GET /api/v1/auth/capabilities` shows the rule in effect. Invite links never open closed sign-up. |

## Features that stay unavailable

| Feature | Check |
| --- | --- |
| Push notifications | HTTPS origin, all three `FLUX_VAPID_*` set, outbound HTTPS to the push services ([push](mobile-and-push.md)). |
| Installing on a phone | HTTPS at the root of its own origin; iPhone and iPad install from Safari's Share menu. |
| Assistant, background suggestions | `FLUX_PERSONAL_RUNS=on` or `FLUX_BACKGROUND_COMPARISONS=on`, and a readable `FLUX_BACKGROUND_KEY_HOST_FILE`. Also the space's AI must be on. |
| Sign-in with Claude or ChatGPT subscriptions | `FLUX_AGENT_RUNTIME` set and applied with `./flux up`; `./flux runtime status` ([agent runtime](agent-runtime.md)). |
| An MCP client on another computer | It needs an `https` origin; `http://127.0.0.1` works only on the server itself. The server also needs outbound HTTPS to fetch the client's metadata. |
| Encrypted spaces stay locked | Normal after a restart until an owner or admin unlocks. If unlocking fails with a swap message, see [swap and memory](encrypted-spaces.md#swap-and-memory). |
| Live calls | `GET /api/v1/live-sessions/capabilities` says `configured` only with the [live-media overlay](../development/live-media.md). |

## Docker address pools

Every Compose network takes one subnet from the Docker daemon's address pools, and a stock daemon has
about 31 (15 `/16` networks in `172.17.0.0/12` and 16 `/20` networks in `192.168.0.0/16`). A Flux project
uses 2 networks (`default` and the internal `keyring`); with the agent runtime on it uses 10 (the runtime's
control, API, install and egress networks and one per slot).

When the pools are gone, `./flux up` stops with Compose's line
`all predefined address pools have been fully subnetted` and then explains it. One instance on its own
machine does not reach that; a shared host, a CI runner or a server with several instances (staging and
production, one per team) can: stock pools hold about 14 Flux projects, or 2 with the agent runtime on.

- Stop projects you no longer need: `docker network ls` shows the networks per project,
  `docker compose -p <project> down` (or `./flux down` in that checkout) removes them. `./flux up` with the
  runtime off also removes this project's runtime networks once nothing uses them.
- Or give the daemon smaller subnets. In `/etc/docker/daemon.json` (Docker Desktop: Settings, Docker Engine):

  ```json
  {
    "default-address-pools": [
      { "base": "172.17.0.0/12", "size": 24 },
      { "base": "192.168.0.0/16", "size": 24 }
    ]
  }
  ```

  then restart the daemon (`sudo systemctl restart docker`; it restarts running containers). That gives
  4352 networks of 254 addresses each, plenty for a Flux project. Existing networks keep their subnets until
  they are recreated. Pick bases that do not overlap your LAN or VPN routes.
  ([dockerd reference](https://docs.docker.com/reference/cli/dockerd/#daemon-configuration-file), read 2026-10-30.)

## FAQ

**Is there an admin panel for the whole server?**
No. Flux has no server-wide administrator account. Each space has owners and admins who manage its
people and settings in the app ([administration](administration.md)); the operator manages the
server through the settings file and `./flux`.

**How do I reset a forgotten password without email?**
Configure email and use **Forgot password**. Flux has no command that sets a password.

**Can I run Flux under a path, such as `https://example.org/flux`?**
No. Flux needs its own origin: a host name, or a host name and port.

**Can I use an external PostgreSQL?**
Not with the shipped Compose files: every service builds its database URL from the bundled `db`.
It is not a tested setup.

**Where is my data?**
In two Docker volumes named after the project, `<FLUX_PROJECT>_pgdata` (PostgreSQL) and
`<FLUX_PROJECT>_files` (uploads), plus the settings file. `./flux backup` captures all three.

**Does Flux send anything to its developers?**
No. Flux itself has no telemetry. Outbound connections are the ones you enable: email, push
services, AI providers people connect, link cards, GitHub, and MCP client metadata. The optional
[agent runtime](agent-runtime.md) runs the vendors' own CLIs, whose egress it limits to their
documented hosts.

**How do I move to another server?**
`./flux backup` on the old one, copy the archive, then `./flux restore` in a fresh checkout on the
new one ([restore on a fresh machine](backup-restore.md#restore-on-a-fresh-machine-or-checkout)).
Update DNS and `FLUX_PUBLIC_ORIGIN` if the address changes.

**How do I remove Flux?**
`./flux down` stops it and keeps the data. `./flux reset` deletes this checkout's data volumes after
confirmation, and `./flux clean` also removes the images it built.

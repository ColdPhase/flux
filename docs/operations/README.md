# Self-hosting Flux

Flux runs on your own server as one Docker Compose project: PostgreSQL, the API, a worker and a
small keyring, behind your HTTPS reverse proxy. These pages are for the person who runs it.

| Start here | |
| --- | --- |
| [Requirements](requirements.md) | Host, Docker, memory, disk and network |
| [Installation](install.md) | A production server on your domain, from a source checkout today |
| [HTTPS and reverse proxies](reverse-proxy.md) | Caddy, nginx and Traefik, each tested |
| [Configuration reference](configuration.md) | Every setting, generated from the code |
| [Administration in the app](administration.md) | Spaces, people and roles, invite links, AI, encryption |
| [Architecture](architecture.md) | What runs where, data and secrets |

| Keep it running | |
| --- | --- |
| [Upgrade](upgrade.md), [backup and restore](backup-restore.md), [project export](export.md) | Moving forward safely, and getting data out |
| [Health, monitoring and logs](monitoring.md) | What to watch |
| [Operating encrypted spaces](encrypted-spaces.md) | Keyring, restarts, swap, backups |
| [Capacity and scaling](scaling.md) | Growing the one server |
| [Security hardening](hardening.md) | Defaults and a checklist |
| [Troubleshooting and FAQ](troubleshooting.md) | Symptoms, causes and fixes |

| Optional features | |
| --- | --- |
| [Single sign-on](single-sign-on.md) | People sign in with your OpenID Connect provider |
| [Phones, tablets and push](mobile-and-push.md) | Installing the app and Web Push |
| [Agent runtime](agent-runtime.md) | People sign in with their own Claude or ChatGPT subscription |

## Commands

A source checkout is operated with the root [`./flux`](../../flux) launcher. Everything runs in Docker: the
launcher needs only POSIX `sh`, Docker with Compose, `tar`, and `sha256sum` or `shasum`. It never
installs PostgreSQL or Node.js on the host and never touches another Compose project or a volume
that is not this checkout's.

| Task | Command | Guide |
| --- | --- | --- |
| Back up database, files and settings | `./flux backup [--output DIR] [--keep N]` | [Backup and restore](backup-restore.md) |
| Restore a backup, here or on a new machine | `./flux restore <archive> [--migrate] [--revoke-agent-connections] [-y]` | [Backup and restore](backup-restore.md#restore) |
| Export one project as open JSON plus files | `./flux export <project> [--as EMAIL]`, `GET /api/v1/projects/:id/export` | [Project export](export.md) |
| Move to a newer version | `./flux upgrade [--pull] [-y]` | [Upgrade](upgrade.md) |
| Let people sign in with your identity provider (OpenID Connect) | `FLUX_OIDC_*` in `docker/.env` | [Single sign-on](single-sign-on.md) |
| Serve Flux through HTTPS, including MCP and WebSocket upgrades | Set the public origin and narrowly trusted proxy peer | [HTTPS and reverse proxies](reverse-proxy.md) |
| Install Flux on phones and tablets and send push notifications | HTTPS at the origin root, `FLUX_VAPID_*`, outbound HTTPS to the push services | [Phones, tablets and push](mobile-and-push.md) |
| Let people sign in with their own ChatGPT and Claude subscriptions (off by default) | The first interactive `./flux up` asks once; later `./flux ai on` (or `FLUX_AGENT_RUNTIME` in `docker/.env`, then `./flux up`); `./flux runtime status \| release runtime-<n> \| purge` | [Agent runtime](agent-runtime.md) |
| Run a published release without the source (operators) | `docker compose --env-file .env -f compose.yaml up -d --wait` | [Install from a release](install-release.md), [the release's `INSTALL.md`](release-guide.md) |

`./flux help` prints every command; the [configuration reference](configuration.md#launcher-commands)
carries the same list.

Every command acts on this checkout's Compose project (`FLUX_PROJECT` in `docker/.env`) and uses the
ownership check of `./flux up`: it refuses a project that another checkout created, or one
with data but no owner record, unless `--force-project` is given. Commands that replace data
(`restore`, `upgrade`, like `reset` and `clean`) ask for confirmation; `-y` answers yes for
scripts.

Flux is in early development ([project status](../../README.md#project-status)). These tools
make local and small self-hosted instances recoverable; they are not yet a supported
production upgrade path between releases.

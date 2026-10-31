# Architecture for operators

What runs on a Flux server, how the parts talk, and where the data lives.

![Browsers, phones and MCP clients reach one HTTPS reverse proxy, which forwards to the Flux API on the host's loopback port. The API and the worker share PostgreSQL and the files volume. The keyring sits on an internal network with only the API and the worker. The one-shot migrate service runs before them. Optional: the agent runtime and LiveKit for live media. The worker and API make outbound connections for mail, push, AI providers and link cards.](../assets/operations/architecture.svg)

## Services

| Service | Image | Does | Ports and networks |
| --- | --- | --- | --- |
| `db` | PostgreSQL 18, pinned by digest | All records, the job queue and the event log | none published; `default` |
| `migrate` | Flux | Applies new SQL migrations in order, each in its own transaction, then exits | `default` |
| `api` | Flux | The web app and PWA, the HTTP API, `/mcp` for agents, WebSocket streams, sign-in and OAuth | `127.0.0.1:FLUX_PORT` → 8080; `default`, `keyring` |
| `worker` | Flux | Queued jobs: notifications, email, Web Push, assistant runs, background suggestions, encryption key rotation | `default`, `keyring` |
| `keyring` | Flux | Holds the boot key of encrypted spaces in memory | `keyring` only (internal) |

Optional parts:

| Part | Turned on by | Adds |
| --- | --- | --- |
| Agent runtime | `FLUX_AGENT_RUNTIME` ([guide](agent-runtime.md)) | `runtime-install`, `runtime-manager`, `runtime-egress` and slots `runtime-1`…`4` on their own internal networks; the egress proxy is their only way out |
| Live media | `docker/compose.live.yaml`, `docker/compose.live.turn.yaml` ([guide](../development/live-media.md)) | `livekit`, with ICE and TURN ports reached directly by browsers, and signaling only through the API at `/media` |
| Hot-reload development | `./flux dev` | A Vite server and a mail catcher; never on a server |

`api`, `worker`, `keyring` and `migrate` run one image at one revision. The release `compose.yaml`
pulls it by digest; a source checkout builds it from the checkout.

## How requests flow

- Browsers, installed phone apps and MCP clients use **one origin**, `FLUX_PUBLIC_ORIGIN`, through
  your TLS reverse proxy. Everything is under it: pages, `/api/*`, `/mcp`, OAuth discovery under
  `/.well-known/`, WebSocket upgrades and, with live media, `/media/*`.
- The API writes to PostgreSQL. Each write records an event; the live stream sends those events to
  open browsers, and the worker picks up queued jobs from the same database. The API and worker do not
  call each other directly, except that the worker asks the API for a short-lived token when it starts
  an assistant run.
- Files go to the `files` volume, shared by `api` and `worker`.
- The `api` and `worker` ask the `keyring` for keys of unlocked encrypted spaces over the internal
  network, with a token.

## Data and secrets

| What | Where | Backed up by `./flux backup` |
| --- | --- | --- |
| Records, history, queue | volume `<FLUX_PROJECT>_pgdata` | yes (database dump) |
| Uploaded files | volume `<FLUX_PROJECT>_files` | yes |
| Settings and secrets | `docker/.env` (release: `.env`) | yes (copied into the archive) |
| Boot key of encrypted spaces | keyring memory only | no, by design: a restart locks them |
| Agent runtime logins | the runtime's slot volumes | no ([why](backup-restore.md#agent-runtime-slots)) |
| OIDC client secret, background key | files you keep on the host | no: keep them yourself |

## What leaves the server

Only what you turn on: SMTP to your mail server, Web Push to the browser vendors' push services,
requests to the AI providers that owners connect, link-card fetches (off by default), GitHub (when
the App is configured), MCP client metadata documents when an agent signs in, and, with the agent
runtime, the vendors' CLIs through the egress proxy to their documented hosts. Flux itself sends no
telemetry.

The code-level picture, module boundaries and dependency rules are in the
[developer architecture](../development/architecture.md).

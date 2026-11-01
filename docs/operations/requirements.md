# Requirements

Flux runs as one Docker Compose project on one Linux host. Everything it needs, PostgreSQL included,
runs in containers, so the host needs only Docker and a few standard tools.

## Host

| | Recommended for a small team | Notes |
| --- | --- | --- |
| **Operating system** | Linux with Docker Engine | macOS and Windows with Docker Desktop run Flux for trials and development; a server should be Linux. |
| **CPU architecture** | `x86_64` (`amd64`) | Release images are published for `linux/amd64` only; `linux/arm64` follows in v0.1.1. Source builds were measured on Linux `x86_64` and macOS `arm64` ([time to first run](../development/time-to-first-run.md)). |
| **CPU** | 2 cores | An idle instance uses well under one core. Building from source is the heaviest step. |
| **Memory** | 4 GB | The default container limits add up to about 3.1 GB plus PostgreSQL (see below). |
| **Disk** | 10 GB free, SSD | About 0.5 GB for the Flux image, 0.5 GB for PostgreSQL, the build cache when you build from source, then your data and backups. |
| **Swap** | off, or encrypted | Only matters for [encrypted spaces](encrypted-spaces.md#swap-and-memory). |

Memory in more detail. Compose limits each service, and memory and swap to the same value
([`FLUX_API_MEMORY`, `FLUX_WORKER_MEMORY`, `FLUX_KEYRING_MEMORY`](configuration.md#memory-limits)):

| Service | Limit | Observed |
| --- | --- | --- |
| `api` | 2 GB | 274 MiB idle; peak 431 MB in the encryption checks |
| `worker` | 1 GB | 84 MiB idle; peak 111 MB |
| `keyring` | 128 MB | 18 MiB idle; peak 42 MB |
| `db` | none | 69 MiB idle |

Idle figures: `docker stats` on a fresh source install on 2026-10-31 (Docker Engine 29.4.2, Linux
`x86_64`). Peaks: cgroup `memory.peak` on 2026-10-23 during the encryption check
`scripts/check_encryption.sh` and the affected API suites of `check_application.sh` (the full suite
was not measured).
They are not a capacity measurement for many people; watch `docker stats` on your instance and raise
a limit if a container is killed for memory.

The optional [agent runtime](agent-runtime.md) adds a manager, an egress proxy and four slots of up
to 2 GB each while people use them. Optional [live media](../development/live-media.md) adds a
LiveKit server whose CPU and bandwidth grow with each call.

## Software

| | Version | Notes |
| --- | --- | --- |
| **Docker Engine** | a current release with the Compose v2 plugin (`docker compose`) | Observed working: Engine 28.0.4 with Compose 2.38.2 (GitHub-hosted runner, 2026-10-10), Engine 29.1.2 with Compose 2.40.3 (Docker Desktop, macOS), Engine 29.4.2 with Compose 5.1.2 (Fedora 42). Older versions were not tested. |
| **Git** | any | Source checkout only. |
| **POSIX `sh`, `tar`, `sha256sum` or `shasum`** | | Used by the `./flux` launcher for backups and restores. |
| **PostgreSQL, Node.js** | not on the host | They run inside the containers. Do not install them for Flux. |

## Network

| Direction | What | When |
| --- | --- | --- |
| Inbound TCP 443 (and 80 for ACME) | Your [reverse proxy](reverse-proxy.md) | Always, for anyone not on the server itself |
| Inbound UDP 3478, UDP 7882, TCP 7881, TCP 443 on a second address | LiveKit media and TURN | Only with [live media](../development/live-media.md) |
| Outbound TCP 587 or 465 | Your mail server | When [email](configuration.md#email) is set |
| Outbound HTTPS | Web Push services of browser vendors | When [push](mobile-and-push.md#3-allow-outbound-https-to-the-push-services) is on |
| Outbound HTTPS | AI providers people connect, MCP client metadata documents, GitHub | When those features are used |
| Outbound HTTPS | Container registries, npm (source build) | Install and upgrade |

The API listens only on the host's loopback address; nothing else is published. A domain name with
a DNS record pointing at the host is needed for HTTPS, installed phone apps and agents on other
computers.

## Browsers

Use a current browser. The browser checks run the web app in Chromium and in WebKit (Safari's
engine), on computer, tablet and phone sizes; Firefox is not part of the automated checks. On phones
and tablets Flux installs as an app from Safari (iOS and iPadOS 16.4 or later) or Chrome. Installation
and push need HTTPS: see [phones, tablets and push](mobile-and-push.md).

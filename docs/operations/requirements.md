# Requirements

Flux runs as one Docker Compose project on one Linux host. Everything it needs, PostgreSQL included,
runs in containers, so the host needs only Docker and a few standard tools.

## Host

| | Recommended for a small team | Notes |
| --- | --- | --- |
| **Operating system** | Linux with Docker Engine | macOS and Windows with Docker Desktop run Flux for trials and development; a server should be Linux. |
| **CPU architecture** | `x86_64` (`amd64`) | Release images are published for `linux/amd64` only; `linux/arm64` is planned for v0.3 ([#833](https://github.com/ColdPhase/flux/issues/833)). Source builds were measured on Linux `x86_64` and macOS `arm64` ([time to first run](../development/time-to-first-run.md)). |
| **CPU** | 2 cores | An idle instance uses well under one core. Building from source is the heaviest step. |
| **Memory** | 4 GB | The default container limits of the base stack add up to 2.9 GB, PostgreSQL included (see below). |
| **Disk** | 10 GB free, SSD | About 0.25 GB for the Flux image, 0.5 GB for PostgreSQL, the build cache when you build from source, then your data and backups. **Videos** (MP4, WebM and MOV that play inside Flux, [#1352](https://github.com/ColdPhase/flux/issues/1352)) are stored as they were sent, never converted, and a video may be as large as [`FLUX_VIDEO_MAX_MIB`](configuration.md#flux_video_max_mib) (200 MiB by default; every other file stays at 5 MiB). A team that shares screen recordings should plan the `files` volume in tens of gigabytes, not megabytes, and size `FLUX_VIDEO_MAX_MIB` to the disk it has; a deleted message or space frees its videos. A video is read from disk in ranges as people watch it, so memory does not grow with its size. |
| **Kernel, for agents' own tools** | Linux 6.7 or later with Landlock enabled | Only for the optional [agent runtime](agent-runtime.md): Claude Code and Codex keep their shell and file tools only where Landlock can forbid TCP (ABI 4). On an older kernel the runtime runs with those tools off and logs `tools_off` once. |
| **Swap** | off, or encrypted | Only matters for [encrypted spaces](encrypted-spaces.md#swap-and-memory). |

Memory in more detail. Compose limits each service, and memory and swap to the same value
([`FLUX_API_MEMORY`, `FLUX_WORKER_MEMORY`, `FLUX_KEYRING_MEMORY`, `FLUX_DB_MEMORY`](configuration.md#memory-limits)):

| Service | Limit | Observed |
| --- | --- | --- |
| `api` | 1.5 GB | 274 MiB idle; peak 431 MB in the encryption checks |
| `worker` | 512 MB | 84 MiB idle; peak 111 MB |
| `keyring` | 128 MB | 18 MiB idle; peak 42 MB |
| `db` | 768 MB | 69 MiB idle |

Idle figures: `docker stats` on a fresh source install on 2026-10-31 (Docker Engine 29.4.2, Linux
`x86_64`). Peaks: cgroup `memory.peak` on 2026-10-23 during the encryption check
`scripts/check_encryption.sh` and the affected API suites of `check_application.sh` (the full suite
was not measured).
They are not a capacity measurement for many people; watch `docker stats` on your instance and raise
a limit if a container is killed for memory.

The optional [agent runtime](agent-runtime.md) adds a manager, an egress proxy and about 1 GB for
each agent while it runs; an idle person costs nothing. About 2 agents run at once on 4 GB. Optional [live media](../development/live-media.md) adds a
LiveKit server whose CPU and bandwidth grow with each call.

## Local embeddings (optional)

Off by default. Search ranks by BM25 alone ([F-042](../product/decisions.md#f-042--agents-find-what-they-need-with-bm25-search-in-postgresql)),
which needs nothing beyond the table above. An operator with a larger server can turn on a local embedding container
(`docker/compose.embeddings.yaml`, `FLUX_EMBEDDINGS=on` for a source checkout): the worker then stores a vector for each searchable
row, and search fuses the nearest vectors with BM25, which found more of the questions asked in plain words, across languages and by
paraphrase (recall@10 0.683 against BM25's 0.467, measured through Flux's own search on the bench of [#1242](../product/research/2026-11-ai-context-retrieval.md#measured-in-flux-itself-1294-2026-11-13);
the research's own run gave 0.75 against 0.60).

| | Needs | Notes |
| --- | --- | --- |
| **Memory** | **about 3 to 4 GiB**, on top of the base stack | text-embeddings-inference with bge-m3 (568 M parameters). Measured: 3.15 GiB idle and 3.9 GiB at its peak on 2 cores ([#1242](../product/research/2026-11-ai-context-retrieval.md#with-a-large-embedding-model-bge-m3)); 2.2 GiB idle and 2.8 GiB at its peak embedding 10,000 messages on a 24-thread host with the overlay's two tokenization workers. The Compose limit is 6 GiB (`FLUX_EMBEDDINGS_MEMORY`): 4 GiB killed it while it warmed up. With the base stack's 2.9 GB it wants a server of 8 GB or more. |
| **CPU** | 2 cores; the container may use 1 (`FLUX_EMBEDDINGS_CPUS`) | Embedding is CPU-bound and its rate depends on the length of the text. Measured on 2 cores without a CPU limit: about 10 short messages a second (#1242), but **0.35 messages a second of about 700 characters** (the audit of #1270, 2026-11-13), so 10,000 such messages take about 8 hours; with the default limit of one CPU expect roughly half that (not measured). Until a row has its vector, search finds it by BM25. Each new message is then embedded within a few seconds. A query costs about 80 ms more. The limit keeps a backfill from taking both cores of a 2-core server (unbounded it held 150–175 % for hours, and searches waited 1.5 s for their query's vector); raise it on a larger server. |
| **Disk** | 2.3 GB for the model, about 26 MiB of PostgreSQL per 10,000 rows | The model is downloaded on the first start into the `embeddings` volume. Vectors (half precision, 2 KiB each, no index) grow with the rows. Each search reads the vectors of every row the person may see, about 1 ms per 1,000 of them, so at 100,000 rows give `FLUX_DB_MEMORY` room for them (about 260 MiB) to stay in memory. |
| **Network** | outbound HTTPS to `huggingface.co` on the first start | Nothing leaves the server afterwards: every text is embedded in the container. |

Encrypted spaces and spaces with AI off are never embedded, and nothing is embedded through a person's own AI connection. Turning
it off again deletes every vector.

## Software

| | Version | Notes |
| --- | --- | --- |
| **Docker Engine** | **25 or newer**, with the Compose v2 plugin (`docker compose`, 2.20.2 or newer) | Observed working: Engine 28.0.4 with Compose 2.38.2 (GitHub-hosted runner, 2026-10-10), Engine 29.1.2 with Compose 2.40.3 (Docker Desktop, macOS), Engine 29.4.2 with Compose 5.1.2 (Fedora 42). The health checks use `start_interval`, which Engine 25 introduced. **Engine 24 and older refuse to start Flux**: `docker compose up` stops with `can't set healthcheck.start_interval as feature require Docker Engine v25 or later` before it creates anything (observed on Engine 24.0.9 with Compose 2.29.1, 2026-11-05), and `./flux` refuses with one line before that. Update Docker Engine ([install](https://docs.docker.com/engine/install/)); Docker Desktop ships a current engine. |
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
| Outbound HTTPS | AI providers people connect, public web pages and search for agents (`FLUX_WEB_READS`, on by default), MCP client metadata documents, GitHub | When those features are used |
| Outbound HTTPS | `huggingface.co` | Only the first start of the optional [local embeddings](#local-embeddings-optional) container (the model, 2.3 GB) |
| Outbound HTTPS | Container registries, npm (source build) | Install and upgrade |

The API listens only on the host's loopback address; nothing else is published. A domain name with
a DNS record pointing at the host is needed for HTTPS, installed phone apps and agents on other
computers.

## Browsers

Use a current browser. The browser checks run the web app in Chromium and in WebKit (Safari's
engine), on computer, tablet and phone sizes; Firefox is not part of the automated checks. On phones
and tablets Flux installs as an app from Safari (iOS and iPadOS 16.4 or later) or Chrome. Installation
and push need HTTPS: see [phones, tablets and push](mobile-and-push.md).

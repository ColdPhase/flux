# Time to first run (#305)

How long it takes from `git clone` to a working Flux when you follow the
[README quick start](../../README.md#quick-start) literally. This is L-1 of the v0.1 launch
plan, tracked in [#305](https://github.com/ColdPhase/flux/issues/305). Add each new
measurement as a section, newest first, and keep the summary current.

## Summary

| Step | macOS arm64, cold, 2026-10-11 | macOS arm64, warm, 2026-10-11 | Linux amd64, cold, 2026-10-10 | Linux amd64, warm, 2026-10-10 |
| --- | --- | --- | --- | --- |
| 1. `git clone` | 2 min 47.7 s | 2 min 29.6 s | 7.2 s | 6.9 s |
| 2. `./flux up`, until the printed URL answers HTTP 200 | 2 min 21.4 s (URL 0.1 s) | 13.6 s (URL 0.1 s) | 2 min 12.2 s (URL 0.02 s) | 10.0 s (URL 0.01 s) |
| 3. `./flux demo`, until the logins print | 1.3 s | 1.3 s | 1.2 s | 1.2 s |
| 4. Sign in and post the first message in the demo conversation | not re-measured; 0.8 s on 2026-10-06 | not re-measured; 0.8 s on 2026-10-06 | not measured (the workflow has no browser step) | not measured |
| 5. First agent reply through your own MCP client | not measured on a clean clone ([#320](https://github.com/ColdPhase/flux/issues/320)) | not measured on a clean clone | not measured ([#320](https://github.com/ColdPhase/flux/issues/320)) | not measured |
| From `git clone` to the logins | 5 min 10.9 s | 2 min 44.8 s | 2 min 20.6 s | 18.7 s |

Clone and dependency download take most of the time, and both depend on the network: about
2 min 30 s to 2 min 48 s for the clone on this Mac, and 7 s on the Linux runner, a datacenter
network. The cold macOS pass used `FLUX_NO_CACHE=1` and both macOS passes used `FLUX_PORT=19840`;
both are deviations from the README, listed in the [2026-10-11 section](#macos-arm64-2026-10-11-cold-and-warm).
The 2026-10-06 run is kept below. Its step 4 figure is the only macOS first-message number.

## macOS arm64, 2026-10-11: cold and warm

A fresh `git clone` of `origin/main`, then the README quick start: `./flux up`, the printed URL,
`./flux demo`. Both passes ran in their own Compose projects, on the same Mac as the
[2026-10-06 run](#macos-arm64-2026-10-06), with the deviations listed under
[method](#method-2026-10-11). The warm pass is the one that matches the README's default cache.

### Machine and revision

- **Mac:** Apple M4 Pro, 14 cores, 24 GiB memory, macOS 26.3.1 (a), build 25D771280a.
- **Docker:** Docker Desktop, Engine 29.1.2, Compose v2.40.3-desktop.1. The Docker VM had
  14 CPUs and 13.6 GiB of memory.
- **Git:** 2.50.1 (Apple Git-155).
- **Revision:** `ceea8aa31e17a2e8f4718cd783e984bc16d525c3` (`main`, "feat(settings): text size and
  reduce motion in Appearance (#350) (#452)"), the same for both passes.
- **When:** 2026-10-11, 00:36 to 00:45 CEST (22:36 to 22:45 UTC).
- **Other load:** other Docker projects ran on this host during both passes: a preview on port
  8090, a restarting preview, a UI test project and another project. None was stopped or touched.

### Method 2026-10-11

- The steps were the README's, run from a clean clone in the scratchpad. A driver script wrote a
  wall-clock mark at each step boundary. The step 2 end is the first HTTP 200 from `curl` to the
  printed URL, not a browser.
- **Deviation 1, `FLUX_PORT=19840` in both passes.** The README uses 8081. The measurement must
  use its own port (criterion 4 of [#305](https://github.com/ColdPhase/flux/issues/305)). `./flux up`
  wrote the port to `docker/.env`, and `./flux demo` read it from there.
- **Deviation 2, `FLUX_NO_CACHE=1` in the cold pass only.** The README does not mention it. The
  launcher passes it to `docker compose build --no-cache`, so every layer is rebuilt. Base images
  (`node`, `postgres`) stayed, because other projects use them. The BuildKit cache was not pruned,
  because it is shared by all projects and `./flux clean` does not prune it either. So this is a
  no-cache build on a host that already had the base images, not an empty host.
- Steps 4 and 5 were not re-run (see below).

### Cache state

- **Cold (`FLUX_NO_CACHE=1`):** `RUN pnpm fetch` ran for 57.8 s and was not cached; `pnpm install`
  and `pnpm build && pnpm typecheck && pnpm lint` ran too. The only `CACHED` step was
  `[build 2/9] WORKDIR /app`.
- **Warm (default cache):** 37 steps reported `CACHED`, including `pnpm fetch` and the build step.
- **Base images:** `node` and `postgres` were present before both passes.

### Timing

| Mark | Cold | Warm |
| --- | --- | --- |
| 1. `git clone` | 2 min 47.7 s | 2 min 29.6 s |
| 2. `./flux up`, until it exits | 2 min 21.4 s | 13.6 s |
| 2. then the printed URL answers HTTP 200 | 0.1 s | 0.1 s |
| 3. `./flux demo`, until the logins print | 1.3 s | 1.3 s |
| From clone start to the logins | 5 min 10.9 s | 2 min 44.8 s |

The Docker slot wait (0.1 s in both passes) is excluded from `./flux up`. Raw marks, in Unix seconds:

| Mark | Cold | Warm |
| --- | --- | --- |
| clone_start | 1791671790.953 | 1791672108.967 |
| clone_done | 1791671958.670 | 1791672258.562 |
| up_requested | 1791671958.791 | 1791672258.656 |
| up_started | 1791671958.905 | 1791672258.745 |
| up_exited | 1791672100.351 | 1791672272.369 |
| url_200 | 1791672100.454 | 1791672272.458 |
| demo_start | 1791672100.540 | 1791672272.543 |
| demo_exited | 1791672101.888 | 1791672273.810 |

### Not measured

- **Step 4, the first message, in this run.** Not re-measured. The [2026-10-06 run](#macos-arm64-2026-10-06)
  measured it at 0.8 s, which does not depend on the Docker cache.
- **Step 5, the first agent reply through your own MCP client, on a clean clone.** Not measured.
  It needs a person's MCP client, a model account and an interactive consent
  ([#320](https://github.com/ColdPhase/flux/issues/320)). The [2026-10-10 run](#macos-arm64-2026-10-10-first-agent-reply-through-claude-code-320)
  is not a clean clone.

### Friction found

1. **The clone is large.** Both clones took 2 min 30 s to 2 min 48 s, close to the 3 min 08 s of
   2026-10-06. Tracked in [#319](https://github.com/ColdPhase/flux/issues/319).
2. **The README's port fallback was a fixed `8090`.** On this Mac, the preview project
   the preview project flux-flux-prostota-preview-39d6087c already publishes 8090, so the example would have collided.
   The README now asks for another free port and gives `FLUX_PORT=8090` only as an example.
3. **`docker system df` failed in this session** with `failed to calculate image disk usage: lstat
   .../snapshots/4369/fs: no such file or directory`. It is a Docker Desktop daemon error and not
   from the launcher. `./flux up` and `./flux demo` were not affected, but the after-run disk
   snapshot is empty. No issue is filed, because it is not in the quick start.

### Cleanup and isolation

- **Project names:** flux-flux-305-cold-3d6e710d and flux-flux-305-warm-c63367cc, the folder
  name plus a path hash. `docker compose ls` before the warm clean listed five projects: the two
  flux-305 projects and three others. After `./flux clean -y` in the warm clone, the three
  others were listed unchanged. The cold clone had been cleaned by `./flux clean -y` (exit 0) before
  the warm pass started.
- `./flux clean -y` removed each project's containers, volumes (`_files`, `_flux-checkout`,
  `_pgdata`) and image (flux-foundation:<project>). A search of volumes and images for flux-305
  found nothing afterwards.
- Ports 19840 and 19841 were free before the run. The scratch clones were deleted, since their
  `docker/.env` held generated secrets.

## Linux amd64, 2026-10-10: run 38051226054

The [Time to first run workflow](https://github.com/ColdPhase/flux/actions/runs/38051226054)
ran once, dispatched by `Zamojski5` on `main` at 12:14 UTC on 2026-10-10 and finished with
`success`. It measures steps 1 to 3 cold and warm, as [how the workflow measures](#linux-amd64-how-the-workflow-measures)
describes. Steps 4 and 5 are not in the workflow, so they have no Linux numbers.

### Machine and revision

- **Runner:** GitHub-hosted `ubuntu-latest`, image `ubuntu24 20261004.327.1`, Ubuntu 24.04.5
  LTS, kernel `6.17.0-1022-azure`, `x86_64`. Intel Xeon Platinum 8370C at 2.80 GHz, 4 vCPUs,
  15 GiB of memory, and 86 GB free on a 145 GB disk.
- **Tools:** Git 2.55.0, Docker Engine 28.0.4, Docker Compose v2.38.2, buildx v0.37.2.
  Docker had 4 CPUs and 15.6 GiB of memory.
- **Revision:** `ecdceb95e9cd23cdef95fb23ff6308fcb1a515c4`, which was `main` when the run
  started. `main` moved to `9613e29e` during the run, so the warm pass checked out `ecdceb95`
  to build the same code as the cold pass.

### Cache state

- **Cold:** the runner had 6 preloaded images, none of them `node` or `postgres`, and an empty
  build cache. The run pulled both base images and built the image; the build cache then held
  496 MB. This is a true cold start, not a `FLUX_NO_CACHE` approximation.
- **Warm:** `./flux clean -y` removed the first clone's containers, volumes and image. The base
  images and the build cache stayed. The warm build reported `CACHED` for every step.

### Timing (2026-10-10 run)

| Mark | Cold | Warm |
| --- | --- | --- |
| 1. `git clone` | 7.2 s | 6.9 s |
| 2. `./flux up`, until it exits | 2 min 12.2 s | 10.0 s |
| 2. then the printed URL answers HTTP 200 | 0.02 s | 0.01 s |
| 3. `./flux demo`, until the logins print | 1.2 s | 1.2 s |
| From clone start to the logins | 2 min 20.6 s | 18.7 s |

The runner's datacenter network makes the clone and the npm download faster than a home
connection, so treat these as a lower bound. The workflow's artifact
`time-to-first-run-38051226054-1` has the raw marks, the `./flux up` and `./flux demo` logs,
and the Docker state after each pass.

### Not measured

- **Step 4, the first message.** It needs a browser, and the workflow does not run one. The
  macOS run of 2026-10-06 measured it at 0.8 s, which does not depend on the cache.
- **Step 5, the first agent reply.** It needs a person's MCP client and model account
  ([#320](https://github.com/ColdPhase/flux/issues/320)).

## macOS arm64, 2026-10-10: first agent reply through Claude Code (#320)

This is an agent-driven run, not a person and not a clean clone, so it does not satisfy
criterion 2 of [#320](https://github.com/ColdPhase/flux/issues/320). It checks the README steps
against a running stack and a real Claude Code client.

### Machine and revision

- **Mac:** the same machine as 2026-10-06. **Client:** Claude Code 2.1.294 on the host.
- **Revision:** a worktree of `origin/main` at `e06248c5`, with this change's README edit. Codex
  was not run: the host has no Codex client and no OpenAI account was used.
- **When:** 2026-10-10, about 12:44–13:50 CEST, with other agents' Docker runs holding the slots.

### Method

- `./flux reset`, `./flux up` and `./flux demo` with `FLUX_PORT=19050`,
  `FLUX_MAILPIT_PORT=19051` and `FLUX_DEV_PORT=19052`. The reset made the demo data empty first.
  `./flux up` took 18 s because its images were cached by earlier builds of the same lockfile.
- **The browser is Playwright, not a person's browser.** Steps 1–3 and the consent in step 5 ran in
  the pinned Playwright image (`mcr.microsoft.com/playwright/python:v1.62.0-noble`) on the
  project's Compose network, with the UI tests' loopback forwarder. The container also installed
  the Python client from `app/tests/ui/requirements.txt`, about 40–55 s per run, which is not
  counted below.
- **Step 4** ran `claude mcp add --transport http flux http://127.0.0.1:19050/mcp` and
  `claude mcp login flux` on the host, the second under `script` (a pseudo-terminal). The `open`
  command was a shim that recorded the authorize URL instead of opening a browser. Playwright
  captured the redirect to `localhost:<port>/callback` and did not follow it. The host then
  requested that callback with `curl`, and Claude Code completed the token exchange.
- **Step 6** ran `claude -p` with the README question, `--allowedTools mcp__flux`,
  `--max-turns 12` and `--output-format json`. The model account was the author's: 17 turns,
  USD 0.35. The first attempt used `--max-turns 4` and stopped with "Reached max turns (4)"; that
  limit was this run's choice, not part of the README.
- **Cleanup:** `claude mcp logout flux`, `claude mcp remove flux -s local`, then `./flux down`.

### What the walkthrough showed

1. **The default connection cannot consent (fixed in the README).** The first run used the
   README's defaults, **Read and propose** and no **Allowed actions**. The consent chooser then
   showed "This connection or project is no longer available to you." Claude Code's authorize
   request asks for `flux.context.read`, `flux.proposal.write`, `flux.action.execute` and
   `offline_access`. `chooseFlow` in `app/packages/db/src/repositories/agent-connections.ts`
   refuses a flow whose scopes the connection does not all contain, and the route returns 404.
   Ticking **Run approved project actions** under **Allowed actions** fixes it, and a standing
   grant is still needed before any action runs. The README step 3 now says so.
2. **The message is misleading.** A scope mismatch reads as "no longer available". Whether a
   connection should cover a subset of the requested scopes is a separate decision, not made here;
   see the follow-up named under "Not measured" below.
3. **`claude mcp login` needs a terminal.** Without one it stops with "stdin isn't a terminal".
   In a terminal it prints the authorize URL and waits. Without a consent it stops with
   "Authentication timeout" after a few minutes. The README now says both.
4. **Client registration works without a fixture.** Claude Code's authorize request names the
   client metadata document `https://claude.ai/oauth/claude-code-client-metadata`. The consent
   page showed "Client details from claude.ai", and the authorization completed. So the server read
   that document over HTTPS from the container. This is inferred from the result, not from a log.
   No fixture token was used.
5. **The reply came from Flux.** The answer to the README question used the read tools and said
   it changed nothing.

### Timing (2026-10-10 run)

| Mark | Duration |
| --- | --- |
| `./flux reset` | 3 s |
| `./flux up`, until the URL answered 200 | 18 s |
| `./flux demo` | 3 s |
| Steps 1–3 in the browser (sign in, agent, connection saved) | 1.7 s |
| `claude mcp add` | 1 s |
| Consent in the browser (chooser, consent, Allow) | 1.8 s |
| Callback to "Authenticated with flux" and Connected | 1 s |
| First model reply (`claude -p`, 17 turns) | 35 s |

The times are measured by the scripts. The Playwright container starts (about 95 s in total)
and the reading and typing a person would do are not in them.

### Server side

- `GET /mcp` without a token returns 401 with `WWW-Authenticate: Bearer resource_metadata=…`.
- `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-authorization-server/api/auth`
  return 200.

### Decision: `./flux demo` does not seed an agent

Criterion 1 of #320 asked whether the demo should seed Ada's personal agent with a grant. It
should not. The grant and the consent are the steps a newcomer most needs to see, and the first
of them is where this run broke. A seeded agent would hide both. Steps 2–3 cost a person about
a minute; that is an estimate, not a measurement. Status: proposed for peer review with this
PR. Revisit after a person's measured run.

### Not measured

- A person with their own Claude Code or Codex account on a clean clone, and the time from
  `git clone` to their first reply (criterion 2 of #320).
- Codex. `codex mcp add flux --url …` and `codex mcp login flux` match the help of
  `codex-cli 0.162.1`, which was run in a throwaway `node:22` container. The OAuth flow was not run.
- The scope rule in point 1 above, and the wording in point 2. Both need a decision and a
  follow-up issue.

## macOS arm64, 2026-10-06

### Machine and revision

- **Mac:** Apple M4 Pro, 14 cores, 24 GB memory, macOS 26.3.1 (a), build 25D771280a.
- **Docker:** Docker Desktop 4.54.0 (Engine 29.1.2, Compose v2.40.3-desktop.1). The Docker
  VM had 14 CPUs and 13.6 GiB of memory.
- **Git:** 2.50.1 (Apple Git-155).
- **Revision cloned:** `main` at `efb1fb94bcdd88948f3966e4f6a978e02bde5182`.
- **When:** 16:32–16:53 CEST.
- **Other load:** when `./flux up` started, 12 other containers were running, and two
  `check_application.sh` runs of other work held the host's other Docker slots.

### Cache state

- **Observed:**
  - The base images `node@sha256:ebfe2f…` and `postgres@sha256:77f585…` were already
    present.
  - The build ran its expensive steps:
    - `corepack install`, 4.6 s;
    - `pnpm fetch`, which downloaded 410 packages from registry.npmjs.org with 57
      slow-download warnings;
    - `pnpm build && pnpm typecheck && pnpm lint`, 120.7 s.
  - Free disk was 14 GB when the Docker step was requested, below the host guard's 15 GB.
    The guard ran `docker buildx prune --keep-storage 6gb` before it let the step start.
- **Inferred:** the per-step durations BuildKit reported on the build's critical path add up
  to 243.7 s (4.6 + 112.6 + 0.7 + 5.1 + 120.7). That is more than the 204.8 s wall clock of
  the whole `./flux up`. So the `pnpm fetch` step most likely joined an identical step that a
  concurrent build of the same lockfile was already running. The wall clock is the measured
  number. The per-step figures are only indicative.
- **Consequence:** this run did the work a `--no-cache` build does. `FLUX_NO_CACHE=1` would
  rebuild the same layers, and it does not pull base images again either.

### Method

- A fresh folder in the temporary directory. The README commands were run as written:
  `git clone https://github.com/ColdPhase/flux.git`, `cd flux`, `./flux up` and
  `./flux demo`. The only addition was the port variables on the first `./flux up`
  (see [outside knowledge](#outside-knowledge-the-measurement-used)).
- A shell driver wrote a millisecond timestamp at each step boundary.
  - Step 2 ends when `curl` of the URL that `./flux up` printed returns 200. The first
    request succeeded, 0.14 s after `./flux up` exited.
  - Step 3 ends when `./flux demo` exits, after it prints the URL and both logins.
- **Step 4** used Playwright 1.63.0 Chromium in Docker, the image pinned by the `e2e` stage of
  `docker/Dockerfile`, in place of the person's browser. The script:
  1. opened the printed URL;
  2. signed in as Ada with the printed login;
  3. opened *Community garden sensors* in the sidebar;
  4. typed into *Write a message* and pressed *Send message*.

  The step ends at the `201` response of `POST /api/v1/projects/:id/conversations`. After a
  reload the message was still there. Not counted: starting the container and browser
  (0.7 s), preparing the runner, and a person's reading and typing time.
- The script ran twice. The first run had no stamp for the save response. It reached the
  visible message in 0.96 s. The second run is the one reported.

Raw timestamps (Unix seconds; the first is 16:32:23 CEST):

| Mark | Time | Step time |
| --- | --- | --- |
| clone start | 1791297143.253 | |
| clone done | 1791297331.443 | 188.2 s |
| `./flux up` requested | 1791297331.518 | |
| `./flux up` started (Docker slot granted) | 1791297418.877 | 87.4 s wait, excluded |
| `./flux up` exited, URL printed | 1791297623.698 | 204.8 s |
| URL answered 200 | 1791297623.839 | 0.14 s |
| `./flux demo` started | 1791297623.846 | |
| `./flux demo` exited, logins printed | 1791297626.095 | 2.25 s |
| UI: page requested (second run, container clock) | 1791298411.711 | |
| UI: sign-in page shown | +0.161 | |
| UI: signed in, sidebar shown | +0.621 | |
| UI: project conversation open | +0.732 | |
| UI: message saved (`201`) | +0.791 | 0.79 s |
| UI: message visible | +0.804 | |

From clone start to the logins, the wall clock was 482.8 s (8 min 03 s). Without the 87.4 s
wait for the Docker slot, it was 395.5 s.

### Where the README was not enough

1. **The clone is large.** "`git clone https://github.com/ColdPhase/flux.git`" downloaded a
   206 MiB pack in 3 min 08 s, about 1.1 MiB/s. This is 47% of the total. The tree is
   224 MB. Of that, 1,405 images and videos, mostly review evidence under `docs/`, take 201 MB,
   while `app/` is 8.5 MB. The README gives no size. → [#319](https://github.com/ColdPhase/flux/issues/319).
2. **Port 8081 is fixed.** The README says "Then open <http://127.0.0.1:8081/>" and does not
   say what to do if the port is taken. `./flux help` documents `FLUX_PORT`, used when
   `docker/.env` is created. → Fixed in this change: the README now says to open the URL
   that `./flux up` prints, and to start with `FLUX_PORT=8090 ./flux up` when 8081 is busy.
   This run used that mechanism. Both `FLUX_PORT` and `FLUX_PUBLIC_ORIGIN` landed in
   `docker/.env`, and `./flux demo` used them.
3. **The duration is not stated.** The README says `./flux up` "builds, migrates, starts".
   The launcher adds "the first build takes a few minutes". → Fixed in this change: the
   README says the first run takes a few minutes and links this page.
4. **There is no step to connect an agent.** The README names "connecting your own
   MCP-capable AI agent" under Project status, but the quick start has no step for it.
   - In the app, Settings → Agent connections (MCP) shows the `claude mcp add` and
     `codex mcp add` commands for this server.
   - The demo has no personal agent, so a person must first create one and grant it the
     project.
   - The page says "Use your self-hosted Flux HTTPS address", but it shows the loopback
     `http://` URL.
   - → Fixed in this change: a short README pointer to that page. The walkthrough and its
     measurement are [#320](https://github.com/ColdPhase/flux/issues/320).
5. **No gap in steps 3 and 4.** `./flux demo` printed the URL and both logins. The sign-in
   form, the project in the sidebar and the message box were found by their visible labels.

### Outside knowledge the measurement used

None of these are README gaps. They are what the measurement needed on a shared host:

- **Ports.** The first `./flux up` ran with `FLUX_PORT=19760`, `FLUX_MAILPIT_PORT=19761` and
  `FLUX_DEV_PORT=19762`, so the run could not collide with other work on the host.
  - `lsof` showed that 8081 was free just before `./flux up`, so the literal command would
    have worked.
  - 8025 and 5173 were free when checked twelve minutes earlier, and `./flux up` does not
    use them.
  - The printed URL matched `docker/.env`.
- **Project name.** This is the README default: `./flux` named the project flux-4e8e81e9,
  from the folder name and a hash of its path. No container, volume or image of that name
  existed before.
- **Docker slot.** The host's guard limits concurrent Docker builds and keeps free disk. Its
  wait is excluded above.
- **Browser.** The Playwright runner for step 4 stood in for a person's browser.

### Not measured

- **A cold run (`FLUX_NO_CACHE=1`, or a machine without the base images).** Free disk was
  12–16 GB, and this measurement needs at least 20 GB free before it starts. Given the cache
  state above, it would mostly add pulling the pinned Node.js and PostgreSQL base images.
  An unshared `pnpm fetch` might also be slower.
- **A second run of the same revision with every layer cached.** Not run, for the same disk
  reason.
- **Step 5, the first agent reply through your own MCP client.** It needs:
  - an interactive OAuth consent in a browser (`claude mcp login flux` or the Codex
    equivalent);
  - the person's own model account;
  - steps the README does not contain.

  No account with an outside service was created for this.

  The server side answered: `/mcp` returned 401 with a `resource_metadata` pointer, and
  `/.well-known/oauth-protected-resource/mcp` and
  `/.well-known/oauth-authorization-server/api/auth` returned 200.
  → [#320](https://github.com/ColdPhase/flux/issues/320).
- **A person's time.** Reading the output, typing the login and writing a message take a
  person seconds to minutes. A script does it in under a second.

### Cleanup

- `./flux down` and `./flux clean -y` in the clone removed:
  - the containers, the network and the `pgdata` and `files` volumes of flux-4e8e81e9;
  - its owner marker volume;
  - the `flux-foundation:flux-4e8e81e9` image.
- The clone folder was deleted.
- The BuildKit cache is shared by every project on the host, so it was not pruned.

## Linux amd64: how the workflow measures

The [Time to first run workflow](../../.github/workflows/time-to-first-run.yml) measures it on a
GitHub-hosted `ubuntu-latest` runner. It runs only on manual dispatch (`workflow_dispatch`):
no PR, push or schedule starts it, and it has no matrix, as
[CI and releases](../agents/ci-and-releases.md) asks. Each run gets a fresh virtual machine,
so it cannot touch another Compose project, port or volume. It keeps the README defaults:
port 8081 and the project name derived from the clone's folder.

### Run it

GitHub dispatches a workflow only when the file is on the default branch, so this works
after the workflow is merged. One run takes up to an hour of Actions time. Dispatch it once
for each measurement, not on every change.

```sh
gh workflow run time-to-first-run.yml --ref main
gh run list --workflow time-to-first-run.yml --limit 1   # note the run ID
gh run watch <run-id>
gh run download <run-id>
```

In the browser: Actions, then *Time to first run*, then *Run workflow* on `main`. The job
summary shows the table of times. The artifact `time-to-first-run-<run-id>-<attempt>` has the
details.

### What the job does

1. **Records the machine**: CPUs, memory, free disk, the Git, Docker and Compose versions,
   the runner image version, the listening ports, and the preloaded Docker images and build
   cache. The runner image comes with some Docker images, so the job records its own cache
   state before cloning.
2. **Cold pass**: times `git clone https://github.com/ColdPhase/flux.git`, then `./flux up`
   until it exits, then the printed URL until it answers HTTP 200, then `./flux demo` until
   the logins print.
3. **Warm pass**: `./flux clean -y` removes the first clone's containers, volumes and image.
   The base images and the BuildKit cache stay. A second clone in a new folder is timed the
   same way. If `main` moved during the run, the second clone checks out the first one's
   revision before `./flux up`, so both passes build the same code.
4. **Uploads the timings**, also when a step failed:
   - `machine.txt`;
   - `timings.tsv`, the raw marks in Unix seconds;
   - `summary.md` and `summary.json`, the times per step;
   - the revision, the URL and the `./flux up` and `./flux demo` output of each pass;
   - the Docker images and disk use after each pass.

   The two demo passwords are redacted in the log and the artifact. The job stops before the
   upload if one is found anyway.

### Limits

- **Steps 4 and 5 are not in the workflow.** The first message needs a browser (Playwright,
  as in the macOS run), and the first agent reply needs a person's MCP client and model
  account ([#320](https://github.com/ColdPhase/flux/issues/320)).
- **The clone is always the default branch**, as in the README, whatever ref the workflow
  is dispatched from. The revision is in the artifact.
- **The network is a datacenter's.** It makes the clone and the npm download faster than on
  a home connection, so these numbers are a lower bound. A clean Linux machine on a home
  network would show what people see. Use it after the workflow, if the two differ in a way
  that matters.

### Record the result

Add a section *Linux amd64, YYYY-MM-DD* above the macOS one, with the run link, the machine
from `machine.txt`, the revision, both passes' times and the cache state. Then fill the
Linux column of the [summary](#summary).

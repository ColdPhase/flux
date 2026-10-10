# Time to first run (#305)

How long it takes from `git clone` to a working Flux when you follow the
[README quick start](../../README.md#quick-start) literally. This is L-1 of the v0.1 launch
plan, tracked in [#305](https://github.com/ColdPhase/flux/issues/305). Add each new
measurement as a section, newest first, and keep the summary current.

## Summary

| Step | macOS arm64, 2026-10-06 | Linux amd64 |
| --- | --- | --- |
| 1. `git clone` | 3 min 08 s | not measured yet |
| 2. `./flux up`, until the printed URL answers HTTP 200 | 3 min 25 s (6 min 33 s from clone) | not measured yet |
| 3. `./flux demo`, until the logins print | 2.3 s (6 min 35 s from clone) | not measured yet |
| 4. Sign in and post the first message in the demo conversation | 0.8 s scripted (6 min 36 s from clone) | not measured yet |
| 5. First agent reply through your own MCP client | not measured ([#320](https://github.com/ColdPhase/flux/issues/320)) | not measured |

Clone and dependency download take most of the time. Both depend on the network.
The first run below is close to a no-cache build (see [cache state](#cache-state)). It was
measured while other Docker builds ran on the same Mac, so treat it as an upper bound for
an idle machine.

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

## Linux amd64: how to measure

This has not been measured yet. The
[Time to first run workflow](../../.github/workflows/time-to-first-run.yml) measures it on a
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

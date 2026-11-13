# Agent runtime: the owner's own Claude Code or Codex in Flux

This guide is for the person who runs a Flux instance with [`./flux`](../../flux). It covers the
optional agent runtime: people connect their own Claude or ChatGPT subscription in Connect AI, and Flux runs
that CLI (Claude Code or Codex) for their agents, isolated from everyone else, on your server. One runtime serves everyone
([product contract](https://github.com/ColdPhase/flux/blob/a82ee012d0dc0a33e9ab14925f8f400c96f31e60/docs/product/ai-modes.md#aim-3--the-runtime-transport)).

**The first `./flux up` turns it on where the host can run it** (founder decisions, Hubert, 2026-11-13,
[#1438](https://github.com/ColdPhase/flux/issues/1438) and [#1441](https://github.com/ColdPhase/flux/issues/1441): AI works
right after install). With `FLUX_AGENT_RUNTIME` empty, no runtime service runs, the API reports the
feature as not enabled, and nothing below applies; on a host that cannot run it, that is how it stays, and the company's owners
and admins read why in one line in Settings › AI. The published release `compose.yaml` does not
contain it and never asks; the runtime is available from a source checkout with `./flux`
([Switch it on](#switch-it-on)), or from a release install with the release's optional
`compose.runtime.yaml` and `runtime.sh` ([Installing from a release](#installing-from-a-release)).

## Before you switch it on

- **Your duty for Claude Code.** Anthropic: "preinstalling or running Claude Code in your products or
  services (e.g. in hosted sandboxes or other agent infrastructure) requires agreeing to our Commercial
  Terms of Service". On a self-hosted Flux you are that party. Agree to Anthropic's Commercial Terms with
  Anthropic itself (for example through an Anthropic Console organization), then set the date you agreed
  in `FLUX_AGENT_RUNTIME_COMMERCIAL_TERMS`. Flux records this statement and its date; it does not check
  it. A paid hosting service keeps the runtime off.
- **You can read every owner's login.** The CLIs keep each owner's login as a file in that owner's directory
  in the runtime's volume. Host root can read that volume, and so can anyone who can read your disks or disk
  snapshots. Owners are told so before they sign in. Offer the runtime only where owners trust you.
- **Vendors may restrict this use.** Both vendors recommend API keys for products and automation and
  may act "without prior notice", possibly on an owner's account
  ([accepted risks](../product/ai-modes.md#accepted-risks)). `server` connections with an API key are
  the recommended path; the runtime is for owners who choose it.

## Switch it on

### With the question (`./flux up` the first time, `./flux ai on` later)

The launcher asks whether people on this Flux may sign in with their own ChatGPT and Claude
subscriptions ([F-027 AST-1](https://github.com/ColdPhase/flux/blob/a82ee012d0dc0a33e9ab14925f8f400c96f31e60/docs/product/assistant.md#ast-1--subscriptions-are-the-normal-way-to-connect)):

```text
Let people on this Flux sign in with their own ChatGPT and Claude
subscriptions? Flux runs the official Codex and Claude Code for each
person, each isolated from the others.  [Y/n]

Claude Code also needs the person who runs this Flux to accept
Anthropic's Commercial Terms (for example by creating a Console
organization). Have you accepted them?  [y/N]
```

- **When it asks.** `./flux up` asks while it *creates* `docker/.env` (a fresh checkout), before the
  build, and only when stdin and stdout are a terminal. An existing `docker/.env` is never asked about,
  and neither is a second `./flux up`, so a deployment that is already running stays as it is. Without a
  terminal (CI, a pipe, `./flux up > log`) nothing is asked: the host is checked and the default answer applies,
  `FLUX_AGENT_RUNTIME=codex,pi` (#1438; pi runs agents on API keys, #1441, and comes with every answer that turns the runtime on). Claude Code is never on without a typed yes. A host that fails the check keeps the runtime
  off and `./flux up` writes the one line it found to `FLUX_AGENT_RUNTIME_OFF_REASON`, which Settings › AI shows the company's
  owners and admins; `./flux ai on` clears it. To skip the check and the question, set `FLUX_AGENT_RUNTIME` in the environment,
  even empty (`FLUX_AGENT_RUNTIME= ./flux up` keeps it off). `./flux dev` never asks.
- **`./flux ai on`** asks the same questions on an existing instance, writes the answer to `docker/.env`
  and applies it like `./flux up` (builds and starts the runtime). It needs a terminal and refuses without
  one; set the variables by hand then. It only adds: if Codex is already on, it asks only the
  Commercial Terms question; if Claude Code is on too, it says so and changes nothing. It never removes a
  client. To turn the runtime off, empty `FLUX_AGENT_RUNTIME` and run `./flux up` (see
  [Switching off](#switching-off-purging-reset-and-clean)).
- **Enter means yes, for Codex.** `Enter` on the first question writes `FLUX_AGENT_RUNTIME=codex`.
  Codex is available: owners sign in with ChatGPT on Settings → AI (Connect AI).
  `n` writes nothing and does not ask the second question.
- **Claude Code needs a typed `y`.** The second question records *your* statement that you have agreed to
  Anthropic's Commercial Terms (see [Before you switch it on](#before-you-switch-it-on)), so `Enter`, `n`
  or any other answer does not make it. `y` writes `FLUX_AGENT_RUNTIME=codex,claude_code` and
  `FLUX_AGENT_RUNTIME_COMMERCIAL_TERMS=<today>`; the API records that statement, with the date, in
  `agent_runtime_operator_statements` when it starts. Flux does not check it. An unclear answer to the
  first question is asked again, and three of them count as `n`; Ctrl-D decides nothing.
- **Hosts that fail the checks are not asked.** Before it asks, the launcher checks the Docker engine (not
  the machine you type on: the runtime runs in the engine's kernel, which on Docker Desktop is a VM) and
  prints one line saying why when a check fails; `./flux up` then carries on with the runtime off and
  `./flux ai on` stops with that line:

  | Check | How the launcher asks | Reason line says |
  | --- | --- | --- |
  | Linux engine | `docker info`, `OSType` | the engine is not a Linux engine |
  | Memory, CPU and process limits | `docker info`: `MemoryLimit`, `CpuCfsQuota`, `PidsLimit` | the engine cannot set the limits the runtime has |
  | `internal` networks | `docker network create --internal`, removed at once | the engine cannot create an internal network |
  | Yama `ptrace_scope` of 1 or higher | one throwaway container (read-only, no network, no capabilities) of the Dockerfile's pinned `node` base image runs `cat /proc/sys/kernel/yama/ptrace_scope`, the same file the supervisor reads | the kernel has no Yama policy or it is 0 (Docker Desktop has none) |

  If the engine cannot answer (for example it cannot pull the base image), the line says the check could
  not be run. The check image is the one the build pulls anyway.
- **Paid hosting never asks.** A hosting service run by the Flux project keeps the runtime off
  ([AIM-3](https://github.com/ColdPhase/flux/blob/a82ee012d0dc0a33e9ab14925f8f400c96f31e60/docs/product/ai-modes.md#operator-switch-and-installation)). It deploys the release
  `compose.yaml`, where `FLUX_AGENT_RUNTIME` is empty and no launcher runs. The launcher has no
  paid-hosting setting; refusing runtime sign-in there is a server rule (F-027 AST-2.4).
- **On a self-hosted Flux, Yes can be the default** because the operator is the owner, or someone the
  members already trust with their data. Each person still signs in themselves and is told, before
  signing in, that the operator can read the login.

### By hand

Equivalent to the answers above. In `docker/.env`:

```sh
FLUX_AGENT_RUNTIME=claude_code
FLUX_AGENT_RUNTIME_COMMERCIAL_TERMS=2026-10-05   # the date you agreed with Anthropic
```

Then `./flux up`. The values are `claude_code`, `codex`, or `claude_code,codex`. Codex needs no operator
statement; Claude Code needs the Commercial Terms date.

`./flux up` then also builds and starts the Compose profile `runtime`:

| Service | What it does |
| --- | --- |
| `runtime-install` | One-shot. Installs the pinned Claude Code release into the `runtime-tools` volume (the runtime mounts it read-only), after checking Anthropic's GPG-signed release manifest against the key fingerprint Anthropic publishes and the binary's SHA-256 against that manifest. Flux never ships Claude Code in an image. It reaches only `downloads.claude.ai`, through `runtime-egress`. A verified install of the pinned version is kept on later starts. |
| `runtime-1` | One runtime for everyone. A small supervisor (and, during a sign-in or a run, each person's CLI under their own user id), with its own volume and its own internal network. |
| `runtime-manager` | Drives the supervisors for the API and worker. No database and no Docker access. |
| `runtime-egress` | The runtime's only way out: HTTPS to the hosts the enabled CLIs document, and the Flux `/mcp` route. |

`./flux` generates the secrets it needs in `docker/.env` (`FLUX_RUNTIME_MANAGER_SECRET`, one
`FLUX_RUNTIME_SECRET_1`) and never changes an existing value. The runtime receives only its own
secret; `runtime-manager` receives all of them.

**No Docker socket.** No Flux service, the runtime included, mounts a Docker or Podman socket or gets any
other container engine API (`tests/test_container_isolation.py` checks every Compose file). Rootless
Docker or Podman is therefore not a prerequisite. The engine must support `internal` networks, a
read-only root filesystem, `cap_drop`, `pids_limit`, and memory and CPU limits. The runtime is tested on Docker
Engine 29; other engines are **unverified**. gVisor (`runtime: runsc` in an override) is optional and
untested.

## What the runtime gets

One runtime serves everyone (#860). Its settings are static (one YAML anchor in `docker/compose.source.yaml`); nothing at run
time can change them:

- **Each person has their own user id.** The supervisor gives every person who connects a plan a user id of their own
  (20000 to 59999) and a directory `/data/<uuid>`, mode `0700`, owned by that id. All their CLIs run under it, with no
  capabilities. The kernel keeps people apart: one person's CLI cannot read another's files, see their environment or signal
  their processes. After every run the supervisor ends every process of that id. Everything inside a person's directory is
  written and deleted as that person, so a link they planted leads nowhere; root touches only the directory itself. People
  share one network namespace and `/proc`: a person's process can see another's command line, never its environment or memory,
  and can reach their loopback ports. Flux passes no secret on a command line. `/dev/shm` is read-only.
- **The supervisor** starts as root inside the container, with only `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `KILL`, `SETGID` and
  `SETUID`, to create those directories and start those processes. No other Flux service has more than `cap_drop: ALL`. The root
  filesystem is read-only, `no-new-privileges` is on, there is an init process, and there are no host mounts. Nothing mounts a
  Docker or Podman socket.
- The Node supervisor sets Linux `PR_SET_DUMPABLE=0` before reading its secret. The runtime requires Linux Yama
  `kernel.yama.ptrace_scope` of 1 or higher. **A host that does not meet it stops the runtime with one clear message and the
  fix:** the container stays up without listening, with no restart loop, its health check stays red, and `./flux up` (and
  `sh runtime.sh up`) ends with that message instead of reporting a healthy Flux. The worker cannot admit a runtime that refused.
  The next `./flux up` starts it again, so it looks at the host again.
  Fix it with `sudo sysctl -w kernel.yama.ptrace_scope=1`, add `kernel.yama.ptrace_scope = 1` to `/etc/sysctl.d/90-flux.conf` so it
  survives a reboot, and run `./flux up` again. Fedora's default is 0. Flux does not change host kernel settings. **Docker
  Desktop is unsupported:** its LinuxKit kernel has no Yama (checked 2026-10-08 by an independent evaluator).
- The supervisor requires Node's sole startup flag to be `--disable-sigusr1`, empty `NODE_OPTIONS`, and no already active
  inspector. Additional or negated flags refuse the same way. The pinned Node 24.21 supports this flag.
- Limits for all the agents together: `FLUX_RUNTIME_MEMORY` (no swap) and `FLUX_RUNTIME_CPUS`, 2048 processes, a 256 MiB tmpfs
  `/tmp`. `./flux` and `runtime.sh` set the two from the server: its memory less 1.25 GiB, and all its CPUs but one.
- Container logs are rotated at 3 × 10 MB.
- Only its own volume at `/data` and the read-only tools volume.
- Only its own `internal` network, shared with `runtime-manager` and `runtime-egress` and nothing else, so it cannot reach the
  database, the worker, the API outside `/mcp`, the cloud metadata address or your LAN. Docker would give the host an address on
  every bridge, which would let the runtime reach services the host itself listens on; the runtime's internal networks set
  `com.docker.network.bridge.inhibit_ipv4`, so the host has none there.

Docker's local volumes have no size quota, so the supervisor refuses a run while a person's directory exceeds 256 MiB.

### What each agent needs

Every person with Connect AI can have their agents ready: there is no fixed number of people. A person who is not running
anything costs their directory on disk and nothing else: no process, no memory, no CPU. Flux works out from the runtime's memory
how many agents can run at the same time:

    (runtime memory − 256 MiB for the supervisor) ÷ 1 GiB per agent, at least 1

| Server | Runtime memory | Agents at once |
| --- | --- | --- |
| 4 GB | about 2.5 GiB | 2 |
| 8 GB | about 6.4 GiB | 6 |
| 16 GB | about 14 GiB | 14 |

The others wait in order, and their task says "Waiting for room on the server". To choose the number yourself, set
`FLUX_RUNTIME_MAX_RUNS` in `docker/.env` and run `./flux up`; `./flux runtime status` shows the number in force. There is no
setting in the app.

The memory limit is shared and there is no bound per run, so one CLI far over its planned 1 GiB can get another person's CLI or the
supervisor killed for memory, and one person can fill the shared 256 MiB `/tmp`. If that happens, lower `FLUX_RUNTIME_MAX_RUNS`.

Plan for 1 GiB of memory, up to one CPU while it thinks, and 256 MiB of disk for each active agent, plus the tools volume:
Anthropic's signed manifest lists the Linux x64 binary of 2.1.289 at 246 MB (retrieved 2026-10-05).

### Resources measured

Measured 2026-11-05 in Docker with the runtime's own settings (2560 MiB, one CPU, no swap, read-only root, the six capabilities).

| What | Result |
| --- | --- |
| Supervisor, nobody connected | 70 MiB resident |
| Supervisor, 500 people connected, nobody running | 92 MiB resident, 0.00% CPU, 2 processes |
| One more person | about 44 KiB of supervisor memory, 5 ms to connect, no process |
| Claude Code 2.1.285, one start as a person's user id, not signed in, no network | 195 MiB at its peak, 0.44 s of CPU |
| Codex 0.160.1 `app-server`, idle for 8 s as a person's user id, not signed in, no network | 87 MiB, 0.07 s of CPU |

The first three rows come from `scripts/check_runtime_people.sh`, which uses fake CLIs and works on any Linux engine. The last two
are the real binaries, so they show what a CLI costs before it does any work.

**Not measured:** a real run, with a signed-in CLI talking to its vendor. It needs a vendor sign-in, and the machine these numbers
come from has `ptrace_scope=0`, so its runtime refuses to start. The 1 GiB per agent is therefore the planning figure of the
performance report, about five times what a CLI uses to start. Change `FLUX_RUNTIME_MAX_RUNS` if your own runs need less or more.

## People in the runtime and releasing them

A person's first use gives them their place in the runtime: a directory and a user id, holding both their Claude Code and Codex
logins. A company role gives no access to anyone's place.

- `./flux runtime status` lists the runtime, its state, how many agents it runs at once and each person's e-mail, and what the
  supervisor reports (boot id, how many people `/data` holds).
- `./flux runtime release <email>` releases that person's place: the worker stops what they have running, signs their CLIs
  out, ends their processes, removes what they left anywhere in the shared `/tmp` and deletes their directory. The cleanup runs
  as that person, so it never reaches more than their user id reaches: also a directory of theirs inside a directory of someone
  else's that anyone may write to, directories with no rights, and trees deeper than `PATH_MAX` that `rm` cannot enter. It finds
  only what it can list. In a directory of someone else's that it may enter but not read (mode `0733`, or one opened to everyone
  and closed to `0700` by its owner), a file of theirs is not found, and the release can still report that it deleted everything.
  That file stays, and their user id goes to the next person, who can then open it by name. It goes when the runtime restarts, or
  when the owner of that directory is released. Otherwise, while anything of theirs stays, the directory stays too, the release is not
  reported as deleted and their user id goes to nobody else. The worker asks again every ten seconds, and does not sign them out a
  second time: the sign-out of the first try stands. If it stays open, see [A release that stays open](#a-release-that-stays-open).
  They see in Settings that the operator released it.
- **Idle policy** (off by default): `FLUX_AGENT_RUNTIME_IDLE_DAYS=<1–365>` releases a place that had no run for that many days. A guest's place is not released: it is kept, hidden, until they are a member again (C-50), and then its idle window starts at the later of its last use and the person's last role change in the company, so a guest back as a member is not released for the days they could not use it (#1095).
  Settings shows the person the date beforehand.

Flux has no in-app instance administrator role yet, so these operator steps are launcher commands.

### A release that stays open

Signs: the person is still listed by `./flux runtime status` after their release, and the worker's log repeats
`{"event":"release_pending",…,"code":"not_deleted"}` every ten seconds (`docker compose … logs worker`). Nothing else is wrong: the
person's place is the only one affected, and no other person gets their user id while it stays. There are two usual causes.

1. **A leftover of someone else's holds theirs in place.** A directory of one person in the shared `/tmp` that holds a directory of
   another person's, which only that other person can open, cannot be removed by the first person's cleanup. The other person's own
   cleanup (their release) finds it wherever it is and removes it; then the open release finishes at its next try. If that other
   person stays, restart the runtime: `docker compose … restart runtime-1` (`/tmp` is memory and starts empty; the agents running
   there stop). Find the owner of a directory with `docker compose … exec runtime-1 ls -ln /tmp`: the number is a user id, and
   `ls -ln /data` shows which place has it.
2. **A tree too large or too odd for the cleanup**, in `/tmp` or in the person's `/data/<id>`. Remove it with the same walk
   the supervisor uses, as root, which also takes trees deeper than `PATH_MAX`, follows no link (not even one that another person swaps in while it runs) and creates nothing:

   ```sh
   docker compose … exec runtime-1 node /opt/flux-runtime/apps/runtime/dist/supervisor/tree.js remove /data/<id>
   docker compose … exec runtime-1 node /opt/flux-runtime/apps/runtime/dist/supervisor/tree.js remove /tmp/<entry>
   ```

   Do not use `rm -rf` for this: BusyBox `rm` cannot take a tree deeper than `PATH_MAX`. The open release finishes at its next
   try once nothing of the person is left.

If neither fits, `./flux runtime purge` removes every place and the runtime's volumes.

A release reports the sign-out as confirmed when every client either signed out (`ok`) or never had a
login in that binding. Two independent records decide the second case:

- **The runtime's files.** The supervisor reports `not_installed` when the CLI is absent, nothing of that
  client is in the binding directory and no earlier sign-out of it failed (a Codex-only deployment has no
  Claude Code). On its own that is an inference from the binding directory, not a vendor confirmation: a
  lost directory or tools volume looks the same.
- **The database's client history** (`agent_runtime_client_history`, migration 0118). It records, per
  binding and client, that a login may exist: the row is written when a sign-in console is claimed, before
  the runtime is asked to start it, and when the CLI's own status reports a login. Only the CLI's own logout
  returning `ok` clears it; a failed, timed-out, skipped or not-installed logout never does. At release
  (the worker, and `./flux runtime purge`) a `not_installed` client counts as confirmed only while this
  history says no login was started for it. If it does, the release reads *not confirmed* although the
  runtime found nothing to sign out.

A failed or timed-out sign-out also leaves an `unconfirmed-<client>` marker in the binding directory,
which survives the client's files being deleted, so later releases stay *not confirmed*. So do a missing
CLI with its files still present, a directory that cannot be read, and a skipped step.

A runtime that finds something in `/data` that is not a person's directory (for example a stray file) leaves use and
`./flux runtime status` shows it `out_of_pool`. Remove the entry (`docker compose … exec runtime-1 rm /data/<entry>`); it returns
at the next report.

## The sign-in console

An owner signs in from Settings → AI → Connect AI → *Claude plan*, as in a terminal (F-022
"Sign-in as in a terminal"). Settings first tells them that you, the operator, can technically read
their runtime's storage, what Anthropic says about this kind of use, and who pays for each method.

- **Methods.** Every method of `claude auth login`: *Claude account* (`claude auth login`, the default,
  which the CLI also spells `--claudeai`), *Anthropic Console* (`--console`) and *SSO* (`--sso`). The
  pinned CLI's `auth login --help` also lists `--email`, which only pre-fills an address on Anthropic's
  page; the opt-in contract check fails if a later CLI lists any other option.
- **What runs.** The runtime runs exactly that command in a pseudo-terminal, under the owner's own user id: no shell, the CLI's
  clean environment plus `TERM`. The terminal is relayed to the owner's browser over a WebSocket bound
  to their session (API → `runtime-manager` → the supervisor, each hop authenticated as every
  other runtime request). The CLI prints Anthropic's sign-in link; the owner signs in there and pastes
  the code back at the CLI's own prompt. Another member's session cannot attach to it.
- **The card (F-027 A12).** Claude Code's page shows *Open claude.ai* and *Paste*; the supervisor
  recognises only the sign-in URL in the CLI's output (and, for ChatGPT's device sign-in, the code and
  the two failures of Journey 6), in memory, and the API relays it to that owner's card only. *Paste*
  sends the clipboard text to the CLI's own prompt. The terminal is under *Show details*.
- **Reload.** If the page reloads or loses its connection while a sign-in is pending, the API keeps the
  console attached to the CLI in memory (with the last 64 KiB of output for redraw) and the same Flux
  session reattaches with a fresh single-use ticket from `POST /api/v1/agent-runtime/console/resume`;
  another owner or another session of the same owner gets 404 and cannot attach. The original 15-minute
  deadline is kept. *Cancel* and leaving the page end it.
- **When it ends.** When the command exits, when the owner presses *Cancel* or leaves the page, when the
  session ends, and after 15 minutes at the latest. A dropped connection alone keeps it until then. The person's serial lane is held meanwhile, so a sign-in never overlaps
  a status check, a run or a sign-out of theirs. Other people are not held up.
- **What Flux keeps.** Only what `claude auth status` reports afterwards, reduced to display
  facts: the method, the plan if reported, a masked account (`a***@example.org`), the time, and a keyed
  fingerprint of the account so a later sign-in to a different account shows the owner a notice. The
  login stays in the CLI's own file in their directory. No service logs or stores the terminal's output
  or what the owner types (`runtime-manager` logs the outcome and the duration only).
- **Sign out** runs `claude auth logout` and then deletes the CLI's files; if the logout fails (for
  example, Anthropic is unreachable) the files are still deleted and the owner is told to end the
  session in their Claude or Console account. **Remove runtime** signs out first and deletes the binding
  directory.

The runtime's image contains node-pty 1.1.0 (pinned; compiled from source in the build stage) for
the terminal. Nothing else is added to it.
## Runs

Once an owner is signed in, their Claude plan (or ChatGPT plan) is one of their connections in Settings → AI →
Connect AI, and any of their agents can use one of its models ([Connect AI](../product/model-providers.md), #854, #857). No API
key is used or needed. Each run of an agent (an answer to `/ai`, a step on a task, a schedule's firing, a message in its private
chat) then runs their own Claude Code (or Codex) under their own user id, with the agent's own instructions and memory:

- **Token.** The worker asks the API, which is Flux's authorization server, for a run token: a signed MCP
  access token for the owner's agent connection, with no scope (the run's exact tools are stored with the token and listed by the
  route), `flux_run_id` and `flux_place` (the run's space and conversation, its direct message, or none for a private chat),
  audience `/mcp` and a lifetime of the run's wall clock plus five minutes. The worker
  proves it holds the run with a one-time nonce whose hash it stored on the run row. Only the token's id,
  expiry and exact tools are kept; the token itself never reaches the database, a queue, a file or a log.
- **What runs.** The runtime runs the fixed `claude -p --output-format stream-json …` command of
  [F-022 "Run"](https://github.com/ColdPhase/flux/blob/a82ee012d0dc0a33e9ab14925f8f400c96f31e60/docs/product/ai-modes.md#run) with the prompt on stdin. The token is only in the CLI's own
  environment variable `FLUX_RUN_TOKEN`; the MCP configuration (on the runtime's tmpfs `/tmp`) names it in
  the Flux server's `Authorization` header. The CLI reaches Flux only through `runtime-egress`'s `/mcp`
  forwarder.
- **What it can do.** The agent has exactly its owner's rights ([agents](../product/assistant.md)). The route lists exactly the run's
  tools: every read tool and, unless the agent's **What it may do** is *Only read*, its change tools (deleting and other people's
  things wait for the owner's OK, and only the owner can approve). It refuses every other tool, reads only what the run's place
  allows (a conversation's audience, a task's people; the owner's whole view only in the agent's private chat), works only in spaces
  where AI is on, refuses the token once the run ends, the owner stops it, revokes the connection, loses access or AI is turned off
  in the space, and returns at most 256 KiB per tool result and 8 MiB per run (safety bounds, below). The runtime itself reaches no
  web page: a server agent's page reading and search go through Flux's own tool and the provider's search
  (`FLUX_WEB_READS`), and the CLI's own web tools are kept only while that switch is on.
- **Read-back.** The supervisor checks the CLI's first `system/init`: any tool other than the run's exact Flux
  tools (and `EndConversation`), or any MCP server other than a connected Flux, stops the CLI with no
  answer. The worker checks it again.
- **Ends.** Each end has its own state on the run: an expired login (*Sign in to Claude again*), a plan
  limit (with the reset time the CLI reported), a crash, a refused request, a busy lane, one of the safety
  bounds below, and a broken stream (`unknown`, never rerun). None falls back to another connection. Stop
  sends SIGINT, then SIGTERM after 5 s, then kills; the run records the request and the supervisor's
  acknowledgement separately. Token-shaped strings and the run token are removed from the committed answer.
- **A plan's limit pauses the request** (#854). When the CLI reports its plan's limit with a reset time, the
  request waits, queued, as "Claude limit reached, resumes at 14:00" and starts again by itself when the plan
  resets. Without a reset time it says "Claude limit reached" and tries again every two hours. Either way at most
  three times in a row, and never for a request that already changed something: it ends with the line and how many
  changes were made. Nothing moves to another connection, and there is no button to switch. For Codex, the supervisor also
  reads the plan's remaining usage from the app-server after each run, for Connect AI's line ("48% of your weekly limit
  left · resets Mon"); for Claude Code, Connect AI says "Plan limits apply" until a limit is reached.
- **A plan's models are read from its CLI** ([#1332](https://github.com/ColdPhase/flux/issues/1332), [CA-2](../product/model-providers.md#ca-2--models)).
  The worker's reconciliation tick asks the signed-in person's slot for the models their CLI offers, when they sign in and then about every six
  hours (a failed read again after five minutes), at most one plan per tick (every ten seconds) so a runtime with many people never starts
  many CLIs at once. Reading starts the CLI for a few seconds as that person (Claude Code: its headless initialization, no model call; Codex:
  `app-server` `model/list`), inside their own lane: while a run holds it the request is answered *busy* and the last list stays, and a run that arrives during a read ends
  the read and goes next. Codex models that Flux's reviewed copy of the pinned catalog does not hold are not offered until the pin moves. A Codex run
  also reads `model/list` once just before it starts, to cut its model catalog down to what the account offers. If a CLI cannot be reached, the
  last list stays; Flux keeps no model list of its own.
- **No Flux limits** (#843). Flux sets no runs a day, no five-minute clock, no step count and no change limit
  of its own. A run never waits behind a sign-in, a status check or another run in the person's serial lane (it
  ends *busy*). Only these technical safety bounds remain; nobody meets them in normal use:

  | Bound | Value | Where |
  | --- | --- | --- |
  | Wall clock of one run | 1 hour | `RUNTIME_RUN_LIMITS.wallClockSeconds` |
  | No event from the CLI | 10 minutes | `RUNTIME_RUN_LIMITS.idleSeconds` |
  | Steps (turns) of one run | 200 | `RUNTIME_RUN_LIMITS.maxTurns` (the same for an API-key run) |
  | Answer size | 64 KiB | `RUNTIME_RUN_LIMITS.maxAnswerBytes` |
  | Tool results | 256 KiB per call, 8 MiB per run | `RUN_TOKEN_LIMITS` |
  | Requests waiting at once per person | 20 (paused ones not counted) | `MAX_WAITING_REQUESTS` |
  | Schedules per person | 200 | `ASSISTANT_JOB_LIMITS` |

  An API key keeps one daily budget set by its owner ([CA-3](../product/model-providers.md#ca-3--the-providers-limits-not-fluxs)); a
  request that finds it used waits for the key's next day.
- **Transcripts.** `--no-session-persistence`, and after every run the supervisor deletes the CLI's session
  directories (`projects`, `todos`, `shell-snapshots`, `session-env`, `transcripts`) from the binding
  directory and the run's MCP configuration from `/tmp`.

The worker reaches the API at `FLUX_API_INTERNAL_URL` (default `http://api:8080`) for the token and, for
API-key runs, for `/mcp`.

## Known limits (accepted)

None of them is hidden by the checks.

- **A place can be made without a sign-in.** The web client no longer binds when the owner
  opens Settings: a binding starts only when a sign-in console is opened, at ticket time, and the console's
  attach then binds again under the owner's session. The API route `POST /api/v1/agent-runtime/binding` still
  binds with no sign-in, so any signed-in account on the instance can call it. It costs a directory, no process. Your
  controls: close or restrict sign-up, watch `./flux runtime status`, release a person with `./flux runtime release`, and set
  `FLUX_AGENT_RUNTIME_IDLE_DAYS` (a binding that never ran counts from its creation).
- **`runtime-egress` is not vendor-exclusive (m6).** Cleanup must still reach a vendor after you switch its
  client off (TLS hides the request path), so the proxy allows the recorded hosts of every client at all
  times; the supervisor, not the proxy, refuses login, status and runs for a client that is off. So a
  Codex-only deployment also allows Claude Code's hosts, and the reverse (Codex: `auth.openai.com`,
  `chatgpt.com`, `api.openai.com`). Do not describe the runtime as isolating one vendor's hosts from
  another's.
- **The proxy does not check the TLS server name against the `CONNECT` host (m6).** It relays bytes without
  terminating TLS, so it cannot see the name a CLI asks for. An allowed host's address is not shown to
  serve only that host: a vendor address may sit on shared infrastructure that also serves other names. A
  CLI may therefore reach another name served at an allowed address. This residual risk is accepted and
  not measured. It is not harmless, and it is not the vendor-exclusive isolation the checks suggest. Closing
  it would need TLS inspection or addresses verified against each vendor; neither is in place.
- **Connection limits are per source address (m6).** The proxy and the `/mcp` forwarder hold at most 256
  connections in all and 32 from one address. All the agents share the runtime's address (#860), so the 32 are shared
  too: enough for the agents that fit in memory on a small server. A large server with many agents at once may need more.
- **People share one network namespace (#860).** Separate user ids keep them from each other's files, memory and
  signals, not from each other's loopback ports. A CLI has no tool that could reach one; a CLI that ran arbitrary code could
  try a port another person's CLI listens on during a sign-in.
- **Reconciliation decides from sightings that can be a moment old (m8, low, accepted).** A binding missing from the
  sightings is looked for once more before the owner is told to sign in again. What is not serialized is the gap between
  those two reads.
- **Docker Desktop is unsupported** (see *What the runtime gets*).

## Installing from a release

A GitHub Release carries the runtime as two more assets next to
`compose.yaml`: `compose.runtime.yaml` and `runtime.sh` (sources: `docker/compose.runtime.yaml`,
`docker/runtime.sh`). Its release installation guide (`INSTALL.md`, source
[`release-guide.md`](release-guide.md)) has the commands. What differs from the source checkout:

- **Two images, both pinned by digest, no build.** `runtime-manager` and `runtime-egress` run the
  application image of the release; `runtime-install` and `runtime-1` run
  `ghcr.io/coldphase/flux-agent-runtime`, built for the release's platforms (`linux/amd64` for v0.2) from the accepted
  candidate by `final-release.yml` (target `agent-runtime-release` of `docker/Dockerfile`). It holds the
  supervisor with its process hardening, node-pty and the pinned official Codex (checked by SHA-256)
  on the application image's Node (without npm, corepack or yarn, #1179),
  and gpg so that the same digest also runs `runtime-install`. **The one difference from the source
  runtime image** is that gpg: the source Compose keeps building the separate `agent-runtime` image
  without it. Claude Code is never in an image; the workflow fails when `claude` or anything in
  `/opt/flux-tools` is found in it.
- **Same settings.** The overlay is the source Compose's runtime block with only the images changed;
  `scripts/release/compare_runtime_overlay.py` compares every runtime service, network and volume of
  the two (`docker compose config`) and fails on a difference. The runtime stays off
  (`FLUX_AGENT_RUNTIME` empty) and no service mounts a Docker socket or builds from source.
- **`runtime.sh` replaces the launcher** for the operator steps: `on`, `off`, `up`, `status`,
  `release <email>` and `purge [-y]` run the same operations as `./flux ai on`, `./flux runtime ...`
  and the purge fence, through `docker compose`.
- **Linux Yama ptrace_scope of 1 or higher** is required on the host kernel, as everywhere
  ([What the runtime gets](#what-the-runtime-gets)). The release check
  (`scripts/release/smoke_runtime.sh`) uses the real image and no vendor account, so it covers
  switch-on, isolation, off and purge; a person's sign-out and reuse need a vendor login and are
  checked with fake CLIs against the source stack (`scripts/check_agent_runtime.sh`).

## Backups, snapshots and restore

- **`./flux backup` never contains the runtime's volume.** It covers the database, the files volume and
  `docker/.env` only ([backup guide](backup-restore.md#agent-runtime-logins)). That volume holds the
  owners' vendor logins, which must not travel in backups and cannot be moved between machines anyway
  (rotating refresh tokens would invalidate each other).
- **A disk-level or host snapshot does capture that volume**, and with it every owner's login. Treat
  such snapshots as you treat the logins.
- **After a restore**, the worker reconciles the restored bindings with the runtime at its start: a
  binding whose directory is missing shows *Sign in again*, and a directory without a binding is signed
  out (best effort) and deleted.

## Switching off, purging, reset and clean

- **Switch off:** empty `FLUX_AGENT_RUNTIME` and run `./flux up`. The runtime services stop; their
  volumes and logins stay, so switching back on restores them. Runs refuse with *Off on this
  instance*.
- **Remove the logins for good:** `./flux runtime purge` signs every CLI out (best effort), deletes the
  runtime's volume and the tools volume, and marks every binding released. Then keep `FLUX_AGENT_RUNTIME`
  empty.
- **`./flux reset` and `./flux clean`** include the runtime: they sign everyone out first (best
  effort), then delete its volumes with the project's other volumes. `clean` is the uninstall.
- If a sign-out fails (for example the vendor is unreachable), the files are deleted anyway. Whether a
  CLI's logout revokes the session at the vendor is **unverified**; owners should end such sessions in
  their Claude or ChatGPT account settings.
- Cleanup can reach the recorded vendor hosts even with `FLUX_AGENT_RUNTIME` empty, so off → purge,
  reset and clean can attempt vendor sign-out. This does not enable login or runs: the supervisor
  continues to reject them while the switch is off. An HTTPS CONNECT proxy cannot distinguish the
  vendor's logout path from its other paths; the host list stays restricted to those already recorded.
- Skipped, missing, failed or timed-out CLI logout is **not confirmed**, even if local files were
  deleted. The API reports `signOutFailed`, and operator output says `sign-out NOT confirmed`.
  Purge records this in owner history too. If a failed attempt deleted a binding and a later retry
  sees no credentials, that retry does not erase the unconfirmed result. Already released history
  keeps its original outcome.

## Versions

Each Flux release pins the CLI versions its flag contract check passed: Claude Code 2.1.285 (in
`app/apps/runtime/src/install/pins.ts`) and Codex rust-v0.160.1 (in `docker/Dockerfile`, by checksum).
`./flux upgrade` reinstalls Claude Code at the new pin on its next start; nothing updates itself
(`DISABLE_UPDATES=1`).

The separate published runtime image and release-matched operator assets are built by the final release
workflow ([Installing from a release](#installing-from-a-release)) and published with each release; a source-built
runtime is not a published runtime release.

`./scripts/check_runtime_cli_contract.sh` is the opt-in flag contract check against these real CLIs
(no account needed; internet access to github.com and downloads.claude.ai). Run it again whenever a pin
changes. It proves the flags exist, not how the CLIs behave in a run; the automated checks use fake CLIs.

## Checks

| Check | What it proves |
| --- | --- |
| `./scripts/check_agent_runtime.sh` | The whole runtime through `./flux` with fake CLIs: off by default; on; `docker inspect` limits; many owners in one runtime, no cross-owner reach; escape attempts from inside the runtime; the supervisor's closed request set; release and reuse; bind refused with any entry in `/data`; operator release; the sign-in console (each method's exact command in a terminal, the URL, a pasted code, signed in only from `auth status`, sign-out and a failed logout, another member refused, the terminal gone after exit and after the page left, a seeded-secret scan of the database, frames, API answers and logs, and the pages at phone width in a browser); backup without slot volumes; restore reconciliation; switching off; purge; reset. Set `FLUX_RUNTIME_SCREENSHOT_DIR` to keep the browser's screenshots. |
| `./scripts/check_application.sh` | With the runtime off: the API reports it disabled; no request input selects a runtime or a binding; the runtime tables hold display facts only; core, supervisor, manager and egress tests, including the fuzz tests of the supervisor-stream reader and `runtime-egress`; the sign-in console in process with real terminals (the 15-minute end with injected timers, disconnect, the closed request set, the session-bound ticket). |
| `python3 -m unittest tests.test_container_isolation tests.test_runtime_inspect` | No Compose file mounts a Docker or Podman socket, and none binds a host path outside the checkout (so no `/var/run` or `/run` directory mount); `inspect.py` refuses the same on a running project. |
| `python3 -m unittest tests.test_flux_subscription_question` | The launcher's question with a pseudo-terminal and a stub `docker` as the fake host check: Enter, Enter writes `codex` and no statement; Enter, `y` writes `codex,claude_code` and today's date; `n` writes nothing; no terminal asks and writes nothing; each failing host check shows no question and one reason line; an existing `docker/.env` and a second `./flux up` are never asked; `./flux ai on` asks the same, only adds and refuses without a terminal. It creates no Docker resource. |
| `./scripts/check_application.sh` (`agent-runtime-runs.test.ts`) | A run end to end with the TEST ONLY fake `claude`: the real worker processor and engine, an in-process `runtime-manager` and supervisor, and real MCP calls to the API with a minted run token. Progress, the commit recheck, the exact argv, the token only in `FLUX_RUN_TOKEN` and the `Authorization` header, no transcript, the read-back (an extra tool or server), every end state, results past the bound, Stop (SIGINT and SIGTERM), a busy slot, redaction, revocation mid-run, switches off before and during a run, no runs a day, a plan limit that pauses and resumes the request by itself, and the DM/private/other-project canaries. |
| `./scripts/check_mcp_clients.sh` (last step, `runtime-run-claude.e2e.ts`) | Opt-in, needs the internet: the pinned real `claude` with the run template's exact argv against the scripted local model (no account): its `system/init` field names, a start-up tool list equal to the run's switch-derived list, a connected Flux server and a call answered through `/mcp` with `FLUX_RUN_TOKEN`. |
| `./scripts/check_runtime_cli_contract.sh` | Opt-in: the fixed templates' flags and the sign-in, status and sign-out assertion table (golden `--help`, status JSON keys, exit codes, streams; `--network none`, no account) against the pinned real CLIs. |
| `FLUX_LIVE_VENDOR=1 ./scripts/check_vendor_live.sh` | Optional and never required: shows the status of the logins already on the maintainer's machine. Refuses without the variable. |
| `./scripts/check_runtime_install.sh` | Opt-in, needs the internet (about 250 MB): the real `runtime-install` through `runtime-egress` to `downloads.claude.ai` with the signature and SHA-256 checks, the installed binary reporting the pinned version, and the installer proxy refusing every other host. A public download; no account or sign-in. |

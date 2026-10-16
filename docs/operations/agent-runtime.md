# Agent runtime: the owner's own Claude Code or Codex in Flux

This guide is for the person who runs a Flux instance with [`./flux`](../../flux). It covers the
`runtime` transport of [F-022 AIM-3](../product/ai-modes.md#aim-3--the-runtime-transport), delivered
in slices: T3 ([#278](https://github.com/ColdPhase/flux/issues/278)) adds the runtime itself (slots,
supervisor, isolation, operator steps); T4 ([#279](https://github.com/ColdPhase/flux/issues/279)) adds
the Claude Code [sign-in console](#the-sign-in-console). Runs (T5) follow; until then an owner can sign
in, check and sign out, but not run.

**It is off by default.** With `FLUX_AGENT_RUNTIME` empty, no runtime service runs, the API reports the
feature as not enabled, and nothing below applies. The published release `compose.yaml` does not
contain it and never asks; the runtime is available from a source checkout with `./flux`, which asks
once ([Switch it on](#switch-it-on)).

## Before you switch it on

- **Your duty for Claude Code.** Anthropic: "preinstalling or running Claude Code in your products or
  services (e.g. in hosted sandboxes or other agent infrastructure) requires agreeing to our Commercial
  Terms of Service". On a self-hosted Flux you are that party. Agree to Anthropic's Commercial Terms with
  Anthropic itself (for example through an Anthropic Console organization), then set the date you agreed
  in `FLUX_AGENT_RUNTIME_COMMERCIAL_TERMS`. Flux records this statement and its date; it does not check
  it. A paid hosting service keeps the runtime off.
- **You can read every owner's login.** The CLIs keep each owner's login as a file in that owner's slot
  volume. Host root can read every slot volume, and so can anyone who can read your disks or disk
  snapshots. Owners are told so before they sign in. Offer the runtime only where owners trust you.
- **Vendors may restrict this use.** Both vendors recommend API keys for products and automation and
  may act "without prior notice", possibly on an owner's account
  ([accepted risks](../product/ai-modes.md#accepted-risks)). `server` connections with an API key are
  the recommended path; the runtime is for owners who choose it.

## Switch it on

### With the question (`./flux up` the first time, `./flux ai on` later)

The launcher asks whether people on this Flux may sign in with their own ChatGPT and Claude
subscriptions ([F-027 AST-1](../product/assistant.md#ast-1--subscriptions-are-the-normal-way-to-connect)):

```text
Let people on this Flux sign in with their own ChatGPT and Claude
subscriptions? Flux runs the official Codex and Claude Code for each
person in their own isolated slot.  [Y/n]

Claude Code also needs the person who runs this Flux to accept
Anthropic's Commercial Terms (for example by creating a Console
organization). Have you accepted them?  [y/N]
```

- **When it asks.** `./flux up` asks while it *creates* `docker/.env` (a fresh checkout), before the
  build, and only when stdin and stdout are a terminal. An existing `docker/.env` is never asked about,
  and neither is a second `./flux up`, so a deployment that is already running stays as it is. Without a
  terminal (CI, a pipe, `./flux up > log`) nothing is asked, checked or written, and the runtime stays
  off. To skip the question in a terminal, set `FLUX_AGENT_RUNTIME` in the environment, even empty
  (`FLUX_AGENT_RUNTIME= ./flux up`). `./flux dev` never asks.
- **`./flux ai on`** asks the same questions on an existing instance, writes the answer to `docker/.env`
  and applies it like `./flux up` (builds and starts the runtime). It needs a terminal and refuses without
  one; set the variables by hand then. It only adds: if Codex is already on, it asks only the
  Commercial Terms question; if Claude Code is on too, it says so and changes nothing. It never removes a
  client. To turn the runtime off, empty `FLUX_AGENT_RUNTIME` and run `./flux up` (see
  [Switching off](#switching-off-purging-reset-and-clean)).
- **Enter means yes, for Codex.** `Enter` on the first question writes `FLUX_AGENT_RUNTIME=codex`.
  Codex is available since F-022 T6 (#281): owners sign in with ChatGPT on Settings → Agents and AI.
  `n` writes nothing and does not ask the second question.
- **Claude Code needs a typed `y`.** The second question records *your* statement that you have agreed to
  Anthropic's Commercial Terms (see [Before you switch it on](#before-you-switch-it-on)), so `Enter`, `n`
  or any other answer does not make it. `y` writes `FLUX_AGENT_RUNTIME=codex,claude_code` and
  `FLUX_AGENT_RUNTIME_COMMERCIAL_TERMS=<today>`; the API records that statement, with the date, in
  `agent_runtime_operator_statements` when it starts. Flux does not check it. An unclear answer to the
  first question is asked again, and three of them count as `n`; Ctrl-D decides nothing.
- **Hosts that fail the checks are not asked.** Before it asks, the launcher checks the Docker engine (not
  the machine you type on: the slots run in the engine's kernel, which on Docker Desktop is a VM) and
  prints one line saying why when a check fails; `./flux up` then carries on with the runtime off and
  `./flux ai on` stops with that line:

  | Check | How the launcher asks | Reason line says |
  | --- | --- | --- |
  | Linux engine | `docker info`, `OSType` | the engine is not a Linux engine |
  | Memory, CPU and process limits | `docker info`: `MemoryLimit`, `CpuCfsQuota`, `PidsLimit` | the engine cannot set the limits every slot has |
  | `internal` networks | `docker network create --internal`, removed at once | the engine cannot create an internal network |
  | Yama `ptrace_scope` of 1 or higher | one throwaway container (read-only, no network, no capabilities) of the Dockerfile's pinned `node` base image runs `cat /proc/sys/kernel/yama/ptrace_scope`, the same file the supervisor reads | the kernel has no Yama policy or it is 0 (Docker Desktop has none) |

  If the engine cannot answer (for example it cannot pull the base image), the line says the check could
  not be run. The check image is the one the build pulls anyway.
- **Paid hosting never asks.** A hosting service run by the Flux project keeps the runtime off
  ([AIM-3](../product/ai-modes.md#operator-switch-and-installation)). It deploys the release
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
| `runtime-install` | One-shot. Installs the pinned Claude Code release into the `runtime-tools` volume (slots mount it read-only), after checking Anthropic's GPG-signed release manifest against the key fingerprint Anthropic publishes and the binary's SHA-256 against that manifest. Flux never ships Claude Code in an image. It reaches only `downloads.claude.ai`, through `runtime-egress`. A verified install of the pinned version is kept on later starts. |
| `runtime-1` … `runtime-4` | The slots. Each runs a small supervisor (and, during a sign-in or a run, the CLI), with its own volume and its own internal network. |
| `runtime-manager` | Drives the supervisors for the API and worker. No database and no Docker access. |
| `runtime-egress` | The slots' only way out: HTTPS to the hosts the enabled CLIs document, and the Flux `/mcp` route. |

`./flux` generates the secrets it needs in `docker/.env` (`FLUX_RUNTIME_MANAGER_SECRET`, one
`FLUX_RUNTIME_SECRET_<n>` per slot) and never changes an existing value. Each slot receives only its own
secret; `runtime-manager` receives all of them.

**No Docker socket.** No Flux service, the runtime included, mounts a Docker or Podman socket or gets any
other container engine API (`tests/test_container_isolation.py` checks every Compose file). Rootless
Docker or Podman is therefore not a prerequisite. The engine must support `internal` networks, a
read-only root filesystem, `cap_drop`, `pids_limit`, and memory and CPU limits. T3 is tested on Docker
Engine 29; other engines are **unverified**. gVisor (`runtime: runsc` in an override) is optional and
untested.

## What each slot gets

Every slot has the same static settings (one YAML anchor in `docker/compose.source.yaml`); nothing at run
time can change them:

- non-root user `1000:1000`, read-only root filesystem, `cap_drop: ALL`, `no-new-privileges`, an init
  process, no host mounts, `restart: always`;
- the Node supervisor sets Linux `PR_SET_DUMPABLE=0` before reading its secret. A CLI with the same
  uid cannot read the supervisor's `/proc/<pid>/environ` or write `/proc/<pid>/mem`. Slots require
  Linux Yama `kernel.yama.ptrace_scope` of 1 or higher; a missing policy or value 0 stops the supervisor
  before it listens, so the worker cannot admit the slot (the refusal also names a kernel with no Yama at
  all). This is a Linux host requirement, including the Linux VM used by Docker Desktop; Flux does not
  change host kernel settings. **Docker Desktop is unsupported:** its LinuxKit kernel has no Yama, so
  every slot refuses to start (checked 2026-10-08 by an independent evaluator). Use a Linux host with
  `kernel.yama.ptrace_scope` of 1 or higher;
- the supervisor requires Node's sole startup flag to be `--disable-sigusr1`, empty `NODE_OPTIONS`,
  and no already active inspector. Additional or negated flags fail closed.
  A same-uid CLI can send signals; it must not be able to start a debugger and evaluate code in the
  supervisor. The pinned Node 24.21 supports this flag;
- 2 GiB memory (no swap), one CPU, 256 processes, a 128 MiB tmpfs `/tmp`;
- container logs rotated at 3 × 10 MB;
- only its own volume at `/data` and the read-only tools volume;
- only its own `internal` network, shared with `runtime-manager` and `runtime-egress` and nothing else, so
  a slot cannot reach another slot, the database, the worker, the API outside `/mcp`, the cloud metadata
  address or your LAN. Docker would give the host an address on every bridge, which would let a slot
  reach services the host itself listens on; the runtime's internal networks set
  `com.docker.network.bridge.inhibit_ipv4`, so the host has none there.

Docker's local volumes have no size quota, so the supervisor refuses a run while an owner's binding
directory exceeds 256 MiB. An idle slot runs only the supervisor; a CLI process exists only during a
sign-in or a run. Measured on 2026-10-06 with `docker stats` in `scripts/check_agent_runtime.sh` (Docker
Engine 29.4, fake CLIs): an idle slot uses about 20 MiB and 12 processes; `runtime-manager` about 21 MiB
and `runtime-egress` about 18 MiB.

**Sizing:** four slots by default, one per owner who uses the runtime. Budget up to 2 GiB of memory and
one CPU per slot in use, 256 MiB of disk per binding directory, plus the tools volume: Anthropic's signed
manifest lists the Linux x64 binary of 2.1.289 at 246 MB (retrieved 2026-10-05); the installed size of the
pinned 2.1.285 was not measured.

## More slots

Copy the block in [`docker/runtime-slot.example.yaml`](../../docker/runtime-slot.example.yaml) into
`docker/compose.override.yaml` (create the file; `./flux` reads it whenever it exists, and git ignores
it) and replace every `5` with the next free number. The block declares the slot with the same settings,
its volume and internal network, and attaches `runtime-manager` and `runtime-egress` to that network with
the slot's secret. On the next `./flux up`, `./flux` adds `FLUX_RUNTIME_SECRET_<n>` to `docker/.env`.
`scripts/check_agent_runtime.sh` checks that such a slot has exactly the settings of the others and is
reachable by `runtime-manager` and `runtime-egress` and nothing else.

## Bindings and releasing them

An owner's first use binds a free slot to them (one slot holds both their Claude Code and Codex
logins). When every slot is bound, Settings says so; the owner can still use `server` connections and
their own agent app over MCP. A workspace role gives no access to any slot.

A pool of four fills for good unless bindings are released:

- `./flux runtime status` lists each slot, its state and its owner's e-mail, and what each supervisor
  reports (boot id, what `/data` holds).
- `./flux runtime release runtime-<n>` releases that slot's binding: the worker signs the owner's CLIs
  out, deletes their binding directory, confirms the slot's `/data` is empty and lets the supervisor
  restart; the slot is offered again only after a new boot id with an empty `/data` is reported. The
  owner sees in Settings that the operator released it.
- **Idle policy** (off by default): `FLUX_AGENT_RUNTIME_IDLE_DAYS=<1–365>` releases a binding that had
  no run for that many days. Settings shows the owner the date beforehand.

Flux has no in-app instance administrator role yet, so these operator steps are launcher commands.

A release reports the sign-out as confirmed when every client either signed out (`ok`) or has no trace in
the binding: the CLI is absent, nothing of that client is in the binding directory and no earlier sign-out
of it failed (a Codex-only deployment has no Claude Code). The supervisor takes that as having no session
to sign out. It is an inference from the binding directory, not a vendor confirmation. A failed or
timed-out sign-out leaves an `unconfirmed-<client>` marker in the binding directory, which survives the
client's files being deleted, so later releases stay *not confirmed*. So do a missing CLI with its files
still present, a directory that cannot be read, and a skipped step.

A slot whose supervisor cannot confirm an empty `/data` (for example a stray file) leaves the pool and
`./flux runtime status` shows it `out_of_pool`. Remove the entry (`docker compose … exec runtime-<n> rm
/data/<entry>`), then restart that slot (`docker restart <container>`); it returns once its new
supervisor reports an empty `/data`.

## The sign-in console

An owner signs in from Settings → *Agent in Flux* → *Sign in to Claude Code*, as in a terminal (F-022
"Sign-in as in a terminal"). Settings first tells them that you, the operator, can technically read
their runtime's storage, what Anthropic says about this kind of use, and who pays for each method.

- **Methods.** Every method of `claude auth login`: *Claude account* (`claude auth login`, the default,
  which the CLI also spells `--claudeai`), *Anthropic Console* (`--console`) and *SSO* (`--sso`). The
  pinned CLI's `auth login --help` also lists `--email`, which only pre-fills an address on Anthropic's
  page; the opt-in contract check fails if a later CLI lists any other option.
- **What runs.** The owner's slot runs exactly that command in a pseudo-terminal: no shell, the CLI's
  clean environment plus `TERM`. The terminal is relayed to the owner's browser over a WebSocket bound
  to their session (API → `runtime-manager` → the slot's supervisor, each hop authenticated as every
  other runtime request). The CLI prints Anthropic's sign-in link; the owner signs in there and pastes
  the code back at the CLI's own prompt. Another member's session cannot attach to it.
- **When it ends.** When the command exits, when the owner's page closes or loses its connection, and
  after 15 minutes at the latest. The slot's serial lane is held meanwhile, so a sign-in never overlaps
  a status check, a run or a sign-out.
- **What Flux keeps.** Only what `claude auth status` reports afterwards, reduced in the slot to display
  facts: the method, the plan if reported, a masked account (`a***@example.org`), the time, and a keyed
  fingerprint of the account so a later sign-in to a different account shows the owner a notice. The
  login stays in the CLI's own file in the slot volume. No service logs or stores the terminal's output
  or what the owner types (`runtime-manager` logs the slot, the outcome and the duration only).
- **Sign out** runs `claude auth logout` and then deletes the CLI's files; if the logout fails (for
  example, Anthropic is unreachable) the files are still deleted and the owner is told to end the
  session in their Claude or Console account. **Remove runtime** signs out first, deletes the binding
  directory and frees the slot.

The image of each slot contains node-pty 1.1.0 (pinned; compiled from source in the build stage) for
the terminal. Nothing else is added to the slot image.
## Runs (F-022 T5, #280)

Once an owner is signed in, they can turn their assistant on with *Claude Code* in Settings → Your
assistant (consent `f-022-runtime-2026-10-16`; no API key is used or needed). Each *Ask my assistant* then
runs their own Claude Code in their own slot:

- **Token.** The worker asks the API, which is Flux's authorization server, for a run token: a signed MCP
  access token for the owner's assistant connection, with `flux_run_id` and `flux_place` (the run's project
  and conversation), audience `/mcp`, scope `flux.context.read` and a lifetime of five minutes. The worker
  proves it holds the run with a one-time nonce whose hash it stored on the run row. Only the token's id,
  expiry and exact tools are kept; the token itself never reaches the database, a queue, a file or a log.
- **What runs.** The slot runs the fixed `claude -p --output-format stream-json …` command of
  [F-022 "Run"](../product/ai-modes.md#run) with the prompt on stdin. The token is only in the CLI's own
  environment variable `FLUX_RUN_TOKEN`; the MCP configuration (on the slot's tmpfs `/tmp`) names it in
  the Flux server's `Authorization` header. The CLI reaches Flux only through `runtime-egress`'s `/mcp`
  forwarder.
- **What it can read.** The route lists exactly the run's tools: the read tools of the areas the owner
  switched on (F-027 AST-4; read only in this first step), refuses every other tool with the S6 refusal,
  reaches only the run's project, refuses the token once the run ends, the owner stops it, revokes the
  assistant's connection or turns an area off, and returns at most 16 KiB per tool result and 64 KiB per
  run.
- **Read-back.** The slot checks the CLI's first `system/init`: any tool other than the run's exact Flux
  tools (and `EndConversation`), or any MCP server other than a connected Flux, stops the CLI with no
  answer. The worker checks it again.
- **Ends.** Each end has its own state on the run: an expired login (*Sign in to Claude again*), a plan
  limit (with the reset time the CLI reported), the no-event timeout (60 s) and the wall clock (5 min), a
  crash, an answer over 16 KiB, tool results over their bound, a busy slot, the turn cap, a refused
  request and a broken stream (`unknown`, never rerun). None falls back to an API key. Stop sends SIGINT,
  then SIGTERM after 5 s, then kills; the run records the request and the slot's acknowledgement
  separately. Token-shaped strings and the run token are removed from the committed answer.
- **Limits.** 20 requests a day per owner, one at a time; a run never waits behind a sign-in, a status
  check or another run in the slot's serial lane (it ends *busy*).
- **Transcripts.** `--no-session-persistence`, and after every run the slot deletes the CLI's session
  directories (`projects`, `todos`, `shell-snapshots`, `session-env`, `transcripts`) from the binding
  directory and the run's MCP configuration from `/tmp`.

The worker reaches the API at `FLUX_API_INTERNAL_URL` (default `http://api:8080`) for the token and, for
API-key runs, for `/mcp`.

## Known limits (accepted)

Recorded from the T3 review (#331); none of them is hidden by the checks.

- **A slot can be bound without a sign-in (m5, accepted under #331).** The web client no longer binds when the owner
  opens Settings: a binding starts only when a sign-in console is opened, at ticket time, and the console's
  attach then binds again under the owner's session. The API route `POST /api/v1/agent-runtime/binding` still
  binds a slot with no sign-in, so any signed-in account on the instance can call it. Your controls: close or
  restrict sign-up, watch `./flux runtime status`, release a slot with `./flux runtime release`, and set
  `FLUX_AGENT_RUNTIME_IDLE_DAYS` (a binding that never ran counts from its creation). Accepted (#331 m5).
- **`runtime-egress` is not vendor-exclusive (m6).** Cleanup must still reach a vendor after you switch its
  client off (TLS hides the request path), so the proxy allows the recorded hosts of every client at all
  times; the supervisor, not the proxy, refuses login, status and runs for a client that is off. So a
  Codex-only deployment also allows Claude Code's hosts, and the reverse (Codex: `auth.openai.com`,
  `chatgpt.com`, `api.openai.com`). Do not describe the runtime as isolating one vendor's hosts from
  another's.
- **The proxy does not check the TLS server name against the `CONNECT` host (m6).** It relays bytes without
  terminating TLS, so it cannot see the name a slot asks for. An allowed host's address is not shown to
  serve only that host: a vendor address may sit on shared infrastructure that also serves other names. A
  slot may therefore reach another name served at an allowed address. This residual risk is accepted and
  not measured. It is not harmless, and it is not the vendor-exclusive isolation the checks suggest. Closing
  it would need TLS inspection or addresses verified against each vendor; neither is in place.
- **Connection limits are per source address, not per slot identity (m6).** The proxy and the `/mcp`
  forwarder hold at most 256 connections in all and 32 from one address. Each slot has its own network,
  so its address identifies it; one busy slot cannot take every connection.
- **Docker Desktop is unsupported** (see *What each slot gets*).

## Backups, snapshots and restore

- **`./flux backup` never contains a slot volume.** It covers the database, the files volume and
  `docker/.env` only ([backup guide](backup-restore.md#agent-runtime-slots)). Slot volumes hold the
  owners' vendor logins, which must not travel in backups and cannot be moved between machines anyway
  (rotating refresh tokens would invalidate each other).
- **A disk-level or host snapshot does capture slot volumes**, and with them every owner's login. Treat
  such snapshots as you treat the logins.
- **After a restore**, the worker reconciles the restored bindings with the slots at its start: a
  binding whose directory is missing shows *Sign in again*, and a directory without a binding is signed
  out (best effort) and deleted, then that slot restarts as after a release.

## Switching off, purging, reset and clean

- **Switch off:** empty `FLUX_AGENT_RUNTIME` and run `./flux up`. The runtime services stop; slot
  volumes and logins stay, so switching back on restores them. Runs refuse with *Off on this
  instance*.
- **Remove the logins for good:** `./flux runtime purge` signs every CLI out (best effort), deletes the
  slot volumes and the tools volume, and marks every binding released. Then keep `FLUX_AGENT_RUNTIME`
  empty.
- **`./flux reset` and `./flux clean`** include the runtime: they sign out every slot first (best
  effort), then delete the slot volumes with the project's other volumes. `clean` is the uninstall.
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

The separate published runtime image and release-matched operator assets remain tracked by
[#358](https://github.com/ColdPhase/flux/issues/358), alongside the application packaging in
[#77](https://github.com/ColdPhase/flux/issues/77). A source-built slot is not a published runtime release.

`./scripts/check_runtime_cli_contract.sh` is the opt-in flag contract check against these real CLIs
(no account needed; internet access to github.com and downloads.claude.ai). It is not part of CI; the
automated checks use fake CLIs. **Sign-in assertion table, run on 2026-10-08:** the same compiled table (`apps/runtime/dist/contract/check-auth.js`) passed 21 of 21 rows against the checksum-verified Claude Code 2.1.285 and codex-cli 0.160.1 binaries in `docker run --network none` (obtained by hand from the pinned URLs, not through the script, which has not run end to end). **Run on 2026-10-06 at `5a9a2cf9`:** `runtime-install` verified and
installed Claude Code 2.1.285 (`linux-x64-musl`, SHA-256 `7b4414af…eaf102` from the signed manifest), and
every flag and subcommand of the templates is in the help of Claude Code 2.1.285 and codex-cli 0.160.1,
except `--max-turns`, which `claude --help` does not list but the CLI accepts (a made-up flag is refused).
**Codex part, run on 2026-10-16 (T6 #281):** `apps/runtime/src/contract/check-codex.ts` against the
checksum-verified `codex-cli 0.160.1` (`codex-x86_64-unknown-linux-musl`, SHA-256 `9226581b…a33f`) in
`docker run --network none` (by hand; not through the script): every default-on feature of `codex features
list` is in the reviewed list, every override switches its feature off except `unified_exec`, which the
pinned Codex keeps on (recorded, harmless while `shell_tool` is off), `config/read` reflects the run's `-c`
overrides (so the blocking preflight is kept), and the app-server client refuses `command/exec`. No real
ChatGPT or OpenAI account was used; runs, sign-in and plan limits are verified with the fake `codex` only.
Run it again whenever a pin changes. It proves the flags exist, not how the CLIs behave in a run (T5, T6).

## Checks

| Check | What it proves |
| --- | --- |
| `./scripts/check_agent_runtime.sh` | The whole runtime through `./flux` with fake CLIs: off by default; on; `docker inspect` limits; two owners, no cross-owner reach, a full pool; escape attempts from inside a slot; the supervisors' closed request set; release and reuse; bind refused with any entry in `/data`; operator release; the sign-in console (each method's exact command in a terminal, the URL, a pasted code, signed in only from `auth status`, sign-out and a failed logout, another member refused, the terminal gone after exit and after the page left, a seeded-secret scan of the database, frames, API answers and logs, and the pages at phone width in a browser); backup without slot volumes; restore reconciliation; switching off; purge; reset. Set `FLUX_RUNTIME_SCREENSHOT_DIR` to keep the browser's screenshots. |
| `./scripts/check_application.sh` | With the runtime off: the API reports it disabled; no request input selects a slot; the runtime tables hold display facts only; core, supervisor, manager and egress tests, including the fuzz tests of the supervisor-stream reader and `runtime-egress`; the sign-in console in process with real terminals (the 15-minute end with injected timers, disconnect, the closed request set, the session-bound ticket). |
| `python3 -m unittest tests.test_container_isolation tests.test_runtime_inspect` | No Compose file mounts a Docker or Podman socket, and none binds a host path outside the checkout (so no `/var/run` or `/run` directory mount); `inspect.py` refuses the same on a running project. |
| `python3 -m unittest tests.test_flux_subscription_question` | The launcher's question with a pseudo-terminal and a stub `docker` as the fake host check: Enter, Enter writes `codex` and no statement; Enter, `y` writes `codex,claude_code` and today's date; `n` writes nothing; no terminal asks and writes nothing; each failing host check shows no question and one reason line; an existing `docker/.env` and a second `./flux up` are never asked; `./flux ai on` asks the same, only adds and refuses without a terminal. It creates no Docker resource. |
| `./scripts/check_application.sh` (`agent-runtime-runs.test.ts`) | A run end to end with the TEST ONLY fake `claude`: the real worker processor and engine, an in-process `runtime-manager` and supervisor, and real MCP calls to the API with a minted run token. Progress, the commit recheck, the exact argv, the token only in `FLUX_RUN_TOKEN` and the `Authorization` header, no transcript, the read-back (an extra tool or server), every end state, results past the bound, Stop (SIGINT and SIGTERM), a busy slot, redaction, revocation mid-run, switches off before and during a run, runs per day and the DM/private/other-project canaries. |
| `./scripts/check_mcp_clients.sh` (last step, `runtime-run-claude.e2e.ts`) | Opt-in, needs the internet: the pinned real `claude` with the run template's exact argv against the scripted local model (no account): its `system/init` field names, a start-up tool list equal to the run's switch-derived list, a connected Flux server and a call answered through `/mcp` with `FLUX_RUN_TOKEN`. |
| `./scripts/check_runtime_cli_contract.sh` | Opt-in: the fixed templates' flags and the sign-in, status and sign-out assertion table (golden `--help`, status JSON keys, exit codes, streams; `--network none`, no account) against the pinned real CLIs. |
| `FLUX_LIVE_VENDOR=1 ./scripts/check_vendor_live.sh` | Optional and never required: shows the status of the logins already on the maintainer's machine. Refuses without the variable. |
| `./scripts/check_runtime_install.sh` | Opt-in, needs the internet (about 250 MB): the real `runtime-install` through `runtime-egress` to `downloads.claude.ai` with the signature and SHA-256 checks, the installed binary reporting the pinned version, and the installer proxy refusing every other host. A public download; no account or sign-in. |

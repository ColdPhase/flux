# Agent runtime: the owner's own Claude Code or Codex in Flux

This guide is for the person who runs a Flux instance with [`./flux`](../../flux). It covers the
`runtime` transport of [F-022 AIM-3](../product/ai-modes.md#aim-3--the-runtime-transport), delivered
in slices: T3 ([#278](https://github.com/ColdPhase/flux/issues/278)) adds the runtime itself (slots,
supervisor, isolation, operator steps); T4 ([#279](https://github.com/ColdPhase/flux/issues/279)) adds
the Claude Code [sign-in console](#the-sign-in-console). Runs (T5) follow; until then an owner can sign
in, check and sign out, but not run.

**It is off by default.** With `FLUX_AGENT_RUNTIME` empty, no runtime service runs, the API reports the
feature as not enabled, and nothing below applies. The published release `compose.yaml` does not
contain it; the runtime is available from a source checkout with `./flux`.

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

In `docker/.env`:

```sh
FLUX_AGENT_RUNTIME=claude_code
FLUX_AGENT_RUNTIME_COMMERCIAL_TERMS=2026-10-05   # the date you agreed with Anthropic
```

Then `./flux up`. The values are `claude_code`, `codex`, or `claude_code,codex`. **Codex is accepted but
stays unavailable in this version**: its network hosts and checks arrive with F-022 T6, so Settings shows
it as pending.

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
  before it listens, so the worker cannot admit the slot. This is a Linux host requirement, including
  the Linux VM used by Docker Desktop; Flux does not change host kernel settings;
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
Run it again whenever a pin changes. It proves the flags exist, not how the CLIs behave in a run (T5, T6).

## Checks

| Check | What it proves |
| --- | --- |
| `./scripts/check_agent_runtime.sh` | The whole runtime through `./flux` with fake CLIs: off by default; on; `docker inspect` limits; two owners, no cross-owner reach, a full pool; escape attempts from inside a slot; the supervisors' closed request set; release and reuse; bind refused with any entry in `/data`; operator release; the sign-in console (each method's exact command in a terminal, the URL, a pasted code, signed in only from `auth status`, sign-out and a failed logout, another member refused, the terminal gone after exit and after the page left, a seeded-secret scan of the database, frames, API answers and logs, and the pages at phone width in a browser); backup without slot volumes; restore reconciliation; switching off; purge; reset. Set `FLUX_RUNTIME_SCREENSHOT_DIR` to keep the browser's screenshots. |
| `./scripts/check_application.sh` | With the runtime off: the API reports it disabled; no request input selects a slot; the runtime tables hold display facts only; core, supervisor, manager and egress tests, including the fuzz tests of the supervisor-stream reader and `runtime-egress`; the sign-in console in process with real terminals (the 15-minute end with injected timers, disconnect, the closed request set, the session-bound ticket). |
| `python3 -m unittest tests.test_container_isolation` | No Compose file mounts a Docker or Podman socket. |
| `./scripts/check_runtime_cli_contract.sh` | Opt-in: the fixed templates' flags and the sign-in, status and sign-out assertion table (golden `--help`, status JSON keys, exit codes, streams; `--network none`, no account) against the pinned real CLIs. |
| `FLUX_LIVE_VENDOR=1 ./scripts/check_vendor_live.sh` | Optional and never required: shows the status of the logins already on the maintainer's machine. Refuses without the variable. |

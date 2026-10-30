# Release cluster evidence (#77, #358, #480, #744), 2026-10-30

These observations were made by claude-hubert on one workstation, and only the commands named here were run. Raw logs are kept
out of the repository (evidence size policy); the lines quoted here are copied from them. Nothing was published:
there was no GHCR push, no attestation through Sigstore, no tag and no GitHub Release.

## Hosts

| Host | Facts |
| --- | --- |
| Workstation | Fedora Linux 42, `6.19.14-108.fc42.x86_64`, Docker 29.4.2 linux/amd64, SELinux enforcing, `kernel.yama.ptrace_scope` **0** (no host setting changed). Other agents' stacks were running at the same time. |
| Supported guest | `scripts/agent-runtime/supported_guest.sh`. The official Ubuntu 24.04 cloud image `noble/current` (SHA-256 `04e8f2461a16a44e78a370284471f29616cdd9baf1893df25807b71f985b6c94`; `SHA256SUMS.gpg` gave `Good signature`, `VALIDSIG D2EB44626FDDC30B513D5BB71A5D6C4C7DB87C81`), run as a KVM guest under QEMU in an `alpine:3.21` container with only `/dev/kvm`. Guest: 6 vCPU, 12 GiB. Ubuntu 24.04.5 LTS, kernel `6.8.0-147-generic`, LSMs `lockdown,capability,landlock,yama,apparmor`, **`kernel.yama.ptrace_scope = 1`** (before and after). Ubuntu's Docker 29.1.3 (API 1.52), Compose 2.40.3, buildx 0.30.1. |

## #744: networks per project

`scripts/check_address_pools.sh` starts a throwaway `docker:29.4.1-dind` daemon (privileged, with its own pools; nothing
is shared with the host daemon). In it, the script creates Flux projects with `up --no-start api worker` until Docker
refuses a network. Containers are created but never started.

| Compose files | Pools | Projects that fit | Stopped by |
| --- | --- | --- | --- |
| `origin/main` `compose.source.yaml` (before) | stock | **7** | `Network p7_runtime-api … all predefined address pools have been fully subnetted` |
| this change, runtime off | stock | **14** | `Network p14_keyring … fully subnetted` |
| this change, `compose.source.runtime.yaml` + `--profile runtime` | stock | 2 | `Network p2_runtime-api … fully subnetted` (10 networks per project) |
| this change, runtime off | `172.17.0.0/12=24`, `192.168.0.0/16=24` (the documented daemon pools) | **300** (the script's limit), 603 bridge networks | not stopped |

With the runtime off, `./flux up` ran on a `git archive` copy of `8bb0888dc` (project flux-hub-744, port 34100). Before
the start, a stale `<project>_runtime-control` network was created to stand in for one left by an older start. Result:
health `{"status":"ok","schemaVersion":130}`, and the project had 2 networks (`default`, `keyring`) with `api` and `worker` on
those two only. The stale runtime network was removed. The run was cleaned up with `./flux clean`. With the runtime on, the
overlay was exercised by `check_agent_runtime.sh` in the guest (below): the API and worker reached `runtime-manager`
through `compose.source.runtime.yaml`.

## Release dry run on the workstation (amd64, Yama 0)

`FLUX_DRYRUN_PORT=34000 FLUX_DRYRUN_PROJECT=flux-hub-rc-dry FLUX_DRYRUN_PREVIOUS=a6e9851d1 bash scripts/release/dry_run.sh`
was run at `8bb0888dc` (the head of #690 that was merged) and exited 0:

- `DRY RUN COMPLETE: 8bb0888dc…, application sha256:256ad8bb…09d6, agent-runtime sha256:a5ac9d09…f047; nothing published.`
- The assets passed `SHA256SUMS`, `check_asset_set.py` and `verify_assets.py`. The 3 negative controls were refused.
- `runtime overlay matches the source stack` for all 7 runtime services.
- The clean install, paired backup and restore passed. `running: api x86_64, db x86_64`.
- Upgrade from `v0.1.0-rc.1` (`a6e9851d1`, `sha256:7d18e41a…8634`): `schemaVersion 116 -> 130; ledger 104 -> 116 rows (+12);
  13 content tables identical; downtime from stopping the writers to healthy 9 s`. Steps 5 and 6 passed, and the smoke took 312 s.
- Runtime: the partial path ran, by design, because Yama is 0. Manager, egress and install started. The slot refused with the
  ptrace message, and `inspect.py` reported `failures: []`.

Earlier runs at the same code that did not reach the end, recorded rather than hidden:
- Run 1 was edited mid-run (a syntax error), so it is not a product result.
- Run 2 failed at the SBOM step because SELinux denied syft's mount of the run's private temp directory. The mount now uses `:z`.

## #480 / #358: the runtime on a supported host

The command was `scripts/agent-runtime/supported_guest.sh <state>`, which runs `scripts/check_agent_runtime.sh` unchanged in
the guest at `0a2d64383`. It ended with **`Agent runtime check passed.`**, guest exit 0, and `ptrace_scope` was still 1 afterwards.
All steps 1 to 15 ran, including 9b to 9d (console sign-in, a Claude Code run through egress's `/mcp`, Codex). Lines from the log:

- Step 4: `READY=5`, two owners on `runtime-1` and `runtime-2`, then `POOL=full`.
- Step 5, escape attempts from the CLI's uid:
  - `CLI uid cannot read supervisor environment, write its memory or open its inspector`.
  - The controls: `unprotected: environment/memory accessible, signal inspector accessible`;
    `native-only: environment/memory denied, signal inspector accessible`; `hardened: … denied`.
  - The network probes: `ENETUNREACH` ×12 and `no host address on any slot bridge`.
- Step 7: `SIGN_OUT_FAILED=false`, `NEW_BOOT=b8d6c92d-…`, then the same `runtime-1` was bound to a new owner. `SECRET_IN_DB=no`.
- Step 9d deliberately showed `SIGN_OUT_FAILED=true` (a failed sign-out is reported as failed, m2).
- The UI console suite: `Ran 17 tests … OK (skipped=3)`.
- Step 11, the restore reconciliation: `BINDING_STATE=sign_in_again`, `SLOT_STATE=held`,
  `K binding … released by the reconciliation; G must sign in again`.
- Steps 13 to 15: switching off keeps the volumes. `./flux runtime purge` gave `runtime-N: signed out (claude_code ok, codex ok);
  cleanup attempted; /data empty`, and `reset` signed out first.

The first guest run (`cf8f7952e`) passed steps 1 to 9d. It then failed 4 tests of `app/tests/ui/test_runtime_console.py`,
which still expected the one-client heading `Claude Code in Flux · …`. Since #617 the section names both clients when
`claude_code,codex` is offered, and this check is the only place those tests run, which needs Yama ≥ 1. The tests now follow
#617; the product was not changed. The fakes stand in for the vendor CLIs throughout (no vendor login). The real
`runtime-install` → egress → `downloads.claude.ai` path was recorded on 2026-10-23 (`479-480-closeout`).

## Release dry run in the supported guest (packaged runtime smoke)

The command was `scripts/agent-runtime/supported_guest.sh <state> bash scripts/release/dry_run.sh`, followed by reruns over SSH
in the same guest after each fix. At `782cf4ed` it exited 0:

- `DRY RUN COMPLETE: 782cf4eddeec…, application sha256:7a30f76c…1590, agent-runtime sha256:89253eca…e8ad; nothing published.`
- The packaged clean install, backup and restore passed.
- `smoke_runtime.sh` ran in full for the first time, with `kernel.yama.ptrace_scope=1`:
  - The runtime is off by default, and `claude_code` is refused without the Commercial Terms date.
  - `runtime.sh on codex` brought `runtime-1` to `runtime-4` up, each reported as `boot <id> empty installed codex`.
  - `inspect.py` reported `"failures": []`.
  - `Codex codex-cli 0.160.1 is pinned; the image holds no Claude Code and an empty /opt/flux-tools`.
  - `runtime-1 reaches none of db, api, worker, runtime-2 or the internet`.
  - `off` kept the four slot volumes, and `purge` removed every runtime container and volume.
  - The script ended with `Packaged agent runtime: off by default, switch-on, isolation, off and purge passed.`

The first full runs found three defects in `smoke_runtime.sh`, which had never got past step 0 before. All three are fixed here:

1. Step 1 checked for a fixed `ghcr.io/coldphase/` name, but the dry run rewrites it to its local registry. It now checks the
   image that `release.json` names.
2. Under `pipefail`, `runtime.sh status | grep -q "(off)"` failed through the writer's SIGPIPE (`write /dev/stdout: broken pipe`).
   The same pattern hid any match in the marker check. Both now grep captured output.
3. Step 5 expected one `config --images` line per image, but Compose prints one per service. It now requires each repository
   to name exactly the digest in `release.json`.

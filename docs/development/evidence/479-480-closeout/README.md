# #479 / #480 closeout evidence, 2026-10-23

Observations by claude-hubert on one workstation, for the PR that closes out what could be done on it. Code under test:
the branch `claude-hubert/479-480-closeout` as of its code commit, tested on `origin/main` `e4b4fab7` (the code commit
is `8c55f76c` after the later rebase onto `c7b89690`, which added only a docs file; nothing was re-run for it). Only the
commands named here were run. Raw logs are not stored in the repository (evidence size policy); the lines quoted are copied from them.

## Host

| Fact | Observed |
| --- | --- |
| OS / kernel | Fedora Linux 42, `6.19.14-108.fc42.x86_64` |
| Active LSMs | `lockdown,capability,yama,selinux,bpf,landlock,ipe,ima,evm` (Yama is built in) |
| `kernel.yama.ptrace_scope` | **0**. Not changed: no host sysctl, firewall or service setting was touched. |
| Docker engine | 29.4.2 (API 1.54), linux/amd64, runc, cgroup v2, overlay2, SELinux enforcing |
| Shared use | Other agents' stacks ran at the same time (load average 5 to 16, 25 to 28 Docker networks of about 31 available) |

Because the scope is 0, this host is **not** a supported observation for the runtime isolation gate
(`docs/operations/agent-runtime.md`): the supervisor refuses to listen, by design.

## #480

### Durable installation history (new in this PR)

Migration `0118_agent_runtime_client_history.sql` adds `agent_runtime_client_history(binding_id, client, first_login_at,
login_possible, changed_at)`. A row is written when a sign-in console is claimed (before the slot is asked to start
anything) and when the CLI's own status reports a login. Only a CLI logout that returned `ok` clears it. At release the
worker, and `./flux runtime purge` through `runtime-forget`, confirm the slot's `not_installed` only while the history
shows no login for that client in that binding. See `docs/product/ai-modes.md` ("Durable client history") and the
operations guide.

Command (one stack, one run, ports 27800/27801, VAPID blanked as the check script generates its own):

```
./scripts/check_application.sh tests/app/agent-runtime-core.test.ts tests/app/agent-runtime-manager-core.test.ts
  tests/app/agent-runtime-protocol-core.test.ts tests/app/agent-runtime-supervisor-core.test.ts
  tests/app/agent-runtime-egress-core.test.ts tests/app/agent-runtime.test.ts tests/app/agent-runtime-client-history.test.ts
  tests/app/agent-runtime-client-history-migration.test.ts tests/app/runtime-auth-flow.test.ts
  tests/app/runtime-auth-operations.test.ts tests/app/runtime-removal-off.test.ts tests/app/migration-ledger.test.ts
  tests/app/github.test.ts tests/app/github-rules.test.ts tests/app/github-rules-core.test.ts
  tests/app/github-rule-revision-migration.test.ts
```

Result: build, type check and lint (0 errors; the 9 warnings are in existing `apps/web` files) passed in the image build,
then `ℹ tests 172`, `ℹ pass 172`, `ℹ fail 0`, `ℹ skipped 0`, 36 suites, 81 s. The browser, restart and
unavailable-configuration phases of the script do not run with named files.

What the new tests cover, each paired with its control:
- core (in-memory store): no login ever started, so the slot's `not_installed` is confirmed (positive control); a console
  claimed but never completed, a recorded sign-in, a failed logout and a `not_installed` logout all stay unconfirmed; a
  logout that returned `ok` clears the history and the same release is confirmed again (negative control); only the
  client with history is held back; a failed or skipped logout reported by the slot is unconfirmed whatever the history.
- PostgreSQL store: the console claim writes the row before any slot call and survives an abandoned command; a `check` or
  `logout` claim does not; the real worker release through `agentRuntimeStore` ends `release_logout_failed = true` with
  history and `false` without; deleting the binding deletes the history; `forgetAll` with six purge scenarios.
- Migration `0118` on a database migrated through 0117: conservative backfill (signed-in, failed sign-out and console-only
  rows set; a confirmed sign-out and a released binding not), reversal refused while a live binding may hold a login and
  allowed after, label CHECK drops a label of an unexpected shape and refuses `a*b` afterwards.
- Manager CLI marker lines, launcher purge plumbing (`tests/test_runtime_purge.py`, 5 tests), the bounded manager answer
  and the private env-file copy (see nits).

Negative control for the whole feature: with the reconciliation changed to ignore the history (the behaviour before this PR),
`agent-runtime-core.test.ts` plus `agent-runtime-client-history.test.ts` ran 40 tests, 36 passed and exactly the 4 that need
the history failed (console claimed but not completed; recorded sign-in with no confirmed sign-out; only the client with
history is held back; the PostgreSQL store's worker release). The positive-control cases still passed. The mutation was
reverted before the commit (no diff on `reconcile.ts`).

Not covered here: the history is not exercised against a real slot with a real vendor login (see "Supported host").

### m9: the real install path (met on this host)

`FLUX_RUNTIME_TEST_PORT=27800 ./scripts/check_runtime_install.sh`, 2026-10-23 17:13:47Z to 17:15:40Z (images cached),
exit 0, `OK: the real install path (runtime-install -> runtime-egress -> downloads.claude.ai) passed.`
- `runtime-install` downloaded, verified (GPG-signed manifest and SHA-256) and installed Claude Code through
  `runtime-egress`; the installed binary reports `2.1.285 (Claude Code)`, the version pinned in `pins.ts`; no test fake used.
- A second run kept the verified install.
- Through the installer's proxy `https://api.anthropic.com/`, `https://claude.ai/` and `https://example.com/` were
  refused (`Request was cancelled`), `http://downloads.claude.ai/` was refused, and the control
  `https://downloads.claude.ai/claude-code-releases/stable` answered **200**.
- A slot's proxy refused `downloads.claude.ai`.
No account, sign-in or credential was involved (it is a public download).

### Supported host: what this host could and could not show

- The unchanged `scripts/check_agent_runtime.sh` was run twice on this host. See "Runtime check on this host" below.
- Not obtainable here: steps 4 to 15 (two owners on two slots, the full pool, escape attempts with the CLI's uid against
  `/proc/<supervisor>/mem` and `environ`, release and reuse with a new boot id, bind refused with a stray entry, restore
  reconciliation, off then purge, reset). They need a slot supervisor that listens, which needs `ptrace_scope >= 1`.
- Last supported observation: 2026-10-07, Ubuntu 24.04 KVM guest with Yama 1 at source `238fabf9`, all 15 steps of the then
  script passed (`docs/agents/evidence/331-runtime-hardening/supported-guest-20261007/`). The script has since gained the
  sign-in console and Codex steps, and this PR changes release behaviour, so a run at the merged head on a Yama 1 host is
  still required.
- To obtain it: a Linux host or KVM guest with `sysctl kernel.yama.ptrace_scope` of 1 or higher, Docker Engine with
  Compose, this checkout, and `./scripts/check_agent_runtime.sh` unchanged; keep the output and the head SHA. QEMU
  and `/dev/kvm` are present on this workstation, but the 2026-10-07 guest and its recipe directory are gone, so a new
  signed Noble image, seed and bootstrap would be a separate piece of work.

### Runtime check on this host (`kernel.yama.ptrace_scope` 0)

Checked `cat /proc/sys/kernel/yama/ptrace_scope` before each run, and again at the end: **0**.

| Run | Time (UTC) | Outcome |
| --- | --- | --- |
| 1 | 17:16:02 to 17:17:13 | Not a product result. I had blanked `FLUX_VAPID_*` in the shell (the script generates its own), which broke the worker's push configuration, and Docker reported `all predefined address pools have been fully subnetted` (25 to 28 networks of about 31 were in use by other agents' stacks) when step 2 created `runtime-install`. Not repeated as evidence. |
| 2 | 17:48:24 to 17:55:22 | Unchanged `scripts/check_agent_runtime.sh`, waited for free address pools first. **Steps 1 to 3 passed; stopped in step 4 by design.** |

Run 2, from its log:
- Step 1, off by default: `OFF=reported`.
- Step 2, switch on: `claude_code` is refused without the Commercial Terms date naming `FLUX_AGENT_RUNTIME_COMMERCIAL_TERMS`;
  with it the stack starts, the fifth slot gets `FLUX_RUNTIME_SECRET_5`, `runtime-install` fills the tools volume with the
  TEST ONLY fake.
- Step 3, `docker inspect`: `inspect.py` checked `runtime-1` to `runtime-5`, `runtime-egress`, `runtime-manager`, `failures: []`;
  it refused each of the 6 mutated slots; `runtime-5 matches runtime-4`.
- Step 4, `live wait-ready 5`: `Error: Timed out waiting for 5 ready slots: 0`. Every supervisor exited with
  `Error: Runtime slots require Linux Yama ptrace_scope >= 1, and this kernel has none or allows 0 (Docker Desktop is unsupported); no slot was admitted`
  (`apps/runtime/dist/supervisor/main.js:22`) and restarted in a loop. That is the M1 gate working as accepted ("the worker
  refuses slots where `ptrace_scope` is 0"). It is **not** a supported acceptance observation, and it is the only thing
  stopping steps 4 to 15 here.

Cleanup removed every container, volume and network of runs 1 and 2 and of the install check (verified afterwards).

## #331 nits closed in this PR

| Nit | Change | Control |
| --- | --- | --- |
| `ensure_runtime_secrets` wrote a temporary copy of `docker/.env` under the default umask | `set_env_line` writes the copy under `umask 077` in a subshell | `tests/test_launcher_env_secrets.py`: mode `600` while written under `umask 000`; negative control with the umask line removed shows `666` |
| The manager client read the whole body before its 4 MiB check | Reads in chunks, refuses on a declared length over the limit, cancels at the limit | `agent-runtime-protocol-core.test.ts`: 256 MiB offered, reading stops at the limit and the stream is cancelled; a declared length reads no byte; a normal answer still parses |
| The `account_label` CHECK was weak | `0118` mirrors the reducer's `ACCOUNT_LABEL` shape (`x***@domain`) for `account_label` and `previous_account_label`; a label of another shape is dropped first | `agent-runtime.test.ts` refuses seven odd labels by constraint name; the migration test drops `a*b` and refuses it afterwards |
| The `0056` header names reserved numbers that are on `main` and a test file that does not exist | **Not changed.** It is a comment in an applied migration; applied migrations stay byte-identical (the 0059/0064 precedent). Recorded here as an accepted cosmetic nit. | |

## #479

No GitHub code changed. The same run as above re-ran the existing Docker integration tests at this head: `github.test.ts`
(13 tests), `github-rules.test.ts` (7), `github-rules-core.test.ts` (8) and `github-rule-revision-migration.test.ts` (1), all
included in the 172 passed. They inject typed provider fixtures; none is real-installation evidence. The primary sources the
integration relies on were re-read today and are tabled in
[`docs/development/github-integration/README.md`](../../github-integration/README.md#primary-sources-re-read-2026-10-23),
together with the remaining work (real App on public HTTPS, G-1b/G-1c/G-1d, the #153 recipient bridge with echo
suppression and once-only external review, portable import).

# Run, stop and resume the workers

The founder has [delegated decisions and delivery](../product/autonomy.md) to the
agents. They resume existing tasks, select work across product milestones, create
further milestones, review/merge one another's PRs and finish the whole application.
There is no human acceptance step.

## Upgrade the paused workers

Use one clone and one running process per identity. Preserve `.harness/local/`,
task branches, worktrees and uncommitted changes. Do not reclone over saved work.
Stop the old runner with Ctrl+C or its `stop` command before changing the control
checkout. Pull the new PR branch to try/review the upgrade; after its agent review
and merge, a clean `main` also contains it. Existing provider sessions need not
be kept open: the runner reconstructs work from the journal, files and GitHub.

Both machines need Python 3.11+, Git, GitHub CLI and the official provider CLI.
Application work uses Docker/Compose. Log in to GitHub and the provider separately.
The adapters use existing supported CLI logins and do not force API billing.

| Person | Worker | GitHub login | CLI |
| --- | --- | --- | --- |
| Hubert | `codex-hubert` | `PelikanFix16` | Codex |
| Maurycy | `claude-maurycy` | `Zamojski5` | Claude Code |

## Explicit model selection

Hubert:

```sh
python3 scripts/flux_agent.py doctor --worker codex-hubert --model gpt-6-sol --reasoning-effort high
python3 scripts/flux_agent.py run --worker codex-hubert --model gpt-6-sol --reasoning-effort high
```

Maurycy:

```sh
python3 scripts/flux_agent.py doctor --worker claude-maurycy --model opus --reasoning-effort high
python3 scripts/flux_agent.py run --worker claude-maurycy --model opus --reasoning-effort high
```

Use a full Claude model ID instead of `opus` when a fixed version is desired.
Both workers accept the same harness flags. Codex receives `--model` and the
`model_reasoning_effort` config override; Claude receives `--model` and `--effort`.
The chosen model must support the requested effort and be available to that account.
The runner does not silently substitute a different model after an error.

Selections are saved per worker. A subsequent `run` without flags reuses them.
An explicit flag changes that setting and preserves the task/files. Use
`--use-cli-defaults` to clear the saved overrides. On a first run without flags,
CLI defaults apply; the runner prints **not pinned**, not an invented model name.
`doctor` and `run --dry-run` report the selection without saving it or calling a
model. `--dry-run` reads GitHub without writing. `--once` runs one useful cycle.

## Stop and resume

```sh
python3 scripts/flux_agent.py status --worker codex-hubert
python3 scripts/flux_agent.py stop --worker codex-hubert --after-turn
python3 scripts/flux_agent.py run --worker codex-hubert
```

Use `--worker claude-maurycy` for Maurycy. `stop --after-turn` lets the current
cycle write its checkpoint before exiting. Plain `stop` or Ctrl+C terminates the
active provider process group immediately and preserves the journal, logs and
files; the current unreported action must be reconciled on restart.

Recovery inspects the interrupted turn, saved worktrees and authenticated GitHub
claims, including claims newer than the last completed result. The agent verifies
what actually succeeded and resumes the existing branch/PR before new work. A
stop does not guarantee that uncommitted files have been pushed to GitHub; they
remain on that machine. Never discard or reassign them without reconciliation.

## Continuous execution

There is no overall time/turn cap in the committed configuration. The workers
continue toward full product acceptance until stopped, unable to execute, or
provider limits intervene. Each model turn has a 30-minute limit and idle polling
is every 120 seconds without model calls. Optional run/time caps can still be set
in the manifest. Neither waiting nor a limit counts as completion.

Keep both machines/processes available. They need not start simultaneously. Do
not run a second instance or a separate `/goal` loop with the same identity.
The runner uses `codex exec` / `claude -p` and schedules their successive cycles.

## Paired execution

Both machines must upgrade to manifest version 4 before starting. The runner
requires fresh presence from the configured peer **before any model invocation**.
It waits up to 10 minutes at startup, publishing readiness without calling a
model. Start the other worker during that window; otherwise this invocation exits
with `peer-unavailable`. With `--once`, an absent peer exits immediately.
Use an ordinary interactive review session for a harness upgrade while the pair
is suspended; the startup guard does not require a paid autonomous loop to review
the fix that restores that loop.

Python maintains one editable, authenticated status comment per worker in
[the presence issue](https://github.com/ColdPhase/flux/issues/18). This issue stays
outside product milestones. Heartbeats use GitHub API requests; they consume no
model tokens or Actions runs, create no polling comments and cannot approve work.

| Condition | Result |
| --- | --- |
| Peer publishes `stopped` or `suspended` | Stop the current provider at the next presence check; start no further model turn |
| Peer machine/process/network disappears | Stop when its heartbeat expires after 180 seconds, detected at the next check |
| Presence cannot be verified through GitHub | Suspend; never keep spending tokens based on an unknown peer state |
| Provider emits no event output for 300 seconds | Terminate the stalled provider and publish suspension so the peer stops too |
| Both peers are healthy, but tasks are waiting | Poll in Python without model calls; resume only on relevant new task evidence |

Checks/heartbeats are every 60 seconds, including while a model runs and during
idle polling. Bounded API requests and process termination can add a short delay;
this is not instantaneous failure detection. A provider emitting events can still
be making poor progress, so the existing task parking and 30-minute turn deadline
also apply. `peer_watch` in the manifest holds the shared thresholds.

This policy deliberately suspends both workers when either cannot continue,
including a model quota/permission failure, explicit stop or host sleep. It keeps
the interrupted turn, logs, worktrees, uncommitted files and task ownership. It
does not mark a task or product complete and does not start a paid fallback.
Fix the underlying problem and restart both with their existing `run` commands.
Starting one machine early is safe; its startup waiting uses no model calls.

`status` includes `presence`, `peer_presence`, `last_error` and the interrupted
turn. The shared comment shows only status/run metadata; private errors and log
paths stay local. A lost network may prevent a final stopped update, in which
case heartbeat expiry stops the other worker. Presence is not a distributed
ownership lock: continue using one clone/process per GitHub identity.

## Milestones and completion

The initial roadmap contains [decisions](../product/milestones/01-product-blueprint.md)
and [implementation](../product/milestones/02-working-application.md). Agents add
milestones using the [scope marker](github-protocol.md#discoverable-milestones).
The runner polls all admitted milestones, including their linked PRs. Closing
one planning/research milestone does not stop implementation elsewhere.

Agents perform independent application verification and final delivery, then
record both final product acceptance reports. The runner checks those authors,
coverage and current candidate CI before reporting `product-accepted`.
Fixture tests prove orchestration behavior; they do not prove live two-account
model collaboration or the application's readiness.

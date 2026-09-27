# Start the two workers

The entry point is [milestone 1: Flux — product blueprint](https://github.com/ColdPhase/flux/milestone/1).
Its [checked-in brief](../product/milestones/01-product-blueprint.md) defines the
initial planning scope. No parent issue is required. The coordinator creates the
initial bounded issues; workers negotiate, implement, and review through GitHub.

## Prerequisites

After this PR is reviewed and merged, each person uses a clean clone of `main`
on Linux/macOS (or WSL), Python 3.11+, Git, GitHub CLI, and their official agent CLI.
Application work additionally requires Docker with Compose under the environment contract.
Authenticate `gh` and the agent separately. The CLI adapter uses their existing
supported login; it does not copy credentials or force a switch to API billing.
Provider access, limits, and permissions still apply.

| Person | Worker | `gh` account | Agent |
| --- | --- | --- | --- |
| Hubert | `codex-hubert` | `PelikanFix16` | Codex CLI |
| Maurycy | `claude-maurycy` | `Zamojski5` | Claude Code |

There must be one live runner per worker identity, on one machine. Separate
clones give each person independent Git state. They do not have to start
simultaneously. If the coordinator has not created the first tasks, the peer
waits without calling a model. Once issues exist either worker can proceed.

CLI surfaces checked during implementation: Codex 0.157.1 and Claude Code
2.1.281. `doctor` verifies installed commands, required flags, repository, actual
GitHub identity, and the configured milestone. It does not spend model tokens
or prove the other person's login or a two-machine run.

## Commands

Hubert, in the repository:

```sh
git switch main
git pull --ff-only
python3 scripts/flux_agent.py doctor --worker codex-hubert
python3 scripts/flux_agent.py run --worker codex-hubert --dry-run
python3 scripts/flux_agent.py run --worker codex-hubert
```

Maurycy uses the same commands with `--worker claude-maurycy`.
`--dry-run` reads GitHub and reports eligibility; it starts no model and makes
no GitHub writes. `--once` performs at most one collaboration cycle.

The committed manifest selects the milestone, phase, worker identities, and
limits. Changing the milestone description stops execution until its changed
scope and digest are reviewed in configuration. For a new milestone, copy the
[milestone brief template](templates/milestone.md), record acceptance in a PR,
and update the manifest. There is no automatic migration from planning to release.

## Stop, inspect, resume

```sh
python3 scripts/flux_agent.py status --worker codex-hubert
python3 scripts/flux_agent.py stop --worker codex-hubert
```

Ctrl+C also requests a stop. The runner terminates the active CLI process group
and preserves the journal, logs, and worktrees under `.harness/local/<worker>/`.
Repeat `run` to reconcile GitHub and continue; do not delete interrupted work or
start a second writer. A new invocation starts a new bounded run, reconstructs
from durable evidence, and uses the same existing task branches.

Current limits are 120 minutes/run, 30 minutes/model turn, and 24 turns/run.
Idle polling currently runs every 120 seconds; it does not make model calls.
Use provider-side spending controls as appropriate for your account; a time or
turn cap is not a monetary budget. Limits suspend work without claiming completion.
The machine and process must remain running; this is not a hosted service.

## What `/goal` does here

The runner schedules successive `codex exec` or `claude -p` invocations. You do
**not** add a second `/goal` loop on top of it. It passes the same milestone and
shared skills, wakes on GitHub changes, and retains checkpoints between turns.

For an interactive, supervised session you may instead use the client's native
`/goal` with the milestone and `flux-work-loop` instructions. Stop its runner
first. Native goals do not provide the runner's journal, idle polling, process
lock, or task parking. Never run both approaches with the same worker identity.

## Current verification boundary

The repository tests exercise orchestration with local Git worktrees, temporary
journals, fake GitHub responses, and CLI fixtures. `doctor`/`--dry-run` can verify
the available real account without starting a model. A complete real Codex/Claude
run under the two distinct accounts must be recorded separately; fixtures are
not evidence of that integration or of application readiness.

Planning can produce recommendations and experiments. Product implementation,
application CI, required checks, packaging and publication follow the accepted
release scope and the [container environment contract](../development/containers.md).

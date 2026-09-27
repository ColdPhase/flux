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

# Independent evaluation

The evaluator is the peer of a task's implementation owner. Use the accepted
contract, current diff, existing findings, and the running application as inputs.
A builder's summary helps locate work; verify its claims independently.

## Before implementation

Negotiate observable criteria and how to verify them. Give each required outcome
a stable ID. Include the main failure and permission cases relevant to the task,
and distinguish prototype demonstrations from required functioning behavior.

For UI tasks, agree on the intended user flow, empty/loading/error states, and
applicable layout/accessibility expectations. Visual direction comes from the
approved product/design input; introducing unrelated design goals changes scope.
For exploration, distinguish recommended directions from accepted ones. Follow
[the design workflow](../design/README.md): a fresh visual reviewer receives
screenshots, a neutral brief and references, separately from functional testing.

## At task review

1. Pin the issue contract and PR head. Check the current base, conflicts,
   required checks, and unresolved prior findings.
2. Read the implementation in an isolated checkout. Inspect integration points,
   data ownership, permission behavior, and compatibility relevant to the diff.
3. Select checks using the verification policy below and run application checks
   through Docker/Compose. For changed user flows, operate the running app
   with a browser and verify relevant API/storage behavior. A screenshot alone
   does not establish that an interaction or persistence works.
4. Record `pass`, `fail`, or `unverified` for each required criterion using the
   [report template](templates/evaluation.md). Attach concrete evidence: commands
   and outcomes, reproduction steps, screenshots when useful, and tested commit.
5. Return actionable findings to the author. Submit an approving GitHub review
   only when all required criteria pass and the account is eligible and authorized.

An evaluator whose local Docker cannot build the images may dispatch the manual
[Evaluator checks](../../.github/workflows/evaluator-checks.yml) workflow on the exact head:

```sh
gh workflow run evaluator-checks.yml --ref main -f ref=<40-hex SHA> -f kind=ui \
  -f browser=webkit -f targets='test_a test_b'
```

`kind=api` takes test files such as `tests/app/search.test.ts`; `live_editing=on` runs the
live-mode script. Cite the run URL and the tested SHA as the evidence. It covers that SHA and
those targets only, does not replace required remote checks, and a target that did not run
stays `unverified`.

Authors and evaluators on a loaded host may also run targeted modules of a pushed ref on demand with
`scripts/ci_test.sh <ref> <ui|live|api> <chromium|webkit> <modules...>` (sharded, any branch or SHA, result lines printed;
[ci-and-releases](ci-and-releases.md#targeted-test-modules-on-demand-scriptsci_testsh)); the same limits apply.

For documentation-only changes, use relevant link, configuration, and structural
checks. Do not run a browser suite or introduce application dependencies merely
to validate a documentation patch.

## Choose verification by impact

This policy applies during implementation, before marking a PR ready, and during
independent review. Choose the smallest set that establishes the changed criteria
and affected integration points. File count alone does not establish risk: a
one-line authorization change may need broad coverage. In the handoff, state the
affected behavior, selected checks and any remaining uncertainty briefly.

| Change | Relevant evidence before review |
| --- | --- |
| Documentation or skill text | Links, referenced commands/configuration, agent setup and relevant foundation checks; no application suite. |
| Isolated core function | Its regression tests and affected callers; current required build/type/lint/portable CI. |
| API or persistence | Affected API tests with real disposable storage, including relevant access, failure and migration cases. |
| Local UI behavior | Affected browser modules/journeys and API/storage paths; applicable phone/desktop and browser engines, plus separate visual assessment when required. |
| A migration, or anything that changes what an upgrade must carry (schema, `.env` settings, the release assets) | `python3 scripts/release/check_released_migrations.py` (no released file changed), `app/tests/app/released-databases.test.ts` (the migrator on a database dumped from each release) and, before review, `./scripts/check_upgrade_matrix.sh` for the releases it affects; see [upgrade compatibility](../development/upgrade-compatibility.md). |
| Shared shell, routing, authorization, schema or runtime | Expand to dependent features and cross-feature journeys; run the full applicable suite when the impact cannot be bounded confidently. |
| Release candidate | Complete configured release checks and integrated acceptance below. |

Do not run the whole application and browser suites automatically for every PR,
every review round, or a documentation-only follow-up. Required remote checks
still run on the current head. Use maintained test selectors where available;
see [contribution commands](../CONTRIBUTING.md#verify-your-change). If no supported
selector can verify the affected behavior, use the existing broader command and
record that runner limitation; do not claim coverage from a skipped check.

After new code or a base update, inspect the delta and rerun affected checks.
Earlier evidence may support unchanged areas only when the relevant source,
dependencies, tests, configuration and runtime inputs remain compatible with
the current head. Link its original SHA and explain this assessment; do not
relabel an old run as a new one. The independent evaluator still reviews the
current head and verifies open findings. New criteria need their own evidence.

For a meaningful batch of integrated changes, agree one integration checkpoint
with a named runner and candidate SHA instead of duplicating the full run in
every contributing PR. This supplements targeted checks and does not replace
the complete final release acceptance. Record failures against their affected
outcomes before admitting more dependent work.

Distinguish a changed-behavior regression, a reproduced baseline defect and an
environment failure using the smallest useful reproduction. Link one shared
blocker with an owner when several PRs hit the same fault. Avoid repeatedly
running an unchanged full suite while that blocker remains. Keep required checks
and required criteria unresolved until verified; do not disable tests or treat
a baseline failure as a passing result.

## Evidence size

Committed evidence is downloaded by every clone, forever ([#319]). Keep it small:

- Prefer WebP, or PNG compressed losslessly, for screenshots. Crop to the region
  the criterion concerns instead of committing full 1440p or 4K pages.
- Keep the short conclusion, tested commit, commands and result in the report;
  do not commit raw logs, traces, machine reports or screenshot matrices.
- Put screenshots, recordings and raw runner output in a CI workflow artifact
  and link the run from the report or PR. Keep only compact source references
  and engineering reports in `docs/agents/evidence/` and
  `docs/development/evidence/`.
- Preserve already-cited historical captures through the immutable commit linked
  by each report or through the [evidence archive](evidence/README.md); do not
  add them back to the current tree.

`python3 scripts/check_agent_setup.py` fails on any file under `docs/` above
400 KB and any screenshot or recording there above 300 KB. Existing large files
are listed with their sizes in `scripts/docs-size-allowlist.txt` and may not
grow. A new entry needs the evaluator's explicit agreement in the PR.

[#319]: https://github.com/ColdPhase/flux/issues/319

## Verdicts

| Result | Meaning |
| --- | --- |
| Pass | Every required criterion was verified at this head; required checks passed. |
| Changes requested | At least one required behavior fails or the implementation breaks an agreed constraint. |
| Unverified | A required check could not run, is pending, or lacks evidence. |

Keep optional improvement suggestions separate from blocking findings. A missing
required interaction, data loss, incorrect access, or a broken primary workflow
blocks acceptance. Missing evidence cannot be replaced with a positive score.

Give every finding a severity, so that review rounds converge:

| Severity | Meaning | Effect on the verdict |
| --- | --- | --- |
| P1 | Data loss, incorrect access, security, a broken primary workflow, or a failing required check | Blocks |
| P2 | A required criterion fails or is unverified, or an agreed constraint is broken | Blocks only if it is a regression from `main` or breaks a recorded decision; otherwise it becomes a milestone issue |
| P3 | Wording, naming, style, optional evidence, a pre-existing defect the PR does not touch, or a later improvement | Never blocks |

A P2 that does not block is filed as an issue in the milestone before the merge
(founder direction, 2026-11-06). The release stays blocked until those issues are
closed, so this moves the fix to later and does not lower the bar.

When only P3 findings remain, approve and list them in the review. Do not require
a new head or another review for P3. Keep optional follow-ups in the existing task.

**At most two review rounds per PR**, shared across agents and head updates
(founder direction, 2026-10-18). The first round reports all observed P1/P2 findings
together. Before handing back a fix, the author verifies every finding and supplies
the resulting evidence. The second round checks only that delta and the open findings;
approve when no blocking finding remains. Do not restart a full review after a rebase, switch of
reviewer or new commit, or add preferences/P3 findings on already reviewed code.

If a blocking finding remains or is newly demonstrated in the second round, record the concrete
blocker and return ownership to the author. Stop the review loop and continue other
ready work; do not start a third round automatically or approve a known failure to
meet the round limit. Merge follows the fast mode in
[workflow §5](workflow.md#5-review-fix-and-merge): required checks, the author's
own recorded checks and no open blocking finding. A reviewer's code change makes them an implementer; it does not
reset this budget.

A PR may deliver part of an issue. It then declares its scope against the issue's
criteria, and links a child issue that preserves every remaining criterion (see
[the workflow](workflow.md#4-implement-and-hand-off)). Evaluate it against that declared
scope. The remaining criteria stay required in the child issue, so this never lowers
the bar. If a declared split would leave a delivered part unusable or misleading,
request changes and say which criterion must land in this PR.

Code changes invalidate the reviewed head. Re-run affected verification and
obtain the required review on the new head; retain prior findings until verified
fixed. If the evaluator edits code, another independent evaluation is needed.

CI/branch rules enforce technical merge gates. Task labels, agent comments, and
local test results cannot bypass required remote checks or Code Owner review.

## The agents' real CLIs without an account

`scripts/check_cli_runtime.sh` ([#1125](https://github.com/ColdPhase/flux/issues/1125)) runs the REAL pinned Claude Code and
Codex inside the agent runtime image, driven by Flux (API, worker, runtime-manager, supervisor, runtime-egress `/mcp`), against a
local vendor mock instead of any account or key (`providermock`, `app/tests/app/support/cli-vendor-mock.ts`). A TEST ONLY image
stage wraps each binary so its model and sign-in hosts are the mock; the runtime's egress has no way out, so no vendor host can be
reached. It asserts Flux's side effects, never model text. Run it, alone, after a change to the runtime's templates, run reader,
error classification, sign-in console or CLI pins, and in release acceptance.

| Covered without an account | Not covered without an account |
| --- | --- |
| On each engine, an `/ai` run and an agent task run calling Flux's MCP tools (a conversation, a task's discussion, a task and a subtask, `flux_read_web`), the run token, the change log and web reads, and exactly which tools the model is offered | Claude plan sign-in (its OAuth hosts are fixed in the binary; the check signs in with an API key in the person's CLI home) |
| Each CLI's own web search: Claude Code's `WebSearch`, and Codex's standalone `web.run` with `external_web_access: false` ([#1065](https://github.com/ColdPhase/flux/issues/1065)); the search and its result addresses recorded, a result read | Claude plan limits: `You've hit your … limit` and the `anthropic-ratelimit-unified-*` headers exist only in plan (OAuth) mode |
| The CLIs' own texts for an over-long request, a 429 or usage limit and a revoked sign-in, and what Flux records and shows ([#1129](https://github.com/ColdPhase/flux/issues/1129)) | Codex's device card: Flux draws it only for `https://auth.openai.com/codex/device`; the mock issuer's page is shown in the terminal |
| Codex: the ChatGPT device sign-in through Flux's console (device code, approval, code exchange, status), a token refresh, the usage limit's reset time read by Flux's app-server client, sign-out with revocation | The path through runtime-egress's CONNECT to the vendors, and Codex's WebSocket transport (the mock answers 426) |
| Codex's tools from Flux's model catalog ([#1127](https://github.com/ColdPhase/flux/issues/1127)); its own MCP resource readers, which reach only Flux and let the run go on, while a reader of another server stops it ([#1165](https://github.com/ColdPhase/flux/issues/1165)) | The vendors' own models' behaviour and quality (with plain tools instead of code mode; a local model's is checked [below](#ai-acceptance-with-a-real-local-model)), and drift of the vendors' wording after the pinned versions |
| No vendor credential in the database or the service logs | The runtime's start on a host with `kernel.yama.ptrace_scope` 0: there the check reads that one file as 1 (and says so) |

## AI acceptance with a real local model

Release acceptance with a vendor account was cancelled: the AI is accepted by simulating it with the REAL Claude Code and the REAL
Codex and a real local model (founder direction, Hubert, 2026-11-09). `scripts/check_ai_real_model.sh` runs the stack of
`check_cli_runtime.sh` (the pinned CLIs in the runtime image, driven by Flux; sign-in, refresh and usage against the vendor mock) with
one difference: `providermock` forwards each CLI's model requests to a local model (`app/tests/app/support/real-model.ts`). It turns
Claude Code's Anthropic Messages and Codex's Responses requests into one Chat Completions request and the answer back into the
vendor's stream, with temperature 0, a fixed seed and the vendor's keepalives. Flux's production brief, tools and CLI templates are
unchanged; `docker/compose.ai-real-model.test.yaml` lists every other difference. A local model has no vendor-side search, so the
shim answers Claude Code's `WebSearch` sub-request and Codex's `web.run` (`alpha/search`, its `open` too) from a Polish fixture corpus
on linkmock (`app/tests/app/support/web-corpus-pl.ts`, one page with a prompt injection), in the vendor's result format.

Eight scenarios run on each engine, Claude Code as Ada and Codex as Bogdan, on a seeded space with Polish threads
(`app/tests/app/ai-real-model.check.ts`): `/ai` summarises and makes a task (private, Show everyone, the approval rule); a task given
to the agent ends Done or handed back by "What it may do"; a page a person linked is read and cited; Polish law with no link is
searched, read and cited; a prompt-injection page (C-30's address check, approvals, the answer's addresses); a schedule from a
sentence in the private chat, turned on and run now; one agent asks another with `<ask>`; nobody else prompts an agent. Checks are on
Flux's records and plain properties of an answer (its language, a fact, a source), never its text. A `security` check must hold on
every attempt; an `outcome` check on one of `FLUX_AI_ATTEMPTS` (default 2). Each attempt's Flux state, model transcript and timings go
to `FLUX_AI_EVIDENCE_DIR` (default `.worktrees/ai-real-model-evidence/<time>` of the main checkout).

The model is configurable. By default it is the `strata` container on Hubert's host (llama.cpp-based, ROCm on the RX 7900 XTX;
image `ghcr.io/niko1221/strata:0.2.9-rocm-gfx110x@sha256:dc06cc82…`, model `qwen3.8-flash-next-iq3_s`, shards sha256 `4c1eb2ce…` and
`316b46f3…`, its saved preset's 131,072-token context, read 2026-11-09): the script starts it only with 52 GiB of RAM available
(`FLUX_AI_MODEL_MIN_AVAILABLE_GB`; its experts take a fixed 46.8 GiB of pinned host RAM, which context and `PARALLEL` do not change),
attaches it to the stack's network, reads its local key without printing it, and stops it again afterwards. `FLUX_AI_MODEL_URL` (and
`FLUX_AI_MODEL_KEY`) points at any other Chat Completions server the stack can reach. Run it alone; a local model is slow.

Tell a Flux finding from a small model's weakness before reporting a failure: a confusing brief, tool description or error text, a
missing record or a rule that did not hold is Flux's; a wrong tool choice or a weak answer with a clear brief is the model's. A
local model is weaker than the vendors' models, so a pass here shows that Flux's brief, tools and rules work with a real model, not
how Claude or GPT answer, and the vendors' own search, sign-in and wording stay unverified.

## At release acceptance

Use a candidate commit from the protected base branch and the accepted release
contract. Verify:

- all promised outcomes, including linked children and follow-up fixes;
- installation and startup from a clean environment with documented configuration;
- complete user journeys across features, not only isolated component checks;
- [mobile PWA criteria MOB-1–MOB-7](../product/mobile-pwa.md), including
  Android/iPhone/iPad installation, touch journeys and authorized push delivery,
  on emulation plus documented platform requirements (physical devices optional);
- relevant multi-user, persistence, access, error, and recovery behavior;
- the actual configured release suite and agreed UI acceptance scenarios;
- distributable artifacts built from the candidate, their installation/startup
  checks, and public download verification when publication is in scope;
- upgrades ([#1241](https://github.com/ColdPhase/flux/issues/1241)): `./scripts/check_upgrade_matrix.sh` passes on the candidate, so
  every published release from v0.2.0 on, installed from its own release assets and from its source tree, upgrades to it with its data
  read back and new work accepted, and an edited released migration and a migration that breaks old data each make it fail (its negative
  controls, `FLUX_MATRIX_CONTROL=edited-migration` and `old-data`). Cite the result lines, the same run's `upgrade` job in the release
  workflow, and the "Upgrades from" line of the draft's notes. A failed upgrade is a release blocker, never a known limit;
- deployment and post-deployment checks when delivery is in the release scope.

The two workers divide the acceptance scenarios so each is evaluated by a peer
independent of its implementation. Cross-cutting flows receive explicit evidence;
the founder delegates final acceptance to these independent agents. No additional
human acceptance is required. Any deferred criterion needs a recorded scope decision, not an agent
marking it complete.

Publish one criterion matrix with the candidate SHA and evidence links in an
acceptance task/PR within the milestone. Missing functionality becomes a task there and
the loop continues. Resolve product decisions with the peer. Missing external access becomes a named
blocker for that task, while independent work continues.
Acceptance applies only to the tested candidate and current contract.

If a criterion blocks, seek peer help and record it in its issue. Continue other
independent acceptance scenarios or tasks. Required parked work still prevents
final acceptance; it must not disappear from the matrix.

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
- Keep JSON, logs and traces to the excerpt that proves the result; gzip larger
  machine output.
- Put bulk evidence (recordings, full screenshot matrices, raw reports) in a CI
  workflow artifact and link the run from the report or PR.

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
| P2 | A required criterion fails or is unverified, or an agreed constraint is broken | Blocks |
| P3 | Wording, naming, style, optional evidence, a pre-existing defect the PR does not touch, or a later improvement | Never blocks |

When only P3 findings remain, approve and list them in the review. The author fixes them
in the same PR when cheap, or opens a follow-up issue in the milestone and links it.

Report every finding you can see at a head in one review. A later round re-checks the
earlier findings and the code changed since. A required criterion or agreed constraint
that newly turns out to fail still blocks, whatever the round: say why an earlier round
missed it and consolidate it into that review. A later round does not add new preferences
or P3 findings on code it already reviewed.

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

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
3. Run configured application checks through Docker/Compose. For changed user flows, operate the running app
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

## Verdicts

| Result | Meaning |
| --- | --- |
| Pass | Every required criterion was verified at this head; required checks passed. |
| Changes requested | At least one required behavior fails or the implementation breaks an agreed constraint. |
| Unverified | A required check could not run, is pending, or lacks evidence. |

Keep optional improvement suggestions separate from blocking findings. A missing
required interaction, data loss, incorrect access, or a broken primary workflow
blocks acceptance. Missing evidence cannot be replaced with a positive score.

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

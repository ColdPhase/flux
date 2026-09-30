# Required application validation rollout (#143)

Date: 2026-09-30. Workflow PR #144 was independently approved at
`ed699090990ca5814c4f6bd8069069e1643ca552` and protected-merged as
`ee366b273528b3a477307db3cf23174a5981b537`.

## Ordered rollout

1. The explicit [main run 36762836984](https://github.com/ColdPhase/flux/actions/runs/36762836984)
   passed at `eb044fd85d940e909697fff50d8411d2b01d5aa9`. The observed check is
   `Application validation`, GitHub Actions app/integration **15368**.
2. Read repository/parent rulesets, effective main rules and classic protection.
   There is one active repository ruleset, **24053383** (`main-protection`),
   and no separate classic protection (its API returns 404).
3. The [original configuration](rules-before.json) was preserved in full. Added
   the observed check/source beside unchanged `Agent setup` and set strict
   current-base validation. No review, Code Owner, thread, history, deletion,
   push or bypass setting was removed or weakened.
4. [Read-back](rules-after.json) equals the submitted configuration; the
   [effective main rules](effective-main-rules.json) expose both required checks
   from integration 15368 and strict validation. Bypass actors remain empty and
   the calling account reports `current_user_can_bypass: never`.

## Controlled enforcement proof

[PR #162](https://github.com/ColdPhase/flux/pull/162) starts from then-current main
`1c49fa81118f001e021dc3ceb368ab37576bbc86`. Intentional failing fixture head
`2f997e3787ff805be7d399a2af02cbd41b40d3ca` adds one real portable core assertion.
[Application run 36764000088](https://github.com/ColdPhase/flux/actions/runs/36764000088)
fails on that assertion; `Agent setup` succeeds. The workflow genuinely runs the
application build/type/lint and portable tests, rather than a fabricated status.

A normal REST squash merge at that exact head returns **HTTP 405** with the
[explicit required-check rejection](rejected-merge.json). It separately names the
outstanding Code Owner review. [Rule-suite 4301851001](failed-rule-suite.json)
records the failed protected-main attempt. No bypass or alternative push was used,
and main was not changed by the rejected attempt.

The fixture is removed in the corrected evidence-only head. Its actual passing
run and eligible independent final-head approval are still required before this
PR merges. Missing review is not relabeled as passing merge readiness.

These controls do not certify browser/API/persistence, installation, media,
physical-device/PWA or final application/release acceptance. The substantial
local checks and all product criteria remain required.

GitHub's [rules API](https://docs.github.com/en/rest/repos/rules)
and [rule-suite API](https://docs.github.com/en/rest/repos/rule-suites)
were checked 2026-09-30; the supplied JSON records are actual repository observations.

---
name: flux-maintain-ci
description: Design and verify Flux GitHub Actions validation workflows for the selected stack, then roll out proven status checks into existing PR protection without weakening other rules.
---

# Build and verify Flux CI

Read `AGENTS.md`, the accepted architecture/release decisions, and
[CI and releases](../../../docs/agents/ci-and-releases.md). Before stack selection,
limit work to the requested repository checks and a pipeline proposal.

- Inventory real local commands and existing workflows/rules. Select appropriate
  lint, static/type, behavior tests, build, and startup checks from the actual stack.
- Run application checks/builds in Docker/Compose with the same dependency and
  service setup locally and in CI; no hidden host-installed database or toolchain.
- Implement focused workflows on a task branch with stable check names, reviewed
  action pins, explicit timeouts, and read-only PR permissions. Keep publication
  credentials out of contribution checks. No placeholder passing jobs.
- Verify locally, then inspect actual Actions runs on the workflow PR. Include
  controlled failure evidence and restore the passing state. The peer reviews
  both workflow changes and the demonstrated behavior.
- Only after the workflow lands and runs successfully, add its observed checks
  to existing branch protection/rulesets when that setting change is authorized.
  Read current rules first; preserve every unrelated protection and source binding.
- Read effective rules back and prove the intended failure blocks merge on an
  authorized test PR. Report exact limits if a policy or permission prevents this.
- Update configured validation commands, check names, and documentation together.
  Missing application gates remain explicit; repository-structure CI is not a
  substitute for application testing.

Return workflow/check names, run links, failure/pass evidence, actual enforcement
state, and any remaining setup. Do not claim remote checks ran from local results.

Keep PR Actions lightweight: lint, type checks and relevant fast tests, with cancellation of superseded runs. Run substantial browser/integration/install tests locally in Docker. Do not run release packaging on main pushes, every PR or a schedule. Reserve it for the completed product candidate through an explicit agent-triggered final workflow.

---
name: flux-verify-release
description: Verify a complete Flux release candidate against its accepted version contract, including integrated user journeys, installation, and any required delivery evidence.
---

# Verify the Flux release

Read `AGENTS.md`, the accepted release contract, and
[Evaluation](../../../docs/agents/evaluation.md). Check delivery obligations in
[CI and releases](../../../docs/agents/ci-and-releases.md).

1. Pin a candidate commit on the protected base and the contract revision. Reconcile
   every release outcome, task, child task, merged PR, and blocking finding.
2. Divide acceptance scenarios between independent evaluators. A worker's own
   implementation cannot receive its sole final evaluation from that same worker.
3. Verify clean setup/startup, the configured release suite, and complete user flows
   across features. Check the actual packaged application when packaging is in scope.
   Do not infer feature completeness from closed issues or a plausible screenshot.
4. Publish an RC-by-RC matrix using
   [the report template](../../../docs/agents/templates/evaluation.md). Preserve
   failing or unverified results with reproduction and evidence.
5. Create or update in-scope repair tasks and notify their owners when gaps remain.
   Continue until the criteria pass; record external blockers without marking success.
6. Hand a passing candidate to `flux-publish-release` when publication is required.
   After delivery, reconcile its artifact/download/deployment evidence before final
   release acceptance. New candidate code requires the affected checks again.

Return the candidate SHA, contract revision, criterion results, evidence, remaining
tasks, and next action. Distinguish a verified candidate from a published version.

# Milestone 2 — Working Flux application

Status: **implementation authorized** under the founder's
[delegation](../autonomy.md). Goal: deliver the complete usable Flux product
described in the [foundation](../FLUX-FOUNDATION.md), through coherent increments.

Agents own architecture, stack, UX, feature sequencing and acceptance. They create
and review each other's issues/PRs and further milestones. No founder acceptance
is required. Use the coverage matrix for areas 8.1–8.16 to keep the full goal visible.

## Start coding

Resume existing work first. In parallel with research, settle the first required
architecture/interface decisions with a concise peer-reviewed record. Then build
the Docker application foundation, real persistence/migrations, identity/access,
UI foundations and fast PR checks. Do not wait for milestone 1 to close.
Follow the [delivery playbook](../playbook-the-5.md): the first target is a
runnable v0.1 of one journey on a clean Compose install, then thin slices.

Continue with integrated human collaboration, conversations, project material,
maps/relationships, tasks, decisions, results, handoffs, search and notifications.
Add real agent participation using officially feasible integrations, resumable
execution and understandable access/cost controls. The agent-agreed specification
must map the full foundation to observable behavior, not a list of placeholders.

Deliver the [required mobile/tablet PWA](../mobile-pwa.md), criteria MOB-1–MOB-7:
installation on Android/iPhone/iPad, responsive phone/tablet touch journeys,
authorized Web Push, connectivity/update recovery and self-hosted operation.
Include these constraints in the initial architecture and UI foundation; split
implementation into concrete issues and link their evidence from the coverage matrix.

Each task has one owner, a different evaluator, specific dependencies and proof
of its user-visible outcome. Preserve unfinished work and resume it after a stop.
Park a blocked task and continue independent implementation or review.

## Verification and delivery

Application tooling, services and tests use Docker/Compose. Test real multi-user
data/access paths, recovery and relevant failure cases. Render and independently
evaluate the actual UI; separately check keyboard, narrow screens and behavior.
Implement clean installation, migrations, update, backup/restore and data export.
Verify mobile installation and actual OS push delivery on the supported device
matrix, including backgrounded app, denied/revoked permission and revoked project
access. Emulated viewports do not establish installation or push behavior.

Keep GitHub Actions light: fast PR checks with cancellation of superseded runs.
Use local Docker for substantial verification. Do not package releases for every
main push. At the completed product candidate, the agents explicitly trigger the
final release workflow, test its artifacts and publish through GitHub Releases.
Verify downloads and startup of that same version before declaring delivery done.

The agents maintain real commands and acceptance evidence in the protected base
revision. Empty application check lists are a bootstrap state, never release
evidence. Foundation checks cannot substitute for application tests.

Milestone closure requires its agreed criteria and independent peer evidence.
Full product completion additionally requires all foundation coverage, integrated
acceptance, actual delivery and both agents' final reports described in
the [protocol](../../agents/github-protocol.md#full-product-acceptance).

# Milestone 2 — Working Flux application

Status: **implementation authorized** under the founder's
[delegation](../autonomy.md). Goal: deliver the complete usable Flux product
described in the [foundation](../FLUX-FOUNDATION.md), through coherent increments.
The later [#44 creative collaboration direction](https://github.com/ColdPhase/flux/issues/44)
sets the integrated product scenarios: private DM → selected sketch → independent
project; map thought → experiment → negative result → new direction, also starting
from work; and a useful return after a pivot with AI unavailable. Preserve
personal, DM and project audiences and the full [coverage ledger](../foundation-coverage.md).

Agents own architecture, stack, UX, feature sequencing and acceptance. They create
and review each other's issues/PRs and further milestones. No founder acceptance
is required. Use the coverage matrix for areas 8.1–8.16 to keep the full goal visible.

## Current visual and UX direction (F-013, 2026-09-29)

[Flux Studio v11](../../design/references/studio-v11/README.md) is now the primary
reference for intended appearance and connected workflows, under [#132](https://github.com/ColdPhase/flux/issues/132).
Keep its calm, compact character and useful improvements already in the repository.
The [focused contract](../../design/studio-v11-refinement.md) supersedes the
v8-only visual baseline and O-003’s prescribed rail/indigo treatment while retaining
#44/#57/#59, the accepted architecture and real mobile requirements.

Required application follow-ups: [#133 compact private recap](https://github.com/ColdPhase/flux/issues/133),
[#134 stable deep map-list relations](https://github.com/ColdPhase/flux/issues/134),
[#135 three separately tuned light/dark accents](https://github.com/ColdPhase/flux/issues/135),
and [#136 integrated calm UI / phone work navigation](https://github.com/ColdPhase/flux/issues/136).
Their issue contracts carry owners, dependencies and verification. They remain
proposed implementation work; this reference does not count as feature delivery.
The later conversation clarification belongs to #136: own messages clearly on
the right, other people's on the left, with readable text width and useful space
beside open panels. #132 includes a runnable refined preview and matched
before/after screenshots so this direction is inspectable by both agents.
Review realistic complete views separately from actual interaction/data tests,
including #44’s three journeys with no AI. Do not copy demo storage, permissions,
AI/media simulation or unchecked historical test claims into production.

## Start coding

Resume existing work first. In parallel with research, settle the first required
architecture/interface decisions with a concise peer-reviewed record. Then build
the Docker application foundation, real persistence/migrations, identity/access,
UI foundations and fast PR checks. Do not wait for milestone 1 to close.
Follow the [delivery playbook](../playbook-the-5.md): the first target is a
runnable v0.1 of one journey on a clean Compose install, then thin slices.

Continue with integrated human collaboration, conversations, project material,
maps/relationships, tasks, decisions, results, handoffs, search and notifications.
Build direct contextual send/reply and fluid map interaction rather than making
people administer materials before ordinary conversation. Keep map thoughts,
work, results and knowledge distinct and linked to their current source revisions.
Add real agent participation using officially feasible integrations, resumable
execution and understandable access/cost controls. The agent-agreed specification
must map the full foundation to observable behavior, not a list of placeholders.

Deliver the [required mobile/tablet PWA](../mobile-pwa.md), criteria MOB-1–MOB-7:
installation on Android/iPhone/iPad, responsive phone/tablet touch journeys,
authorized Web Push, connectivity/update recovery and self-hosted operation.
Include these constraints in the initial architecture and UI foundation; split
implementation into concrete issues and link their evidence from the coverage matrix.

Deliver [contextual live collaboration](../live-collaboration.md): join at existing
work with devices off, explicit context presentation and opt-in following,
human audio/video/screenshare on our self-hosted SFU/relay, quiet/return, and
results in the existing conversation/task/map/wiki. Track the reference/contract
in #59, server/context in #61, interface in #62 and deployment/quality in #63.
Real two/four-person receiver, revocation, network and supported mobile evidence
are required; a local HTML preview is not acceptance. Keep optional personal AI
help within #57; no shared subscription or hidden audio-processing participant.

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

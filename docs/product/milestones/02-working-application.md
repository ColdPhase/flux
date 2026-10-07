# Milestone 2 — Working Flux application

## Final design — F-026 (2026-10-07)

The [final design "Prostota"](../../design/final/README.md) is the only UI and UX on the
computer and the phone. It is a founder direction: agents implement it as drawn and do not
re-decide it. [#336](https://github.com/ColdPhase/flux/issues/336) lists the implementation
issues. It governs every appearance or placement statement in this brief.

## Required additions — F-016 (2026-09-30)

[Local MCP co-work](../mcp-cowork.md) governs the new feature. Flux owns the single task/thread, GitHub supplies PR/CI facts through project
bindings (#74), several external agents may belong to one person, and standing
owner grants allow cooperation without routine approval prompts. Keep the
embedded helper, existing Node stack, tenant/project access and review gates.

The [delivery table](../mcp-cowork.md#delivery-and-evidence--co-5) maps connection,
co-work, task-thread and motion/presence slices. #336 owns the UI, #151
phone-to-ultrawide and #149 map drafts. Required evidence includes
real two-owner/three-connection work, task/PR/result review, no duplicate backlog,
revocation/reconnect, deterministic board rules/manual override, two-user typing,
all no-AI journeys and F-015/#20 device gates. Active owners and reviews stay;
independent ready work continues while dependencies finish. Earlier direction
below is historical where superseded. No production completion is claimed here.

Status: **implementation authorized** under the founder's
[delegation](../autonomy.md). Goal: deliver the complete usable Flux product
described in the [foundation](../FLUX-FOUNDATION.md), through coherent increments.
The later [#44 creative collaboration direction](https://github.com/ColdPhase/flux/issues/44)
sets the integrated product scenarios: private DM → selected sketch → independent
project; map thought → experiment → negative result → new direction, also starting
from work; and a useful return after a pivot with AI unavailable. Preserve
personal, DM and project audiences and the full [coverage ledger](../foundation-coverage.md).

Agents own architecture, stack, feature sequencing and acceptance; the UI and UX are the
founders' final design (F-026). They create
and review each other's issues/PRs and further milestones. No founder acceptance
is required. Use the coverage matrix for areas 8.1–8.16 to keep the full goal visible.

## Appearance and integrated UX — final design / F-026

The [final design](../../design/final/README.md) is the only visual and interaction target.
[#336](https://github.com/ColdPhase/flux/issues/336) covers the whole application: tokens and
Kreska, the computer and phone shells, Inbox "Needs you", the five project views, one detail
panel or sheet, the conversation, hand-off, files and photos, settings, onboarding and the
small moments. #154 supplies creation notice and first-message semantics; #155 real typing and
restrained motion.

Preserve merged #133 explicit acknowledgment and #134 personal outline. #149 adds
draft-before-save and safe recovery. Existing owners and current-head reviews remain; work
that changes appearance follows the final design. Required no-AI #44 journeys, #57/#68
helper, #59 live collaboration, current permissions and #20 mobile evidence remain.
Demo storage, roles, PR/CI and author assertion counts establish no production
capability.

### Adaptive working capacity — F-015 (2026-09-30)

[#151](https://github.com/ColdPhase/flux/issues/151) delivers
[ADAPT-1–ADAPT-5](../../design/adaptive-workspaces.md): continuous layout from
small Android phones through 4K/ultrawide, more useful work/context on large
screens, familiar navigation and preserved drafts/selection/source position
during transitions, within the final design. #336 acceptance includes it alongside
#149. #20 retains mobile/PWA gates.

Use the full viewport/height/scaling/input matrix, intermediate widths, real
text enlargement, independent visual and running behavior review, measurable
performance budgets and emulated 4K/ultrawide plus mobile evidence with documented platform requirements; physical hardware is optional (founder direction #266, 2026-10-05). Prototype screenshots do not verify the production requirement. Missing evidence
remains open; available implementation and layout checks continue independently.

## Ready co-work instructions and addressed requests — F-018

[#160](https://github.com/ColdPhase/flux/issues/160) delivers the shipped
[playbook and onboarding](../cowork-workflow.md), using #152 bootstrap and #153
durable inbox/claims. Users connect, authorize and invoke the supplied Start/Resume
action. Workflow/instruction delivery is built into Flux: no required README,
prompt copying or manual skill installation. A client without a tested integrated
activation path does not pass acceptance. Requests wait durably while a
peer finishes its current step, survive context loss and are handled at safe
checkpoints. No periodic global issue/PR/comment scans or idle model calls.
First-entry analysis covers the Flux plan/wiki/relevant conversations/decisions
and existing tasks. Agents may create/manage native tasks within standing grants,
prevent duplicate decomposition and link verified PRs; later read affected changes.
#74 bridges linked GitHub events/formal reviews; the Agents view (#336) shows pending
work and controls without duplicating the task thread or flooding human unread.

Require real supported client activation and two-owner/three-connection busy-peer,
offline/resume, duplicate, stale-version and revocation evidence. The docs/seed
content are not a deployed skill or completed runtime. Settle the bootstrap/inbox
interfaces first; independent work remains available and ownership unchanged.

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

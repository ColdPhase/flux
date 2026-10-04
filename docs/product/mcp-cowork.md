# Local MCP co-work and project GitHub integration

**Direction F-016, 2026-09-30.** Hubert's later request makes this required
milestone-2 work. This is a production contract and handoff, **not implemented
capability**. [Source package](../design/references/studio-v11.6/README.md),
[UI contract](../design/studio-v11.6.md), and the issue table below belong together.

## One workspace experience, one task

Flux keeps the authoritative task, discussion, result, map, wiki and acceptance
criteria. The Agents tab is another view of that same work. GitHub supplies
repositories, branches, commits, PRs and CI facts. Do not create, import, mirror
or synchronize GitHub Issues as a second backlog. Existing external issue links
may remain provenance. This product rule does not replace this repository's
own development issue/PR workflow in `docs/agents/`.

The source's “workspace/space” means the existing **project and its audience**.
Production still has an administrative workspace/tenant containing projects.
Bindings, grants, tools, events and caches retain both boundaries. Changing a
selected project in the browser cannot retarget a running agent's authorization.

Keep O-002 React/Node/Fastify/PostgreSQL and shared domain commands. This section
is mode 1 of the proposed [F-022](ai-modes.md) two AI modes; mode 2 also keeps
provider subscription credentials off the Flux server. The supplied
FastAPI/Next.js, new storage services and hosted execution diagrams are not
adopted. This adds local external co-work; it does not move terminals, agent
containers, browsers or provider subscription credentials into the Flux server.
Technical inbox/outbox/webhook workers remain ordinary non-LLM infrastructure.

## Ready workflow amendment — F-018

[CW-1–CW-5](cowork-workflow.md) and the [starter playbook](cowork-playbook.md)
make the instruction/communication loop explicit: Flux ships the workflow,
clients load it through a tested Start/Resume path, and addressed durable requests
survive busy/offline/context-reset states. Agents act at safe checkpoints without
periodically scanning all GitHub issues/PRs/comments. Coordination stays in Flux;
formal GitHub approval/check gates stay real. #160 packages content/onboarding;
#152/#153/#74/#136 implement their existing domains against this amendment.

## Connections and owner-authorized autonomy — CO-1

The in-product helper (#57/#68, O-007/O-008) remains: chat, research, finding
connections, map/wiki/task assistance and scoped proposals. External MCP agents
are separate connections using the owner's client and compute. Never substitute
another person's connection or payer when one is unavailable.

One owner can have many connections, including several of one client type:
**Hubert / Codex, Hubert / Claude, Marek / Claude = three agents**. Each has its
own stable ID, visible owner/client/name, grants, availability and revocation.
A connection can have multiple session records; a protocol session is not an
identity. Show configured, last seen, queued, working and disconnected honestly.
Client/model labels are reported provenance, not proof of model identity.

Reuse completed #52 / PR #103 and O-005. Existing database agents/connections
already allow multiple rows per owner. Extend the present Claude-only provenance
and tools with tested Codex support. Fix the current whole-browser-session OAuth
selection limitation: Hubert can authorize both connections in one normal login,
using request-bound consent which another tab cannot swap. Do not inherit #68's
single personal-helper enablement restriction into this external-agent model.

A standing owner grant names the project, task classes, allowed read/write
actions and audiences, repository scope, permitted peer requests, concurrency,
limits and expiry/revocation. Validate it at every operation; validation is not
another confirmation dialog. Inside it, agents may discover/claim tasks, code,
test, branch, submit PRs, exchange context, review and perform authorized domain
updates without routine human management. A peer message is a trigger, never
authority to expand the receiving owner's grant. New recipients, payer, scope
or reserved action need authority. Execution and reviewer grants are separate.

Selection of a connection is not reassignment of the human responsible for the
task. Make that a separate explicit action, default off, with current task rights
and the receiving owner's consent. The existing human-only domain decision
acceptance rule remains; delegating that requires its own reviewed amendment.

## Shared context and local execution — CO-2

Tools reuse current UI/helper domain services and authorization, not alternate
tables or permissive MCP shortcuts. Read/search the authorized project
conversation, map, tasks, wiki and results through bounded versioned references;
support permitted writes and publication to the same records. Never load private
DMs, another project's content or the owner's private memory implicitly. Apply
current ACLs to identifiers, snippets, counts, caches, artifacts and stream replay.
External content cannot change a grant or trusted policy.

The handoff UI can open the original source message and download a versioned
reference packet after current authorization, without credentials/active grants
or hidden source metadata. Swapping executor/reviewer is an assignment choice,
never a profile switch or rewriting previous artifact authorship.

An atomic claim gives one active author for a work unit and a fencing generation.
Review is a separate work unit. Checkpoints contain observable progress, sources,
tests and next action, not hidden reasoning or a copied model transcript. Targeted
durable handoffs carry references to the original task/message; they create no
second chat, wiki or LLM-generated handoff summary. Replies/questions remain
possible when useful; heartbeats, logs and acknowledgements do not wake models or
inflate unread counts. Bound retry loops and descendant budgets across delegation.

Transfer before an artifact retains task/run IDs, increments generation and
invalidates the old claim. A declined replacement leaves the prior assignment
paused, never silently restarted. Preserve original authorship after a PR/result;
new assignments can continue subsequent work. Late claims/results are rejected.
Idempotency and version checks cover retries, reconnects and duplicate requests.

The first required slice supports real active local clients. Optional duty mode
must have a versioned, tested client/adapter capability contract; MCP alone does
not launch a closed client or guarantee arbitrary interruption. Queued/offline
work remains visible without fictitious progress or idle model polling. Record
supported/unsupported/unknown discovery, notifications, resume, cancellation and
usage capabilities. No hosted fallback. Revocation prevents new Flux effects;
it cannot cancel independent local Git commands, revoke unrelated credentials
or erase already received context. Cancellation request and acknowledgment differ.
Unknown local subscription usage is unknown, not zero or a fabricated quota.

## GitHub binding and board behavior — CO-3

Project settings bind zero or more repositories, possibly from different owners,
through authorized GitHub App installation access. Login identity, App
installation, project integration and individual repository binding are distinct.
OAuth/install callbacks bind the initiating user and project with verified state;
recheck current permissions and actual repository selection. No global current
repository/token, credential passthrough, automatic grant expansion when an
installation gains repositories, or exposure of admin-visible repositories to
ordinary agents. Default repository is only a creation hint.

Private repository facts require both current Flux audience access and verified
repository access; do not broaden them to all project members implicitly. Any
future organization-approved broader sharing needs a separately reviewed policy.
The same repository in two projects shares permitted external facts only, never
their Flux conversations, task/agent roster or hidden project identity.

Use many-to-many links with binding, provider host, stable repository/object IDs
and relationship role. One task may require several PRs in several repositories;
one PR can relate to several tasks. Verify locally supplied PR references against
the binding. Owners' local Git/CLI is the default code/push/PR path. Optional App
writes require narrow explicit authority and never expose installation tokens.

Disclosed project rules can move the **same Flux task** from verified PR/CI facts,
without an LLM or duplicate issue. Rules name triggering facts, required links and
effects; manual correction suspends automatic movement until explicitly resumed.
Closed-unmerged is not done; green CI or merge alone does not complete unmet
acceptance/hardware outcomes. Related-only PRs cannot drive completion. New SHA
invalidates dependent review. Apply optimistic task versions and preserve manual
changes. Existing task statuses stay `open`, `in_progress`, `blocked`, `done`,
`not_pursued`; parking remains separate. Execution/review/CI states are projections,
not additional board columns unless a later contract deliberately changes them.

Verify signed webhooks, persist before processing, deduplicate deliveries and
reconcile out-of-order/missed events against the provider. A failure for one
binding must not lose another binding's delivery. Retry with current access;
unknown external write outcomes reconcile before retry. No global exactly-once
promise. On disconnect/revocation stop future privileged reads/writes and live
projections; retain permitted historical provenance with truthful unavailable
states. Export/import contains history, never tokens, active grants or auto-runs.

## Review and completion — CO-4

A review names the exact PR head SHA or result-message ID and version, criteria,
findings, reviewer connection/owner and actual evidence. Updated code/results
need new assessment; recheck version when accepting, not only opening a dialog.
A standing review grant authorizes fresh assessments within its scope, never a
preapproved verdict. A new SHA or result version invalidates dependent review
evidence, not standing authorization. Execution-only grants cannot claim review.
Changing reviewer preserves history and validates the replacement's own grant;
ask for consent only when existing authorization does not cover the assignment.
Identical retries do not create another delivery. Non-code work can finish as a reviewed result message with no
invented PR. Missing review and unperformed device tests stay visibly pending.

Permit distinct non-author connections of one owner to review each other under
explicit project policy, e.g. Hubert's Claude reviews Hubert's Codex. A stricter
policy can require different owners. Record authorship, separation of execution
and evidence; renaming the author's run is not independent review. This qualifies
the source's unconditional different-owner restriction to support the user's
multiple-agent requirement without claiming stronger independence than exists.

Flux assessment, eligible GitHub approval, checks, merge and task completion
are different facts. A PR author cannot approve their own PR on GitHub; two
connections sharing an account/App do not become two eligible GitHub approvers.
Preserve repository protections. Do not introduce a trusted Gate/App check as a
silent replacement for required approvals. Merge/acceptance can proceed under
explicit standing policy when all applicable gates pass; there is no universal
human-confirm-every-step rule. Reserved actions still require their authority.

## Delivery and evidence — CO-5

| Work | Contract / dependency |
| --- | --- |
| Project GitHub integration and deterministic board policy | #74, promoted from connector idea; GitLab/Gitea remain later candidates |
| Multiple external connections and domain MCP tools | [#152](https://github.com/ColdPhase/flux/issues/152), successor to completed #52; retain #57/#68 helper boundaries |
| Claims, local cooperation, handoffs and current-version review | [#153](https://github.com/ColdPhase/flux/issues/153), depends on connection contract; code path additionally #74 |
| Ready playbooks and supported Start/Resume | [#160](https://github.com/ColdPhase/flux/issues/160), [CW-1–CW-5](cowork-workflow.md); consumes #152 bootstrap and #153 durable inbox/checkpoint interface |
| Same-task creation notice and first real discussion message | [#154](https://github.com/ColdPhase/flux/issues/154), amends #36/#101 behavior without rewriting history |
| Studio 11.6 / Agents tab and responsive integration | #136 with #151; consumes the domain contracts above |
| Subtle motion and real typing presence | [#155](https://github.com/ColdPhase/flux/issues/155), coordinated with #136 |

Required integrated fixture: two owners/three connections, distinct grants and
two projects; one existing task → local code/tests → verified PR → authorized
peer review → fix/new SHA → required approval/checks → merge → criterion-based
task completion. Include same-owner permitted review and stricter different-owner
policy, non-code result/version review, new commit → stale verdict → already
authorized fresh review without another owner prompt, denial of review under an
execution-only grant, reconnect/stale worker, revoked access,
simultaneous claims, private sources, duplicate/out-of-order events, manual board
override, unavailable client and no repeated prompt inside a valid standing grant.
Capture real supported-client versions and operations. Mock clients support
regression tests but do not prove Codex/Claude compatibility or closed-client wake.
Human no-agent journeys, #20 PWA and F-015 large-screen requirements remain.

## Evidence and source reconciliation

Primary sources checked 2026-09-30: [MCP architecture](https://modelcontextprotocol.io/docs/2026-07-28/learn/architecture)
describes context/tools and host responsibility; it does not establish a Flux
scheduler. [GitHub review eligibility](https://docs.github.com/en/pull-requests/how-tos/review-pull-requests/approving-a-pull-request-with-required-reviews)
and [protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)
support the separate approval gates. Protocol/client details must be verified at
implementation against supported versions; no automatic protocol upgrade here.
These are source facts; CO-1–CO-5 are the reconciled Flux product design.

The source's optional GitHub issue sync, hosted runners, stack suggestions,
two-owner-only example, blanket final-human gate and demo policy checks do not
override this contract. `AGENTS_COOP.md` is an inert supplied adapter proposal,
not repository agent instructions or an authorization mechanism. Author test
counts and simulated sessions/PRs are not production evidence.

# Flux application behavior and release proposal

**Revision:** 2026-09-27, proposal v2 for [issue #16](https://github.com/ColdPhase/flux/issues/16), contract [5852053065](https://github.com/ColdPhase/flux/issues/16#issuecomment-5852053065). **Owner:** `codex-hubert`; independent evaluator: `claude-maurycy`. This specifies intended behavior; it is not evidence that the application exists. The [coverage ledger](foundation-coverage.md) tracks every founder product area and pillar separately.

## Authority and decision status

The [foundation](FLUX-FOUNDATION.md), later [delegation](autonomy.md), and [mobile requirement](mobile-pwa.md) define the authorized goal. The [accepted #14 journey](journeys-and-vocabulary.md) supplies a provisional shared scenario. [#8 research](first-segment-and-usp-proposal.md) recommends a returning project steward in a small software product team; [O-001](decisions.md) remains open. [#9's merged feasibility assessment](own-ai-feasibility.md) is research, while O-005 remains open. [O-002](application-architecture-proposal.md) is accepted and merged in [PR #25](https://github.com/ColdPhase/flux/pull/25), including its independently reviewed AC-5 handoff. O-003 is being compared under [#15](https://github.com/ColdPhase/flux/issues/15). The current supervising user direction, [recorded in #15](https://github.com/ColdPhase/flux/issues/15), asks the visual review to compare the selected direction with `flux-ux-v8.html` and improve on that reference. This specification makes no final provider, visual, pricing, or enterprise compliance promise.

Use the working terms *workspace, project, material, conversation, decision, work item, result, handoff,* and *agent run* from #14. A decision's proposed, accepted, and superseded states have different authority. A relation has an explicit meaning; map adjacency alone creates no work dependency. The browser, API, stream, worker, search, notification, file, agent and extension paths must apply the same current authorization, including after revocation. The exact schema and routes belong to bounded implementation contracts.

**Later product clarification (F-012, 2026-09-27):** [#44](https://github.com/ColdPhase/flux/issues/44) adds creative side projects and three integrated scenarios as current direction. Personal capture, independent DM, sketch/map thought and wiki knowledge have distinct meaning and audiences; they are not interchangeable generic material or project chat. The #14 Tide case remains a permissions and decision-history regression. This clarification preserves the accepted O-002 architecture and O-004 complete-product public release boundary.

## Creative integrated journey added by F-012

1. Two people send and reply inline in a private DM about a gesture-controlled
   lamp. They select specific messages to seed a shared sketch, then promote
   selected sketch material into an independent two-person project. The audience
   and exact content of each wider share are previewed; neither the whole DM nor
   later DM messages synchronize into the project. Unrelated project members see
   no existence hint, count, title or summary. Personal quick capture remains
   private until a deliberate share.
2. Camera, low light and privacy are separate map thoughts. A fluid sketch lets
   people add/edit inline, connect through one visible-plus action, drag,
   multi-select, pan/zoom, undo, paste an indented list and use shapes/media,
   with click/tap/keyboard and phone/list alternatives. One experiment may link
   several thoughts; the same discussion thread is reachable from task, map and
   conversation. A negative low-light result can finish the experiment and
   inform a cited wiki revision while preserving prior camera reasoning. Repeat
   by starting with the task and adding the map links later. A map placement is
   not the task, and removing it does not delete the task or thread.
3. After a break and an explicit pivot, a participant sees the current direction,
   important sourced changes, last result, still-useful work and one next action.
   Exploring variant B differs from choosing B. Obsolete work is parked rather
   than marked complete; prior decisions, results and rationale remain. The
   journey works on phone/tablet without AI, a return note or inbox cleanup.

For every linked view, show the live source or an explicit source revision/stale
state. Preserve stable IDs and many-to-many typed relationships among
conversation, thought, task, decision, result and wiki. Following/muting, task
assignment and content audience are separate controls. A project or DM composer
sends to the current conversation with inherited audience and no mandatory
material form or public-comment checkbox. AI may, after bounded opt-in, react to
useful events with sourced return context or proposals, but it must deduplicate
triggers, cap cost, suppress rejected unchanged suggestions and prevent agent
loops. Human authority is required for commitments, audience and assignments.
Deterministic Git/CI rules use no LLM and distinguish PR closed from merged;
manual correction suspends automatic movement until resumed. These are
**specified requirements**, not evidence of implemented behavior.

## Integrated return journey (AC-1)

The synthetic **Tide / Shared export** example and IDs M-1, C-1, D-1, M-2, D-2, W-1, R-1 and H-1 are defined in [#14](journeys-and-vocabulary.md#synthetic-scenario-and-source-records). They are examples, not implemented URLs. Each transition below creates or changes persistent state. Reopening from another signed-in device must show the same committed state and its source versions.

| Transition | Actor and persistent object | Visible outcome | Permission boundary and failure check |
| --- | --- | --- | --- |
| Capture | Ari saves a private draft M-1 from a phone, then publishes a redacted version to the project. | Audience and saved/pending state are visible; the project sees the published version and Ari can resume after reconnect. | M-1-private stays in the named support group. Offline retry cannot publish twice or expose unredacted text. |
| Discuss | Ari starts C-1 from M-1; Nia replies with a source link. | Reply order, authors and an authorized route to M-1 survive refresh. | A quote, preview or link cannot reveal M-1-private; membership is checked again when opened. |
| Decide | Jo accepts D-1 with rationale and delegates bounded project decision authority to Ari. | Proposed and accepted state, accepting actor, authority and source versions are clear. | Only an authorized decision owner may accept; an agent suggestion has no acceptance authority. |
| Change direction | Nia adds versioned permission test M-2; Ari accepts D-2 and supersedes D-1 while Jo is away. | The current rule, historical D-1, reason, and affected work are navigable. | Delegation scope and expiry are enforced; D-2 cannot silently broaden M-1-private access or rewrite history. |
| Assign | Ari assigns W-1 to Nia with D-2 and the Tide guest/member test cases. | Owner, expected result, input revisions, blockers and next action appear together. | A new assignee receives no access through mention alone. Cross-project links obey both scopes. |
| Inspect result | Nia attaches partial R-1; Ari accepts it as evidence while W-1 remains in progress for wording. | Result shows author, test context, reviewed state and links to W-1/D-2. | A stale result or successful agent call cannot close W-1 or overwrite newer work without explicit review. |
| Find and return | After a week, Jo searches or opens the saved return point on desktop/tablet. | The trail highlights Ari's D-2 over Jo's D-1, Nia's R-1, remaining wording and original sources. | Search filters before counts, snippets and relations; absent or withdrawn sources say so without leaking content. |

**Human handoff with no AI:** Nia pauses W-1 and assigns H-1 to Ari with the current source snapshot, unfinished wording, open question and next action. Ari sees it in the in-app inbox, checks newer versions and either records a result or returns it to Nia. Revoking Ari's membership removes project content from old links, stream replay, search, files and later notification openings; another authorized member can take H-1. The handoff remains usable when no model, provider account or agent runtime is configured. Its acceptance scenario uses two people and a server restart, with no AI service.

**Conditional agent path:** an authorized human grants a named agent only the records and actions needed for W-1, with expiry, execution mode, cost source, ceiling and explicit payer consent. The run records input revisions and presents output as a proposal. A stop, model limit, offline external client, changed input or revoked grant produces a visible recoverable state; a human can continue H-1. Suspending the phone PWA does not stop a server-side run. Before a queued run reads data and before committing a result, the server rechecks the grant and source versions. A stale write, repeated command or silent paid-provider fallback fails safely. Implement only an officially supported path accepted through O-005; no personal subscription reuse is implied by this proposal.

**Mobile and accessible route:** repeat capture, conversation, decision review, search, handoff and agent-result review on phone/tablet. A map has a list or equivalent keyboard/screen-reader route to every essential object. Keep the composer and actions reachable with the software keyboard, rotation, safe areas and enlarged text. Drafts and pending operations survive suspension; reconnect and service-worker update must not duplicate a write. Opening a push deep link checks current access. [MOB-1–MOB-7](mobile-pwa.md#required-outcomes) require real Android, iPhone and iPad installation and OS delivery evidence at release.

## Dependency and coding slices (AC-3)

These are sequencing boundaries, not permission to treat a skeleton or static view as a completed journey. Each slice should have one issue owner, an independent evaluator, current contract and observable failure scenarios. Parallel work begins once the shared interface for that slice is accepted.

| Slice | Deliverable and gate | Can overlap |
| --- | --- | --- |
| 1. Application foundation | [#28 / PR #34](https://github.com/ColdPhase/flux/pull/34): Compose, browser/API/worker/PostgreSQL, migrations, persistent integration fixture and fast PR gate; merged into `main` at `c0bac61`. The foundation is a runnable developer skeleton, with user journeys still to implement. | #15 UI direction, #20 device/platform research, and O-001/O-005 research. |
| 2. Identity and policy | [#29](https://github.com/ColdPhase/flux/issues/29): persistent sessions, workspace/project grants, private drafts, revocation and one domain authorization boundary. Its [contract v1](https://github.com/ColdPhase/flux/issues/29#issuecomment-5856852514) is accepted; the human identity/session AC-1 slice merged in [PR #39](https://github.com/ColdPhase/flux/pull/39), while policy and later slices remain open. | UI components can use mock data if they do not claim production behavior. |
| 3. Human collaboration | Capture, materials, conversation/replies, decision history, work/result/handoff, source links and return point on actual shared data. Gate: identity/policy and object/version contracts. A runnable first journey is an **internal** checkpoint. | Map and search design can be explored against the same object contract. |
| 4. Relationships and knowledge | Navigable semantic links, map plus accessible alternative, authorized search, files, provenance and version history. Gate: durable objects and access filtering. | Mobile layouts and notification preferences can proceed on accepted interfaces. |
| 5. Agents and automation | Accepted O-005 integration path, agent identity/grants, run queue, consent/cost, proposals, interruption and recovery, bounded proactive triggers. Gate: policy and durable jobs; no model dependence in human paths. | External SDK/extension design can proceed after versioned public contracts are pinned. |
| 6. Extension and operations | Public API/SDK/MCP boundary where supported, replay/idempotency, export, diagnostics, update/migrations, backup/restore and self-hosted HTTPS. Gate: stable core contracts and tested security boundary. | Mobile PWA #20 spans slices 2–6; push delivery requires identity, events and HTTPS. |
| 7. Integrated acceptance and delivery | Local Docker multi-user, permission, browser, install/restore and device matrix; independent visual and behavior review; explicit final workflow builds/publishes the exact accepted candidate. Gate: every required ledger row verified, protected PRs/checks and both agent reports. | No partial public release or per-push packaging. |

Fast PR Actions should lint, type-check and run focused tests with cancellation of superseded runs. Substantial integration, browser, restore, image and device tests run locally in isolated Docker/Compose environments. The final packaging workflow is invoked explicitly after integrated acceptance. The [CI and release guide](../agents/ci-and-releases.md) governs rollout and actual GitHub gates.

## O-004 proposal: first public release (AC-4)

**Problem:** an early runnable slice is useful for development, but a public release carrying the Flux promise must work as a coherent application. **Options considered:** publish a first-journey v0.1 now; or keep that as an internal checkpoint and publish when all required foundation outcomes and F-010 are implemented and independently verified. **Recommendation:** the second option, consistent with [delegated delivery](autonomy.md#actions-budget) and the [working-application brief](milestones/02-working-application.md). The independent evaluator [accepted O-004 in the review of proposal `56d47dd`](https://github.com/ColdPhase/flux/pull/35#pullrequestreview-5331218809). This records a release boundary, not release readiness.

The first public candidate must let people install and self-host Flux, maintain persistent shared and private project state, complete the human return/handoff journey without AI, run at least one supported and consented agent path, use every required foundation area in a coherent workflow, recover and export data, and use the phone/tablet PWA with authorized push. It must have versioned public contracts for the supported extension path. [The ledger](foundation-coverage.md) gives per-area proof; **unknown, failing or parked rows prevent acceptance**. A capability beyond this boundary needs an agent-reviewed scope decision, never silent omission. Enterprise certification, pricing, a closed edition, unsupported provider subscriptions and native app-store packages are not promised.

**Exit checks:** one protected-base candidate SHA; every ledger area and pillar linked to an implemented task and independent behavioral evidence; clean Compose installation and upgrade; migration and backup/restore with real data; export fidelity; two-user/two-workspace authorization, revocation and conflict tests; actual agent run and no-AI continuation; browser keyboard/accessibility and realistic visual review; real Android/iPhone/iPad install and OS push matrix; passing fast PR checks and substantial local Docker tests; independent integrated reports by both workers; explicitly triggered final image/archive workflow; verified download and clean start of those artifacts. A release tag or successful Actions run without these checks is insufficient.

**Tradeoff and revisit condition:** this boundary delays a public label and requires broad device and operations evidence. It avoids claiming a complete product from a static prototype or first thin slice. Revisit the precise release scope when representative user trials, platform capability evidence, or a recorded independent decision shows a different coherent boundary; preserve every unfinished requirement in the ledger and a named milestone. The founder's full-product direction and F-010 cannot be waived by editing this proposal.

## Maintenance and next contracts (AC-5)

The #16 owner maintains the [coverage ledger](foundation-coverage.md) through this PR. After merge, the owner of each feature PR updates its affected rows with a commit-specific test link and remaining work; the independent evaluator checks those rows before approval. An `implemented` row needs merged behavior and reproducible verification steps; `verified` needs independent evidence at the tested head. If a later merge invalidates a check, revert that state until reverified. The final acceptance owners reconcile all rows at one candidate SHA.

The next bounded milestone-2 issues are [#29 identity and access](https://github.com/ColdPhase/flux/issues/29), [#20 mobile PWA/Web Push](https://github.com/ColdPhase/flux/issues/20), [#36 human capture and conversation](https://github.com/ColdPhase/flux/issues/36), [#37 supported agent integration decision](https://github.com/ColdPhase/flux/issues/37), and [#38 runtime and fixture hardening](https://github.com/ColdPhase/flux/issues/38), following merged [#28 application foundation](https://github.com/ColdPhase/flux/issues/28). Their own contract acceptance and dependency checks still govern coding. Negotiate subsequent decision/work/handoff, authorized map/search/files, agent execution, extension/export, and operations/integrated acceptance tasks without duplicating existing issues. The [#15 UI decision](https://github.com/ColdPhase/flux/issues/15) supplies visual rules for production UI. In its independent visual review, compare the candidate with `flux-ux-v8.html` at matched viewports and record the useful improvements and deliberate departures. Each later task must link the ledger rows it advances and keep release proof separate from a planning artifact.

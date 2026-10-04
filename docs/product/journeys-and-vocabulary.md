# Flux vocabulary and connected work journeys

**Proposal date:** 2026-09-27. **Status:** accepted provisional journey document under [issue #14](https://github.com/ColdPhase/flux/issues/14), extended by the later [#44 founder direction](https://github.com/ColdPhase/flux/issues/44). These are intended journeys, not proof of complete application behavior.

## Authority and evidence

The [foundation](FLUX-FOUNDATION.md) and [delegation](autonomy.md) establish the human and agent workspace, self-hosting, and full-product goal. Human collaboration remains useful without AI. [F-010](mobile-pwa.md) adds phone/tablet PWA and Web Push. These are accepted directions, not implemented behavior.

The small cross-functional software team and returning project steward in [#8's research proposal](first-segment-and-usp-proposal.md) are **provisional**: its PR was merged, while [O-001](decisions.md) still awaits a recorded agent decision. [O-002 architecture (#13)](https://github.com/ColdPhase/flux/issues/13) and [O-005 AI paths (#9)](https://github.com/ColdPhase/flux/issues/9) also remain open. As of 2026-09-27, no O-001, O-002, or O-005 agent decision is accepted. The term choices, illustrative IDs, team situation, and audience wording below are **Flux inferences** for peer review. They do not select a layout, schema, provider login, billing method, or public release scope.

**Dated reconciliation, 2026-09-27:** The preceding paragraph records the state when #14 was drafted. O-002 and O-004 were subsequently accepted, and the Compose foundation, sessions and runtime slices merged; O-001 and O-005 remain open. [F-012](decisions.md) makes creative side projects, independent audiences and the three journeys below the current direction. Tide remains a useful permissions/decision regression example, not the sole or primary product persona. No integrated creative journey is implemented or verified yet.

| Founder direction retained here | Source | Flux inference to validate |
| --- | --- | --- |
| Proposed, accepted, and superseded decisions remain distinguishable, with provenance. | [Foundation §8.6](FLUX-FOUNDATION.md#8-wizja-poszczególnych-obszarów-produktu) | The words “Decision” and the D-1/D-2 example. |
| Private content must not leak through search snippets or relationships; revocation applies to active automation. | Foundation §8.12 and §8.15, same link | The four audience descriptions and Tide's support group. |
| Human work continues without AI, and an agent cannot silently change the payer or billing path. | [Foundation §9](FLUX-FOUNDATION.md#9-własne-ai-i-własna-subskrypcja) | The H1–H4 and A1–A5 sequence. |
| Phone/tablet PWA and authorized Web Push belong in the complete product. | [F-010](mobile-pwa.md) | The device touchpoints in these synthetic journeys. |

This is a synthetic scenario. No customer interview, comparative trial, running Flux journey, or device test produced it. Current competitor claims and contrary practitioner reports are already dated and labeled in [#8's source ledger](first-segment-and-usp-proposal.md#source-ledger); they are not retested here.

## Working vocabulary (AC-1)

These terms are provisional until #8 and #13 settle the segment and domain boundaries. A participant should be able to use them without knowing a storage model.

| Term | Working meaning | Ownership and visibility invariant |
| --- | --- | --- |
| **Team / organization** | Team is the people doing work. Organization is their administrative and data boundary where one exists. | Membership and administrator power differ; joining a team does not grant all projects or private drafts. |
| **Workspace** | Administrative and data boundary with an explicit owner; not a required social group or selector before ordinary work. | Membership alone reveals no restricted project, DM or personal capture. A capture shows its audience before publication. |
| **Direct message (DM)** | A private conversation with explicitly named participants, independent of any project. | A DM does not grant project membership; selecting content for a sketch or project previews exactly what is shared. Later DM messages never synchronize automatically. |
| **Sketch / map thought** | A fluid shared or personal thinking surface with placements, shapes and semantic links; a thought need not become work. | Its audience and each linked object's audience are checked separately. Removing a placement does not delete the source object. |
| **Project** | A continuing objective containing conversations, materials, decisions, work, and results. “Initiative” stays descriptive prose until another type proves useful. | Linking or moving content into a project cannot silently expand its audience. |
| **Material** | A source, note, link, file, document, or draft used as evidence or output. | Show source, version, owner, audience, and missing or withdrawn source state. History remains identifiable. |
| **Conversation** | Human discussion about a project or specific object, including replies and source links. | Show audience before sending; quoting a private item cannot publish it. |
| **Decision** | A choice with accountable human, reason, sources, and state: proposed, accepted, or superseded. | A suggestion does not become an agreement automatically. Supersession preserves the old choice. |
| **Work item** | An assigned outcome with owner, inputs, state, blocker, and expected result. | Completion needs inspectable output or an explicit negative finding, beyond a status change. |
| **Result** | Inspectable output or finding of work, including a failed experiment. | Preserve author, input versions, review state, and links to the work and decision. |
| **Wiki / knowledge** | A revisable explanation that draws on results and sources without replacing their histories. | A citation retains the exact source revision and obeys current access. |
| **Handoff** | Named next actor, current state, open question, sources, and next action attached to work. | A mention does not grant access; links use current permissions. |
| **Agent run** | A bounded attempt by an identified agent to perform a scoped work item. | Show initiator, grant, execution state, input versions, cost source/limit, and proposed output. |

**Actor roles:** the *steward* restores context and an accurate next step; a *collaborator* contributes conversation, material or work; the *decision owner* accepts or supersedes a choice; the *work owner* answers for the outcome and can hand it off; an *administrator* governs membership and policy; an *agent* acts under a revocable grant. One human can hold several roles. “Private to me,” “shared with this project,” “shared with the team,” and “restricted to a named group” are provisional user-facing audience descriptions; #13 must settle their exact authorization model. Group membership gives access only to material explicitly shared with that group. The displayed audience must agree with enforced access through UI, API, files, search, and extensions.

## Synthetic scenario and source records

Jo (returning project steward and initial decision owner), Ari (designer, support liaison, and delegated decision owner during Jo's absence), and Nia (engineer and work owner) maintain a small software product, **Tide**. Their project **Shared export** asks whether a CSV export should include archived work invisible to a guest. “Guest” and “member” are Tide's customer roles, not Flux access roles. Ari, who belongs to a restricted support group, redacts the original support report before publishing M-1 to the project. Jo accepts the initial choice D-1, then leaves for a week. During that absence Nia's permission test changes the choice; Ari accepts the correction under delegated authority and assigns the related work. Jo returns after those changes.

The following IDs are illustrative stable object references, **not implemented routes**. Later product views must link each authorized record to its current view and, when relevant, a historical version.

| ID | Record and relation | Intended audience |
| --- | --- | --- |
| M-1 | Ari's redacted support report: a Tide guest saw an archived item in an export. M-1-private is its unredacted source. | M-1: project; M-1-private: restricted support group, including Ari. |
| C-1 | Ari and Nia discuss export behavior, citing M-1. | Project. |
| D-1 | Jo accepts “include all archived items” after C-1. Later superseded. | Project. |
| M-2 | Nia's versioned permission test and revised policy note, citing D-1 and M-1. | Project. |
| D-2 | Ari accepts “export only items visible to the requesting Tide user at export time,” superseding D-1 after M-2 under Jo's delegated decision authority. | Project. |
| W-1 | Nia's assigned implementation and verification work under D-2. | Project. |
| R-1 | Nia's inspectable partial verification result: Tide guest export excludes the archived item; Tide member export includes it. Links W-1 and D-2. | Project. |
| H-1 | Handoff to Ari for guest-facing wording, with next action and open question. | Project, subject to Ari's current membership. |

## Journey A: capture, discussion, decision, work, result, return (AC-2)

Every row states proposed product behavior. “Links” refer to the illustrative records above and must resolve only for currently authorized readers.

| Step | Actor and action | Visible state and source links | Access scope | Observable success |
| --- | --- | --- | --- | --- |
| 1. Capture | Ari, an authorized support liaison, redacts M-1-private, saves M-1 on a phone and publishes it to Shared export. | Draft and published states differ; audience appears before publish. M-1-private stays restricted to the support group. | Ari sees draft and restricted source; project members see only published M-1. | Ari finds M-1 after reconnecting without retyping and knows who can see it. |
| 2. Discuss | Ari opens C-1 from M-1; Nia replies with an archived-record question. | C-1 points to M-1, with human authors and reply order. | Project members. | Nia opens the exact source from the reply, including on a phone. |
| 3. Decide | Jo accepts D-1 with rationale from C-1, delegates decision authority for this project to Ari, then leaves for a week. | The accepted state is distinct from the proposal; D-1 links C-1 and M-1. Jo's absence and Ari's authority are visible. | Jo accepts D-1; Ari can accept a later project decision; members can read. | A returning member identifies who accepted the initial choice and why. |
| 4. Correct | During Jo's absence Nia attaches M-2; Ari accepts D-2, superseding D-1. | D-1 remains historical. D-2 links M-2, D-1, and C-1; any existing dependent work is flagged for review, not silently rewritten. | Project; no M-1-private leak through links. | Ari and Nia identify the current rule and reason for change. |
| 5. Assign | Ari gives W-1 to Nia with D-2, input versions, owner, and Tide guest/member cases. | W-1 links current D-2; a changed input is visible. | Nia acts within her project role. | Nia knows the outcome and source without an oral recap. |
| 6. Show result | Nia attaches R-1; Ari inspects and accepts it as partial verification. W-1 stays in progress pending Ari's guest-facing wording. | R-1 shows test context, author, versions, and review state; W-1 shows Ari's remaining wording step. | Project members with W-1/R-1 access. | Ari can inspect evidence for both Tide customer roles without mistaking R-1 for completed W-1. |
| 7. Find | Ari searches “guest archived export” or follows D-2 to W-1/R-1. | Result shows title, type, current state, and authorized source; M-1-private has no snippet or relationship hint. | Current membership and material permissions. | Ari reaches the current decision and result, beyond an old matching message. |
| 8. Return | After a week away Jo opens Shared export from a saved point on desktop or tablet. | Change trail highlights Ari's D-2 over Jo's D-1, Nia's R-1, W-1's remaining wording step, and direct sources. It states when a change lacks an explanation. | Jo's current access. | Jo names the current rule, reason, evidence, and Ari's next action without a recap. |

**Constructed multi-tool baseline:** this team could keep C-1 in Slack, a policy note in Notion, W-1 in Linear or GitHub, and R-1 in a PR. Careful reciprocal links and a current summary might pass the same return task. This is an illustrative workflow, not observed customer practice or a claim that those products lack this ability. The [#8 research](first-segment-and-usp-proposal.md#current-alternatives-and-what-they-disconfirm) records dated vendor descriptions and disconfirming reports. A neutral trial should use the same records and time window in both workflows and compare completeness, mistaken current decisions, source retrieval, elapsed time, and confidence. No advantage has been measured.

**Disconfirming case:** if Jo must enter the same choice separately in chat, a decision form, a board, and a recap, Flux adds upkeep. If a linked existing setup lets Jo and Ari resume just as safely with less effort, this journey fails its value hypothesis. Structure should arise near the actual conversation and work, rather than require duplicate administration.

## Journey B: complete human handoff, optional agent path (AC-3)

Human handoff follows Journey A's return and uses the same in-progress W-1, D-2, and M-2 records. It must work with no model configured, on phone/tablet and desktop.

| Step | Actor and action | Visible state and source links | Access scope and success |
| --- | --- | --- | --- |
| H1 | Nia pauses W-1 and creates H-1 for Ari: review guest wording, with current source snapshot and next action. | W-1 remains in progress; H-1 links D-2, M-2, and Nia's draft. | Mention grants no access. Ari can say what is done and what remains without Nia. |
| H2 | Ari opens H-1 from her return list or an in-app notification. | Current D-2 and newer changes appear beside the handoff snapshot; stale or missing sources are explicit. | Notification reveals only safe metadata; opening rechecks access. Ari spots a changed source. |
| H3 | Ari comments and records a result or hands W-1 back to Nia. | Author, version, open question, and next owner remain on W-1/H-1. | Project. Nia can continue without treating Ari's comment as an accepted decision. |
| H4 | Ari loses project membership. Authorized members reassign H-1. | Ari's old link shows no project content; search, files, and notification target do not reveal it. | Current membership is checked at read and action time. An old link or cached view cannot restore access. |

An **optional agent path** could use an officially supported external tool or an approved embedded/API/local execution mode, depending on the independent [#9 O-005 decision](https://github.com/ColdPhase/flux/issues/9). No personal subscription, provider login, or embedded run is promised here. The proposed [F-022](ai-modes.md) (2026-10-04) now defines the two AI modes and which subscription connections are supported.

| Step | Actor, visible state, and source links | Authorization, cost, and failure boundary |
| --- | --- | --- |
| A1. Authorize | Nia requests a bounded draft or test task for an identified agent on W-1. Grant displays readable records, allowed actions, initiator, and expiry. | Nia must be allowed to delegate each action. M-1-private is excluded. The account owner or payer who would bear the charge explicitly consents to the compute account, billing path, and cost cap before execution. |
| A2. Run | Agent reads authorized versions of D-2/M-2/W-1. Run shows source versions, actor, state, cost source/limit, and proposed output. | Changed or missing inputs pause application. Agent output does not automatically become D-2 or R-1. |
| A3. Interrupt | Nia stops the run, the model limit ends, or an external agent client or supported local runtime disconnects. W-1 retains completed work and unresolved steps. Suspending or disconnecting the Flux PWA does not interrupt a server-side run; it only delays display or notification. | No silent subscription-to-paid-API switch. A human continues H1–H3. Resume checks current grants and input versions. |
| A4. Revoke | Administrator or authorized owner removes the grant, or Nia loses access. Authorized members see an interrupted state and any already committed, authorized proposal, with its provenance. | Recheck grants before input reads and before result commit. Uncommitted partial output is withheld; queued work, search, files, and push cannot bypass revocation. Nia sees no project content after losing access. |
| A5. Review | Nia inspects a permitted proposed result against current D-2/M-2, with provenance and unresolved limits. | A conflict asks for review; no silent overwrite, duplicate external effect, or automatic acceptance. Ari holds delegated decision authority until the grant ends; Jo can inspect the decision on return. |

## Creative collaboration journeys added by F-012

These three synthetic scenarios are the later founder's current acceptance
direction, tracked by [#44](https://github.com/ColdPhase/flux/issues/44).
They extend rather than erase Tide's provenance and revocation checks. Their
objects and UI routes are **specified**, not implemented or device-verified.

1. **Lamp idea → collaboration.** Two people discuss a gesture-controlled lamp
   in a DM. They select only the camera/sensor/privacy messages needed to seed a
   shared sketch; later they deliberately promote selected sketch material into
   a new, independent two-person project. Other members of an unrelated
   Marketplace project see no title, count, preview or agent summary. A reply
   sends in the current DM/project thread with its inherited audience; personal
   quick capture stays private until shared. A wider share previews its exact
   content and recipients. No entire DM or future message stream is imported.
2. **Thinking ↔ execution.** On the sketch, camera, low light and privacy are
   related thoughts. A visible plus adds a connected thought; drag, multi-select,
   pan/zoom, undo, pasted lists, useful shapes/media and click/keyboard/touch
   alternatives make exploration fluid. One experiment investigates multiple
   thoughts. Its task is created with a source link but does not replace the map
   thoughts. The same conversation thread is reachable from the task, map and
   project. A negative low-light result completes the experiment, informs a
   cited wiki revision and suggests a sensor alternative; the historical
   camera reasoning remains. Repeat by creating the task first and linking it
   to the map later. A map placement can be removed without deleting the task.
3. **Return after pivot.** After a break, a participant sees the current
   direction, sourced important changes, last result, still-relevant work and
   one direct next action. Exploring sensor variant B is distinguishable from
   choosing B. A deliberate pivot retains the old decision and result, parks
   obsolete work without labeling it complete, and can be understood on phone
   and tablet with AI unavailable. A return note is optional; no inbox-clearing
   ritual, streak or guilt metric is required.

Project and DM participation are independent. Conversation, map thought, task,
decision, result and wiki keep stable identities with many-to-many typed links
and source revisions. Following, audience and assignment have separate meanings.
The [specification](application-specification.md) and [coverage ledger](foundation-coverage.md)
track implementation and proof; [#29](https://github.com/ColdPhase/flux/issues/29)
must enforce audience policy across every read/write path.

## Design and implementation handoff (AC-4)

These are minimum surfaces and acceptance scenarios for later bounded tasks, **not** the full [foundation 8.1–8.16 coverage matrix (#16)](https://github.com/ColdPhase/flux/issues/16).

| Journey | Surfaces and shared objects | Boundary | Later observable application scenario |
| --- | --- | --- | --- |
| A | Quick capture/draft/audience; project conversation; material/version; decision states; work/result; search; return point/change trail. M-1/M-2, C-1, D-1/D-2, W-1, R-1. | Project links do not publish private sources; search/relationship views filter current access. A decision change preserves history and flags affected work. | Two people use persistent data; one changes a decision during the other's absence; the returning member finds current choice, source, result, and next actor. Repeat on phone and tablet with touch, drafts, software keyboard, and safe areas. |
| B human | Work, handoff/return list, in-app inbox, result review. W-1, H-1, D-2, M-2. | Mentions/push grant no access; stale snapshots and membership loss are server enforced. | Nia hands off, Ari resumes with AI disabled; after revocation, old deep links, search, files and notifications reveal no project content. |
| B agent, conditional | Agent identity/grant, run status, consent/cost, proposed result review, interruption/retry. W-1, D-2, M-2, run and grant. | Same current authorization across UI/API/files/search/extensions; MCP is one possible extension interface pending #13/#9. Provider auth/billing depends on #9. | Through an actually supported path, stop/exhaust a run, change M-2, then try resume; verify no paid fallback, stale write, duplicate effect, or lost human continuation. |

Journey A draws on [foundation §8.1–8.3](FLUX-FOUNDATION.md#8-wizja-poszczególnych-obszarów-produktu) for project, capture, and conversation; §8.5–8.8 for work, decision, material, and return; §8.12 for search; and §8.15 for access. Journey B draws on §8.5 and §8.8–8.10 for handoff, attention, and agent participation; §8.14 for concurrent changes; §8.15 for revocation; and [§9.2/§9.4](FLUX-FOUNDATION.md#9-własne-ai-i-własna-subskrypcja) for AI access and billing boundaries. These references identify dependencies, not proof that all sixteen areas are specified here.

The mobile PWA and Web Push implementation belongs to [#20](https://github.com/ColdPhase/flux/issues/20). Later tests must include installation, a project deep link, software keyboard and offline draft recovery, notification delivery, and revoked access on required devices. No such test has passed here. #16 and milestone 2 govern integrated release evidence.

## Peer decision and reconsideration (AC-5)

**Requested decision:** accept this vocabulary and both journeys as a *provisional product contract* for #15 UI direction and bounded milestone 2 tasks. Check that return and handoff work without AI, that current and historical decisions differ visibly, and that agent/notification paths respect current access and explicit cost consent. Acceptance here does not accept O-001, O-002, O-005, release scope, or implemented behavior.

**Reconciliation status on 2026-09-27:** [#8](https://github.com/ColdPhase/flux/issues/8) supplies merged research but no accepted O-001 decision; [#9](https://github.com/ColdPhase/flux/issues/9) and [#13](https://github.com/ColdPhase/flux/issues/13) have no accepted O-005 or O-002 decision. Therefore there is no accepted wording or boundary to reconcile at this head. The #14 owner will re-check these terms when each decision is recorded, and #15 UI, #16 specification, and milestone-2 task owners must use the then-current decisions in their contracts. A mismatch requires a linked follow-up issue or a revision before dependent implementation; it does not keep this provisional #14 decision open indefinitely. A material criteria change needs a new contract revision. Revisit this proposal if linked existing tools pass the neutral return task with less effort; interviews reject this team situation; a proposed link is unsafe; or accepted architecture/AI decisions require different object or execution boundaries. The [foundation §18](FLUX-FOUNDATION.md#18-jak-przechodzimy-od-wizji-do-pełnego-produktu) continues to govern the complete product goal.

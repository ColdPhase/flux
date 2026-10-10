# Native coordination through EXT-1 — bounded proposal

**PROPOSED, 2026-10-10; independent decision pending.** Owner @PelikanFix16;
coordination owner @Zamojski5. For #460/#152/#160, using #153/#154 and #74.
This document does not amend EXT-1, enable a public tool or accept runtime delivery.
The original complete busy-review → fix → fresh-review/restart outcome remains required.

## Current evidence and gap

Production source at `aca7a588` / `8a3a4d5a` deliberately reports
`coordination_unavailable` in bootstrap. The maintained
`mcp-cowork-actions.test.ts` asserts the current catalog has unit lifecycle,
request claim and decline; admission, inbox/recovery and resolve are absent.
`requests.ts` and `recovery.ts` under `apps/server/src/co-work` are internal
compositions. `responses.ts` needs a production actor-aware publisher, and
`policy.ts` explicitly refuses publication. `requireCoWorkAdmission` currently
refuses GitHub references. SQL deferral/ranking is storage, not an authorized
native scheduler. Internal fixture compositions cannot prove a native workflow.

The proposed [owner-local native controls](2026-10-10-native-connect-controls.md)
can supply instruction delivery, factual process lifecycle and typed owner
controls; it cannot invent these missing domain capabilities. A complete
supported path needs both independently accepted seams. Unit-only checkpoint
and native non-code result evidence remains partial.

## Proposed additive catalog and version plan

Keep EXT-1 `toolContractVersion: 1`, bootstrap `contractVersion: 1`, all existing
names, inputs, scopes, operations/classes, annotations, keys and error envelope.
EXT-1 explicitly permits additive tools/optional inputs/output fields within a
version and requires an updated `mcp-tools.v1.json` snapshot in that PR. This
proposal adds new entries only. Any discovered narrowing of an existing input or
changed existing scope/class/annotation returns to a versioned independent
contract decision; do not edit the old snapshot to hide it.

Use fresh authenticated server factories in both admitted wire eras, one domain
implementation, and exact new permission entries. Existing saved entry sets do
not admit these tools automatically. The owner explicitly enables the new entries
within original consent and applicable project rights. Read/Act Off and removal
from selected projects retain their current fences. No Read or Execute is added
silently to a read-only/proposal-only connection.

| New tool | Scope/capability and operation | Exact bounded input; effect |
| --- | --- | --- |
| `flux_list_requests` | `flux.context.read`; new `connection.inbox.read` plus actual reference-kind read dependencies; no standing write operation | `{projectId, limit?, cursor?, order?}`; limit 1–50 default20, cursor opaque max804, order `arrival` or `ready` default `arrival`. Lists only the verified connection's currently authorized pending references. It never ACKs, defers, claims or resolves. |
| `flux_request_work` | `flux.action.execute`; existing `cowork.request` capability/standing operation; class is the sender unit's actual `execute`, `review` or `plan` | Base write fields + sender unit fence + `request` below. Calls existing `coWorkRequestInTransaction` with server policy/providers; atomically creates addressed intent/lineage/debit/receipt or returns the retained identical intent. Recipient selection grants no authority. |
| `flux_defer_request` | `flux.action.execute`; new `cowork.request.defer` capability/standing operation, classes `execute`, `review`, `plan`, exact recipient unit/class | Base write fields + `{unitId, requestId, expectedRequestVersion, reason, nextBoundary, dependencyRef}`. reason `busy`, `dependency`, `policy` or `capability`; nextBoundary bounded machine key 1–80; dependencyRef nullable exact source. Updates only addressed queued/deferred metadata under locks. It neither claims another unit nor interrupts current work. |
| `flux_resolve_request` | `flux.action.execute`; existing `cowork.request.respond` capability/standing operation, recipient unit's actual class | Base write fields + recipient unit fence + `{requestId, expectedRequestVersion, response}` below. Publishes the bounded actor-authored response in the original native task thread and resolves atomically. Existing `flux_decline_request` remains unchanged. |

All new schemas use `additionalProperties:false`, canonical UUIDs, bounded
integers/arrays and no owner/client/grant-generation/tenant/payer authority fields.
Base write is the existing `{projectId,runtimeSessionId,grantId,clientCommandId,
peerRequestClass}`. Unit fence is `{unitId,expectedVersion,generation,leaseId}`,
with positive bounded versions/generation and UUIDs. `request` uses the exact
current bounded request fields:
`{unitId,expectedUnitVersion,recipientConnectionId,intentKey,parentRequestId,kind,
target,sourceRefs,criteriaRefs,priority,peerUnblocking,lifetimeSeconds}`.
Its unit is the recipient; the outer fenced unit is the sender. Preserve the
current bounds: intentKey 1–200 machine characters, kind help/review/fix/handoff,
sourceRefs1–16, criteriaRefs1–8, priority0–3, boolean peerUnblocking, lifetime1–604800.
No copied prompt, model transcript, arbitrary URL, shell or instruction overrides.

`response` is a new closed publisher schema:
`{finding,body,target,sourceRefs}`; finding `pass`, `changes_requested`, `blocked`
or `completed`, body 1–20000 characters, exact target and 1–16 bounded original
source references. The target must equal the admitted request's current target;
new artifact versions need a fresh request. It is a normal native task-thread
contribution attributed to the actual agent/owner/connection, not decision
acceptance, eligible GitHub approval or task completion. Human-reserved decisions
and the task's human assignee remain unchanged.

New list annotations: readOnly=true, destructive=false, idempotent=true.
New mutations: readOnly=false, destructive=false, idempotent=true. Set
openWorld=true for these new tools because admitted GitHub references may require
fresh remote source verification; the ordinary server command remains bounded.
Do not change any existing tool annotation. Extend the error-code list additively
for genuine new failures, retaining `{code,error}` / `isError:true` and all prior
codes. Strict schema refusal precedes effects.

Supply a newly versioned playbook, proposed `flux.cowork` 1.4.0, naming exact tools,
required capabilities and bounded Start/Resume modules. Digest/ACK stays distinct
from active-client instruction loading and authority. Add optional bootstrap
coordination feature/version fields without removing existing keys. Remove
`coordination_unavailable` only for the exact fully wired usable path; missing
permissions/capabilities/publish/source providers stay explicit gaps and prevent
that workflow from appearing ready. Do not claim existing version1.3.0 or old ACKs
prove new coordination.

## Authority, scheduling, publication and recovery

- Reuse verified owner/client/grant binding and runtime generation, exact selected
  project/current owner+agent roles, original consent/token scopes, current MCP
  policy version/entries/source capabilities and operation/class/object standing
  grant. Source/read filtering precedes packet projection, count, pagination or
  content. Prepare → complete sorted slot/task/unit/request locks → effect →
  receipt/postconditions → protected delivery retains current fences in both eras.
- Request requires the sender's live claim in this exact runtime session. Check
  sender expected version/generation/lease after lock waits, canonical shared
  task/run/lineage, recipient's current assignment/unit version and separate
  owner's authority. Selecting a foreign client only queues a request. Recipient
  independently needs its own owner grant to claim/review/execute/respond.
  Preserve server-selected separation, lineage budgets, depth/round ceilings and
  exact-source checks. Client priority is a bounded hint, never permission.
- Deferral needs the addressed recipient's current owned runtime and exact
  defer grant/class/unit. `busy` must correspond to a different server-held live
  unit; store a reason and next safe boundary without altering that unit's lease,
  checkpoint, result or progress. Dependency deferral needs the actual authorized
  reference. No deferral of claimed/terminal/stale/expired requests. CAS/version,
  command idempotency and prepare/effect/replay/delivery fences apply. Offline
  recipients cannot manufacture a deferral and remain visibly queued.
- At a safe actual checkpoint the local adapter reads only its addressed queue,
  preserves the one-active-unit rule and server ranking with capped aging,
  peer-unblocking priority, stable ties and bounded pages. Ranking must filter
  authorized source references before limit/cursor/count, just like arrival
  recovery. A persistent bounded non-LLM wait/notification hint may trigger a
  read; it does not schedule a model while idle or ACK work as complete. Avoid
  global GitHub/project scans and reciprocal waits; keep unresolved requests.
- For resolution, **proposed grant decision:** an exact `cowork.request.respond`
  grant on the recipient unit/class covers only this bounded publication into
  its original task thread as part of one transaction. It grants no general
  conversation write or reserved human action. Use #154's actor-aware primitive
  with transaction-bound event intents, then persist responseRef and resolve
  before event flush. Publish failure rolls back response, request, debit and
  receipt. Claim/resolve checks current unit lease/generation, request version,
  addressing, current target/source versions and separation. Replays recheck
  current authority and referenced response; no duplicate message or resolution.
- GitHub references need the receiving owner's existing #74 verified access and
  current artifact/source provider, not a copied URL or sender's credential.
  Retain private-repository authorization, exact binding/link/current SHA,
  immutable authorship and non-author separation. A new head supersedes old
  requests/verdicts while keeping the standing review grant; fresh review targets
  the new head. Eligible GitHub approval/checks/normal protected merge remain
  mandatory. Until this provider is composed/tested, its code workflow remains
  visibly pending. Do not remove that mandatory gate or treat a native result-only
  path as the complete outcome.
- Inbox recovery uses the current canonical pending-reference projection with
  snapshot/continuation/resync_required and explicit coverage, no source contents,
  credentials, fingerprints or payer secrets. Bind opaque authenticated cursors
  to actual owner/workspace/project/connection/client/grant, current binding
  generation and MCP-policy revision, expiry and stable precise position/rank
  time. Fresh authorization precedes decoding. Stale, missing/retained-gap,
  expired or foreign cursors produce explicit authorized resync, not completion.
  Restart/lease loss returns unresolved work to effective pending; explicit
  terminal reason/version history remains inspectable in the native task thread.
- Owner Stop/revoke/current role loss/Off take precedence over scheduler hints.
  Actual native interruption/progress/control acceptance belongs to the local
  control seam and existing Stop integration, including dependency #383. This
  proposal neither kills unrelated local work nor equates HTTP notification
  refusal with cancellation. No new task status, content store, hosted model
  executor or automatic payer substitution.

## Required independent decision and actual tests

Accept/reject the exact additive catalog/version/capability plan, new defer grant,
bounded respond-publication authority, actor-aware publication/source providers,
ranked recovery and local adapter scheduling seam before public contract/code
implementation. Coordinate with #153/#154 owner; do not edit another active branch.
If an agreed provider is missing, record it as a concrete dependency and continue
other gates. Required full outcomes remain open, not deleted.

Use actual pinned Codex/Claude with scripted local models only, both wire eras,
clean configs and the built-in supplied Start/Resume adapter. Two owners each use
both client types, with the required three-connection mix and independent same-
client homes. Actual native steps must create/claim tasks, enqueue an exact review,
keep a busy reviewer's unrelated work untouched with durable reasoned deferral,
reach a safe checkpoint, review/publish findings, apply the fix as author, and
request a fresh non-author review against the new version/head. Verify restart
with cold context/checkpoint/cursor and useful non-code result review.

Negative/race cases: cross-owner/project/guessed IDs, self/author separation,
missing scopes/capabilities/new entries, disabled client, role loss, policy change,
revoked/expired/exhausted grants, held pre-effect and postcommit delivery,
idempotent retry/lost ACK/no duplicate publication, changed target/SHA,
simultaneous claims, offline recipient, cursor gap/retention, fairness/round
exhaustion and no lost pending request. Record actual tool/network/model counts:
quiet idle and ACK/renewal create zero model calls or conversation/unread noise.
No internal composition injection may stand in for a native public step. Vendor
account/model obedience and untested native OS/desktop/IDE paths remain unverified;
physical PWA hardware is optional under #266, which does not certify native hosts.

This is decision preparation, not delivered #460/#152/#160 or eligible approval.

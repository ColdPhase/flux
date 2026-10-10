# Managed native MCP binding — proposed public effect-fence amendment

**PROPOSED, 2026-10-10; independent public-contract acceptance pending.**
Owner @PelikanFix16; #460/#152/#160, coordinated with #153/#154/#383 owners.
No managed binding, companion/control endpoint or new MCP input is implemented
by this document. Ordinary current clients keep the accepted PC-1–PC-5 contract.

The bounded [native-controls design](research/2026-10-10-native-connect-controls.md)
and [coordination design](research/2026-10-10-native-coordination-seam.md) were
independently accepted at exact `9aff85ac1743b83b4ebca8e4dc4a2ad0d319f223` in
[controls COMMENT5480821010](https://github.com/ColdPhase/flux/pull/467#pullrequestreview-5480821010)
and [coordination COMMENT5480821048](https://github.com/ColdPhase/flux/pull/467#pullrequestreview-5480821048).
Author recorded that scope at `f84b5f32` before preparing this amendment.
Independent agent `review_protocol_decision` is separate from author `visual_next`;
shared @PelikanFix16 COMMENTs are delegated design acceptance, not eligible
GitHub/Code Owner approval, founder direction, runtime or parent completion.
They explicitly **exclude acceptance of this new public managed effect fence**.

## MNG-1 — explicit enrollment and immutable identity boundary

The owner opts a dedicated new named connection into managed-native setup in an
ordinary authenticated browser action. Default is unmanaged. Do not silently
manage a connection with another native client's existing authorization or local
process; refuse that collision and offer a new selection. A separately approved
companion read binding is the only permitted pre-existing setup binding.
Enrollment itself confers no role, scope, action/review grant or compute account.

Server enrollment record binds `{enrollmentId, ownerUserId, connectionId,
projectId, adapterId, origin, generation, state}`. IDs are UUIDs, origin is the
exact canonical HTTPS Flux origin, generation positive integer, state
`pending_native_authorization|managed|fenced|unpaired`. Owner/client/model labels,
CLI session IDs, ACKs and payload IDs do not authenticate it. A mode tombstone is
retained on the actual native OAuth binding; missing runtime/control rows in a
managed binding fail closed and never revert to ordinary mode.

The installed companion drives native add/login for its dedicated alias and
registers the semantic authorization-request fingerprint (the existing
`flux.oauth-flow.v1` canonical sorted-parameter hash) in the paired outbound
channel. The server associates it only with the same owner's request-bound,
signed consent selection and **actual AS-issued native grant binding**. The
fingerprint is correlation, not authentication: owner session/connection,
PKCE/resource/client registration and signed provider flow remain mandatory.
Cross-tab/owner/client/origin/project changes, replay or expired enrollment refuse.
No client ID or grant reference supplied by task text can retarget enrollment.
Existing enabled-client and OAuth scope ceilings/CIMD/redirect rules stay intact;
do not enable DCR or borrow/export native/vendor credentials.

Native and companion read bindings are distinct server-recorded purposes tied to
the actual AS client/flow, not reported native family. The companion's separately
consented read-only grant cannot activate the native runtime, claim a unit or
supply action authority. Actual installed-client/version support is tested
integration evidence, never authority inferred from its public client ID.

## MNG-2 — closed owner/control schemas and durable commands

Proposed owner-only control input (unknown fields refused):
`{commandId, enrollmentId, expectedGeneration, projectId, intent, taskId, role}`.
`intent` is `start|resume|pause|stop`; taskId UUID identifies canonical task,
role `execute|review|plan` is checked against actual unit/grants, never a role
upgrade. A Resume uses the server's stored context/checkpoint/native mapping;
there is no caller-supplied thread/turn/session/history/path/model/provider/
shell/approval/sandbox/payer/instruction field. Current owner/project rights,
connection selection and existing standing authority still govern every effect.
Project-authorized canonical Stop may also originate through #383; it exposes no
foreign owner's private native IDs or local control channel.

Server-created context is
`{contextId,enrollmentId,bindingId,generation,commandId,projectId,taskId,role,
clientSessionId,runtimeSessionId,unitId,unitGeneration,leaseId,state,leaseExpiresAt,
playbookReference,approvedPolicyReference}`. Before native activation, runtime/unit
fields are null. Server chooses the correlation UUID clientSessionId; it is not
identity. Context/runtime/binding owner/tenant/project equality is mandatory.
No public payload may select a different native binding. The first contextual
bootstrap confirms the real native bearer before recording runtimeSessionId.

Command ID plus normalized exact-input hash is durable before dispatch. States
are `accepted|dispatched|native_identified|running|terminal|outcome_unknown`;
same-ID/same-input returns current stored state, changed input conflicts. Native
RPC IDs are not launch idempotency. An unknown dispatched result is reconciled
against only its owned native mapping before another paid launch; otherwise it
stays blocked. Neither reconnect nor a new command ID automatically retries it.
No refund, zero spend or stopped-compute claim follows from server denial.

Pair/control audience, one-use confirmation, token/refresh custody, one writer,
30-second lease/ten-second non-LLM renewal, event sequences, signed installation,
private bounded telemetry and retention are the exact accepted NC-1–NC-4 design.
Control tokens cannot call `/mcp`, grant writes or submit new owner launch intents.
Context lease timestamps come from server wall time, never client reports.

## MNG-3 — actual native runtime before paid turn or first effect

Add **optional** `activationRef` to `flux_bootstrap` and to supplied `start_work`
/`resume_work` prompt arguments; it is an opaque base64url challenge (43–128
characters) with server-side hash, context/generation/origin/owner/connection/
expected-native-flow binding and 30-second expiry. The server sends it only to
the paired companion for an owner-accepted command. It adds no OAuth/domain
rights. Unknown/malformed/foreign/expired proofs refuse before runtime creation.
All existing unmanaged inputs/outputs/prompt behavior remain accepted unchanged.

A current managed activation checks the normal verified MCP bearer and actual
native grant reference, current selection/Read/entry/runtime/policy access and
server context before consuming the reference. Require the exact existing
`tool:flux_bootstrap` entry and its `project.identity.read`,
`connection.runtime.read`, `project.policy.read`, `cowork.playbook.read`
capabilities; a supplied prompt also requires its own exact enabled prompt entry.
A related On switch is not implicit bootstrap/activation consent. These extra
managed-path checks do not narrow the original unmanaged prompt behavior. It calls the **same** runtime
factory with those actual native claims, tags the real issued runtime to the
current context, and records exact current playbook/policy references atomically.
The companion-read binding is explicitly refused here. Same context/binding/
correlation retry can return that same issued runtime after fresh checks; another
binding/generation or changed input cannot reuse a consumed challenge.

| Pinned client | Selected proposed startup order; no undocumented API |
| --- | --- |
| Codex rust-v0.160.1 | Private app-server child starts its owned thread without a model turn. Native OAuth/status validates the dedicated Flux server. Its existing native `mcpServer/tool/call` invokes contextual `flux_bootstrap` with activationRef and server correlation UUID using **its own** OAuth. Actual native runtime/current bundle/policy are verified and supplied as per-thread developer instructions. Only then may `turn/start` launch the paid turn; later native actions use that bound runtime/unit and current authority. No experimental MCP flag, OAuth-cache export or copied user prompt. |
| Claude Code 2.1.285 | The companion's separately consented read grant retrieves current bundle/policy for appended trusted instructions, never its runtime as action identity. The official CLI is invoked with the **supplied native MCP Start/Resume prompt** containing projectId + activationRef, exact native session mapping, snapshot-off and local native approval broker. Before the first model request, that native prompt fetch authenticates with the CLI's own OAuth. Its managed branch issues/binds the actual native runtime and returns the full current bundle/policy + bound runtime/correlation UUID as trusted context data. Only that native runtime may perform the subsequent first action. Resume refreshes appended system instructions immediately and retrieves a fresh proof/current policy/checkpoint. |

**Observed basis, not an implementation:** at the current pin the maintained
native Claude Start test actually expands the authenticated server prompt into
the first scripted-model request; current `playbook.ts` only binds connection/
project, while runtime creation currently happens later in `flux_bootstrap`.
The proposed prompt-stage runtime hook above is new and needs implementation
and real native proof. The actual same-session snapshot-off primitive is tested
separately; it does not prove this hook or integrated Resume.

The managed prompt branch must return a genuine RPC/HTTP refusal on failed
activation, not a successful gap-text prompt that lets a model continue.
**Mandatory pin gate:** a refused managed prompt must produce zero first model
requests/paid turns and zero effects. If 2.1.285 instead treats that failure as
ordinary user text or continues, the Claude path stays pending and this ordering
returns for a bounded independent amendment before dependent code/support. Do
not substitute the companion runtime, rely on model obedience, silently launch
before binding, copy prompts to the user or invent a native direct-tool API.

During activation/orientation there is no arbitrary write privilege. Task/unit
setup uses the actual native bearer and separately applicable standing grants,
role/source/version/operation/object checks under the live context. The transition
to working requires the exact canonical claim/lease; absence of any required
capability/provider/context remains pending. ACK/resource listing/bootstrap or
native exit zero still cannot establish Start/Resume-ready UI.

## MNG-4 — complete write, replay and protected-delivery fence

For managed bindings the context lookup is server-owned and required at the
verified connection/runtime boundary. Opening another runtime, omitting optional
activationRef, changing clientSessionId or copying a label cannot escape it.
No payload/context proof can add authority to an unmanaged or another binding.
Every action still intersects original connection/OAuth consent, token scopes,
live policy entry/capabilities, selected project, current owner+agent roles,
approved policy and exact current standing grant/class/object/limits/expiry.

All managed effects — every existing and new native task/result/decision/map/
wiki/conversation/proposal/coordination mutation, not just claim/release — check
current managed binding, context generation/state/server lease, actual native
runtime and applicable canonical unit/role/generation/lease. Read/bootstrap/ACK
metadata are not exempted from their original scope/entry/source/delivery fences;
they cannot create action readiness or work on a fenced context.

Check this gate at preparation, immediately before domain effect, receipt
completion, replay and protected delivery. Retain one transaction and existing
source/idempotency/provenance/postcondition semantics. Scope/role/grant revocation
and Off never depend on a native event/ACK. Committed effects and bytes already
handed to transport cannot be retracted; late receipt output is still protected.

Lock plan: use the existing verified connection/binding/structural prefix, then
managed-state shared lock **before** MCP policy/actor/source/domain/command/slot/
task/unit/request locks. Activation takes its managed exclusive lock at that
same position; it does not upgrade after taking domain locks. Stop/Pause/unpair/
renew/enroll take the same ordered prefix and sorted managed rows before the
existing complete slot/task/unit/request order. No canonical Stop may first
hold a task/unit lock and then wait for managed state. Current project authority
is checked through the existing policy, not a second ACL module. Document and
prove the actual adapter lock order before implementation acceptance; no late
lock may be added to make a race fixture pass.

## MNG-5 — Stop, Pause, expiry, reconnect and unpair transitions

| Transition | Server and native ordering; honest outcome |
| --- | --- |
| running → pause_requested | Stop dispatching new native turns/units. The current unit may finish its bounded safe step under unchanged live authority for at most15seconds. A real typed checkpoint is validated/persisted through canonical #153 services, then context/unit is parked and fenced before native interrupt if needed. No fabricated checkpoint/progress. If deadline/lease/authority fails, fence and interrupt with checkpoint-unavailable/unknown outcome; Resume needs actual recovery. |
| any live/startup context → Stop | Commit context epoch increment/fenced state and canonical #383 stopped unit/task transition before native interrupt dispatch. All future managed effects/replays/delivery fail under the new state. Cancel queued approvals. Show server-fenced versus interrupt-requested versus observed interrupted/exited separately; ACK/disconnect is not stopped. |
| lease/role/Off/native binding revoke | Fresh server facts refuse effects even before a sweeper/event runs. Fence the context, preserve history/checkpoint/pending requests and request owned native interruption. No late renewal revives an expired epoch or exhausted grant. |
| reconnect/recovery | Reauthenticate the same pair and current authority, reconcile dispatched/native-unknown outcomes, obtain a new generation/proof and bind a real current native runtime. Same native session mapping/canonical task/checkpoint only. No hidden second paid launch or stale approval/result. |
| unpair | Fence context/generation first, disable control/companion-read renewal and dispatch, interrupt the owned child when reachable; preserve unknown interruption honestly. Keep the native binding's managed tombstone and refuse old-token effects. Do not silently become unmanaged when control rows/secrets are removed. Native account/config/history remain untouched. |
| re-enroll | New explicit owner confirmation/generation/proof and current native binding/runtime checks; old runtimes/challenges/intents/approvals stay invalid. Ordinary fresh standalone authorization is a distinct new connection/owner flow, not an unpair escape for old managed tokens. |

An actual native terminal state closes only its mapped owned turn/process group;
it does not imply domain task completion. A canonical result/checkpoint is
published through its existing granted command, never telemetry. No other local
CLI/Git process/PID is controllable. Native use/cost remains unknown unless actually
observed. Unresolved work and unknown outcomes are never discarded to unblock.

## MNG-6 — publication and acceptance gates

The accepted coordination research specifies the four additive list/request/
defer/resolve entries, exact six deferral boundaries, explicit new entries and
standing grants, fair authorized recovery and narrow atomic response publication.
Their governing catalog/schema amendment and production #153/#154/#74 providers
still need recording/verification before new public implementation. Preserve
CO-3's complete private-source/audience closure on all future read/event/replay
channels; refuse detailed private-backed publication until that provider exists.
A native result-only test cannot complete the required code review/fix/merge path.

This proposal changes no current supported/client-ready claim. Independent public
contract evaluation must accept the exact enrollment/bootstrap/context/epoch/
transition/lock/refusal boundary above before dependent adapter/domain code.
New required input/scope/class/annotation restrictions on old **unmanaged** inputs
are forbidden under EXT-1 v1; use its compatibility classifier/snapshots. Preserve
all old names/resources/URIs/keys/errors, including historical playbook resources.
If a real breaking change is needed, return a versioned independent amendment.

Mandatory actual proof in both wire eras and real pinned clients:

- Native OAuth-flow association, owner/cross-tab/origin/client/project/companion
  separation, fresh/replayed/expired/foreign activation and actual pre-model
  native runtime/current bundle/policy; failed prompt yields zero model requests.
- Held managed prepare/effect versus Stop/Off/revoke/lease expiry; postcommit
  protected delivery and receipt replay; activation/enroll/unpair/re-enroll
  races cannot fall back to unmanaged or accept an old runtime/nonce/approval.
- All affected domain operations/source types, role/grant/capability limits,
  idempotency/version/provenance, canonical Pause/Stop/checkpoint and lock order;
  no callback/metadata label substitutes for a fence or observed interruption.
- Real signed installer/pairing/native approvals, Start/Resume/Pause/Stop,
  unknown-launch recovery and privacy/custody/size/quiet idle, complete two-owner
  Claude/Codex mix/independent homes, busy review→fix→fresh review/cold recovery,
  useful non-code and protected #74/code outcomes, and actual required platforms.
- Fresh functional and neutral visual evaluation of the exact current source;
  eligible PR466/main composition, PR467 required CI/independent eligible review
  and normal protected merge. Absence of a check is UNVERIFIED.

#460/#152/#160 remain open. Research/design acceptance, this public amendment,
implementation, supported integration/runtime and release acceptance are separate.

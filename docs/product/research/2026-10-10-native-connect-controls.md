# Built-in native Connect and work controls — bounded proposal

**Proposed, 2026-10-10; independent decision pending.** Owner @PelikanFix16;
[#460](https://github.com/ColdPhase/flux/issues/460), [#152](https://github.com/ColdPhase/flux/issues/152)
and [#160](https://github.com/ColdPhase/flux/issues/160). This does not amend their
accepted criteria or the [PC-1–PC-5 contract](../mcp-protocol-compatibility.md).
It proposes the missing implementation mechanism before code depends on one.
The independent decision at `8a3a4d5a8f426ad0d1c4c3145680a295fd9561f0`,
[COMMENT5480757786](https://github.com/ColdPhase/flux/pull/467#pullrequestreview-5480757786),
requested NC-1–NC-4 corrections. Direction was defensible, not accepted for
implementation. This revision chooses the boundaries below; runtime/distribution
proof and renewed independent acceptance remain required.

## Problem and evidence

Hubert uses his own installed Codex and Claude Code on his computer. Flux must
let him Connect/authorize and use supplied Start/Resume/Pause/Stop, report actual
progress and recover without copied instructions or a separate agent backlog.
The external client retains his compute account and filesystem permissions.

**Observed:** independent evaluation at `aca7a588` confirms real native transport
and supplied resource/prompt delivery. It explicitly leaves product-integrated
controls/states/recovery unverified. Current Flux Connect renders command text;
it has no native host bridge, setup URL handler or process controller. A server
token, open runtime session or ACK cannot prove active-model loading or let a
browser start, interrupt or resume a closed native client. Existing domain claims,
checkpoints and requests remain the work system; a launcher must not replace them.

**Pinned source inspected:** official Codex `rust-v0.160.1`, commit
`d27764b82f7118f674371e6d6e76271d9d606edb` (2026-10-05), defines
[thread start/resume](https://github.com/openai/codex/blob/d27764b82f7118f674371e6d6e76271d9d606edb/codex-rs/app-server-protocol/src/protocol/v2/thread.rs)
with per-thread developer instructions and
[turn start/interrupt](https://github.com/openai/codex/blob/d27764b82f7118f674371e6d6e76271d9d606edb/codex-rs/app-server-protocol/src/protocol/v2/turn.rs).
These are native primitives, not an implemented Flux integration. The
[OpenAI app-server reference](https://developers.openai.com/codex/app-server/)
(checked 2026-10-10) documents default stdio JSON-RPC; its WebSocket transport
is experimental/unsupported for production. Do not expose that listener as a
browser integration or assume it is already running.

The [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference)
(checked 2026-10-10) documents streaming JSON input/output, session/resume
and supplied/system prompt options. The maintained pinned CLI is 2.1.285.
Process interruption, native approval routing and resume behavior still require
actual tests; documented flags are not proof of Flux controls. No vendor account,
credential or real-model/spend test has been used for this proposal.

## Alternatives and recommendation

1. **Keep commands or tell the user to say Start. Rejected as delivery.** Existing
   native-resource observations remain useful, but there is no supplied product
   control, status channel or recovery mechanism. It cannot meet PC-4/CW-1 alone.
2. **Add a waiting MCP tool/duty loop only. Insufficient alone.** A waiting active
   client could receive scoped deterministic events without idle LLM calls, but
   it does not install/start/connect a native client or provide required owner
   launch/resume/interrupt controls. Duty mode remains separate under CO-2.
3. **A product-owned local adapter on the owner's computer. Recommended for
   independent evaluation.** It uses the installed, unmodified official CLI's
   local stdio/process interface. The web product supplies bounded typed intents;
   the local adapter performs native setup and Start/Resume/Pause/Stop and reports
   factual lifecycle events. This adapter and installer are NEW required work,
   not a capability that currently exists. It must ship through a tested built-in
   setup flow, not a README command or manually installed skill.

The adapter is external-owner mode (F-022 mode b), not a hosted Flux runtime or
API-key/consumer-session embedding. Vendor credentials remain solely with the
official client in the owner's native account storage. Flux neither receives
them nor substitutes another payer. This classification and required distribution,
approval and local control boundaries need independent acceptance before code.

## Proposed closed control and authority boundary

- Owner starts/installs the product adapter through the supported Connect flow.
  An unavailable helper/client/platform is a visible pending state. Do not claim
  a URL handler or automatic launch before its installation and actual behavior
  are verified. Preserve standalone ordinary OAuth and no-AI use.
- The adapter's identity is separate from reported client/model labels. Bind its
  control channel to the actual authenticated owner/connection, nonce/generation,
  intended server origin and selected project. Pairing/renewal/reconnect need
  explicit tests for another owner, origin, replay, stale generation and revocation.
- Accept only schema-checked `connect`, `start`, `resume`, `pause`, `stop` intents
  with exact connection/project/run/task references. No raw shell command,
  executable name, path or developer-instruction text from the web request or
  task content. Local project-folder mappings and native approvals remain an
  explicit owner choice. Do not silently weaken the client's sandbox/approval
  configuration; test bypass settings remain fixtures only.
- The adapter retrieves the authenticated Flux bundle and current bootstrap/
  approved policy itself, verifies the exact version/digest and supplies them
  through a supported per-thread native invocation. It never edits repository
  AGENTS.md/global instructions or hands the user copied workflow text. Preserve
  the same native task/unit/inbox/checkpoint/history and required capabilities.
- Codex uses a private child app-server over stdio; Claude uses its supported
  stream/session invocation. Model/provider account and permission routing stay
  native. The adapter may invoke only its paired owner's authorized connection;
  every Flux operation still crosses current role/scope/project/policy/grant and
  prepare/effect/replay/delivery fences. Control pairing grants no domain authority.
- A typed owner Pause parks the actual unit/checkpoint at a safe boundary; Stop
  ends future authorized unit effects and actually interrupts the local native
  turn. Report requested/stopping/stopped separately until observed. Already
  committed effects/handed bytes are retained. Disconnection, notification
  refusal or a process status label is not cancellation proof.
- Progress comes from actual native lifecycle/observed task outcomes. A quiet
  control heartbeat/ACK has no conversation/unread/notification effect. A busy
  agent defers addressed requests safely; offline work stays durable and visibly
  queued. No global scans, idle LLM polling or automatic payer substitution.
- Reconnect revalidates all live authority; Resume uses the saved task/unit/
  checkpoint and native session mapping only after current bootstrap/policy
  checks. An obsolete native session cannot revive a revoked/exhausted grant.

## Selected candidate NC-1 — outbound paired control; native/private retrieval

Choose a product companion with an **outbound HTTPS/WSS channel** to the paired
Flux origin. The browser sends typed owner intents to Flux; it never connects to
Codex's listener or a local HTTP control port. Production requires HTTPS/WSS;
loopback HTTP exists only in isolated development fixtures. The companion is new
software, not an available capability of the current desktop app.

Proposed setup: Connect offers the tested signed companion installer for an
available platform. The installed companion registers `flux-companion:` with the
OS. The setup URI contains only HTTPS origin, pairing ID and a one-use 128-bit
nonce. Its handler accepts no executable/path/instructions and displays the
origin for local confirmation. It then contacts that origin outbound. The owner
confirms the exact pending adapter in an ordinary signed-in Flux browser session,
connection and selected project. Until installer/handler/pairing is actually
verified, show setup pending; a downloaded file or command is not completion.

Pairing expires after five minutes, consumes the nonce atomically and binds
`{issuerOrigin,ownerId,connectionId,projectId,adapterId,generation}`. The server
records only a nonce hash. Both local origin confirmation and authenticated
browser confirmation are required. Other owner/session/origin/project, replay,
already consumed nonce and stale generation refuse without binding. Suppress
nonce URL logs/referrers and use no-store/no-referrer on setup pages. OS delivery
of a URI is not proof of the browser or owner identity.

Control access tokens are separately audience-bound to the proposed native
control resource, five-minute lifetime, signed by the Flux authorization server;
they never work at `/mcp` or create a standing grant. Renewal uses a separately
scoped opaque companion refresh secret, stored locally only, hashed server-side,
with a 30-day maximum and current pair/generation checks on every renewal. Owner
unpair/revoke disables renewal/control dispatch immediately. No human cookie or
provider credential is given to the companion/control channel. One live writer
per enrolled native binding uses a 30-second control lease, renewed every ten
seconds without an LLM call. An owner reconnect supersedes its old generation;
server admission/effect fences must not rely only on queued socket messages.

The setup adapter changes only an owner-approved distinct Flux MCP server entry
in the installed CLI, via its native add/login interface. Use a reserved alias
bound to the connection ID, verify exact HTTPS endpoint before reuse, and refuse
an alias/origin collision. Never overwrite unrelated native configuration or
silently retarget an existing Flux server. Default Codex uses the accepted legacy
path without experimental features or global configuration changes.

**Codex retrieval choice:** use its private stdio app-server and the pin's
`mcpServerStatus/list`, `mcpServer/resource/read` and `mcpServer/tool/call`,
restricted to that configured Flux alias. Use native OAuth login with automatic
registration and the real ordinary Flux consent; do not read/export its OAuth
cache. Only the registered Flux playbook/policy URI and exact read-only bootstrap/
orientation entries are allowed for setup. Verify actual bootstrap owner,
connection, selected project, versions and digest before activating work.

**Claude retrieval choice:** a separate, explicitly consented companion OAuth
PKCE S256 grant for `flux.context.read` and `offline_access` at the same Flux MCP
resource. Its public CIMD identity is served by the paired Flux origin; the owner
sees that it is the companion's read grant for this same connection. The native
companion owns the verifier and exchanges the one-use request-correlated code;
an HTTPS callback on Flux relays only that opaque code to the bound outbound
channel. Neither browser cookie nor Claude/vendor credential is borrowed.
Do not enable DCR or relax current metadata/redirect checks. This is a proposed
new fixture-tested setup path, not an existing registration feature.

The companion's read grant fetches actual authenticated bundle/current policy/
bootstrap from Flux and verifies the digest. Its bootstrap runtime identity is
**not** the Claude runtime used for claims/actions. The active native Claude
client obtains its own bootstrap via its own Flux OAuth; current connection/
project/reference agreement is checked before its first action. Read-only
companion material cannot supply an action grant/runtime or upgrade the native
client's scopes. Expired/revoked/Off/unavailable read authority blocks fresh
Start/Resume until actual reconsent/recovery. Separate callback/scope/replay and
cross-owner tests are required before this choice can ship.

## Selected candidate NC-2 — durable intents and ordered fencing

Every owner intent has a UUID `commandId` and normalized exact-input hash bound
to owner/origin/connection/project/run/unit/control generation. Persist server
states `accepted`, `dispatched`, `native_identified`, `running`, `terminal` or
`outcome_unknown`, with exact native thread/session/turn references private to the
owner. Companion SQLite journal persists accepted intent **before** sending a
native operation and native IDs before acknowledging them. Native JSON-RPC IDs
alone are not idempotency. Same-ID/same-input returns the stored state; changed
input conflicts. Server and local generation/sequence/CAS checks permit one
writer, one active native turn and monotonic acknowledged event cursors.

A lost `turn/start`/process-launch response does not cause another paid launch.
Reconcile the owned exact native thread/session using read-only native state and
the recorded command marker/last known IDs. If the native result cannot be
established, retain `outcome_unknown`, prevent automatic new launch and offer
owner recovery that first fences/interrupts the owned child. A fresh command is an
explicit recovery action with the unknown prior outcome visible, not an automatic
retry or assumed refund. Creating a native thread before a paid turn and storing
its ID reduces the window but does not eliminate this gate.

**Needed canonical effect-fence amendment, also pending independent acceptance:**
explicit owner enrollment marks the specific native OAuth binding as managed by
this adapter/generation. Before paid Start the server binds the actual verified
native bootstrap runtime to its canonical work context/control generation.
Every managed-binding write then checks that current control context and any
current claimed unit/role/generation/lease in the same prepare/effect/replay/
delivery transaction as the existing action grant. An unbound runtime or missing/
closed/expired managed context is refused; a model cannot evade Stop by opening
another runtime. The controller's control token grants no domain write authority;
the native MCP bearer plus current domain grant still supplies it. Initial
orientation is read-only; any task/unit setup uses the native bearer and explicit
standing authority while the server-controlled launch context is still live.

This is a **new restrictive managed-mode mechanism**, not present production
behavior. It needs a concrete public contract amendment and independent evaluation
before code, including the initial-context → live-unit transition and held races.
Unenrolled ordinary clients keep their current inputs/semantics and all two-era
controls. Enrollment cannot silently manage another native process sharing that
binding; the setup must use a dedicated named connection/binding or refuse the
collision. Existing #383 Stop integration and #153 canonical services are
prerequisites, not code to duplicate on an active peer branch.

Pause first records requested state, parks the canonical current unit with a
validated typed checkpoint at an actual safe boundary, then interrupts the bound
native turn when needed. Stop first commits the managed-generation/run/unit
fence, then sends native interruption. Display `requested`, `server_fenced` or
`parked`, `interrupt_requested`, and `interrupted`/`exited` distinctly. A timeout
or disconnect stays unknown/pending. Already committed effects/history remain.
Role loss, revoke, Off or control lease loss fence late managed writes even when
the local channel is offline. Queued approvals are cancelled by the same epoch;
stale answers cannot reactivate work.

Codex interruption addresses only the owned thread/turn. Claude receives an
interrupt to only the spawned child/process group. Wait for actual terminal event
or child exit; if graceful interruption has not ended the owned group within
15 seconds, terminate that group only and retain partial/unknown outcome.
No arbitrary PID/command from the browser. Unrelated local CLI/Git work is outside
this control, and server refusal is not evidence that native compute stopped.

## Selected candidate NC-3 — exact native operations and permission routing

Pinned Codex source additionally inspected from the independent source set:
[common request definitions](https://github.com/openai/codex/blob/d27764b82f7118f674371e6d6e76271d9d606edb/codex-rs/app-server-protocol/src/protocol/common.rs)
and [MCP definitions](https://github.com/openai/codex/blob/d27764b82f7118f674371e6d6e76271d9d606edb/codex-rs/app-server-protocol/src/protocol/v2/mcp.rs).
The closed host allowlist is initialize/initialized; exact enrolled server's
OAuth/status/resource/bootstrap reads; thread start/resume/read on the companion's
own mapping; turn start/interrupt on its own current IDs; and responses to the
native pending approval/elicitation request. Thread start/resume supplies current
`developerInstructions` from the authenticated read, preserving native base
instructions. Resume specifies the stored thread ID, never arbitrary history,
rollout path, copied auth state or another native session.

Resolve the executable/version and project folder **locally** through owner
choice and verified pins. Omit native model/provider/account, sandbox, approval,
permission profile, arbitrary config, path/history, shell/exec and instruction
fields from all browser/task intents. Preserve local defaults/requirements; a
conflicting or missing approval capability stays unavailable. The companion's
private owner UI handles native command/file/permission approval and MCP
elicitation requests with exact request ID + thread/turn/control generation.
Only the owner's current decision is relayed to that pending native request;
never approve from task text, scope switches or a blanket test allowlist.
Interrupted/revoked/expired/unknown requests reject late responses. Observe
`turn/started` and actual `turn/completed` state for progress/interruption, not an
interrupt RPC acknowledgment. These APIs are pinned source facts; their complete
operation/approval/control composition still requires actual client tests.

Claude uses the pinned native CLI's stream JSON input/output, exact session UUID
for start/resume, and **appended** trusted instructions with
`--system-prompt-snapshot off` on every invocation. The dated
[official CLI reference](https://code.claude.com/docs/en/cli-reference)
(checked 2026-10-10) distinguishes immediate rebuilding from normal recorded
system prompts, and documents a noninteractive permission-prompt tool. Its
absence from help alone would not prove a flag unavailable. Actual 2.1.285 same-
session immediate refresh is a mandatory probe; source docs alone are not a pass.
No repository/global instruction edit or user prompt-copy fallback is allowed.

Choose `--permission-prompt-tool` targeting one companion-owned **local stdio**
approval broker; it renders the actual request privately to the local owner and
returns only the native allow/deny decision with original input, never widened
or auto-approved input. Preserve the CLI's native permission mode/settings and
interactive-elicitation restrictions. Broker payload/decision compatibility at
2.1.285, stale-request rejection and actual native owner approval are runtime
prerequisites; missing broker support refuses launch. Never use bypass flags,
global allowedTools, consumer-token input or API/provider fallback in production.
Interrupt the owned process group, preserve its native session ID, and reconcile
native terminal output/exit before Resume with freshly retrieved instructions.
Partial output is not accepted completion. Linux fixture flags/model endpoints
are test configuration only and confer no vendor/account/platform acceptance.

## Selected candidate NC-4 — metadata, custody and shipped setup bounds

Allow control events only for accepted/dispatched intent, native session/turn
identified, turn started, waiting for owner approval, unit/checkpoint/outcome
reference, interrupt requested, terminal state or fault category. Each carries
paired generation, monotonic sequence, command ID and exact canonical references;
validate them against stored mappings. Events are owner-private. Collaborators
see only already authorized canonical task/unit/outcome facts through existing
surfaces. Kreska/activity must not invent progress from control heartbeat/ACK.
Native model/account/usage remain unknown unless actually observed; no cost or
subscription entitlement estimate is manufactured.

Never forward raw stdout/stderr, system/developer text, reasoning, prompts, tool
arguments/results, diffs, local paths, login traffic or transcripts to Flux.
Approval payload remains local private UI memory only. Native output is parsed
locally with a 512-KiB frame limit and 100-KiB instruction ceiling; control frames
max16-KiB, outbound metadata queue max256 events. An over-limit/error stops new
work and retains a bounded fault category; no silent truncation as a success.
Idle connection lease/ACK/reconnect performs no model call or unread/notification
publication. Results use the existing authorized canonical command path.

Local storage: private OS-user directory0700, control/companion Flux refresh
secret file0600 (or OS credential store where supported), separate from untouched
vendor CLI storage. SQLite journal/mapping max64-MiB and 10000 intents, completed
metadata retention90days after server acknowledgment; never delete unresolved
intents to make room. Capacity exhaustion visibly blocks new launch. No raw
model/native transcript is stored by the companion; the official CLI controls its
own history. The native invocation deadline is bounded by current control lease
and work authority, not a silent fallback payer.

Initial distribution candidate is a project-built Linux x86_64 companion `.deb`
with its user-session service and registered setup URI, from an explicitly built
accepted release. Verify Ed25519-signed manifest + artifact hash + version before
installation/update. The signing key stays release infrastructure, never the
product. Update is an explicit owner action after verification and interruption/
checkpoint reconciliation; no silent CLI/version/config downgrade. Installer,
URI, local confirmation and browser pairing need actual Docker/package/native
execution plus truthful platform evidence before Connect lists them supported.
Other required OS/desktop/IDE paths stay pending until their signed installer and
native behavior are exercised; Linux tests do not certify them.

Unpair stops/fences the managed context, revokes only control and companion-read
credentials, clears registered pairing/journal secrets after preserving canonical
recovery references, and leaves official native accounts/config/history untouched.
Removing the Flux MCP entry is a separate explicit local owner choice. Uninstall
removes only companion-owned service/URI/binary/private data; it does not sign out,
delete or reinstall a vendor CLI. No-AI work and ordinary authorization remain.

## Gate and proportionate next evidence

Independent evaluator accepts/rejects the local-adapter architecture and its
exact authority/distribution/payer/control contract before a public amendment or
implementation relies on it. This proposal is not a runtime or eligible approval.
Reconsider if a supported native interface cannot preserve instructions,
approvals, interruption or recovery, vendor terms disallow the actual pattern,
or local pairing cannot retain the owner boundary. Keep the required outcome;
do not retreat to copied instructions/manual commands or publish broad support.

After acceptance, use actual pinned clients in Docker with scripted models only:
paired browser Connect → ordinary OAuth → supplied Start → full native bundle →
bounded action; Pause/Stop during held work with no late effect, real progress,
reconnect/revoke/Resume, busy review → fix → fresh review and crash recovery.
Record both owners using Claude and Codex, the required three-connection mix plus
independent same-client homes, and actual supported platform evidence. Other OS/
desktop/IDE paths remain pending until exercised; source statements alone do not
establish them. No paid/vendor credentials or spend are needed for these fixtures.

Meanwhile the owner can implement truthful server-fact projections and ownership/
Off/revoke recovery, and finish native domain/cooperation tests without this
adapter. Those components cannot label a connection Start/Resume-ready from OAuth,
transport, a URI listing or ACK alone. #460/#152/#160 remain open throughout.

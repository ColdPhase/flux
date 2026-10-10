# Built-in native Connect and work controls — bounded proposal

**Proposed, 2026-10-10; independent decision pending.** Owner @PelikanFix16;
[#460](https://github.com/ColdPhase/flux/issues/460), [#152](https://github.com/ColdPhase/flux/issues/152)
and [#160](https://github.com/ColdPhase/flux/issues/160). This does not amend their
accepted criteria or the [PC-1–PC-5 contract](../mcp-protocol-compatibility.md).
It resolves the missing implementation mechanism before code depends on one.

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

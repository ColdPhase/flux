# Pinned Codex MCP compatibility — accepted bounded research choice

**2026-10-10; bounded research choice independently accepted; public amendment and delivery pending.** Owner:
@PelikanFix16, [#460](https://github.com/ColdPhase/flux/issues/460), milestone 2.
This research checkpoint does not amend an accepted protocol contract or declare
Codex Start/Resume delivered. [#152](https://github.com/ColdPhase/flux/issues/152),
[#160](https://github.com/ColdPhase/flux/issues/160),
[F-016](../mcp-cowork.md), [CW-1](../cowork-workflow.md)
and [F-024](../mcp-identity.md) remain binding.

## Accepted research choice and bounded outcome

**[Accepted research choice] Support explicit MCP `2025-06-18` and `2026-07-28` on the existing
authenticated `/mcp` endpoint through the pinned SDK's stateless legacy adapter,
subject to a separately evaluated public admission contract and the runtime gates below.** Keep
the same verified bearer factory, domain dispatch, live policy and delivery
fences. Reject other revisions and malformed modern claims; do not silently
rewrite a protocol or relax authorization. The default pinned Codex can then use
the ordinary connection without enabling a global experimental feature.

The persona is Hubert, using his installed personal Codex CLI with his own
compute account and a selected Flux project. He needs a connection that actually
reads permitted work and performs only granted actions. Successful OAuth and an
entry in the client's server list currently conceal the later protocol failure.
This proposal addresses that compatibility boundary. Supplied instruction
activation, Start/Resume and recovery across owners/connections remain #160 work.

No account credentials or subscription access are embedded in Flux. This is the
external-agent mode of [F-022](../ai-modes.md), not the embedded agent runtime.

## Scoped independent acceptance record

[Review 5480322828](https://github.com/ColdPhase/flux/pull/466#pullrequestreview-5480322828),
submitted 2026-10-10, accepted the architectural choice at exact research head
`c39eea3019de2cbc28aa798d2ae5e005e33fd3eb`. Evaluator:
`review_protocol_decision`, a separate agent independent of author `visual_next`.
The GitHub state is COMMENTED under the shared @PelikanFix16 account. This is
**delegated decision acceptance, not an eligible GitHub/Code Owner approval,
founder direction or production acceptance**. Normal protected merge gates and
@Zamojski5's eligible current-head evaluation remain separate.

The accepted scope is exactly the two explicit wire revisions through the
existing stateless SDK adapter, verified bearer factory, shared domain dispatch
and protected delivery fences. The evaluator checked source/artifact/patch/probe
hashes, retained logs and the author-run results, rather than rerunning Docker.
Its setup, 102 foundation tests, diff/runner/patch checks passed. Research-head
GitHub checks passed. Neither record certifies broader client support.

The independent review requires exact admission/header/batch/notification
rules, complete two-era authorization and held-race equivalence, required
feature/payload equivalence, and truthful built-in Connect with supplied
activation. Every original #460/#152/#160 criterion remains binding; the
implementation gates below retain these obligations. The next contract
amendment requires independent evaluation before implementation depends on it.
No legacy production support or completed onboarding is recorded here.

Current-main reconciliation on 2026-10-10: `2175d2490a023905143569a13ca68f43e93bb403`
has no difference from the tested research base in the MCP connection/server
sources, Connect source, lock, client harness/model fixture, native-client tests,
Dockerfile and relevant MCP/identity/onboarding/extension contracts. This
establishes source equivalence for this decision only; no new main runtime pass
or unrelated behavior acceptance is claimed.

## Actual baseline experiment

**[Observed]** The application source was
`975747426a778cc4471bd4c9eabb8910eb187671`; real Linux amd64 Codex was
`codex-cli 0.160.1`, with the pinned Code Mode host. Both came from the checked-in
checksummed release assets, not a substitute client. The server SDK was locked
`@modelcontextprotocol/server@2.1.0`. [Pins and source hashes](evidence/460/source-manifest.json),
[sanitized results](evidence/460/baseline-results.json) and the
[exact research probe](evidence/460/baseline-probe.ts) preserve the evidence.

| Native client case | Actual MCP exchange | Result |
| --- | --- | --- |
| Default clean configuration | `initialize`, offer `2025-06-18` | HTTP 400, `-32022`; supported `2026-07-28`, zero Flux tools |
| `--enable mcp_2026_07_28` | No initialize; `server/discover`, `tools/list`, calls with `2026-07-28` header and per-request metadata | HTTP 200, 45 Flux tools |
| Plain invocation after the flagged invocation | `initialize`, offer `2025-06-18` again | Same rejection, zero tools; configuration byte-identical |
| Native `features enable mcp_2026_07_28`, then plain invocation | Modern discovery/list/call | HTTP 200, same 45 tools; feature persisted and existing server retained |
| Owner revokes that connection; cached native OAuth remains | Modern discovery | HTTP 403, zero tools, no selected-project data |

All five CLI invocations exited zero, including rejected startup. An exit code
or successful `mcp get/list` therefore does not certify a usable connection.
In the flagged case the actual client read only “Selected research”, obtained
authenticated bootstrap/playbook metadata, created a task under a one-use
standing grant, and received `PROJECT_NOT_FOUND` for “Outside selection”. An API
read verified the task persisted. This is a bounded positive/negative control,
not proof of every role, tool, replay or delivery race.

Flux sign-in, connection selection, consent, OAuth and the installed clients were
real. The registered OAuth client was seeded; client metadata discovery/dynamic
registration were not exercised. Responses went to the existing local scripted
model fixture: no vendor account, real key or spend. The probe used the existing
isolated test client's sandbox-bypass setting, not a proposed production setting.
Codex emitted its temporary-home helper/PATH warning; MCP calls through the real
Code Mode host still succeeded. Desktop/IDE, other OS/architectures and genuine
model obedience were not assessed.

The first recorder attempt exited one because it incorrectly required a legacy
initialize in modern mode. The corrected and final recorder runs exited zero;
the final run also corrected an auxiliary-feature-line match. Those attempts
remain in the local logs named in the manifest. No failed attempt counts as pass.

## Source findings and alternatives

**[Code inspected]** The official Codex tag `rust-v0.160.1` resolves to
`d27764b82f7118f674371e6d6e76271d9d606edb`, dated 2026-10-05.
Its [feature definition](https://github.com/openai/codex/blob/d27764b82f7118f674371e6d6e76271d9d606edb/codex-rs/features/src/lib.rs)
marks `mcp_2026_07_28` under development and off by default. Its
[MCP client](https://github.com/openai/codex/blob/d27764b82f7118f674371e6d6e76271d9d606edb/codex-rs/codex-mcp/src/rmcp_client.rs)
constructs legacy initialize with `2025-06-18`; the flagged mode is automatic
modern discovery, capable of a legacy outcome. Other-server compatibility was
not tested, so global enablement is not claimed to break every old server.

The [native CLI feature command](https://github.com/openai/codex/blob/d27764b82f7118f674371e6d6e76271d9d606edb/codex-rs/cli/src/main.rs)
persists user configuration, agreeing with the actual experiment and
[OpenAI's CLI reference](https://developers.openai.com/codex/cli/reference/)
(checked 2026-10-10). A flag on add/login or one exec invocation cannot persist
this choice. It applies at the client configuration level, not only to Flux.

**[Native interface audit]** The pinned
[config protocol](https://github.com/openai/codex/blob/d27764b82f7118f674371e6d6e76271d9d606edb/codex-rs/app-server-protocol/src/protocol/v2/config.rs)
and [config processor](https://github.com/openai/codex/blob/d27764b82f7118f674371e6d6e76271d9d606edb/codex-rs/app-server/src/request_processors/config_processor.rs)
contain persistent config value/batch writes. Experimental feature enablement
is an in-memory override, even for this key. [OpenAI's app-server documentation](https://developers.openai.com/codex/app-server/)
(checked 2026-10-10) describes MCP OAuth/reload operations and config writes;
it also marks WebSocket transport experimental and unsupported for production.
Code Mode is the client's tool-execution host, not an available Flux setup bridge.

**[Flux source]** [ClientGuide](../../../app/apps/web/src/agent-connection/ClientGuide.tsx)
renders add/login commands inside Connect. Neither it nor the connection page
has a native execution bridge, app-server RPC client or tested setup URL handler.
A persistent native configuration primitive exists, but Flux cannot currently
invoke it as an integrated action. An experimental-flag solution would require
a separately bounded, independently accepted local host adapter, informed choice
about a global experimental setting, managed-config refusal/reversal handling
and real host/platform tests. A static command or README alone is insufficient.

**[SDK source]** The official package was published 2026-09-23 and fetched
2026-10-10 from its [versioned registry artifact](https://registry.npmjs.org/@modelcontextprotocol/server/-/server-2.1.0.tgz).
Its integrity matched the checked-in lock. The GitHub `v2.1.0` tag endpoint was
unavailable (404); the published, integrity-verified code was inspected instead.
`createMcpHandler` defaults to `legacy: 'stateless'`; Flux explicitly selects
`legacy: 'reject'` today. The legacy adapter creates a fresh server from the same
factory and a fresh `WebStandardStreamableHTTPServerTransport` for each POST,
with no session ID generator. GET/DELETE return 405. It does not verify bearer
tokens; Flux's existing outer authentication remains essential.

SDK defaults alone are insufficient: they admit more legacy revisions and
initialize can respond with another version. Explicit version admission is
required. The SDK classifier preserves malformed/unsupported modern requests as
modern errors; such requests must never be redirected into the legacy path.
The [2025 lifecycle](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle)
uses initialize negotiation. The [2026 versioning contract](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)
uses per-request metadata/header, without that handshake. These are two explicit
wire contracts, not a renamed modern response. Sources were checked 2026-10-10.

**[Inference]** The stateless adapter fits the existing request-bound Flux
architecture and avoids a new native configuration authority. Its likely cost is
an explicit admission adapter plus parity/security regression coverage. It is
preferable to requiring a global under-development client switch. Source shape
alone does not prove equivalent wire semantics or required-client capabilities.

## Temporary prototype evidence

**[Observed, temporary patch only]** One isolated Docker build/probe exited zero
on the same application base plus [this exact research patch](evidence/460/prototype-patch.json),
SHA-256 `000557a3697ca87d54d0f5b3302935495f5b8d7ccc121c64edce186c402e7595`.
It changed only the two-version admission, SDK fallback setting and server
version list inside the build. The existing verified claims, request factory,
domain authorization, policy dispatch and response/relay fences were retained.
There is no tracked production patch. Build, type check and lint passed for the
prototype image; the [research probe](evidence/460/prototype-probe.ts) and
[sanitized results](evidence/460/prototype-results.json) record the tested delta.

| Prototype control | Actual result |
| --- | --- |
| Plain native Codex, then plain again after a flagged run | Initialize selected `2025-06-18`; 45 Flux tools; no config mutation |
| Flagged native Codex | Modern discovery; identical 45 tool names |
| Native old and new calls | Each bootstrapped and persisted a separate task under the same two-use grant; each refused the unselected project |
| Direct authenticated old/new HTTP | Equal complete tool definitions, playbook resource text and bound Start prompt text; resources/prompts listed |
| Separate genuine read-only OAuth token | Proposal write refused in both formats; no broadened token |
| Unknown legacy initialize and unknown modern revision | HTTP 400 / `-32022`; no substitution |
| Modern claim with legacy header; headerless legacy tool call | HTTP 400, no tool result |
| Cached bearer after live connection revocation | Direct old/new HTTP and actual native default/flagged calls refused; zero native tools |

The direct HTTP prompt/resource rows establish wire response parity, not that
Codex loads those responses into an active model. The denied-scope token was
obtained through the real existing HTTP OAuth fixture, not the second native
login. These checks reduce uncertainty about the adapter; they do not complete
all required-client features or security equivalence. Held races, replay,
provenance, policy Off, other-owner/role-loss and full grant cases remain gates.
GET/DELETE, stateful sessions and subscription behavior were not runtime-tested.
The prototype was deliberately discarded after evidence capture; its runner,
Compose override and Dockerfile are archived beside the results. Detailed log:
`/tmp/flux-460-prototype/prototype.log`, with hash in the results. Owned resources
and image tags were cleaned. No unsupported client is now declared supported.

## Proposed contract and implementation gates

The bounded architecture choice is accepted as recorded above. Its public
admission/authentication/feature amendment still requires independent evaluation
before application implementation relies on it. Neither choice nor contract
acceptance certifies implementation or completes #460.

1. Admit exactly `2025-06-18` legacy initialization and subsequent versioned
   requests, and `2026-07-28` modern requests. Preserve SDK modern envelope,
   method/name/header, size and malformed-input checks. Reject unknown legacy
   offers rather than substituting a version; reject unknown modern revisions,
   mismatches and missing required metadata. Specify/test batch and headerless
   legacy handling explicitly. No security-sensitive routing by client label.
2. Keep one OAuth resource/audience and the same verified issuer, PKCE/consent,
   owner/agent/connection/grant/client binding. Bind a fresh actor context to
   every request. Retain current roles, selected projects, intersected scopes,
   enabled entries, approved policy, standing-grant bounds, replay checks,
   reserved human decisions and protected delivery fences in both wire formats.
   Protocol session metadata never becomes actor identity or authority.
3. Prove equal required domain tool names, schemas/annotations, readable
   resources, Start/Resume prompt payloads, bootstrap/playbook/policy versions,
   errors, pagination/cursors, command idempotency and persisted provenance.
   Cover actual default and flagged native clients plus direct wire controls.
   Do not advertise stateful legacy sessions, server-initiated requests or
   subscription delivery from this per-request adapter without separate proof.
4. Run old/new positive and negative authorization controls: other owner,
   unselected project, missing scope, owner/agent role loss, policy Off, revoked
   OAuth/connection/client, exhausted/expired grant, invalid audience and stale
   replay. Existing held prepare/effect/delivery race coverage must also run
   through the changed transport; a next-call denial alone does not replace it.
5. In the built-in Connect path state the tested client/revision and the actual
   unsupported state. With the proposed legacy path, ordinary Codex setup must
   reach authenticated tools without a feature flag or config edits; no native
   bridge is claimed. OAuth consent, transport compatibility and supplied
   Start/Resume must remain distinct statuses. An incompatible client gets a
   useful visible failure. Do not infer “working” from OAuth success, list or
   exit zero, and do not add a prompt-copy/README remedy.

**Still unverified:** complete legacy feature/security equivalence, integrated
Connect status/recovery, all required native clients/platforms, #152's full
multi-owner/multi-connection matrix and #160's actual instruction activation.
The existing modern Codex onboarding test records missing instruction delivery;
this research does not certify the legacy client loads them either. No tool list,
prompt/resource HTTP response or acknowledgment proves active-model loading.

**Reconsider this choice** if a required Flux feature cannot retain its semantics
through the bounded stateless legacy path, parity or delivery checks fail, or
the actual pinned client cannot use the explicitly admitted revision. In that
case retain a visible unsupported state and propose the native adapter with its
own trust/platform contract; do not weaken the required outcome. Recheck vendor
pins and public documentation before publication. #160 stays open independently.

## Reproduction and checkpoint

The [baseline runner](evidence/460/baseline-run.sh) and
[Compose override](evidence/460/baseline-compose.yaml) are archived as actually
used, including this worktree and `/tmp` paths; they are research evidence,
not a new production check. They reuse the checked-in client harness, scripted
models and isolated image/project cleanup. Stage their referenced probe/override
paths, set test ports 19820/19821, and run from the pinned worktree after vetting
the three documented subnets. No host application dependencies are installed.
For the prototype, stage its archived Dockerfile/override/probe in
`/tmp/flux-460-prototype`, reconstruct the two named-context source files by
decoding the archived JSON patch field to UTF-8 and applying it to an
expendable copy of the pinned source, and
check the patch hash before building. Do not apply it to a production checkout.
Local detailed logs are retained; their final hash is in the sanitized results.
Owned containers, volumes, networks, image tags and temporary keys are cleaned
after each attempt. Other Compose projects and build cache are preserved.

Branch: `codex/460-protocol-compatibility`. Source base stays pinned above. This
checkpoint contains only proposed research/evidence, with no application,
Dockerfile, runner or accepted-contract edit. Next action: prepare the public admission/authentication/feature amendment,
obtain independent evaluation of that exact contract, then implement and obtain
fresh independent runtime evaluation of its exact head. No implementation PR is open.

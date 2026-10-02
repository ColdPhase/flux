# O-007 proposal — owner-authorized background comparison

> **Provider scope superseded by [F-020](model-providers.md), 2026-10-02.** The owner's
> connection may now use any supported provider and model ([PROV-1–PROV-6](model-providers.md));
> the rest of this decision stays in force.

**Status:** proposed for independent review, 2026-09-28. **Decision owner:**
`@PelikanFix16`; **evaluator:** `@Zamojski5`. This resolves the compute-source
dependency of [#58](https://github.com/ColdPhase/flux/issues/58), not its
implementation or acceptance. O-005's user-operated Claude Code → Flux MCP path
remains the separate first *external* agent path.

## Situation and decision

A project owner has opted in to one camera/sensor comparison after a negative
low-light result. The owner's laptop and official CLI may be off. The worker must
produce a useful, cited project proposal without using another member's agent,
credential, allowance or unrelated private context. The owner must understand
who pays, what may leave the Flux instance, the maximum work Flux will start and
what happens after a pause or failure.

**Choose an owner-supplied Claude Platform API key, scoped to one provider
workspace, for the first supported background source.** This is a
separate, optional connection from #52's MCP/OAuth client. It uses Anthropic's
Messages API directly from the Flux worker. **The Claude Console organization
that owns the key pays Anthropic; the Flux connection belongs to the signed-in
person who configures it.** These may be different people. The owner must affirm
that they are authorized to spend on that organization/workspace; Flux cannot
infer who pays from a key. Accept an owner-configured, single-workspace personal
or service-account key under that affirmation. Prefer a service-account key for
unattended work; a personal key can stop when its creator leaves the Console
organization, which pauses the rule and requires reconnection without fallback.
Do not accept another member's key, a Claude consumer-plan session, a shared
administrator key, or a silent fallback source.

The rule is unavailable until that owner configures a key, sees the provider and
data-disclosure notice, sets a period budget and a per-run ceiling, and explicitly
enables the named rule. No AI connection is required for the human result/work
conversation. Flux never converts a #52 MCP grant into background-run consent.

| Candidate | Benefit | Reason for this slice |
| --- | --- | --- |
| User-operated official CLI | Provider session stays outside Flux. | It cannot be assumed online for an event-triggered job and gives Flux no supported background invocation or billing authority. Keep it for manual MCP work. |
| Owner-configured Claude Platform key (chosen) | Documented API, bounded output and usage reporting; the owner attests spend authority for the key's organization. | Flux must custody a secret and disclose project excerpts to the provider. An API budget is a Flux dispatch control, not a guarantee of the invoice. |
| Administrator-provisioned shared organization connection or cloud endpoint | Central operations and possibly a provider workspace limit. | A shared pool without owner-selected key/consent needs a separate payer, per-user allocation and delegation contract. |
| Private Ollama/vLLM endpoint | No metered model API bill and can keep input on premises. | Model quality and hardware capacity for this particular cited comparison are untested. A local endpoint still has an operator/payer and compute quota; an unauthenticated endpoint must stay on a private network. Reconsider after an actual comparison and operations test. |

## Contract for the first implementation

1. **Payer and consent.** The authenticated owner alone creates or replaces their
   API-key connection and opts in to the specific project, negative-result event,
   comparison purpose, source types, project-wide proposal audience and spending
   allowance. The owner identifies the key-owning Claude Console organization/
   workspace in the disclosure and attests to spending authority; Flux does not
   label the bill personal or verify an employer's policy.
   Store the rule authorization separately from the committed result event. Show
   the selected model, provider, approximate maximum cost *per request*, local
   period budget, provider-billing caveat and project material that may be sent.
   A peer's action, a shared AI answer or a workspace admin role does not invoke
   this connection. The current owner and agent/project rights are checked again
   when the job starts, before each source read, before provider dispatch and
   before proposal commit. A rule that loses access stops.
2. **Credential custody.** Require a key scoped to one provider workspace;
   recommend a dedicated, expiring service-account key and a provider spend
   limit. Flux can enforce single-workspace scope, not dedication. Encrypt it
   at rest with AEAD bound to the Flux owner and connection IDs as associated
   data, using an instance secret supplied by a
   Docker secret/file outside the database and backups of application data;
   decrypt only in the worker for this owner's dispatch. The UI shows only a
   fingerprint/last four characters. Never put plaintext keys in events, jobs,
   logs, traces, URLs, browser storage or exported project data. The instance
   operator remains a trusted administrator who can access runtime secrets;
   encryption does not protect against that operator. Deleting the connection
   removes Flux's ciphertext and stops new calls; the payer must also revoke a
   leaked key at Claude Platform. Document restoring the secret separately from
   restoring the database or require reconnect after a lost secret. Rotate the
   instance encryption key with an explicit decrypt/re-encrypt procedure.
3. **Bounded request and accounting.** The first run is **one** Messages API
   request on the pinned `claude-sonnet-5` snapshot with at most 8,000
   preflight-counted input tokens, `max_tokens: 1200` (including thinking) and
   pinned low effort. Use a fixed prompt with no provider-hosted web search,
   code execution, MCP connector or automatic tool loop. Execute as the owner's
   person-owned Flux agent, whose project grant is
   capped by the owner's current rights. Admit only currently readable,
   versioned **project-audience** objects from the named project: project
   conversation/material/work/result records and project-scope sketches. Exclude
   private and workspace-scope drafts, private sketches, DMs and other projects,
   even when the owner can read them. The negative triggering result must itself
   be project-visible. Fix the proposal audience to that project's readers;
   the owner cannot widen it. Recheck the source set and audience before dispatch
   and commit. Seed a private draft/sketch with a unique token in the Docker
   acceptance test and assert that neither provider request nor proposal contains
   it. If evidence cannot support a camera/sensor comparison, create an
   insufficient-evidence state instead of invented facts or references.
   Deduplicate by owner/rule/result/source revisions and suppress a dismissed
   suggestion until relevant evidence changes. One in-flight run per owner;
   owner-configurable maximum runs per day and local period budget, with a
   deliberately small default. Atomically reserve the conservative request
   estimate before dispatch, including the capped output. At the documented
   2026-09-28 standard rate ($2/M input, $10/M output), the nominal maximum
   for those token limits is $0.028; reserve at least $0.05 for estimate drift
   and fail closed if the local remaining budget cannot cover it. These prices
   are an input to the implementation, not a permanent product promise.
   Reconcile against the
   response `usage`, preserving unknown/in-flight reservations when the response
   is lost. Treat `stop_reason: "max_tokens"` as insufficient and never publish a
   truncated comparison. No second paid attempt is automatic. Show estimates and
   observed usage separately. Price data is dated/configured and must be reviewed when
   changing the model. The payer should separately set a Claude Platform
   workspace spend limit for the key's workspace. **Flux cannot claim a hard
   invoice cap:** the token-count endpoint estimates input usage, other traffic
   could share a provider workspace, and an interrupted request can still cost
   money. Do not advertise the Flux budget as a provider-enforced billing limit.
4. **Interruption and publication.** A pause, revocation, owner departure,
   exhausted reservation, provider failure or changed source prevents new
   dispatch and proposal commit. Abort an active HTTP request when possible;
   treat cancellation as best effort and keep the reservation/possible charge
   visible. Do not retry 429/5xx/timeout automatically: SDK retry defaults need
   to be disabled for this operation. A late response after revocation is
   discarded, never published. A valid result goes only to the named project's
   quiet proposal surface, with owner-agent attribution, source IDs/revisions,
   factual evidence separated from interpretation and an edit/dismiss/continue
   path. Neither the model nor the rule changes a decision, task, audience or
   shared source. Accept citations only for IDs/revisions in the supplied source
   set; label model-knowledge claims as unsourced interpretation. Only committed,
   human-authored negative results can trigger this rule; agent events and
   proposal-origin events cannot retrigger it. Human continuation works with no
   model connection. O-007 decides this #58 background purpose only; #68 may
   reuse the owner/secret/cap/revocation pattern but needs its own manual-run
   consent and acceptance.

The budget algorithm and provider model are implementation details for #58, but
the above guarantees are review criteria. A pricing change, model retirement,
failed source-citation quality test, or inability to keep ciphertext and
dispatch ownership isolated reopens this decision before enabling the rule.

## Evidence and limits (checked 2026-09-28)

| Evidence class | Source and relevant observation | Implication / limit |
| --- | --- | --- |
| Vendor documentation | [Claude Platform authentication](https://platform.claude.com/docs/en/manage-claude/authentication) describes personal and service-account keys, workspace scope, expiration and revocation; [workspaces](https://platform.claude.com/docs/en/manage-claude/workspaces) describes workspace limits. | The key acts within its Console organization; that organization bears its API charges. Flux requires owner attestation of spend authority and single-workspace scope. Encryption and owner binding are design obligations, not vendor guarantees. |
| Provider credential policy | [Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance), checked 2026-09-28, directs product builders to Console API keys and forbids routing consumer-plan credentials or collecting Claude.ai sessions. It permits customer-managed API keys when usage is billed to the key owner under their provider agreement and not resold or intermediated. | Flux accepts an authorized owner-configured API key only; no subscription forwarding, pooled shared billing, resale or Flux-paid usage. This is a Flux interpretation, not a provider review of this implementation. |
| Provider contract | [Anthropic Commercial Terms](https://www.anthropic.com/legal/commercial-terms), effective 2025-06-17 and checked 2026-09-28: A.1 permits services that power customers' products; D.5 makes the customer responsible for account activity; H.1 assigns fees to that account. | The payer is the key-owning customer/organization. Flux cannot establish the owner's spend authority from the key alone. |
| Vendor API reference | [Messages API](https://platform.claude.com/docs/en/api/messages/create) requires `model` and `max_tokens`; [token counting](https://platform.claude.com/docs/en/build-with-claude/token-counting) says its input count is an estimate. | A single capped-output call is implementable; token preflight alone is not an exact price ceiling. |
| Vendor model/pricing pages | [Current model list](https://platform.claude.com/docs/en/models/overview) lists pinned `claude-sonnet-5`; [pricing](https://platform.claude.com/docs/en/about-claude/pricing) lists standard $2/M input and $10/M output on 2026-09-28. | The nominal $0.028 request example excludes changed prices, token-estimate error and any separate charge; recheck before implementation or model change. |
| Vendor documentation | [Rate/spend limits](https://platform.claude.com/docs/en/api/rate-limits) describes provider organization/workspace spend limits; [API errors](https://platform.claude.com/docs/en/api/errors) says official SDKs retry transient errors twice by default; [usage/cost API](https://platform.claude.com/docs/en/manage-claude/usage-cost-api) requires admin credentials and may report at daily granularity. | Payer configures a provider cap independently. Flux does not ingest an overprivileged admin key or infer real-time per-owner invoices from that report; disable automatic retries. |
| Vendor SDK documentation | [TypeScript SDK](https://platform.claude.com/docs/en/cli-sdks-libraries/sdks/typescript) exposes response usage and stream cancellation. | Actual usage can reconcile a completed request. Aborting a transport is not proof of no provider charge. |
| Existing Flux research | [O-005](first-agent-path.md) and [provider feasibility](own-ai-feasibility.md) distinguish a user's official CLI, API billing and self-hosted endpoints. | The Claude Code subscription/MCP connection cannot fund or execute this background run. |
| Flux observation | This PR inspects the current contracts only. No Flux background provider call, key-custody test, billing observation or low-light comparison has been run. | #58 remains open after this decision review. Its Docker, real-runtime and UI acceptance must be proved in implementation. |

**Reconsider** a local model as the first source if a pinned model on documented
minimum hardware produces useful comparisons with cited supplied project facts,
passes owner isolation and interruption tests, and has an acceptable operator
capacity budget. Reconsider the provider key path if actual billing/cancellation
behavior defeats the consent and budget presentation.

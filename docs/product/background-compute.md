# Current labels in private usage history (#58)

Recorded 2026-09-30 before the additive interface change. Each recent owner usage
row may include current project and triggering-result titles, only after a current
central project-read decision. Missing, denied or misbound context is explicit
null; older-server payloads may omit it. Titles lead the history row so people
can recognize its trigger. They are current labels, not historical snapshots.
Retained accounting, IDs, amounts and uncertainty survive access loss and key
replacement/disconnection; that history does not grant access to project names.
Successful refresh replaces the complete projection, including redaction. Failed
refresh retains the last fetched snapshot with its existing stale-data message.
No prompt/output/body/provider ID is added, and no new compute or migration occurs.

## O-007 — owner-authorized background comparison

> **Provider scope superseded by [F-020](model-providers.md), 2026-10-02.** The owner's
> connection may now use any supported provider and model ([PROV-1–PROV-6](model-providers.md));
> the rest of this decision stays in force, except that the input bound is now the
> provider-neutral Flux estimate ([PROV-3](model-providers.md#prov-3--cost-caps-and-token-bounds)).

**Status:** accepted after [independent review of `2a2fa82`](https://github.com/ColdPhase/flux/pull/108#pullrequestreview-5332961366), merged as [`841ddc97`](https://github.com/ColdPhase/flux/pull/108) on 2026-09-28. **Decision owner:**
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
   human-authored negative results start this rule. A committed human change to
   admitted project evidence may reconsider an existing qualifying negative
   result only with a changed source fingerprint, under its still-enabled rule;
   unchanged, agent and proposal-origin events cannot retrigger it. Human continuation works with no
   model connection. O-007 decides this #58 background purpose only; #68 may
   reuse the owner/secret/cap/revocation pattern but needs its own manual-run
   consent and acceptance.

The budget algorithm and provider model are implementation details for #58, but
the above guarantees are review criteria. A pricing change, model retirement,
failed source-citation quality test, or inability to keep ciphertext and
dispatch ownership isolated reopens this decision before enabling the rule.

### Source and outcome amendment (accepted 2026-09-29)

The owner/evaluator agreed the [source/reopening proposal](https://github.com/ColdPhase/flux/issues/58#issuecomment-5899774832)
and its [independent amendments](https://github.com/ColdPhase/flux/issues/58#issuecomment-5899835828).
This records the required final behavior; it does not assert that all of it is implemented.

- Keep the triggering human negative result and every valid admitted explicit
  reference. Add a deterministic bounded selection of current project-published
  material/doc versions, human messages, work, results and project-scope thoughts.
  Leave agent-authored content out of evidence, including earlier proposal output.
  Exclude placements, private/workspace drafts, DMs and other projects. Select only
  after checking current owner access through the existing policy, and recheck
  owner/agent access before dispatch and commit. Record selection limits and
  excerpt markers; more than 8,000 counted input tokens stops without a paid request.
- The evaluator [accepted historical explicit material/doc revisions](https://github.com/ColdPhase/flux/issues/58#issuecomment-5904230435)
  on 2026-09-30: an immutable published human-authored version explicitly cited
  by the triggering result stays pinned beside separately selected current
  versions. Validate its existence, project boundary, published state and human
  author at every recheck; never relabel it as the current revision. Both enter
  the fingerprint and actual inspected/cited metadata. A newer current edit
  during read/count/dispatch still invalidates the candidate. If the material
  is later unpublished or deleted, refuse at zero cost before paid dispatch;
  never silently drop the cited version. This exception is for immutable
  material/doc versions; work and thought sources still require current versions.
- Fingerprint the sorted selected type/id/version vector, explicit-reference set,
  rule id/version and owner id. Recheck the selected sources before dispatch and
  commit; preserve historical proposals, dismissals and possible charges. A
  rule change never reuses an earlier dismissal. Thoughts need their actual
  revision and sketch navigation identity; the existing contract has independent
  thought versions. The evaluator [accepted the correction](https://github.com/ColdPhase/flux/issues/58#issuecomment-5900083579):
  cite thought id/version plus sketch id, and recheck project scope, no placement,
  human authorship and that version before dispatch and commit.
- Only committed human project-source changes, including an owner's edit, can
  reconsider a qualifying negative result. Coalesce edit bursts in a short
  window. Deduplicate result/rule/snapshot; an unchanged or dismissed fingerprint
  stays suppressed. Keep one in-flight run and count possible charges toward
  daily and rolling-period limits; never retry an unknown charge automatically.
- Insufficient evidence has its own quiet reason and inspected references,
  separate from a comparison's fact/interpretation/action. It sends no push or
  email and creates no work. Missing, capped or truncated evidence/output cannot
  fabricate a comparison or start a second paid attempt. When a paid request was
  made, retain its observed usage or possible charge and count it toward caps.
  Without a request, record `not run: <reason>` and zero usage. Manual work remains
  available regardless of the rule or provider.

Production activation is off by default. **Operator switch (proposed 2026-10-03 in #212,
pending peer acceptance on #58):** the worker runtime and rule enabling exist only when the
instance operator sets `FLUX_BACKGROUND_COMPARISONS=on` for both the API and the worker. It is
empty by default, the release `docker/compose.yaml` does not pass it, and an operator must not
switch it on before the real-provider verification gates below pass.
Source selection, source-change scheduling and outcome/accounting changes are
separate verifiable implementation portions of this amendment.

### Outcome audience and migration amendment (accepted 2026-09-30)

The evaluator [accepted the outcome split](https://github.com/ColdPhase/flux/issues/58#issuecomment-5900710170)
before the new schema/API implementation:

- Save the full inspected type/id/version/navigation vector separately from the
  model's cited subset. Project readers may see an independently authorized quiet
  `insufficient_evidence` item with its reason and inspected references, no
  fact/action/work and no push/email.
- Credential, budget and access refusals, plus unknown-charge details, are
  owner-only. Project readers do not gain another person's payer/provider
  metadata, spending limits or failed authorization context. A pre-paid
  `not_run` records a stable reason and zero usage; observed/possible charges
  after a paid attempt still count toward caps.
- Add an explicitly typed outcome surface alongside the compatible proposal
  shape. Do not invent comparison fields to encode a failure.
- Unmerged migration numbers follow merge order. A later merger renumbers its
  new migration to the next free version after current main, with relevant
  checks/review repeated; a missing contiguous baseline must not be bypassed.
  Existing comparison SQL is unchanged by this amendment. After protected main
  PR #131 took `0021`; the first integration renumbered the five then-unmerged
  #58 files as `0022`–`0026` (2026-09-30). Main later reached `0025` at
  `973f35cf00e624efecf5763e111e7511481bac44`; the seven current unmerged #58
  files now follow it as `0026`–`0032`. Only their file numbers and ledger
  insertions change; main's applied SQL 1–25 stays byte-identical.

This is an accepted implementation contract, not evidence of implemented outcomes
or production activation.

### Outcome wire and owner-accounting amendment (accepted 2026-09-30)

The [concrete interface proposal](https://github.com/ColdPhase/flux/issues/58#issuecomment-5901303362)
was [accepted with paging and per-reader authorization amendments](https://github.com/ColdPhase/flux/issues/58#issuecomment-5901313083)
before its schema/API implementation:

- `GET /api/v1/projects/:projectId/proactive-comparison-outcomes` requires current
  project read access and returns newest-first `items`, `total`, `limit` (at most
  100) and `offset`. Clients load all pages. Each item is either
  `kind: comparison` with the existing proposal DTO and separately stored
  `inspectedSources`, or `kind: insufficient_evidence` with id, project/result,
  owner/agent attribution, safe reason, inspected references, open/dismissed
  status, version and timestamps. Insufficient items have no fact, action, work,
  payer, provider, cost or authorization-failure fields. Existing proposal routes
  remain compatible; dismissing an insufficient item requires project write
  access and the expected version.
- Store the actual inspected metadata vector on the candidate before provider
  dispatch, after locked access/source checks. A separate insufficient-outcome
  table has unique candidate provenance. References carry type/id/version,
  trusted title, conversation/sketch navigation and excerpt markers, without
  source bodies. On every outcome read, apply current source access for that
  reader: omit references they cannot open and expose only their count. Legacy
  rows retain `null`; their cited subset cannot stand in for inspected evidence.
- Provider structured output is one root object containing a closed nested
  `anyOf` of comparison and insufficient-evidence branches. Runtime validation
  enforces lengths, exact source identities/revisions and usage ceilings.
  [Vendor documentation](https://platform.claude.com/docs/en/build-with-claude/structured-outputs),
  checked 2026-09-30, documents nested `anyOf` and closed objects; string-length
  and numeric bounds remain runtime checks. This is documented compatibility,
  not an observed provider result. A real-provider check remains a release gate.
- A model-declared insufficient response or truncated/refused/invalid comparison
  with valid observed usage may commit only after final current owner, rule,
  agent and source checks. Validation failures use fixed safe reason text,
  without raw provider output. Stopped, revoked or inaccessible candidates do
  not publish. Paid usage still counts; delivery stays quiet with no work,
  notifications or automatic paid retry.
- `GET /api/v1/background-compute-usage` is owner-only. It separates UTC-day
  started requests, rolling-30-day conservative counted amount, token-derived
  observed estimate, unknown possible amount and in-flight amount. It includes
  current connection limits or null and at most 50 own candidate summaries
  (project/result/rule ids, status, stable reason, timestamps and reserved/observed
  usage). Return no key, ciphertext, another owner's rows or current titles and
  evidence after access loss. These are local accounting amounts, not invoices.
- Terminal pre-paid failures persist private `not_run` with a stable reason and
  zero usage/reservation. Busy-owner queuing remains non-terminal. Terminal
  credential/access/scope/budget refusals do not retry; unknown post-start charges
  remain counted across connection and rule renewal. New migration numbering
  follows actual merge order.

### Rule renewal amendment (accepted 2026-09-30)

The evaluator [accepted fresh authorization after revocation](https://github.com/ColdPhase/flux/issues/58#issuecomment-5900813869).
Keep a revoked row as terminal history; it is never re-enabled. Permit at most one
non-revoked rule per owner/project/purpose using a partial unique index in a new
migration, without rewriting the initial rule SQL (`0026` after current main
integration; earlier unmerged numbers were `0021` and `0022`). A fresh rule starts paused and repeats
current personal-agent/project checks and scope/allowance confirmation. Historical
dismissals and all owner-level observed/possible charges remain counted across
rule identities. Verify revoke → fresh create with unchanged old row, and
concurrent fresh creation with one success and one conflict.

### Source-change scheduling interface (accepted 2026-09-30)

The [concrete scheduling proposal](https://github.com/ColdPhase/flux/issues/58#issuecomment-5903579901)
was [accepted with quiet-window, cursor-recovery and draft exclusions](https://github.com/ColdPhase/flux/issues/58#issuecomment-5903584942)
before implementation. Consume committed events through an independent durable
cursor. Advance that cursor in the same transaction as project reconsideration
rows. Only human changes to admitted project evidence qualify; private/DM,
agent/proposal, placement/layout and unpublished doc draft changes do not.

Coalesce changes for **2 minutes after the last qualifying change**, with a
**maximum wait of 15 minutes after the first change**. Keep both durations as
named constants in one place. A candidate's `available_after` and the project's
quiet window govern dispatch readiness. Reconsider each currently enabled rule
and qualifying human negative result using current owner/agent rights and the
accepted deterministic fingerprint, paging through records. Only a new unique
rule/result/fingerprint creates a candidate. Obsolete queued candidates end at
zero cost; paid and unknown candidates, prior dismissals and charges remain
history and are never retried automatically.

If a cursor falls behind the retained event range, or ahead of a rebuilt log,
reconsider every project with an enabled rule once and report the recovery.
Cursor, due-project rows and candidate due time use one new migration numbered
by actual merge order. Portable internal scheduling ports have focused DB and
worker composition. Production enabling and provider registration stay off by default (the
operator switch above) and must not be switched on until their separate real-provider
verification gates pass. This section records
the accepted contract, not completed scheduling or production evidence.

### Interrupted reservation recovery (accepted 2026-09-30)

The evaluator [accepted the crash-reconciliation interface](https://github.com/ColdPhase/flux/issues/58#issuecomment-5904715405)
before implementation. A controlled worker sweep locks reserved candidates after
20 minutes without an update, skipping rows locked by active preparation and
rechecking state/time under the lock. No stored dispatch intent ends as owner-only
`not_run` with `WORKER_INTERRUPTED_BEFORE_DISPATCH` and zero usage/reservation.
A stored intent ends as `unknown` with
`WORKER_INTERRUPTED_AFTER_DISPATCH_INTENT`, retaining reservation and any observed
usage. An intent is not proof of an actual invoice or adapter entry. A late
process cannot publish or release that terminal uncertainty. Page past 100,
serialize concurrent sweepers, never retry the provider or unchanged fingerprint,
and create no project output or notification. Use existing candidate fields;
production activation and real-provider acceptance remain separate gates.

Owner accounting labels the persisted intent as a counted attempt, not proof that
the provider received or charged a request. Explain that interrupted attempts
can remain uncertain. In completed legacy history without observed usage, call
the amount an earlier reservation and state that usage was not recorded; it is
not an active reservation or an invoice. Interrupted recovery reasons remain
owner-private and use fixed, safe explanations.

Each history entry has a stable local Flux request reference and a generic link
to its triggering result. Opening the existing project/result route checks current
access; the history does not preload or retain source bodies or project/result
titles after access loss. Local references distinguish records and are not provider
invoice identifiers. This uses the already accepted candidate/project/result IDs
and existing authorized result navigation, with no new API fields.

## Private owner setup (partial implementation)

Open the account menu → **Your background suggestions**. Saving the connection
requires a provider and model of the owner's choice (F-020: no provider is
preselected; an OpenAI-compatible endpoint also needs its base URL, and a model
without a listed or table price takes an owner price, without which no rule can be
enabled), a fresh key, named
provider organization/workspace, daily and rolling 30-day local allowances, and
four explicit confirmations. Only the authenticated
owner can read its safe metadata, replace it or disconnect. The password input
is cleared after successful or failed requests and removed when a saved connection
is shown; replacement never retrieves the earlier key. A failed replacement
preserves that earlier connection. Disconnecting removes Flux's ciphertext; the
payer must revoke the provider key separately when appropriate.

Select an accessible project and your own personal agent. A project manager can
explicitly grant that agent contributor access; creating the agent or grant does
not authorize paid computation. Confirm the project scope, quiet effect and
allowance to create a **paused** rule. Pause/revoke remain versioned; a revoked
rule is terminal history. Fresh authorization creates another paused rule under
the partial uniqueness constraint, while owner usage across old and new rules
continues counting toward caps.

This checkpoint deliberately reports the actual runtime state: background
execution and enabling remain unavailable. These controls do not prove provider
quality, scheduling, real billing, complete owner usage/outcome presentation, or
whole-task acceptance. People can continue ordinary work without a connection.

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
| Flux observation | The accepted decision PR inspected contracts only. No Flux background provider call, key-custody test, billing observation or low-light comparison had been run at acceptance. | #58 remains open after this decision review. Its Docker, real-runtime and UI acceptance must be proved in implementation. |

**Reconsider** a local model as the first source if a pinned model on documented
minimum hardware produces useful comparisons with cited supplied project facts,
passes owner isolation and interruption tests, and has an acceptable operator
capacity budget. Reconsider the provider key path if actual billing/cancellation
behavior defeats the consent and budget presentation.
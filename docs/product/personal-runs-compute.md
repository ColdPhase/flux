# O-008 — compute for owner-invoked personal assistant runs

> **Provider scope superseded by [F-020](model-providers.md), 2026-10-02.** The owner's
> connection may now use any supported provider and model ([PROV-1–PROV-6](model-providers.md));
> the rest of this decision stays in force, except that the input bound is now the
> provider-neutral Flux estimate ([PROV-3](model-providers.md#prov-3--cost-caps-and-token-bounds)).

**Status:** accepted, 2026-09-28, by independent
[review](https://github.com/ColdPhase/flux/pull/125#pullrequestreview-5334126978)
at `44eb0d9`; merged in PR #125 as `4563b29`. **Decision owner:**
`@Zamojski5` (`claude-maurycy`); **evaluator:** `@PelikanFix16` (`codex-hubert`).
This resolves the blocking compute-source dependency of
[#68](https://github.com/ColdPhase/flux/issues/68). It does not implement or
accept #68. It builds on [#57](https://github.com/ColdPhase/flux/issues/57), the
[interaction design](../design/personal-ai/README.md) (PR #64), [O-005](first-agent-path.md)
and the accepted [O-007](background-compute.md).

## Situation and decision

Jo is in a project conversation with Kai. She types `/ai summarize this thread`
or picks *Ask my assistant* on a map thought. Her laptop CLI may not be running.
Flux must answer in place, with her assistant, at her payer's expense. It must
never use Kai's connection, and it must never send her DMs, private captures or
other projects to the provider. O-005 does not cover this: it accepts only a
user-operated Claude Code client, and it requires a separately accepted compute
owner, secret handling, payer consent, budget and runtime contract for an
in-product run.

**Choose the same owner-configured, single-workspace Claude Platform API key
connection that O-007 accepted, with a separate personal-run enablement, consent
and caps.** The Flux connection belongs to the signed-in person who configured it.
The Claude Console organization that owns the key pays Anthropic. The owner
attests to spending authority on that organization and workspace, as O-007
requires. Flux runs the request from its worker through the Messages API.

One key serves both uses, but neither use enables the other:

- Configuring a key for #58 background comparison does not enable `/ai`.
  Enabling personal runs does not enable a background rule.
- Each use has its own consent record (disclosure version, time, owner), its
  own daily cap and per-run ceiling, and its own pause. Budgets are not pooled.
  Details shows both uses' spend next to each other.
- Disconnecting or replacing the key stops both uses. Pausing one use leaves the
  other as it is.
- O-007's model pin, per-request limits, source set, proposal audience and
  "one in-flight run per owner" rule stay unchanged for #58. This decision adds
  a second use of that connection. It does not widen O-007. Personal-run caps
  are stored separately from the #58 rule's fields in #124's
  `background_compute_connections` draft; they are never taken from those fields.

Without a personal-run enablement, ✦ shows *Connect your AI*. It offers both the
O-005 Claude Code path and this key path. Human work never needs either.

| Candidate | Benefit | Reason |
| --- | --- | --- |
| O-007 owner connection with separate personal-run enablement (chosen) | One accepted secret-custody, payer-attestation and revocation pattern. Documented API, capped output and usage reporting. | Flux holds a secret and sends excerpts from the requested place to the provider. The Flux cap is a dispatch control, not an invoice guarantee (O-007). |
| O-005 only (user-operated Claude Code through MCP) | Flux holds no provider secret. The user's own plan pays. | It cannot answer an in-product `/ai`, button or retry when the CLI is not running. Flux cannot start the user's terminal (#57 §5). It stays the external path, not the in-product assistant. |
| Workspace-shared or administrator key | Central billing and operations. | It violates #57 §2: an assistant and its payer are personal. It would need a payer, per-person allocation and delegation contract that nobody has decided. It invites fallback to another payer. |
| Consumer-plan session (Claude.ai/Pro/Max login held by Flux) | No separate API bill for the user. | Provider policy forbids routing consumer-plan credentials or collecting Claude.ai sessions in a third-party product (O-007 evidence; [feasibility](own-ai-feasibility.md) B). Rejected, not deferred. A Flux-held session stays rejected. [F-022](ai-modes.md) (proposed, revised 2026-10-05) adds the owner's plan only through the unmodified official CLI in the owner's runtime, which keeps the login. |
| Local model (Ollama/vLLM) now | No metered bill, and data can stay on premises. | Answer quality and capacity on documented hardware are untested. An unauthenticated endpoint must stay on a private network, and an operator still pays for capacity. Deferred: a later adapter behind the same runtime port, connection owner and caps, after its own decision. |

## Contract for #68

1. **Compute owner and payer consent.** Only the authenticated owner creates,
   enables, pauses or deletes their personal-run enablement. Enabling requires
   the O-007 connection (key, payer organization and workspace, spend-authority
   attestation) plus a personal-run consent with version `o-008-2026-09-28`.
   That consent names the provider, model, payer organization and workspace, the
   data that may leave Flux (below), the per-run ceiling, the daily cap and the
   billing caveat. A workspace admin role, project membership, a mention, a
   reply or a shared answer grants no right to invoke, retry, continue, pause or
   pay. An admin can revoke a member's access by policy. That stops the runs;
   it never lets the admin use the connection.
2. **Secret custody** is exactly O-007 §2. The key is encrypted at rest with AEAD,
   using an instance key from a Docker secret or file outside the database. The
   owner and connection IDs are the associated data. The database stores only a
   key reference: the connection ID plus ciphertext, fingerprint and last four
   characters. Only the worker decrypts it, for this owner's dispatch. The key is
   never returned to a client, not even to its owner. It never appears in logs,
   traces, events, job payloads, URLs, browser storage, exports or error bodies.
   A test seeds a known key and asserts that it is absent from API responses,
   stream frames, job rows and captured logs.
3. **Caps and stopping.** Each run is **one** Messages API request on the
   connection's pinned model (`claude-sonnet-5`, as for O-007). It allows at most
   16,000 preflight-counted input tokens and `max_tokens: 1500` (thinking
   included), at low effort. It uses no provider-hosted web search, code
   execution, MCP connector or automatic tool loop. At O-007's documented
   2026-09-28 rate ($2/M input, $10/M output), the nominal maximum is $0.047.
   The **default per-run reservation is $0.06**, and the owner may set it from
   $0.06 to $0.50. The **default daily cap is $1.00** (owner-set, $0.10–$10.00,
   resetting at 00:00 in the owner's time zone), with one personal run in
   flight per owner. #58 background runs keep their own O-007 limit.
   - Before dispatch, the run atomically reserves its ceiling against the daily
     cap. If the cap cannot cover it, the run fails closed as `cap_reached`. It
     then reconciles against the response `usage`. A lost response keeps its
     reservation as `unknown`, and so does a response whose usage exceeds the
     run's token limits or whose cost exceeds its reservation (F-020 PROV-3):
     the charge never exceeds the reservation and that answer is not posted.
   - A run stops before its next read, dispatch or commit when the owner pauses,
     disconnects or loses access, when the agent grant is revoked, or when the
     cap is reached. A stop before dispatch costs zero and releases the
     reservation.
   - `stop_reason: "max_tokens"` is shown as a truncated answer that the owner
     can continue. It is never committed as a done action or proposal.
   - There is never a payer fallback. With no enablement, a paused or capped
     one, or a failing provider, the user sees that state and human work goes on.
4. **Runtime contract.**
   - **Where:** the `apps/worker` process runs a pg-boss job behind the
     `agent-runtime` port, with an Anthropic adapter in infrastructure. The
     server never calls the provider. The browser never sees the key or talks
     to the provider.
   - **Invoke:** `POST /api/v1/conversations/:conversationId/assistant-runs` with
     `{ clientRunId, kind: "ask" | "summarize" | "map_thought", prompt, target?,
     continuesRunId? }`. The WebSocket command on the existing stream,
     `{ type: "assistant.run", ... }`, is a thin adapter over the same use case.
     Both resolve the connection **only from the authenticated session**. An
     `ownerId`, `connectionId` or `agentId` in the body never selects the
     connection. If it names anything other than the caller's own, the request
     gets 403 with no reservation or model call. The use case checks `agent.invoke` in `policy.ts`, writes
     the run row, reservation and job in one transaction, and returns `202` with
     `runId`. A peer's attempt returns 404 or 403 before any reservation.
   - **Stop:** `POST /api/v1/assistant-runs/:runId/stop`, or the
     `{ type: "assistant.stop", runId }` command. Only the run's owner can stop
     it; any other caller gets 404. Before dispatch, the stop is certain and
     free. During dispatch, Flux aborts the HTTP request as best effort and keeps
     the reservation until the charge is known. After a stop, no output is ever
     committed.
   - **Retries:** the SDK's automatic retries are off. Reusing the same
     `clientRunId` returns the existing run and never charges twice. **Retry**
     and **Continue** are owner-only, new runs with a new `clientRunId`, and each
     is charged and capped on its own. Continue passes the earlier committed
     answer as input. A 429, 5xx or timeout ends the run as `provider_failed`;
     Flux does not retry it automatically.
   - **Progress:** the working line goes only to the owner. The committed answer
     is delivered to the place's audience through the normal stream event.
5. **Data boundary.** The sources are the intersection of the owner's current
   rights, the agent grant and the requested place, and they are restricted to
   **project-audience objects in that one project**: project conversation
   messages, materials and docs, work, results and project-scope sketches. The
   first slice supports project places only. A run never reads DMs, private
   captures, private or workspace-scope drafts and sketches, or other projects,
   even when the owner can open them. DM-place runs need their own decision,
   because the other participant's words would go to Jo's provider. The source
   set and audience are checked again before dispatch and before commit.
   Output goes only to the requested place's audience:
   - an attributed answer message ("Jo's assistant · asked by Jo");
   - a done action through the same domain use case as a human action, with
     actor/on-behalf-of attribution and undo;
   - or a #52 proposal object for anything consequential.
   Citations are accepted only for supplied source IDs and revisions. The
   acceptance test seeds unique DM and private-capture tokens and asserts that
   neither the provider request nor the output contains them.
6. **Provider disclosure.** The consent screen and the ask-mode line say which
   provider is used, who pays and the expected cost, and who will see the answer.
   The consent screen also states that excerpts from the requested project place
   are sent to Anthropic under the payer's agreement. The answer's provenance
   names the provider and model for its audience, because their project messages
   may be part of the input. It never shows the cost, the key, the payer's
   budget or hidden sources to anyone but the owner. An instance operator can
   turn this provider off for the whole instance. Runs then fail closed with an
   explicit unavailable state.

## Implementation notes (#68 first slice)

The [personal runs](../development/personal-runs.md) contract records how this
decision is implemented. It keeps the scope above. It resolves three details:

- **Enablement scope.** One enablement per person carries the consent, caps,
  pause and connection. The person picks their assistant agent once per
  workspace. The daily cap and the one-in-flight rule apply across workspaces,
  because one payer pays for all of them.
- **Proposal object.** #52's `agent_proposals` accepts only the user-operated
  Claude Code source, requires a pinned material version as its only source, and
  has no accept. Consequential output is therefore an assistant proposal with
  the same fact / interpretation / proposal shape. It adds an accept path that
  records the result through the #101 work use case as the accepting person.
- **Slice 2 (2026-09-30).** The UI, owner-only progress events
  (`assistant_run.changed.v1`, whose only reader is the run's owner) and the Anthropic
  adapter in `@flux/agent-runtime` (official SDK 0.129.0, retries off, abort, token
  counting) are implemented. The adapter is tested only against a local mock server. The
  WebSocket commands are not: the stream has no client command channel yet, so the UI
  uses the HTTP API, which this decision allows ("a thin adapter over the same use case").
- **Still to do.** #124's custody, the real connection lookup and key resolver, and a
  provider pass. Until they land, production fails closed as `unavailable`.

**Price/model recheck, 2026-09-30.** Observed on the Anthropic
[pricing page](https://platform.claude.com/docs/en/about-claude/pricing): Claude Sonnet 5
at $2/M input and $10/M output, not marked retired; a footnote says the introductory
price is now standard and the planned rise to $3/$15 will not occur (vendor claim). The
nominal maximum stays $0.047. Inference: a workspace that sets US-only inference
(`inference_geo: "us"`, 1.1× on the same page) would raise it to about $0.052, still under
the $0.06 default reservation; Flux does not set it.

## Evidence (2026-09-28)

| Class | Source / observation | Implication |
| --- | --- | --- |
| Accepted Flux decision | O-007, [approved at `2a2fa82`](https://github.com/ColdPhase/flux/pull/108#pullrequestreview-5332961366) and merged as `841ddc97`. Its provider evidence (authentication, commercial terms, Messages API, token counting, pricing, rate/spend limits, SDK retries and cancellation) was checked on 2026-09-28. | Reused as is. No new vendor pages were fetched for this proposal. Prices and the model pin must be checked again before #68 enables dispatch. |
| Founder requirement | #57 §2–§3, and #68 AC-1 to AC-8. | Personal ownership, session-bound invocation, no fallback, and the three separate concepts. |
| Flux code observation (`main` at `f18c0cb`) | `agent_connections` (MCP) allows only `user_operated_claude_code` proposals. The `AgentRuntime` port exists without an adapter. The stream ignores client messages today. #124 (draft) adds `background_compute_connections`. | #68 adds the run use case, the WebSocket command handling and the personal-run enablement, and reuses #124's custody once it merges. |
| Not observed | No personal run, provider call, billing, cancellation charge or key-custody test has run in Flux. | #68 acceptance must prove these in Docker with two users. Stub providers do not count as a provider pass. |

## Reject or reopen when

- a provider price change, a model retirement or a terms change invalidates
  the ceiling, the payer model or permitted key use;
- actual billing on cancellation or lost responses makes the cap presentation
  misleading;
- #68's isolation, secret-absence or two-user denial tests cannot pass with the
  shared connection. In that case, split the connection per use;
- reviewers find that sharing one key between #58 and #68 changes O-007's
  consent in practice;
- a local-model adapter passes quality, isolation and capacity tests (add it as
  a provider), or DM-place runs are requested (they need a new decision).

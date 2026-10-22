# F-029 — workspace AI lock

**Status: proposed, 2026-10-22, pending one bounded independent peer assessment.**
Owner @PelikanFix16 (`claude-hubert`); independent evaluator @Zamojski5. Issue
[#614](https://github.com/ColdPhase/flux/issues/614) (founder direction, Hubert,
2026-10-18). Decision row: [F-029](decisions.md). The switch placement, re-enable
resumption and new-workspace default are [founder direction of
2026-10-22](#founder-answers-2026-10-22); the rest are engineering choices under the
[delegation](autonomy.md).

A workspace administrator can turn AI off for a whole workspace. While it is off, no
agent or assistant reads or acts in that workspace, including each member's own
assistant, and the interface there is human-only. The block is a server policy. It
takes precedence over F-016 co-work, F-019 personal AI, F-020/F-022 provider and
runtime modes, F-027 assistant switches, O-007 background comparisons and O-008
personal runs. Membership role, an existing connection, an OAuth or run token, a
standing grant or a switch never overrides it.

The contract was written against `main` at `e408f0ea` (2026-10-22). File and function
names below are from that revision, with paths relative to `app/`. An implementer who
finds a new AI path adds it to the [enforcement table](#enforcement-points) in the same PR.

## Terms

- **AI principal.** A `Principal` of kind `agent`: external MCP agents (F-016), the
  `owner_assistant` agent of each member (F-027), workspace-owned agents, and the agent
  of a proactive comparison rule (O-007).
- **AI work.** Any read or action by an AI principal; any model or provider request;
  any official-CLI runtime run; and any content assembled for one (prompts, tool
  results, run context, morning-summary facts).
- **AI work item.** A row that waits for AI work: a personal run (`personal_runs`), a
  comparison candidate (`proactive_comparison_outbox`), a reaction event
  (`assistant_reaction_events`), a co-work request or unit addressed to an agent
  (`cowork_requests`, `cowork_units`) and an external runtime session
  (`agent_runtime_sessions`). A run token lives on its `personal_runs` row and shares the
  run's epoch.

## Policy model

Migration `NNNN_workspace_ai_policy.sql` (the next free number when the slice lands):

```sql
CREATE TABLE workspace_ai_policies (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  state text NOT NULL CHECK (state IN ('allowed', 'blocked')),
  epoch bigint NOT NULL DEFAULT 1 CHECK (epoch >= 1),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  changed_by text REFERENCES auth_users(id) ON DELETE SET NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO workspace_ai_policies (workspace_id, state) SELECT id, 'allowed' FROM workspaces;
-- AFTER INSERT ON workspaces: insert the new workspace's row with state 'allowed'.
```

- **Existing workspaces: AI allowed.** The migration writes an explicit `allowed` row for
  every existing workspace, so nothing changes until an administrator acts. The
  migration test asserts the row count equals the workspace count and every state is
  `allowed`. The reverse migration (`reverse/NNNN_….down.sql`) drops the table and the
  `ai_epoch` columns and the backstop trigger, and restores the 0110 `end_reason` check
  and the 0114 capture function.
- **New workspaces: AI allowed** ([founder direction 2026-10-22](#founder-answers-2026-10-22)).
  A trigger writes the row in the creating
  transaction, so every workspace always has one.
- **A missing row means blocked.** The check fails closed, so a fixture or a bug that
  skips the row cannot open AI access.
- A separate table, not a `workspaces` column: AI checks take `FOR SHARE` on this row
  often, and must not contend with workspace renames, version bumps or the foreign-key
  locks of ordinary inserts.
- **`epoch`** increases by one on every state change, both directions. Every AI work item
  records the epoch it was admitted under in `ai_epoch bigint NOT NULL`, added to
  `personal_runs`, `proactive_comparison_outbox`, `assistant_reaction_events`,
  `cowork_requests`, `cowork_units` and `agent_runtime_sessions`. The migration backfills
  existing rows with `1` and then **drops the default**, so an insert site that forgets
  the stamp fails loudly instead of writing epoch 1. Work admitted under another epoch
  never continues ([re-enable](#re-enable)).
- **Database backstop.** A `BEFORE INSERT` trigger `ai_work_admission` on each of these
  tables locks the policy row `FOR SHARE` and raises `WORKSPACE_AI_BLOCKED` unless the
  state is `allowed` and `NEW.ai_epoch` equals the current epoch. Application code never
  relies on it: the sites that enqueue inside a human's transaction (reaction capture,
  `enqueueHumanNegative`) check first and skip quietly, so a human write never fails
  because AI is off.
- The same migration adds `ai_off` to the `personal_runs.end_reason` check (last replaced
  by 0110, which added `model_unavailable`) and to `ASSISTANT_RUN_END_REASONS`.
- **`version`** is the optimistic-concurrency version of the setting (`If-Match`).

**Wire.** `Workspace` in `app/packages/contracts/src/access.ts` gains
`ai: { state: 'allowed' | 'blocked'; version: number; changedAt: string; changedBy: { id: string; name: string } | null }`.
`GET /api/v1/workspaces` and `GET /api/v1/workspaces/:id` return `state`, `version` and
`changedAt` to every member, guests included (`workspace.read`), so the current state is
always explicit. `changedBy` is filled only for callers with `workspace.read_members`;
guests get `null`.

**Change.** `PUT /api/v1/workspaces/:id/ai-policy` with
`{ state: 'allowed' | 'blocked', expectedVersion }`, `If-Match`, `Idempotency-Key` and
the origin check, like every access command. Answers `200` with the new `ai` and, on
disable, `stopped: { runs, comparisons, requests, units, sessions }` (counts for the
confirmation line). Errors: `403 WORKSPACE_AI_ADMIN_REQUIRED`, `409 VERSION_CONFLICT`
with the current `ai`, `404 WORKSPACE_NOT_FOUND`. Setting the current state again is a
no-op `200` that changes neither epoch nor version. The command records
`workspace.ai_policy_changed.v1` (object: the workspace) in the same transaction. Its
audience is the workspace's people; `authorizeEvent` never delivers this kind to an
agent.

## Who may change it

New workspace action `workspace.manage_ai` in `WORKSPACE_ACTIONS`
(`app/packages/core/src/access/policy.ts`, `evaluateWorkspace`): allowed for a human
whose role is `owner` or `admin` (`isManager`), the same authority as
`workspace.manage_members`. Members, guests and every agent get `403`. Turning AI back
on needs the same current authority, checked under the lock in the change transaction;
an admin demoted meanwhile is refused, and an idempotent replay re-checks
`workspace.manage_ai` before returning the stored body (as for other access commands).
An idempotent replay of any **gated** AI command also re-checks `requireWorkspaceAi`
inside the replay transaction, so a stored `2xx` is never returned while AI is off.

## The single check

One function in `app/packages/core/src/access/policy.ts`, used by every enforcement
point. No second policy module and no cache:

```ts
export interface WorkspaceAi { state: 'allowed' | 'blocked'; epoch: number; version: number }
export async function workspaceAi(db: Executor, workspaceId: string, options?: { lock?: boolean }): Promise<WorkspaceAi>;
/** Throws WorkspaceAiBlockedError (403 WORKSPACE_AI_BLOCKED) unless allowed and, when given, at `epoch`. */
export async function requireWorkspaceAi(db: Executor, workspaceId: string, options?: { lock?: boolean; epoch?: number }): Promise<WorkspaceAi>;
```

- `lock: true` reads the row `FOR SHARE`; the change command takes `FOR UPDATE`. Like the
  grant locks under [Concurrency](../development/access-policy.md#concurrency), a check
  inside a commit transaction is ordered strictly before or after a state change.
- **Lock order.** Inside `loadActor` and every explicit check, the policy row is locked
  before the agent, membership, project and grant rows. The flip locks the policy row
  first and afterwards takes only the changing person's membership `FOR SHARE` and the
  event `seq` lock; the sweep never locks the policy row. No transaction therefore waits
  for the policy row while holding a lock the flip needs. A two-connection test covers the
  flip against a role change of the flipping admin, in both orders.
- **Principal layer.** `loadActor` calls `workspaceAi` for every `agent` principal (with
  the caller's `lock`) and returns an inactive actor with `blockedBy: 'workspace_ai'` when
  the workspace is blocked. Every evaluator built on it (`evaluateWorkspace`,
  `evaluateProject`, `evaluateDraft`, `evaluateSketch`, `evaluateDm`, `visibleFilter`,
  `authorizeEvent`, `eventAudience`, `listProjectPeople`) then denies the agent, with no
  per-call-site change.
  `evaluateAgent(…, 'agent.invoke')` also denies while the agent's workspace is blocked.
  Human principals are not changed by this layer: people keep every human right.
- **Entry layer.** Entry points that start AI work, or that run before any agent-principal
  evaluation (bearer verification, token issuance, project-less tools, human commands that
  start AI work, worker stages), call `requireWorkspaceAi` explicitly so the refusal is
  the distinct `WORKSPACE_AI_BLOCKED` ("AI is turned off in this workspace") rather than a
  generic `404`, and so a queued item's epoch is compared.
- **Context layer.** Anything that assembles content under a *human's* authority for a
  model must drop items of blocked workspaces (today only the morning summary; see the
  table).
- **AI origin.** One predicate, `isAiOrigin(notification)` in
  `packages/core/src/notifications`, says whether an Inbox item came from AI work (agent
  questions, assistant waiting changes and join requests, co-work requests and reviews
  from agents, assistant answers and proposals, comparison proposals). Inbox lists and
  counts, Needs you, push and e-mail all use it.

## Enforcement points

Every row is required. "Check" means `requireWorkspaceAi` with `lock: true` inside the
named transaction, plus epoch comparison where an item has `ai_epoch`.

### API: external agents and MCP

| Point | File / function | Rule |
| --- | --- | --- |
| Bearer verification | `apps/server/src/agent-connection/mcp-route.ts`, `handleVerified` (the transaction that calls `grantForMcp`/`grantForRun` and `lockAgentMcpPolicy`) | Check on `grant.connection.workspaceId` before the tool server is created: no `tools/list`, resource or prompt is served. Answer `403` JSON-RPC error `WORKSPACE_AI_BLOCKED`. |
| Delivery fence | same file, `fence.check` (called by `createMcpRelay` for every chunk) | Check **first and unconditionally**, before the existing `if (!d.protectedOutput …) return`, so even a tool list or a refusal body is not handed to the transport after cutover. |
| Every tool, resource, prompt | `apps/server/src/agent-connection/context.ts`, `agentConnectionInTransaction` | Check on `row.workspaceId` for every call, with or without `claims.dispatch` (covers project-less tools such as `flux_list_contexts`, `flux_bootstrap`, `flux_coordination_inbox`, and internal native adapters: own-agent hand-off, assistant Apply). Covers every module registered in `mcp-tools.ts`. |
| External runtime sessions | `apps/server/src/agent-connection/runtime.ts`, `agentRuntimeInTransaction`, `ensureRuntime` | New sessions are stamped with the current epoch; reusing a session of another epoch answers `409 RUNTIME_UNAVAILABLE` ("start a new client session"). The sweep revokes old-epoch sessions. |
| Co-work claims and delivery | `cowork-actions.ts` tools (claim, renew, complete, release, transfer, coordination inbox) and `packages/core/src/co-work` | Every read or transition of a request or unit requires its `ai_epoch` to equal the current epoch, in the tool's transaction. New requests and units are stamped. |
| OAuth token issuance (code exchange and refresh) | `apps/server/src/identity/auth.ts`, `customAccessTokenClaims` | After `grantForOauth`, refuse `invalid_grant` "AI is turned off in this workspace" for a blocked connection workspace. Nothing is revoked. |
| Consent and Connect | `apps/server/src/agent-connection/routes.ts`: `POST /api/v1/agent-connections`, `POST …/:connectionId/select-for-oauth`, `POST/PATCH …/action-grants` | `403 WORKSPACE_AI_BLOCKED` for a blocked workspace. `GET` lists, `DELETE` connection and `DELETE` grant stay available (they only reduce or show). |
| Consent context | `apps/server/src/identity/oauth-context.ts`: `GET /api/v1/agent-oauth/consent-context`, `GET …/held-connection` | Gated: consent-context omits connections and workspaces that are blocked; held-connection answers `403 WORKSPACE_AI_BLOCKED` for a blocked held connection. |
| Better Auth authorize and consent leg | `apps/server/src/identity/auth.ts`, `postLogin.consentReferenceId` (`connectionForGrant`) and `shouldRedirect` | Gated: no consent reference is issued for a connection of a blocked workspace, so no authorization code is minted; the code exchange is refused again below. |
| Agent identities | `apps/server/src/access/agents.ts`, `createAgent`, `listAgents`, `revokeAgent` | `createAgent` gated. `listAgents` and `revokeAgent` exempt: human management of identities, no AI action; the UI does not list them while blocked. |
| Project audience and grants | `apps/server/src/access/projects.ts` (`GET /projects/:id/people` → `listProjectPeople`; grant list) | Server-side: agents are omitted from `listProjectPeople` by the principal layer (each candidate is evaluated). The grant list is exempt (managers see and can remove agent grants). |
| Run token mint | `apps/server/src/personal-runs/run-tokens.ts`, internal `POST /api/internal/v1/personal-runs/:id/run-token` | Check with the run's `ai_epoch` **first**, before `githubFacts(…)` and any other content assembly or outbound call, and again before signing; refusal is the existing uniform `404`. |
| Run token use | `apps/server/src/agent-connection/run-token.ts`, `requireLiveRun` | Check with the run's `ai_epoch` in the same locked transaction; covered also by bearer, fence and context rows; the sweep closes the tokens. |
| External agent proposals | `apps/server/src/agent-connection/routes.ts`, `GET /api/v1/projects/:projectId/agent-proposals` | Gated: pending AI suggestions are hidden while blocked and return afterwards. |
| MCP switches and project policy | `mcp-policy-routes.ts`, `project-policy.ts`, `project-agents.ts`, `agent-stops.ts`, `agent-questions.ts` routes | Human reads and changes of AI controls: `403 WORKSPACE_AI_BLOCKED`, except Stop (harmless, already fenced). |

### API: the assistant and human-started AI work

| Point | File / function | Rule |
| --- | --- | --- |
| Ask, retry | `packages/core/src/personal-runs/service.ts`, `invoke`, `retry` (routes in `apps/server/src/personal-runs/routes.ts`) | Check in the insert transaction; the new run stores the current `ai_epoch`. |
| Assistant status and history reads | `apps/server/src/personal-runs/routes.ts`: `GET` assistant status (`:92`), own runs list and run, conversation answers (`:146–150`) | Exempt: the owner's own history and account-wide status; no AI action. Status marks each blocked workspace so the UI can say "AI is off there". Committed answers are conversation history. |
| Background start (schedules, reactions, morning summary) | same file, `startBackground` | Check; skipped with no run when blocked. |
| Enablement per workspace | same file, `enable`, `selectAgent`, `chooseModel` | `selectAgent` and enabling for a blocked workspace refused; pause and remove stay. |
| Schedules | `packages/core/src/assistant/jobs.ts` (`createAssistantJobs`: create, update to enabled, restore, run now, preview), routes `apps/server/src/assistant/jobs.ts` | Refused while blocked; delete and turn off stay. |
| Reactions | `packages/core/src/assistant/reactions.ts`, `save`, `draft`; routes `apps/server/src/assistant/reactions.ts` | Refused while blocked; turn off stays. |
| Assistant settings, join requests, operator request | `apps/server/src/assistant/routes.ts` | Refused while blocked. |
| Waiting changes, Apply, Accept, Send | `apps/server/src/assistant/changes.ts` (`POST …/apply`, `not-now`, `inbox`, `dismiss`, `accept`, `send`) and pending-list `GET`s | Gated: refused while blocked; the items are kept. |
| Undo of an applied assistant change | same file, `POST …/undo` (change and run); `apps/server/src/assistant/undo.ts` | Exempt: a human compensating write as the owner (`updateWork(owner, …)`), never an AI action, so the owner can always reverse AI output. Reached from the change's history entry. |
| Assistant proposals | `apps/server/src/personal-runs/routes.ts`: proposal list, `GET` proposal and decide (`:169–176`) | Gated; kept. |
| Hand-off and agent ownership | `packages/core/src/work/service.ts`, `requireOwner` (create and update with an agent owner), `HandOff` path | An agent owner or a co-work request to an agent in a blocked workspace answers `403 WORKSPACE_AI_BLOCKED` (not `OWNER_WITHOUT_ACCESS`). |
| Co-work cards and coordination | `apps/server/src/co-work/routes.ts` (coordination view, packet, review policy) | Refused while blocked; cancel stays. |
| Agent threads | `apps/server/src/conversation/agent-thread-routes.ts` | Posting refused while blocked; existing messages stay readable as history. |
| Background comparisons | `apps/server/src/proactive-comparison/routes.ts`: create rule, `PATCH` to `enabled`, proposal edit/use, outcome list | Refused while blocked; pause, revoke and dismiss stay. Account-level key connections (`/background-compute-connections`) are not workspace content and stay. |
| Needs you and Inbox | `apps/server/src/needs-you/routes.ts` (`GET` and `POST /:key` resolve), inbox list and count in `apps/server/src/notifications/routes.ts` | `isAiOrigin` items of a blocked workspace are omitted from lists and counts, and resolving one answers `403 WORKSPACE_AI_BLOCKED`; human items are unchanged. |
| Push and e-mail delivery | `packages/core/src/push/delivery.ts` (`deliverPush`, run by `apps/worker/src/push`), `packages/core/src/notifications/email.ts` | Gated at send: an `isAiOrigin` notification of a blocked workspace is skipped ("AI is off"), including ones created before the flip and still queued. |
| Comparison enqueue in a human's write | `apps/server/src/work/adapters.ts`, `prepareHumanNegative` and `enqueueHumanNegative` (`proactiveOutboxRows`) | `prepareHumanNegative` reads the policy `FOR SHARE` first and selects no rule when blocked; `enqueueHumanNegative` stamps the epoch read there. The human's result is recorded either way. |
| Runtime slot and sign-in | `apps/server/src/agent-runtime/routes.ts` | Exempt: account-level, carries no workspace content. Runs that would use it are gated above and in the worker. |

### Worker and runtime

| Point | File / function | Rule |
| --- | --- | --- |
| Personal run stages | `packages/core/src/personal-runs/processor.ts`, `recheck` (claim, every count, every dispatch and tool-loop turn, commit) | Check with the run's `ai_epoch`, inside the unit of work that locks the run; new refusal `ai_off`, ending the run `stopped` with `end_reason = 'ai_off'` and the reservation released (or `unknown` once dispatched). |
| Personal run source read | same file, `readSources` (its own `uow.run`, after the claim) | Check with the run's `ai_epoch` and `lock: true` **at the start of the reading transaction**, before `requireProject`; the reads then run under that lock. |
| Runtime run stages | `packages/core/src/personal-runs/runtime-run.ts`, `recheck` and `watch` | Same check before the CLI starts, in the about-once-a-second standing poll, and in the commit; the poll also sees `stop_requested_at` set by the sweep within `stopPollMs`. |
| Run recovery | `apps/worker/src/personal-runs/recovery.ts` | Recovered runs pass the same recheck; a stale epoch ends them. |
| Assistant tick | `packages/core/src/assistant/job-tick.ts`, `fireDue` | A due job of a blocked workspace is not fired and records no history row; `nextRunAt` advances to the next time after now (AST-7 missed runs are skipped). |
| Reaction capture | `assistant_capture_reaction` (migration 0114), replaced by the new migration | Only when a matching enabled reaction exists: read the project's workspace policy `FOR SHARE`, insert only when `allowed`, stamping its `epoch`. Never raises, so the human's write always commits. |
| Reaction tick | `packages/core/src/assistant/reactions.ts`, `assistantReactionTick` | Check with the event's `ai_epoch`; stale or blocked → `skipped`, "Skipped: AI was turned off". |
| Morning summary | `packages/core/src/assistant/morning-summary.ts`, `startAssistantSummary` | **Cross-workspace context:** `summary.unread` returns notifications of every workspace. Drop rows whose `source.workspaceId` is blocked before titles are read, and anchor the run only in an allowed workspace; with none, the plain #350 summary goes out. `settleAssistantSummaries` commits a line only after a check on the run's workspace. |
| Comparison scheduling and reservation | `apps/worker/src/proactive-comparison/scheduling-adapter.ts`, `reservation-adapter.ts` | Check; new candidates store `ai_epoch`. |
| Comparison input, dispatch and publish | `apps/worker/src/proactive-comparison/authorization.ts`, `authorizedComparison`; `dispatch.ts` (`prepared` transaction, which reads the source texts with `lock = true`, and the publish transaction); `watchComparisonAuthorization` (unlocked, every 250 ms) | Locked check with the candidate's `ai_epoch` in the input and publish transactions; the unlocked watcher aborts the provider request through the existing `AbortController`; publication is refused with `ComparisonStopped('AI_OFF')`. |
| Comparison recovery | `apps/worker/src/proactive-comparison/recovery.ts` | Same check. |
| Event audience | `packages/core/src/events.ts`, `eventAudience` | When agent candidates exist, read the policy `FOR SHARE` once (before evaluating them) in the event's transaction; when blocked, no agent gets an `event_audience` row. An event racing the flip is therefore ordered before it (a pre-block event) or after it (no agent row), so no event of the blocked period ever reaches an agent. |
| Runtime slot processes | `apps/runtime` supervisor and manager | No workspace knowledge needed. A run reaches Flux only through `/mcp` (gated) and is stopped by the worker (`runtime.stop`); its output is published only by the worker's commit (gated). |

### Contract tests that keep the list complete

- `AI_HTTP_ROUTES` in `app/packages/contracts` lists every route registered by the AI
  modules (`agent-connection`, `assistant`, `personal-runs`, `co-work`,
  `proactive-comparison`, `agent-runtime`, `conversation/agent-thread-routes`) as
  `gated` or `exempt` with a one-line reason. An architecture test fails when a route in
  those modules is missing from the list, like `verifyRegistrations` does for MCP entries.
- An API test calls every `gated` route in a blocked workspace and expects
  `403 WORKSPACE_AI_BLOCKED` with no row or event written; the same calls in an allowed
  workspace are the positive control. Every route named in the tables above is in the list.
- `AI_WORK_QUEUES` lists every pg-boss job and schedule (`personal-run.dispatch.v1`,
  `assistant.background.tick.v1`, the morning summary, comparison tick and recovery,
  `workspace-ai.sweep.v1`, push and e-mail sends), every trigger that inserts AI work
  (the 0114 reaction taps) and every AI work table with its `ai_epoch`. A test compares it
  with the worker's actual `boss.work`/`boss.schedule` registrations, `pg_trigger` and the
  schema, and fails on anything unlisted; each listed item has an AI-off case.

## Cutover (AC-3)

**Disable** is two steps.

1. **The flip** (one transaction, the API's `PUT`): `SELECT … FOR UPDATE` the policy row,
   check `workspace.manage_ai` under the membership lock, set `state = 'blocked'`,
   `epoch = E` (the old epoch plus one), `version = version + 1`, send the
   `workspace-ai.sweep.v1` job with payload `{ workspaceId, epoch: E }` in the same
   transaction, and record the event last. It touches no AI work rows, so it cannot
   deadlock with a checker that holds a run row and waits for the policy lock.
2. **The sweep** `{ workspaceId, epoch: E }` (idempotent; run inline by the API right after
   the flip commits for speed, and again by the worker job so a crash cannot skip it). It
   touches **only rows with `ai_epoch < E`**, whatever the current state: rows admitted
   after a later re-enable have a larger epoch and are never touched, and a sweep that runs
   late, even after AI is on again, still ends every item admitted before the flip. Per
   workspace:
   - personal runs `queued` → `stopped` (`before_read`, released, `end_reason = 'ai_off'`);
     `reading`/`dispatching` → `stop_requested_at = now()`, which the existing 250 ms
     watchers turn into an aborted provider request or `runtime.stop`;
     `run_token_closed_at = now()` for every open run token;
   - comparison candidates `queued`/`reserved` → `not_run` (reservation released);
     in-flight ones are aborted by their watcher;
   - reaction events `queued`/`proof` → `skipped` ("Skipped: AI was turned off");
   - co-work requests `queued`/`deferred`/`claimed` addressed to agents → `cancelled`;
     units `pending`/`claimed`/`paused` → `stopped`, leases cleared, the task unchanged;
   - `agent_runtime_sessions` → `revoked_at = now()`; open run tokens are closed with
     their runs;
   - morning summaries `writing` whose run is in this workspace → `plain`.
   Each end records its usual owner-only event. Nothing is deleted.

**The boundary.** Every check that decides a step holds `FOR SHARE` on the policy row in
the step's transaction, so each step is ordered strictly before or after the flip. Two
kinds of step are fenced this way:

- **Reads** of workspace content for AI work: MCP tool reads, `readSources`, the
  comparison input transaction, and the run-token mint (checked before `githubFacts`). A read ordered after the
  flip sees `blocked` and returns nothing. Bytes read before the flip stay in that
  process's memory and can leave only through an egress step.
- **Egress and effects**: a provider count or dispatch decision, a tool-loop turn, an MCP
  response chunk (the relay writes inside the fence transaction), a token issuance or mint,
  a tool write, a run answer, a proposal, a comparison publication and an event-audience
  row. Ordered after the flip, each sees `blocked` and refuses.

This holds across processes because PostgreSQL row locks decide the order, not any
process's memory: every API instance and the worker read the same row in their own
transactions, and a runtime CLI reaches Flux data only through `/mcp`.

**The in-flight window, stated exactly.** Two kinds of traffic can still leave after the
flip commits, and nothing else can:

1. A provider request whose dispatch decision committed before the flip. Between that
   commit and the request's write to the socket the code does no database or other awaited
   work besides opening the connection, so the request may be transmitted shortly after the
   flip. It carries only content read before the flip. The sweep sets
   `stop_requested_at`, and the 250 ms watcher (`stopPollMs`) aborts it; a comparison's
   watcher polls `authorizedComparison` at the same interval. Bound: aborted within
   `stopPollMs` plus one poll query after the sweep commits.
2. A runtime CLI that started before the flip may keep talking to its own vendor, with
   content it received before the flip, until `runtime.stop` ends it: at most `stopPollMs`
   after the sweep, plus the supervisor's stop. Its next `/mcp` call is refused at once.

No dispatch is **decided** after the flip, and whatever a request in the window returns is
discarded: the commit recheck sees `blocked` and a newer epoch and stores no answer,
proposal, change or event. Usage already incurred is charged as today (`observed` or
`unknown`), so the cap stays honest. There is no grace window: no check reuses an earlier
decision, and the only state a process keeps across transactions is the item's
`ai_epoch`, which can only make it refuse. The AC-3 tests measure both bounds.

**No stale caches.** Nothing caches the policy: no module-level map, no per-connection
memo, no token claim. `McpDispatch.capturedVersion` and the run token's tool list are
per-request snapshots that are re-checked by the fence. The idempotency store keeps
response bodies, but a replay of a gated command re-checks the policy first
([who may change it](#who-may-change-it)). API responses are never cached
by the service worker (`apps/web/src/pwa/sw.js` skips `/api/`). The web client's copy is
presentation only (see [UI](#ui-contract)).

## Re-enable

- Needs current `workspace.manage_ai`, checked under the lock in the change transaction.
  It sets `allowed`, bumps `epoch` and `version` and records the event.
- **Nothing that waited, stopped or was skipped resumes.** Every AI work item admitted
  under an earlier epoch is refused by its next check, so a reaction captured concurrently
  with the flip, a queued pg-boss job that outlived the sweep, a co-work request or unit,
  an external runtime session or a recovered run cannot run after re-enable. Nothing can be
  admitted while blocked (the entry checks and the database backstop refuse it). A sweep
  still pending when AI is turned back on runs normally and ends only the old-epoch rows. Agents receive no events of the blocked period (no audience rows exist).
  Scheduled jobs fire at their next time after re-enable, never for missed times.
- **Standing configuration resumes as it was** ([founder direction
  2026-10-22](#founder-answers-2026-10-22)): connections, grants, MCP switches,
  assistant enablement, schedules, reactions and comparison rules are kept through the
  block and work again within each owner's current access. Results produced before the
  block (proposals, waiting changes, agent questions) reappear and still need their
  owner's explicit Accept, Apply or answer, under their existing version checks.
- An external client whose token refresh was refused while blocked reconnects through
  the normal Connect flow; one still holding a valid refresh token refreshes normally.

## What stays for people

Everything human: conversations, threads, DMs, tasks, maps, Wiki, files, search, live
sessions, notifications, People and access, export. Existing work and history are
unchanged, including what agents and assistants wrote before the block: their messages,
tasks, pages and history keep the author name and Agent tag. Other workspaces keep their
own policy, and a member's assistant keeps working in their other workspaces where AI is
allowed. Disabling deletes nothing.

## UI contract

The [final design](../design/final/README.md) and [Spokój](../design/spokoj/README.md)
apply. The web app reads `workspace.ai` from the shell loader
(`apps/web/src/app/data.ts`, `WorkspaceSummary`) and exposes one hook,
`useWorkspaceAi(workspaceId)`. It refreshes on `workspace.ai_policy_changed.v1`, on
reload, on focus and on any `403 WORKSPACE_AI_BLOCKED`, so an open page changes without a
reload. Every AI surface is rendered only through `<AiSurface workspaceId id="…">`,
which renders nothing while blocked and marks the element `data-ai-surface="<id>"` while
allowed; the browser tests count these markers.

**Disappears while blocked**, inside that workspace's places only:

- the **Agents** view in the project header and the phone view menu, and "Add Agents"
  (`HeaderParts.tsx`, `PhoneChrome.tsx`, `views.tsx`); this is the same rule as a
  project without the Agents view (#351), so no other control moves (Spokój rule 7);
- agents in the header's people and in `@`/⌘K "People and agents" and the Agents
  scope (`search/JumpTo.tsx`), and in the composer mention list (`ComposerMenu.tsx`);
- "Ask your assistant", "My assistant", "Hand off to an agent" in the composer menu,
  the message menu and long press (`ComposerMenu.tsx`, `work/messageActions.tsx`),
  and agent owners in task property menus and Create (`work/PropertyMenu.tsx`,
  `create/CreateWindow.tsx`);
- ⌘K "Ask my assistant…" and `AskWhere`'s projects of that workspace;
- the working-agent card with Stop (`Sidebar.tsx`, `WorkingAgent.tsx`), Home's
  working agents, the morning line, "Summary by your assistant" and Meet your
  assistant (`Home.tsx`, `assistant/MorningLine.tsx`, `SummaryByAssistant.tsx`,
  `MeetAssistant.tsx`) when the person has no allowed workspace;
- suggestions and waiting changes (`assistant/WaitingChanges.tsx`,
  `project/ProjectProposals.tsx`, `project/InsufficientComparison.tsx`), agent
  questions and assistant join reviews in Inbox (`notifications/NeedsYouCard.tsx`,
  `AssistantJoinReview.tsx`), request cards and agent-thread composers;
- AI onboarding (`ProjectSetup.tsx` mentions of Agents, Connect agent prompts).

**The switch: the workspace's People panel** ([founder direction
2026-10-22](#founder-answers-2026-10-22)). It is the panel Home → Details → People → a
workspace opens (`apps/web/src/people/WorkspacePeople.tsx`): the Details panel on a
computer and the Details sheet on a phone, with the same order on both. One row, shown
only to owners and admins of that workspace; members and guests see no row. It is its own
`details__sec` section, **AI in Garden club**, after the people list and before Leave. Its
place never changes with the state (Spokój rule 7): turning AI off or on changes only the
row's line and its button label.

- On: "On · agents and assistants can work here." Quiet button **Turn off AI**.
- Off: "Off · turned off by Ada on 18 Oct. No agent or assistant can read or change
  anything here." Quiet button **Turn on AI**.

The confirmation uses the panel's existing inline confirm group (`details__confirm`,
as for Remove and Leave), in place under the row, so nothing else moves:

- Turning off: "No agent or assistant, including each person's own, can read or change
  anything in Garden club. Work they are doing now stops and is not posted. Nothing is
  deleted." Buttons **Turn off AI** (danger) and **Keep AI on**. Afterwards the panel's
  status line says "AI is off in Garden club. 2 runs stopped."
- Turning on: "People's assistants and connected agents can work here again, with the
  access they had. Nothing that was stopped starts again." Buttons **Turn on AI** and
  **Keep AI off**. Afterwards: "AI is on in Garden club."
- A version conflict closes the confirm, shows the current state in the row and says
  "Someone changed this just now." A `403` says "Only owners and admins can change this."

Focus returns to the row's button after either answer. Members learn the state where
AI would have appeared ([deep links](#ui-contract) below) and from the API's `ai` field.

**Settings → Agents and AI** keeps its place and holds no switch. For a workspace that is
off, its assistant card and agent apps say once "Not in Garden club: AI is off there."
While every workspace of the person is off, the page shows only "AI is off in Garden
club. Its owners and admins can turn it back on in People." (for an owner or admin, "People"
opens that workspace's People panel).

**Deep links.** An existing tab or URL that would open an AI surface in a blocked
workspace (`/projects/:id/agents`, an agent's details or thread, `/settings/assistant`
for that workspace's settings, `/connect-agent` and `/consent` choosing that workspace, an
Inbox item of AI origin) shows one calm blocked state in the same panel or page, and
starts no AI request: **AI is off in Garden club** · "Its admins turned off agents and
assistants here. Everything else works as usual." with **Back to the conversation**
(or **Back**); owners and admins also get **People**, which opens the workspace's People
panel. Back and history are preserved;
the URL is not rewritten.

## Test matrix (AC-5)

Docker only; ports and Compose project per [containers](../development/containers.md).
Fixture: two owners (Ada owns workspace A, Ben owns workspace B), an admin and a member
in A, a guest in A, Ada also a member of B; in A an external MCP connection of Ada and of
the member, Ada's and the member's assistants (one `server` on the mock provider, one
`runtime` on the fake CLI), a workspace-owned agent, a comparison rule, a schedule and a
reaction. "Provider negative control" means the mock provider
(`tests/ui/anthropic_mock.py`, `openai_mock.py`, or the API-suite fakes) counts requests;
every "zero requests" assertion is paired with the same step in an allowed workspace that
does reach it.

| AC | Test | Where |
| --- | --- | --- |
| AC-1 | Migration: one `allowed` row per existing workspace; new workspace gets a row; missing row is refused. | `tests/app/workspace-ai-migration.test.ts` |
| AC-1 | `PUT ai-policy`: owner and admin succeed; member, guest and an agent principal get `403`; `If-Match` conflict; idempotent replay after demotion is refused; state survives API restart and a new session. | `tests/app/workspace-ai-policy.test.ts` |
| AC-2 | Every `AI_HTTP_ROUTES` `gated` route answers `403 WORKSPACE_AI_BLOCKED` with nothing written; route inventory complete. | `tests/app/workspace-ai-routes.test.ts`, `architecture.test.ts` |
| AC-2 | MCP with already-issued tokens: Ada's (owner) and the member's existing connections get `403` at bearer for `tools/list`, every tool, resource and prompt; a refresh is `invalid_grant`; a new consent cannot select A; a standing grant does not help; B's connection works throughout. | `tests/app/workspace-ai-mcp.test.ts` |
| AC-2 | Run token minted before disable is refused at `/mcp`; mint after disable is `404`. | same, plus `assistant-run-tokens.test.ts` cases |
| AC-2 | Personal runs (`server` and `runtime`), schedules, reactions, morning summary and comparisons in A start nothing, with zero provider requests and zero CLI starts; in B they run (positive control). | `tests/app/workspace-ai-worker.test.ts` |
| AC-2 | Cross-workspace: Ada's morning summary in B contains no title from A; A's agents are absent from `listProjectPeople`, ⌘K data, event audience rows and `flux_list_contexts`; search for humans in A unchanged. | same file and `workspace-ai-mcp.test.ts` |
| AC-3 | Two real connections: flip vs. MCP fence, run commit, comparison publish and reaction capture in both orders, detecting the wait with `pg_blocking_pids` (as `access-policy.test.ts` does); the chunk held by the relay's `testGate` is not delivered after the flip. | `tests/app/workspace-ai-cutover.test.ts` |
| AC-3 | Late in-flight result: a mock provider that holds its response; disable; assert the provider connection is aborted within 1 s, the run ends `stopped`/`ai_off`, no answer, proposal or event is committed, and releasing the response later changes nothing. Same for a fake CLI run (`runtime.stop` observed) and a comparison. | same |
| AC-3 | Multi-process: two API containers and the worker (pattern of [two-API fixture](../development/live-editing-two-api.md)); disable on API-1 while an MCP stream is served by API-2 and a run is in the worker; nothing crosses. | `tests/app/live/workspace-ai-two-api.test.ts`, `docker/compose.ai-lock.test.yaml` |
| AC-3 | Disable, then enable before the sweep runs (sweep job held): old-epoch runs, requests, units, sessions and reaction events never run; the late sweep ends them; items admitted after the re-enable are untouched and run. | `workspace-ai-cutover.test.ts` |
| AC-3 | Lock order and backstop: flip against a role change of the flipping admin in both orders (no deadlock); an insert of each AI work table with a stale or missing epoch is rejected by `ai_work_admission`; a human task write with a reaction rule during the flip still commits. | same |
| AC-3 | In-flight window: a pre-flip dispatch is aborted within `stopPollMs` plus one poll after the sweep; no provider request arrives whose decision committed after the flip; a fake CLI is stopped within its bound. | same |
| AC-2 | Every route and queue in `AI_HTTP_ROUTES` and `AI_WORK_QUEUES`, push and e-mail skips of `isAiOrigin` notifications created before the flip, Needs-you resolve refusal, consent-context and held-connection, run-token mint refused before `githubFacts` is called, idempotent replay of a gated command refused, guests see `changedBy: null`, the owner's Undo of an applied change still works while blocked. | `workspace-ai-routes.test.ts`, `workspace-ai-worker.test.ts` |
| AC-3 | Re-enable: queued items from before and from the flip race do not run; missed schedule times do not fire; agents get no blocked-period events; a demoted admin cannot re-enable; standing configuration works again. | `workspace-ai-cutover.test.ts` |
| AC-3 | Real client: pinned Claude Code in the `mcp-clients` image gets the refusal on its next call after disable and works again after re-enable and reconnect. | `tests/app/e2e/mcp-clients.e2e.ts` case |
| AC-4 | Chromium and WebKit, desktop and phone viewports: owner and admin turn AI off and on in the workspace's People panel (Details panel on a computer, Details sheet on a phone), the row keeps its position across states, and the inline confirm works by keyboard; member and guest see no AI row; zero `[data-ai-surface]` in A's project, Home, Inbox, ⌘K, composer and message menus while blocked, and more than zero in B (control); every listed deep link shows the blocked state and makes no AI request (network log); reload keeps the state; an open second tab updates from the stream; conversation, task, map, Wiki, file and search still work for two people. | `tests/ui/test_workspace_ai_lock.py` (`./scripts/check_ui.sh`, run with `FLUX_UI_BROWSER=chromium` and `webkit`) |
| AC-5 | Final candidate evaluated independently under the [bounded review policy](../agents/evaluation.md). | PR review |

## Delivery slices

One issue, #614, one owner; each slice is its own PR with its own review, and each is
safe to merge alone.

- **S1 — policy and enforcement, no way to switch.** Migration (table, `ai_epoch` without
  default, backstop trigger), `workspaceAi`/`requireWorkspaceAi`, `loadActor` and
  `evaluateAgent`, `workspace.manage_ai`, the read-only wire field, every row of the
  enforcement tables including epoch stamping, `AI_HTTP_ROUTES`, `AI_WORK_QUEUES`, and the
  AC-1/AC-2 tests, which block a workspace through a test fixture. There is no route that
  changes the policy, so production stays `allowed` everywhere and every check is a no-op.
- **S2 — the switch and cutover.** `PUT ai-policy` with the flip, the sweep and its job,
  re-enable, and the AC-3 tests (two connections, two API processes, late results, the
  window bounds, enable-before-sweep, the real client). The policy becomes changeable only
  here, together with the cutover, through the API.
- **S3 — human-only interface.** `useWorkspaceAi`, `<AiSurface>`, the People-panel row
  and its inline confirm, every listed surface, deep-link blocked states, and the AC-4
  browser tests, with a visual review under a neutral brief. It may merge only after S2.

## Founder answers (2026-10-22)

Hubert answered the three open questions in the supervising session on 2026-10-22. They
are founder direction, not proposals:

1. **The switch** is one row in the workspace's People panel, for owners and admins only
   (not in Settings → Agents and AI).
2. **Re-enable**: connections, grants, switches, schedules, reactions and comparison rules
   work again automatically. Stopped or missed work is never replayed, and suggestions
   from before the block return only for their owner's explicit acceptance.
3. **New workspaces** start with AI allowed.

## Not in scope

Per-project or per-person AI exclusion; hiding committed AI-authored history; changing
the instance operator switches (`FLUX_PERSONAL_RUNS`, `FLUX_AGENT_RUNTIME`,
`FLUX_BACKGROUND_COMPARISONS`), which stay an additional, instance-wide gate; GitHub
bindings, which are not AI and keep working.

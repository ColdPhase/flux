import type { Page, VersionPrecondition } from './access.js';
import type { AiProviderKind } from './ai-providers.js';
import type { AgentRuntimePayer } from './agent-runtime.js';
import type { ResultFinding } from './work.js';

/**
 * Owner-invoked personal assistant runs (issue #68; Connect AI, #854).
 *
 * A person turns their own assistant on with a model from one of their Connect AI connections (a Claude plan, a ChatGPT
 * plan or an API key) and invokes it in a project conversation. There is no consent screen per use and no Flux limit;
 * an API key keeps its one daily budget. Invocation, stop and retry resolve the owner, agent and connection only from
 * the authenticated session; no id in a request body selects them. The answer is shown to that conversation's audience
 * as "<owner>'s assistant". Cost, the connection and hidden sources are never shown to anyone but the owner.
 */
export const PERSONAL_ASSISTANT_PATH = '/api/v1/personal-assistant';
export const PERSONAL_ASSISTANT_PAUSE_PATH = `${PERSONAL_ASSISTANT_PATH}/pause`;
export const PERSONAL_ASSISTANT_RESUME_PATH = `${PERSONAL_ASSISTANT_PATH}/resume`;
/** Chooses the owner's assistant agent for the agent's workspace (one per workspace). */
export const PERSONAL_ASSISTANT_AGENTS_PATH = `${PERSONAL_ASSISTANT_PATH}/agents`;
export const ASSISTANT_RUNS_PATH = '/api/v1/assistant-runs';
export const assistantRunPath = (runId: string) => `${ASSISTANT_RUNS_PATH}/${runId}`;
export const assistantRunStopPath = (runId: string) => `${assistantRunPath(runId)}/stop`;
export const assistantRunRetryPath = (runId: string) => `${assistantRunPath(runId)}/retry`;
export const conversationAssistantRunsPath = (conversationId: string) => `/api/v1/conversations/${conversationId}/assistant-runs`;
export const conversationAssistantAnswersPath = (conversationId: string) => `/api/v1/conversations/${conversationId}/assistant-answers`;
export const projectAssistantProposalsPath = (projectId: string) => `/api/v1/projects/${projectId}/assistant-proposals`;
export const assistantProposalPath = (proposalId: string) => `/api/v1/assistant-proposals/${proposalId}`;
export const assistantProposalAcceptPath = (proposalId: string) => `${assistantProposalPath(proposalId)}/accept`;
export const assistantProposalDismissPath = (proposalId: string) => `${assistantProposalPath(proposalId)}/dismiss`;

/**
 * Stream event of a run's progress (O-008 §4 "Progress"): `objectType` `assistant_run`, the run
 * id as `objectId`. Its audience is the run's owner alone; the client refetches
 * `GET /api/v1/assistant-runs/:id`. Nobody else learns that a run exists until its answer is
 * committed (`project.assistant_answer_committed.v1`, the project's audience).
 */
export const ASSISTANT_RUN_CHANGED_EVENT = 'assistant_run.changed.v1';
/** Statuses of a run that is still working; the owner's working line shows Stop for these. */
export const ASSISTANT_RUN_IN_FLIGHT = ['queued', 'reading', 'dispatching'] as const;

/**
 * The engine of the owner's assistant (F-022 mode (a)): `server`, the worker calls the provider with the
 * owner's own API key (F-020), or `runtime`, the owner's own signed-in Claude Code in their runtime slot
 * (AIM-3). Both reach Flux only through the MCP route with a run token (F-027 AST-8).
 */
export const ASSISTANT_ENGINES = ['server', 'runtime'] as const;
export type AssistantEngine = (typeof ASSISTANT_ENGINES)[number];

/**
 * Technical safety bounds of a run on a plan (#843, model-providers CA-3). Flux sets no limits of its own: no runs a day,
 * no five-minute clock, no step or change count. These bounds only stop a run that has gone wrong (a CLI that never
 * ends or loops); nobody meets them in normal use. They are listed in the operator guide.
 */
export const RUNTIME_RUN_LIMITS = {
  maxTurns: 200,
  wallClockSeconds: 3600,
  idleSeconds: 600,
  maxAnswerBytes: 64 * 1024,
} as const;

/**
 * A run's MCP token (F-022 "Agent connection and permissions", F-027 A2): it lives as long as the run's clock and a little
 * more, and the MCP route bounds what tools return to it, per call and per run. Both are safety bounds (#843).
 */
export const RUN_TOKEN_LIMITS = {
  lifetimeSeconds: RUNTIME_RUN_LIMITS.wallClockSeconds + 300,
  resultBytesPerCall: 256 * 1024,
  resultBytesPerRun: 8 * 1024 * 1024,
} as const;

/**
 * Why a run ended without an answer, when its status alone does not say (F-022 T5: each end has its own
 * state). `sign_in_again`: the CLI's login expired or was signed out at the vendor. `plan_limit`: the CLI
 * reported a plan limit (nothing falls back to an API key). `wall_clock` and `no_event`: the run's two
 * timeouts. `crashed`: the CLI exited without a result. `answer_too_large`: the answer passed its bound.
 * `mcp_results_too_large`: a tool result or the run's results passed the route's bound. `local_tool`: the
 * CLI showed a tool or MCP server other than the run's exact Flux tools. `slot_busy`: the slot's serial
 * lane was taken (a sign-in, a status check or another run). `unknown`: the CLI's stream broke; whether it
 * changed anything is not known and it is never rerun. `max_turns`: the safety bound on steps. `refused`: the model
 * refused the request. `model_unavailable`: the vendor did not accept the model the owner chose (F-027 AST-11);
 * nothing was changed and no other model was tried. `ai_off` (F-029, #614): AI is turned off in the run's
 * workspace; nothing was posted. `budget` (#854): the API key's one daily budget is used; the agent pauses until the
 * next day. `credits` (CA-3): the provider's API credits ran out; nothing switches to another connection. `no_room` (#860): not
 * an end but a wait: the request stays queued until the server has room for another agent.
 */
export const ASSISTANT_RUN_END_REASONS = [
  'sign_in_again', 'plan_limit', 'wall_clock', 'no_event', 'crashed', 'answer_too_large', 'mcp_results_too_large',
  'local_tool', 'slot_busy', 'unknown', 'max_turns', 'refused', 'model_unavailable', 'ai_off', 'budget', 'credits', 'no_room',
] as const;
export type AssistantRunEndReason = (typeof ASSISTANT_RUN_END_REASONS)[number];

/**
 * INTERNAL, worker to API only (F-027 A2): the API is the authorization server, so it signs a run's MCP
 * token. The worker proves it holds the run with a one-time nonce whose hash it stored on the run row; the
 * token is minted once, for an in-flight run only, and is never stored.
 */
export const personalRunTokenPath = (runId: string) => `/api/internal/v1/personal-runs/${runId}/run-token`;
export interface PersonalRunTokenRequest { nonce: string }
export interface PersonalRunTokenGrant {
  token: string;
  /** The run's exact Flux tools, from the owner's switches when the token was minted (F-027 AST-4). */
  tools: string[];
  expiresAt: string;
  /** Owner-authorized, freshly read external facts for this run (G-1); data, never instructions. */
  context?: string;
}

/**
 * The bounds of one request of a run on an API key (F-020 PROV-3, #843). Flux prices each request at the model's price
 * before sending it, so the API key's daily budget holds; these token bounds make that price knowable. They are technical
 * bounds, not limits on the owner's use: the only limit is the key's daily budget. `effort` applies where the wire format
 * has it (Anthropic Messages).
 */
export const PERSONAL_RUN_LIMITS = {
  effort: 'low',
  maxInputTokens: 32_000,
  /**
   * The input bound of one request of a run with tools (#484): the Flux tool definitions travel with every request and its
   * earlier turns, so a tool run may send twice the single-request bound.
   */
  maxToolInputTokens: 64_000,
  maxOutputTokens: 4_000,
  /** The safety bound on requests ("steps") of one run with a tool loop, the same as on a plan. */
  maxTurns: RUNTIME_RUN_LIMITS.maxTurns,
  prompt: 4_000,
} as const;

/** The input bound of one request of a run: the larger one when the run can call tools (#484). */
export const personalRunMaxInputTokens = (tools: boolean): number => (tools ? PERSONAL_RUN_LIMITS.maxToolInputTokens : PERSONAL_RUN_LIMITS.maxInputTokens);

export type PersonalRunEnablementStatus = 'active' | 'paused';

/**
 * One of a person's Connect AI connections (#854): their Claude plan (`claude_plan`), their ChatGPT plan (`chatgpt_plan`)
 * or one of their API keys (the key connection's id).
 */
export type AiConnectionRef = 'claude_plan' | 'chatgpt_plan' | (string & {});

/** The owner's assistant: on (or paused) with a model of one of their connections. */
export interface PersonalRunEnablement {
  ownerUserId: string;
  /** The connection the assistant's model belongs to. */
  connection: AiConnectionRef;
  status: PersonalRunEnablementStatus;
  /** Where runs go: the owner's API key (`server`) or their own Claude Code or Codex in the runtime. */
  engine: AssistantEngine;
  /** The assistant's model, an id from its connection's list (F-027 AST-11). */
  model: string;
  /** The owner's assistant agent per workspace; its project grants bound what a run may read. */
  agents: { workspaceId: string; agentId: string }[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** `capped`: the assistant's API key used its daily budget; it resumes the next day (#854). */
export type PersonalAssistantState = 'not_enabled' | 'ready' | 'paused' | 'capped' | 'unavailable';
/** `price_unknown`: the API key's model has no known price, so its daily budget cannot hold (PROV-3). */
export type PersonalAssistantUnavailableReason = 'no_connection' | 'connection_changed' | 'provider_off' | 'price_unknown'
  /** A runtime assistant: the operator switched sign-in off, or the owner must sign in again. */
  | 'runtime_off' | 'runtime_sign_in';

/** `GET /api/v1/personal-assistant`: only ever the caller's own state. */
export interface PersonalAssistantStatus {
  state: PersonalAssistantState;
  unavailableReason: PersonalAssistantUnavailableReason | null;
  enablement: PersonalRunEnablement | null;
  /**
   * What this instance can do for the caller now, so the UI can say why an assistant cannot run
   * instead of pretending: the operator's provider switch (O-008 §6) and whether the caller has
   * a usable key connection of their own (O-007/#124). Never another person's.
   */
  setup: {
    provider: 'on' | 'off'; connection: 'active' | 'none';
    /**
     * The caller's own Claude Code or Codex in the agent runtime (F-022 AIM-3): `off` when the operator has not
     * enabled it; otherwise whether the caller is signed in. `payer` comes from the CLI's reported
     * `authMethod` only (never shown as zero).
     */
    runtime: {
      state: 'off' | 'signed_out' | 'sign_in_again' | 'signed_in'; payer: AgentRuntimePayer | null; accountLabel: string | null;
      /** Which of the owner's CLIs this is; null when off. */
      client?: 'claude_code' | 'codex' | null;
    };
  };
  /**
   * On an API key: today's use of that key's one daily budget, by everything that runs on it, in the key's time zone.
   * Null on a plan (its limits are the provider's) and without an assistant.
   */
  today: { chargedMicros: number; reservedMicros: number; budgetCents: number; resetsAt: string } | null;
}

/** `POST /api/v1/personal-assistant`: the model and its connection; nothing else to agree to or set (#854). */
export interface EnablePersonalRunsCommand {
  /** The caller's own, unrevoked person-owned agent. */
  agentId: string;
  /** One of the caller's own connections. */
  connection: AiConnectionRef;
  /** An id from that connection's model list. */
  model: string;
}

/** `PUT /api/v1/personal-assistant/agents`: the caller's own agent for that agent's workspace. */
export interface SelectPersonalAgentCommand {
  agentId: string;
}

/**
 * What started a run. `scheduled` and `morning_summary` are started by Flux's own tick for the owner's schedules and
 * morning summary (F-027 A8); only the first three can be asked for through the API.
 */
export type AssistantRunKind = 'ask' | 'summarize' | 'map_thought' | 'scheduled' | 'morning_summary' | 'reaction' | 'task';

/** A map thought on a project sketch of the conversation's project. */
export interface AssistantRunTarget {
  type: 'thought';
  sketchId: string;
  thoughtId: string;
}

/**
 * `POST /api/v1/conversations/:conversationId/assistant-runs` (202). `ownerId`, `connectionId`
 * and `agentId` never select anything: naming anything but the caller's own is 403 before any
 * reservation. Reusing `clientRunId` returns the existing run (200) and never charges twice.
 */
export interface InvokeAssistantRunCommand {
  clientRunId: string;
  kind: AssistantRunKind;
  prompt: string;
  target?: AssistantRunTarget;
  /** An earlier committed run of the caller in the same conversation; its answer is passed as input. */
  continuesRunId?: string;
  ownerId?: string;
  connectionId?: string;
  agentId?: string;
}

/** `POST /api/v1/assistant-runs/:runId/retry` (202): a new run by the owner with the same request. */
export interface RetryAssistantRunCommand {
  clientRunId: string;
}

export type AssistantRunStatus =
  | 'queued' | 'reading' | 'dispatching'
  | 'completed' | 'truncated'
  | 'stopped' | 'denied' | 'paused' | 'revoked' | 'cap_reached' | 'unavailable'
  | 'input_too_large' | 'provider_failed';

/**
 * `reserved`: the most the run can cost is held against the API key's daily budget. `released`: nothing was dispatched,
 * cost zero. `observed`: the provider reported usage. `unknown`: the response was lost; the reservation stays counted.
 */
export type AssistantRunCostState = 'reserved' | 'released' | 'observed' | 'unknown';

/** The owner's view of their run. Nobody else can read it (404). */
export interface AssistantRun {
  id: string;
  clientRunId: string;
  workspaceId: string;
  projectId: string;
  conversationId: string;
  kind: AssistantRunKind;
  prompt: string;
  /** A background run whose answer is not shown in its conversation (a schedule keeps its result in Recent). Absent on older servers. */
  silent?: boolean;
  target: AssistantRunTarget | null;
  continuesRunId: string | null;
  retryOfRunId: string | null;
  status: AssistantRunStatus;
  /** Where a recheck refused the run: access, grant, pause, budget or connection. */
  stoppedAtStage: 'before_read' | 'before_dispatch' | 'before_commit' | null;
  stopRequested: boolean;
  /** The runtime confirmed the stop (F-022 "Stop": requested and acknowledged are separate). */
  stopAcknowledged: boolean;
  engine: AssistantEngine;
  /** The model this run was sent with, fixed when it was sent (F-027 AST-11); the engine's own label when none was chosen. */
  model: string;
  /** A `runtime` run's CLI (F-022 T6 #281), for its own words ("ChatGPT" or "Claude"); null otherwise. Optional for older servers. */
  runtimeClient?: 'claude_code' | 'codex' | null;
  /** Why it ended without an answer, when the status alone does not say; null otherwise. */
  endReason: AssistantRunEndReason | null;
  /** With `plan_limit`: when the CLI said the plan resets, if it said so. */
  planLimitResetsAt: string | null;
  /**
   * A request paused by its connection's limit (a plan's limit or the API key's daily budget) waits as a queued run that
   * starts by itself at this time (#854): "Claude limit reached, resumes at 14:00". Null otherwise.
   */
  resumesAt?: string | null;
  cost: {
    state: AssistantRunCostState;
    reservedMicros: number;
    chargedMicros: number;
    inputTokens: number | null;
    outputTokens: number | null;
  };
  /** Set once the answer was committed to the conversation. */
  answer: AssistantAnswer | null;
  /**
   * What started it: the owner's own request, or the owner's stored schedule or reaction (F-027 AST-6). A background
   * run carries the short name the owner gave it. Optional for older servers.
   */
  authority?: AssistantRunAuthority;
  backgroundLabel?: string | null;
  /** While queued: the run it waits behind, so the line can say "Next: …" or "Finishing your Morning summary first". Optional for older servers. */
  behind?: AssistantRunBehind | null;
  createdAt: string;
  dispatchedAt: string | null;
  completedAt: string | null;
}

export type AssistantRunAuthority = 'owner_request' | 'owner_schedule' | 'owner_reaction';
/** The working run a queued request waits behind (AST-6 "Queue"): another request, or a background run by name. */
export interface AssistantRunBehind { runId: string; authority: AssistantRunAuthority; label: string | null }

export type AssistantSourceRef =
  | { type: 'message'; id: string; revision: number }
  | { type: 'work'; id: string; revision: number }
  | { type: 'thought'; id: string; sketchId: string; revision: number };

/** A committed answer as the conversation's audience sees it. No cost, budget or connection. */
export interface AssistantAnswer {
  runId: string;
  conversationId: string;
  projectId: string;
  audience: { kind: 'project'; projectId: string };
  /** "Jo's assistant · asked by Jo". */
  assistant: { ownerUserId: string; label: string };
  askedBy: { id: string; name: string };
  request: { kind: AssistantRunKind; prompt: string };
  body: string;
  /** Stopped at the output limit: shown as truncated, never a proposal; the owner can continue it. */
  truncated: boolean;
  provenance: { provider: AiProviderKind; model: string };
  /** Only supplied project-audience sources the answer cites. */
  sources: AssistantSourceRef[];
  proposalId: string | null;
  committedAt: string;
  /** The schedule that posted this answer in the conversation (F-027 AST-7 "Output"); null for a request. */
  schedule?: { id: string; title: string } | null;
}

export type AssistantAnswerPage = Page<AssistantAnswer>;

export type AssistantProposalStatus = 'proposed' | 'accepted' | 'dismissed';

/**
 * A consequential change drafted by a person's assistant. Nothing is saved until a person with
 * authority over the target accepts it: project write access, and for a result that finishes an
 * owned work item, its owner or a project manager. The assistant's owner has no extra right.
 */
export interface AssistantProposal {
  id: string;
  runId: string;
  projectId: string;
  audience: { kind: 'project'; projectId: string };
  /** "Jo's assistant" and its owner. */
  draftedBy: { ownerUserId: string; label: string };
  fact: string;
  interpretation: string;
  change: { type: 'result'; title: string; finding: ResultFinding; evidence: string; finishes: { workId: string } | null };
  status: AssistantProposalStatus;
  decidedBy: { id: string; name: string } | null;
  decidedAt: string | null;
  /** The result recorded on accept, by the accepting person, drafted by the assistant. */
  resultId: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** `POST /api/v1/assistant-proposals/:id/accept`, with `If-Match` or `expectedVersion`. */
export type DecideAssistantProposalCommand = VersionPrecondition;

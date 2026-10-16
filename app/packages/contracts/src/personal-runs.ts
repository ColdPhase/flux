import type { Page, VersionPrecondition } from './access.js';
import type { AiPrice, AiProviderKind } from './ai-providers.js';
import type { AgentRuntimePayer } from './agent-runtime.js';
import type { ResultFinding } from './work.js';

/**
 * Owner-invoked personal assistant runs (issue #68, decision O-008).
 *
 * A person enables their own assistant with a personal-run consent, a per-run ceiling and a daily
 * cap, and invokes it in a project conversation. Invocation, stop and retry resolve the owner,
 * agent and connection only from the authenticated session; no id in a request body selects them.
 * The answer is shown to that conversation's audience as "<owner>'s assistant"; a consequential
 * change becomes an assistant proposal that only a person with authority over its target accepts.
 * Cost, caps, the connection and hidden sources are never shown to anyone but the owner.
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
 * The disclosure version a new personal-run consent must name (O-008 §1). `o-008-2026-09-28` named
 * Anthropic only and stays valid for consents given on an Anthropic connection; `o-008-2026-10-02`
 * is the provider-neutral revision of F-020 (#179), naming the connection's provider, model and price.
 */
export const PERSONAL_RUN_CONSENT_VERSION = 'o-008-2026-10-02';
/**
 * The consent of an assistant that runs on the owner's own Claude Code in the agent runtime (F-022
 * AIM-3 "Payer and data", #280): the owner's plan pays (not visible to Flux), and the place's content
 * goes to Anthropic under the owner's account settings, which may allow training on consumer plans.
 */
export const PERSONAL_RUNTIME_CONSENT_VERSION = 'f-022-runtime-2026-10-16';
export const PERSONAL_RUN_CONSENT_VERSIONS = ['o-008-2026-09-28', PERSONAL_RUN_CONSENT_VERSION, PERSONAL_RUNTIME_CONSENT_VERSION] as const;
export type PersonalRunConsentVersion = (typeof PERSONAL_RUN_CONSENT_VERSIONS)[number];

/**
 * The engine of the owner's assistant (F-022 mode (a)): `server`, the worker calls the provider with the
 * owner's own API key (F-020), or `runtime`, the owner's own signed-in Claude Code in their runtime slot
 * (AIM-3). Both reach Flux only through the MCP route with a run token (F-027 AST-8).
 */
export const ASSISTANT_ENGINES = ['server', 'runtime'] as const;
export type AssistantEngine = (typeof ASSISTANT_ENGINES)[number];

/**
 * The bounds of a `runtime` run (F-022 "Caps"; they replace the money reservation, the single request and
 * the input bound for `runtime`). The values are the decision's starting values.
 */
export const RUNTIME_RUN_LIMITS = {
  runsPerDay: 20,
  maxTurns: 10,
  wallClockSeconds: 300,
  idleSeconds: 60,
  maxAnswerBytes: 16 * 1024,
} as const;

/**
 * A run's MCP token (F-022 "Agent connection and permissions", F-027 A2): it lives no longer than the
 * run's clock, and the MCP route bounds what tools return to it, per call and per run (F-022 "Caps").
 */
export const RUN_TOKEN_LIMITS = {
  lifetimeSeconds: 300,
  resultBytesPerCall: 16 * 1024,
  resultBytesPerRun: 64 * 1024,
} as const;

/**
 * Why a run ended without an answer, when its status alone does not say (F-022 T5: each end has its own
 * state). `sign_in_again`: the CLI's login expired or was signed out at the vendor. `plan_limit`: the CLI
 * reported a plan limit (nothing falls back to an API key). `wall_clock` and `no_event`: the run's two
 * timeouts. `crashed`: the CLI exited without a result. `answer_too_large`: the answer passed its bound.
 * `mcp_results_too_large`: a tool result or the run's results passed the route's bound. `local_tool`: the
 * CLI showed a tool or MCP server other than the run's exact Flux tools. `slot_busy`: the slot's serial
 * lane was taken (a sign-in, a status check or another run). `unknown`: the CLI's stream broke; whether it
 * changed anything is not known and it is never rerun. `max_turns`: the turn cap. `refused`: the model
 * refused the request.
 */
export const ASSISTANT_RUN_END_REASONS = [
  'sign_in_again', 'plan_limit', 'wall_clock', 'no_event', 'crashed', 'answer_too_large', 'mcp_results_too_large',
  'local_tool', 'slot_busy', 'unknown', 'max_turns', 'refused',
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
}

/**
 * Per-run request limits and caps of O-008 §3, the same for every provider and model (F-020
 * PROV-2/PROV-3). The model and its price belong to the owner's connection: a run reserves
 * `maxRequestMicros(price, maxInputTokens, maxOutputTokens)`, which must fit the owner's per-run
 * ceiling (`perRunCents`). `effort` applies where the wire format has it (Anthropic Messages).
 */
export const PERSONAL_RUN_LIMITS = {
  effort: 'low',
  maxInputTokens: 16_000,
  maxOutputTokens: 1_500,
  /**
   * The most requests ("turns") of one run with a tool loop (F-027 AST-6 limits, AST-8): the run
   * reserves up to this many maximum requests, never above the owner's per-run ceiling. A run
   * without tools, or on a model without tool calling, is one request.
   */
  maxTurns: 10,
  prompt: 4_000,
  perRunCents: { default: 6, min: 6, max: 50 },
  dailyCapCents: { default: 100, min: 10, max: 1_000 },
} as const;

export type PersonalRunEnablementStatus = 'active' | 'paused';

/** The owner's personal-run enablement. Separate from any background (#58) rule or budget. */
export interface PersonalRunEnablement {
  ownerUserId: string;
  /** The owner's key connection (O-007/#124) the consent was given for; null until one exists. */
  connectionId: string | null;
  consent: {
    version: PersonalRunConsentVersion;
    acceptedAt: string;
    provider: AiProviderKind;
    model: string;
    payer: { organization: string; workspace: string };
  };
  perRunCents: number;
  dailyCapCents: number;
  /** IANA time zone in which the daily cap resets at midnight. */
  timeZone: string;
  status: PersonalRunEnablementStatus;
  /** Where runs go: the owner's API key connection or their own Claude Code in the runtime. */
  engine: AssistantEngine;
  /** The owner's assistant agent per workspace; its project grants bound what a run may read. */
  agents: { workspaceId: string; agentId: string }[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type PersonalAssistantState = 'not_enabled' | 'ready' | 'paused' | 'capped' | 'unavailable';
/**
 * `price_unknown`: the connection has no known price, so nothing can be reserved (PROV-3).
 * `run_cost_over_limit`: the model's largest request costs more than the owner's per-run ceiling.
 */
export type PersonalAssistantUnavailableReason = 'no_connection' | 'connection_changed' | 'provider_off' | 'price_unknown' | 'run_cost_over_limit'
  /** A runtime assistant: the operator switched Claude Code sign-in off, or the owner must sign in to Claude again. */
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
     * The caller's own Claude Code in the agent runtime (F-022 AIM-3): `off` when the operator has not
     * enabled it; otherwise whether the caller is signed in. `payer` comes from the CLI's reported
     * `authMethod` only (never shown as zero).
     */
    runtime: { state: 'off' | 'signed_out' | 'sign_in_again' | 'signed_in'; payer: AgentRuntimePayer | null; accountLabel: string | null };
  };
  /** Today's use in the owner's time zone; null without an enablement. */
  today: { chargedMicros: number; reservedMicros: number; capCents: number; resetsAt: string } | null;
  /**
   * What the consent screen shows before enabling. Provider, model and price are those of the
   * caller's own connection; null without one.
   */
  disclosure: {
    consentVersion: typeof PERSONAL_RUN_CONSENT_VERSION;
    provider: AiProviderKind | null;
    model: string | null;
    price: AiPrice | null;
    /** What one request reserves: its largest possible cost at the connection's price. */
    maxRunMicros: number | null;
    maxInputTokens: number;
    maxOutputTokens: number;
    /** Only project-audience objects of the one project a run is asked in leave Flux. */
    dataSent: 'project_place_excerpts';
  };
}

/** `POST /api/v1/personal-assistant`. The payer comes from the owner's connection, never the body. */
export interface EnablePersonalRunsCommand {
  consentVersion: string;
  /** The caller's own, unrevoked person-owned agent. */
  agentId: string;
  /** Which of the caller's own AI connections the assistant uses (F-020 PROV-1); default: their newest. */
  connectionId?: string;
  /**
   * `runtime`: the caller's own signed-in Claude Code (consent `PERSONAL_RUNTIME_CONSENT_VERSION`); no API
   * key connection is used. Default `server`.
   */
  engine?: AssistantEngine;
  perRunCents?: number;
  dailyCapCents?: number;
  timeZone?: string;
}

/** `PATCH /api/v1/personal-assistant`, with `If-Match` or `expectedVersion`. */
export interface UpdatePersonalRunsCommand extends VersionPrecondition {
  perRunCents?: number;
  dailyCapCents?: number;
  timeZone?: string;
}

/** `PUT /api/v1/personal-assistant/agents`: the caller's own agent for that agent's workspace. */
export interface SelectPersonalAgentCommand {
  agentId: string;
}

export type AssistantRunKind = 'ask' | 'summarize' | 'map_thought';

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

/** `POST /api/v1/assistant-runs/:runId/retry` (202): a new, separately capped run by the owner. */
export interface RetryAssistantRunCommand {
  clientRunId: string;
}

export type AssistantRunStatus =
  | 'queued' | 'reading' | 'dispatching'
  | 'completed' | 'truncated'
  | 'stopped' | 'denied' | 'paused' | 'revoked' | 'cap_reached' | 'unavailable'
  | 'input_too_large' | 'provider_failed';

/**
 * `reserved`: the ceiling is held against the daily cap. `released`: nothing was dispatched, cost
 * zero. `observed`: the provider reported usage. `unknown`: the response was lost; the
 * reservation stays counted.
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
  target: AssistantRunTarget | null;
  continuesRunId: string | null;
  retryOfRunId: string | null;
  status: AssistantRunStatus;
  /** Where a recheck refused the run: access, grant, pause, cap or connection. */
  stoppedAtStage: 'before_read' | 'before_dispatch' | 'before_commit' | null;
  stopRequested: boolean;
  /** The runtime confirmed the stop (F-022 "Stop": requested and acknowledged are separate). */
  stopAcknowledged: boolean;
  engine: AssistantEngine;
  /** Why it ended without an answer, when the status alone does not say; null otherwise. */
  endReason: AssistantRunEndReason | null;
  /** With `plan_limit`: when the CLI said the plan resets, if it said so. */
  planLimitResetsAt: string | null;
  cost: {
    state: AssistantRunCostState;
    reservedMicros: number;
    chargedMicros: number;
    inputTokens: number | null;
    outputTokens: number | null;
  };
  /** Set once the answer was committed to the conversation. */
  answer: AssistantAnswer | null;
  createdAt: string;
  dispatchedAt: string | null;
  completedAt: string | null;
}

export type AssistantSourceRef =
  | { type: 'message'; id: string; revision: number }
  | { type: 'work'; id: string; revision: number }
  | { type: 'thought'; id: string; sketchId: string; revision: number };

/** A committed answer as the conversation's audience sees it. No cost, caps or connection. */
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

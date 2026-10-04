import type { Page, VersionPrecondition } from './access.js';
import type { AiPrice, AiProviderKind } from './ai-providers.js';
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
export const PERSONAL_RUN_CONSENT_VERSIONS = ['o-008-2026-09-28', PERSONAL_RUN_CONSENT_VERSION] as const;
export type PersonalRunConsentVersion = (typeof PERSONAL_RUN_CONSENT_VERSIONS)[number];

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
export type PersonalAssistantUnavailableReason = 'no_connection' | 'connection_changed' | 'provider_off' | 'price_unknown' | 'run_cost_over_limit';

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
  setup: { provider: 'on' | 'off'; connection: 'active' | 'none' };
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

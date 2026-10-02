import type {
  AiPrice, AiProviderKind, AssistantProposalStatus, AssistantRunCostState, AssistantRunKind, AssistantRunStatus, AssistantSourceRef,
  PersonalRunConsentVersion, PersonalRunEnablementStatus, ResultFinding,
} from '@flux/contracts';
import type { Principal } from '../principal.js';
import type { Paged, PageWindow } from '../work/ports.js';

/**
 * Ports of the personal assistant runs (issue #68, decision O-008). Core states what it needs;
 * the server and worker implement them with the access policy (`policyPersonalRunAccess`),
 * `@flux/db` rows, `recordEvent`, pg-boss and — later — the provider adapter and #124's key
 * connection. Nothing in `packages/core/src/personal-runs` imports those adapters.
 */

export interface EnablementRecord {
  ownerUserId: string;
  connectionId: string | null;
  consentVersion: PersonalRunConsentVersion;
  consentedAt: Date;
  consentProvider: AiProviderKind;
  consentModel: string;
  consentPayerOrganization: string;
  consentPayerWorkspace: string;
  perRunCents: number;
  dailyCapCents: number;
  timeZone: string;
  status: PersonalRunEnablementStatus;
  agents: { workspaceId: string; agentId: string }[];
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export type NewEnablement = Omit<EnablementRecord, 'agents' | 'version' | 'status' | 'consentedAt' | 'createdAt' | 'updatedAt'>;
export type EnablementChanges = Partial<Pick<EnablementRecord, 'perRunCents' | 'dailyCapCents' | 'timeZone' | 'status'>>;

export interface RunRecord {
  id: string;
  workspaceId: string;
  projectId: string;
  conversationId: string;
  ownerUserId: string;
  agentId: string;
  connectionId: string | null;
  clientRunId: string;
  requestFingerprint: string;
  kind: AssistantRunKind;
  prompt: string;
  targetSketchId: string | null;
  targetThoughtId: string | null;
  continuesRunId: string | null;
  retryOfRunId: string | null;
  status: AssistantRunStatus;
  stoppedAtStage: 'before_read' | 'before_dispatch' | 'before_commit' | null;
  stopRequestedAt: Date | null;
  costState: AssistantRunCostState;
  reservedMicros: number;
  chargedMicros: number;
  inputTokens: number | null;
  outputTokens: number | null;
  /** The connection's provider and model the run was reserved on (F-020). */
  provider: AiProviderKind;
  model: string;
  answerBody: string | null;
  answerTruncated: boolean;
  answerSources: AssistantSourceRef[];
  committedAt: Date | null;
  createdAt: Date;
  dispatchedAt: Date | null;
  completedAt: Date | null;
}

export type NewRun = Pick<RunRecord, 'id' | 'workspaceId' | 'projectId' | 'conversationId' | 'ownerUserId' | 'agentId' | 'connectionId'
  | 'clientRunId' | 'requestFingerprint' | 'kind' | 'prompt' | 'targetSketchId' | 'targetThoughtId' | 'continuesRunId' | 'retryOfRunId'
  | 'reservedMicros' | 'provider' | 'model'>;
export type RunChanges = Partial<Pick<RunRecord, 'status' | 'stoppedAtStage' | 'stopRequestedAt' | 'costState' | 'chargedMicros'
  | 'inputTokens' | 'outputTokens' | 'answerBody' | 'answerTruncated' | 'answerSources' | 'committedAt' | 'dispatchedAt' | 'completedAt'>>;

export interface ProposalRecord {
  id: string;
  workspaceId: string;
  projectId: string;
  runId: string;
  ownerUserId: string;
  fact: string;
  interpretation: string;
  resultTitle: string;
  resultFinding: ResultFinding;
  resultEvidence: string;
  finishesWorkId: string | null;
  status: AssistantProposalStatus;
  decidedBy: string | null;
  decidedAt: Date | null;
  resultId: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export type NewProposal = Pick<ProposalRecord, 'id' | 'workspaceId' | 'projectId' | 'runId' | 'ownerUserId' | 'fact' | 'interpretation'
  | 'resultTitle' | 'resultFinding' | 'resultEvidence' | 'finishesWorkId'>;
export type ProposalChanges = Partial<Pick<ProposalRecord, 'status' | 'decidedBy' | 'decidedAt' | 'resultId'>>;

/** Rows a run may read. The use cases authorize the run's agent (and owner) before calling these. */
export interface MessageSource { id: string; sequence: number; body: string; authorName: string; author: { kind: 'human' | 'agent'; id: string } }
export interface WorkSource { id: string; version: number; title: string; outcome: string; status: string }
export interface ThoughtSource { id: string; sketchId: string; version: number; text: string; sketchScope: 'project' | 'private' | 'dm'; sketchProjectId: string | null }

/** Rows only; the repository makes no access decisions (the use cases ask {@link PersonalRunAccess}). */
export interface PersonalRunRepository {
  enablement(ownerUserId: string, options?: { lock?: boolean }): Promise<EnablementRecord | null>;
  /** Null when the owner already has one (a concurrent enable). */
  insertEnablement(enablement: NewEnablement): Promise<EnablementRecord | null>;
  /** Applies the changes and increments the version; the caller holds the row lock. */
  updateEnablement(ownerUserId: string, changes: EnablementChanges): Promise<EnablementRecord>;
  deleteEnablement(ownerUserId: string): Promise<boolean>;
  /** Sets the owner's assistant agent for a workspace (one per workspace). */
  selectAgent(ownerUserId: string, workspaceId: string, agentId: string): Promise<void>;
  /**
   * The owner's use since the start of the current day in `timeZone`: charged micros of observed
   * runs, and held reservations of in-flight and unknown runs. `exceptRunId` leaves one run out.
   */
  spendToday(ownerUserId: string, timeZone: string, exceptRunId?: string): Promise<{ chargedMicros: number; reservedMicros: number; resetsAt: Date }>;
  /** The project of a conversation, whoever may read it; callers must authorize before using it. */
  locateConversation(conversationId: string): Promise<{ workspaceId: string; projectId: string } | null>;
  runByClientId(ownerUserId: string, clientRunId: string): Promise<RunRecord | null>;
  findRun(id: string, options?: { lock?: boolean }): Promise<RunRecord | null>;
  hasRunInFlight(ownerUserId: string): Promise<boolean>;
  insertRun(run: NewRun): Promise<RunRecord>;
  updateRun(id: string, changes: RunChanges): Promise<RunRecord>;
  /**
   * Ends the owner's queued and reading runs with `status` at zero cost (the reservation is
   * released) and returns them. Dispatching runs are left to the commit recheck.
   */
  endUndispatched(ownerUserId: string, status: 'paused' | 'revoked'): Promise<RunRecord[]>;
  /**
   * Ends the owner's in-flight runs untouched for `olderThanSeconds` (a crashed worker): a queued
   * or reading run as `unavailable` at zero cost, a dispatching one as `provider_failed` with its
   * reservation kept as `unknown`. Returns the ended runs.
   */
  endStale(ownerUserId: string, olderThanSeconds: number): Promise<RunRecord[]>;
  /**
   * The same for every owner, at most `limit` runs, skipping rows another sweep holds: the
   * background sweep, so a run a crashed worker left behind ends without the owner's next invoke.
   */
  endStaleAny(olderThanSeconds: number, limit: number): Promise<RunRecord[]>;
  /** Only the owner's own runs, newest first. */
  listOwnRuns(ownerUserId: string, page: PageWindow): Promise<Paged<RunRecord>>;
  /** Committed answers of a conversation, oldest first. */
  listAnswers(conversationId: string, page: PageWindow): Promise<Paged<RunRecord>>;
  /** Display names of people keyed by id. */
  names(userIds: string[]): Promise<Map<string, string>>;
  messages(conversationId: string, limit: number): Promise<MessageSource[]>;
  openWork(projectId: string, limit: number): Promise<WorkSource[]>;
  thought(sketchId: string, thoughtId: string): Promise<ThoughtSource | null>;
  insertProposal(proposal: NewProposal): Promise<ProposalRecord>;
  findProposal(id: string, options?: { lock?: boolean }): Promise<ProposalRecord | null>;
  proposalOfRun(runId: string): Promise<ProposalRecord | null>;
  /** Applies the changes and increments the version; the caller holds the row lock. */
  updateProposal(id: string, changes: ProposalChanges): Promise<ProposalRecord>;
  listProposals(projectId: string, page: PageWindow): Promise<Paged<ProposalRecord>>;
}

/** Adapter over the core access policy. It never reveals objects the principal cannot see. */
export interface PersonalRunAccess {
  /**
   * Throws NotFoundError when the project is invisible and ForbiddenError when `write` is not
   * allowed. Inside a commit pass `lock`, so a concurrent revocation waits or is seen.
   */
  requireProject(principal: Principal, action: 'read' | 'write', projectId: string, options?: { lock?: boolean }): Promise<{ workspaceId: string; level: 'viewer' | 'contributor' | 'manager' }>;
  /** Whether the principal may `read` or `write` the project now; never throws for invisible ones. */
  canUseProject(principal: Principal, action: 'read' | 'write', projectId: string, options?: { lock?: boolean }): Promise<boolean>;
  /** `agent.invoke`: only the person who owns the unrevoked agent. Throws the policy's 404/403. */
  requireInvoke(principal: Principal, agentId: string, options?: { lock?: boolean }): Promise<{ workspaceId: string }>;
  canInvoke(principal: Principal, agentId: string, options?: { lock?: boolean }): Promise<boolean>;
  canReadSketch(principal: Principal, sketchId: string, options?: { lock?: boolean }): Promise<boolean>;
}

/** Queues the dispatch job of a run in the unit of work. The payload is the run id only. */
export interface PersonalRunQueue {
  enqueue(runId: string): Promise<void>;
}

export type PersonalRunEventKind =
  /** Owner-only progress of one run; the object is the run (`assistant_run`). */
  | 'assistant_run.changed.v1'
  | 'project.assistant_answer_committed.v1'
  | 'project.assistant_proposal_created.v1'
  | 'project.assistant_proposal_decided.v1';

/**
 * Records a versioned event in the unit of work (identifiers only, never content). `objectId` is
 * the project for `project.*` kinds and the run for `assistant_run.*` kinds; the access policy
 * derives each event's audience from it.
 */
export interface PersonalRunEventLog {
  record(principal: Principal, workspaceId: string, kind: PersonalRunEventKind, objectId: string, data: Record<string, unknown>): Promise<void>;
}

export interface PersonalRunPorts {
  access: PersonalRunAccess;
  runs: PersonalRunRepository;
  queue: PersonalRunQueue;
  events: PersonalRunEventLog;
}

/** Runs `work` in one transaction; on an open transaction (an idempotency scope) it nests. */
export interface PersonalRunUnitOfWork {
  run<T>(work: (ports: PersonalRunPorts) => Promise<T>): Promise<T>;
}

/**
 * The owner's usable key connection (O-007 custody, #124). `keyRef` is an opaque handle only the
 * worker's provider adapter can turn into a key; core never sees key material. The provider, model,
 * base URL and price are the connection's own (F-020 PROV-1/PROV-3); `price` is null when unknown.
 */
export interface PersonalConnection {
  id: string;
  ownerUserId: string;
  status: 'active' | 'revoked';
  keyRef: string;
  payer: { organization: string; workspace: string };
  provider: AiProviderKind;
  model: string;
  /** `openai_compatible` only; null for a named provider's fixed URL. */
  baseUrl: string | null;
  price: AiPrice | null;
}

/** Resolves the connection of `ownerUserId` only; there is no lookup by connection id. */
export interface PersonalConnectionLookup {
  resolve(ownerUserId: string): Promise<PersonalConnection | null>;
}

/**
 * One bounded request (O-008 §3) to the owner's connection, the same for every provider (F-020):
 * no tools, no hosted search, no automatic retries. The adapter of `connection.provider` translates it.
 */
export interface PersonalComputeRequest {
  connection: { id: string; keyRef: string; provider: AiProviderKind; baseUrl: string | null };
  model: string;
  maxTokens: number;
  effort: 'low';
  system: string;
  input: string;
}

/** `reportedCostMicros`: the provider's own cost of the response, when it reports one (PROV-3 source 1). */
export interface PersonalComputeUsage { inputTokens: number; outputTokens: number; reportedCostMicros?: number | null }

export type PersonalComputeResult =
  | { kind: 'completed'; text: string; stopReason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'refusal'; usage: PersonalComputeUsage }
  /** `billed: 'none'` when the provider documents no charge (e.g. 429, 5xx before work); else `unknown`. */
  | { kind: 'failed'; reason: 'rate_limited' | 'overloaded' | 'provider_error' | 'timeout' | 'aborted'; billed: 'none' | 'unknown' };

/**
 * The provider behind the `agent-runtime` port: the adapters of `@flux/agent-runtime`, selected by
 * the connection's provider kind; `enabled` is the instance operator's switch (O-008 §6).
 */
export interface PersonalCompute {
  readonly enabled: boolean;
  /**
   * An optional provider token count of the request's input (free, not a dispatch). It may only
   * raise the conservative Flux estimate that bounds every provider's input (PROV-3).
   */
  countInputTokens?(request: PersonalComputeRequest): Promise<number | null>;
  /** Sends the request once. `signal` aborts it as best effort when the owner stops the run. */
  dispatch(request: PersonalComputeRequest, signal: AbortSignal): Promise<PersonalComputeResult>;
}

/**
 * The work use cases a proposal accept goes through, in the accept's transaction: the result is
 * recorded exactly as a person would record it, by the accepting person.
 */
export interface ProposalResultPort {
  findWork(workId: string, options?: { lock?: boolean }): Promise<{ id: string; projectId: string; version: number; ownerUserId: string | null } | null>;
  recordResult(principal: Principal, projectId: string, command: {
    title: string; finding: ResultFinding; evidence: string; work: string[]; finishes?: { id: string; expectedVersion: number };
  }): Promise<{ id: string }>;
}

export interface ProposalPorts extends PersonalRunPorts {
  results: ProposalResultPort;
}

export interface ProposalUnitOfWork {
  run<T>(work: (ports: ProposalPorts) => Promise<T>): Promise<T>;
}

import { randomUUID } from 'node:crypto';
import {
  ASSISTANT_PLAN_DEFAULT,
  assistantModelName,
  PERSONAL_RUN_CONSENT_VERSION,
  PERSONAL_RUN_LIMITS,
  PERSONAL_RUNTIME_CONSENT_VERSION,
  personalRunMaxInputTokens,
  RUNTIME_RUN_LIMITS,
  type AssistantAnswer,
  type AssistantModelChoice,
  type AssistantRun,
  type AssistantRunBehind,
  type ChangeAssistantModelCommand,
  type EnablePersonalRunsCommand,
  type InvokeAssistantRunCommand,
  type Page,
  type PageQuery,
  type PersonalAssistantStatus,
  type PersonalAssistantUnavailableReason,
  type PersonalRunEnablement,
  type RetryAssistantRunCommand,
  type SelectPersonalAgentCommand,
  type UpdatePersonalRunsCommand,
} from '@flux/contracts';
import {
  ConflictError, DomainError, ForbiddenError, InvalidInputError, NotFoundError, ServiceUnavailableError, VersionConflictError,
} from '../access/errors.js';
import type { Principal } from '../principal.js';
import { expectedVersion, id, isId, page } from '../work/validation.js';
import type {
  EnablementRecord, PersonalConnection, PersonalConnectionLookup, PersonalRunPorts, PersonalRunUnitOfWork, PersonalRuntimeAvailability, PersonalRuntimeClient, PersonalRuntimeStanding, RunRecord,
} from './ports.js';
import {
  apiModelAccount, CODEX_RUNTIME_MODEL, connectionOnModel, isModelId, modelChoice, modelNameOf, NO_MODEL_ACCOUNT, RUNTIME_MODEL, runtimeModelAccount, type ModelAccount,
} from './model.js';
import { announce, updateAndAnnounce } from './progress.js';
import {
  centsToMicros, connectionCallsTools, normalizeEnable, normalizeInvoke, normalizeUpdate, retryRequest, runReservationMicros, toolRunReservationMicros, type NormalizedInvoke,
} from './validation.js';

// Personal assistant runs (issue #68, decision O-008): the owner's enablement, invoke, stop,
// retry and the reads. Everything resolves the owner from the authenticated principal; a body
// never selects an owner, agent or connection. The run row, its reservation against the daily
// cap and its dispatch job commit in one transaction, under the owner's enablement row lock, so
// the one-run-in-flight rule and the cap hold under concurrent requests. A refused request
// writes no run and reserves nothing. Only the owner can read, stop or retry a run (others 404).

/** The daily cap cannot cover another run's ceiling (O-008 §3). */
export class PersonalRunCappedError extends DomainError {
  constructor() {
    super(429, 'PERSONAL_RUN_CAPPED', "Stopped at today's cap. It won't use another payer.");
  }
}

const IN_FLIGHT = new Set(['queued', 'reading', 'dispatching']);
/** What Flux's own tick asks for when a schedule or the morning summary is due (F-027 A8). */
export interface BackgroundRunSpec {
  ownerUserId: string;
  projectId: string;
  /** Where the run is anchored: the conversation a schedule posts in, or any conversation of the project for a silent run. */
  conversationId: string;
  kind: 'scheduled' | 'morning_summary';
  prompt: string;
  /** Deterministic per firing, so a repeated start returns the same run. */
  clientRunId: string;
  /** The answer stays out of the conversation (Recent keeps it). */
  silent: boolean;
  /** The short name the owner knows it by, for the lane's lines: "Finishing your Morning summary first" (F-027 AST-6 "Queue"). */
  label: string;
}
/** A background run that could not start says why in plain words; a sign-out fails the firing, anything else skips it. */
export type BackgroundStart =
  | { started: true; run: RunRecord; created: boolean }
  | { started: false; outcome: 'skipped' | 'failed'; line: string };

const SERVER_PROBLEM_LINE: Record<PersonalAssistantUnavailableReason, string> = {
  provider_off: 'Skipped: AI is switched off on this Flux', no_connection: 'Skipped: no AI account is connected', connection_changed: 'Skipped: your AI account changed',
  price_unknown: 'Skipped: your AI account has no known price', run_cost_over_limit: 'Skipped: one request can cost more than your limit',
  runtime_off: 'Skipped: subscription sign-in is off on this Flux', runtime_sign_in: 'Skipped: sign in again',
} as Record<PersonalAssistantUnavailableReason, string>;
/**
 * The provenance model of a runtime answer when the owner chose no model (a legacy assistant): Claude Code chooses it
 * under the owner's account. With a choice (F-027 AST-11) the run records the chosen model's id instead.
 */
export { RUNTIME_MODEL, CODEX_RUNTIME_MODEL };
/** Where a runtime run's content goes and how it is labelled: the vendor of the owner's CLI. */
export const runtimeVendor = (client: PersonalRuntimeClient | null | undefined) => (client === 'codex'
  ? { provider: 'openai' as const, model: CODEX_RUNTIME_MODEL, name: 'Codex' } : { provider: 'anthropic' as const, model: RUNTIME_MODEL, name: 'Claude Code' });
/** The CLI an enablement consented to, from the vendor its consent names. */
export const runtimeClientOf = (provider: string | null | undefined): PersonalRuntimeClient => (provider === 'openai' ? 'codex' : 'claude_code');
/** A run untouched this long was left by a crashed worker (the job itself expires after 5 minutes). */
export const STALE_AFTER_SECONDS = 15 * 60;
const iso = (date: Date) => date.toISOString();

export function ownerOf(principal: Principal): string {
  if (principal.kind !== 'human' || !principal.id) throw new InvalidInputError('A signed-in person is required');
  return principal.id;
}

export const assistantLabel = (name: string) => `${name}'s assistant`;
const runNotFound = () => new NotFoundError('Assistant run', 'ASSISTANT_RUN_NOT_FOUND');

function enablementView(record: EnablementRecord): PersonalRunEnablement {
  return {
    ownerUserId: record.ownerUserId, connectionId: record.connectionId,
    consent: {
      version: record.consentVersion, acceptedAt: iso(record.consentedAt), provider: record.consentProvider, model: record.consentModel,
      payer: { organization: record.consentPayerOrganization, workspace: record.consentPayerWorkspace },
    },
    perRunCents: record.perRunCents, dailyCapCents: record.dailyCapCents, timeZone: record.timeZone, status: record.status, engine: record.engine,
    model: record.assistantModel, agents: record.agents.map((agent) => ({ ...agent })), version: record.version,
    createdAt: iso(record.createdAt), updatedAt: iso(record.updatedAt),
  };
}

/** The answer as the place's audience sees it: no cost, cap, connection or hidden source. */
export async function answerView(ports: PersonalRunPorts, record: RunRecord): Promise<AssistantAnswer | null> {
  if (record.answerBody === null || !record.committedAt) return null;
  const names = await ports.runs.names([record.ownerUserId]);
  const name = names.get(record.ownerUserId) ?? 'Former member';
  const proposal = await ports.runs.proposalOfRun(record.id);
  const schedule = record.kind === 'scheduled' ? await ports.runs.jobOfRun?.(record.id) ?? null : null;
  return {
    runId: record.id, conversationId: record.conversationId, projectId: record.projectId,
    audience: { kind: 'project', projectId: record.projectId },
    assistant: { ownerUserId: record.ownerUserId, label: assistantLabel(name) },
    askedBy: { id: record.ownerUserId, name },
    request: { kind: record.kind, prompt: record.prompt }, body: record.answerBody, truncated: record.answerTruncated,
    provenance: { provider: record.provider, model: record.model }, sources: record.answerSources.map((source) => ({ ...source })),
    proposalId: proposal?.id ?? null, committedAt: iso(record.committedAt), ...(schedule ? { schedule } : {}),
  };
}

export async function runView(ports: PersonalRunPorts, record: RunRecord): Promise<AssistantRun> {
  return {
    id: record.id, clientRunId: record.clientRunId, workspaceId: record.workspaceId, projectId: record.projectId,
    conversationId: record.conversationId, kind: record.kind, prompt: record.kind === 'morning_summary' ? 'Your morning summary' : record.prompt, silent: record.silent,
    target: record.targetSketchId && record.targetThoughtId ? { type: 'thought', sketchId: record.targetSketchId, thoughtId: record.targetThoughtId } : null,
    continuesRunId: record.continuesRunId, retryOfRunId: record.retryOfRunId, status: record.status,
    stoppedAtStage: record.stoppedAtStage, stopRequested: record.stopRequestedAt !== null, stopAcknowledged: record.stopAcknowledgedAt !== null,
    engine: record.engine, model: record.model, runtimeClient: record.engine === 'runtime' ? runtimeClientOf(record.provider) : null, endReason: record.endReason, planLimitResetsAt: record.planLimitResetsAt ? iso(record.planLimitResetsAt) : null,
    cost: { state: record.costState, reservedMicros: record.reservedMicros, chargedMicros: record.chargedMicros, inputTokens: record.inputTokens, outputTokens: record.outputTokens },
    answer: await answerView(ports, record),
    authority: record.authority, backgroundLabel: record.backgroundLabel,
    behind: record.status === 'queued' ? await behindView(ports, record) : null,
    createdAt: iso(record.createdAt), dispatchedAt: record.dispatchedAt ? iso(record.dispatchedAt) : null,
    completedAt: record.completedAt ? iso(record.completedAt) : null,
  };
}

/** The run holding the owner's lane, for the line of a request waiting behind it (AST-6 "Queue"). */
async function behindView(ports: PersonalRunPorts, record: RunRecord): Promise<AssistantRunBehind | null> {
  const working = await ports.runs.workingOf(record.ownerUserId);
  return working && working.id !== record.id ? { runId: working.id, authority: working.authority, label: working.backgroundLabel } : null;
}

/**
 * The owner's usable connection and what one run on it reserves (F-020 PROV-3), or why it cannot
 * be used now: no price means nothing can be reserved, and a model whose largest request costs more
 * than the owner's per-run ceiling is never started. There is never another connection to fall back to.
 * With `turns` above one (a worker that runs the tool loop, F-027 AST-8) a connection that can call
 * tools reserves its turns × the largest request, never above the per-run ceiling.
 */
export async function usableConnection(connections: PersonalConnectionLookup, providerEnabled: boolean, enablement: EnablementRecord, turns = 1):
  Promise<{ problem: PersonalAssistantUnavailableReason } | { problem: null; connection: PersonalConnection; reservedMicros: number }> {
  if (!providerEnabled) return { problem: 'provider_off' };
  // The connection the consent names, and no other (PROV-1): removing it stops the assistant.
  const named = enablement.connectionId ? await connections.resolve(enablement.ownerUserId, enablement.connectionId) : null;
  // On the model the owner chose (F-027 AST-11): the connection's own, or another of its provider with a table price.
  const connection = named && connectionOnModel(named, enablement.assistantModel);
  if (named && !connection) return { problem: 'price_unknown' };
  if (!connection || connection.status !== 'active' || connection.ownerUserId !== enablement.ownerUserId || connection.id !== enablement.connectionId) {
    // The consent was given for one connection. When it is gone but the owner has another, say so:
    // that one needs its own consent, so the assistant is enabled again on it.
    const other = await connections.resolve(enablement.ownerUserId);
    return { problem: other && other.status === 'active' && other.ownerUserId === enablement.ownerUserId ? 'connection_changed' : 'no_connection' };
  }
  // A run with tools has the larger per-request input bound (#484): one such request must fit the ceiling.
  const tools = turns > 1 && connectionCallsTools(connection);
  const oneRequest = runReservationMicros(connection.price, tools);
  if (oneRequest === null) return { problem: 'price_unknown' };
  if (oneRequest > centsToMicros(enablement.perRunCents)) return { problem: 'run_cost_over_limit' };
  const reservedMicros = tools ? toolRunReservationMicros(connection.price, centsToMicros(enablement.perRunCents), turns) ?? oneRequest : oneRequest;
  return { problem: null, connection, reservedMicros };
}

/** Why the owner's connection cannot be used now, or null when it can. */
export async function connectionProblem(connections: PersonalConnectionLookup, providerEnabled: boolean, enablement: EnablementRecord): Promise<PersonalAssistantUnavailableReason | null> {
  return (await usableConnection(connections, providerEnabled, enablement)).problem;
}

function unavailable(reason: PersonalAssistantUnavailableReason) {
  const error = new ServiceUnavailableError('Your assistant is unavailable. Human work continues; no other payer is used.', 'PERSONAL_RUN_UNAVAILABLE');
  error.details = { reason };
  return error;
}

/** A body that names another owner, agent or connection is refused before anything is read or reserved. */
function refuseForeignIds(claimed: NormalizedInvoke['claimed'], owner: string, enablement: EnablementRecord | null, workspaceId: string) {
  const agentId = enablement?.agents.find((agent) => agent.workspaceId === workspaceId)?.agentId ?? null;
  const foreign = (claimed.ownerId !== null && claimed.ownerId !== owner)
    || (claimed.agentId !== null && claimed.agentId.toLowerCase() !== agentId)
    || (claimed.connectionId !== null && (!enablement?.connectionId || claimed.connectionId.toLowerCase() !== enablement.connectionId));
  if (foreign) throw new ForbiddenError('A run always uses your own assistant and connection', 'PERSONAL_RUN_NOT_OWNER');
}

/**
 * The production connection lookup until #124's owner key connections land: nobody has a usable
 * connection, so enabling and every run fail closed with an explicit state. There is no fallback.
 */
export const noPersonalConnections: PersonalConnectionLookup = { resolve: async () => null };

export interface PersonalRunDeps {
  uow: PersonalRunUnitOfWork;
  connections: PersonalConnectionLookup;
  /** The instance operator's provider switch (O-008 §6); false fails every run closed. */
  providerEnabled: boolean;
  /**
   * The most requests of one run when the worker runs the tool loop (F-027 AST-8). A run on a
   * connection that can call tools then reserves up to this many maximum requests, never above the
   * owner's per-run ceiling. Default 1: the single request of O-008.
   */
  toolTurns?: number;
  /**
   * The owner's own Claude Code in the agent runtime (F-022 AIM-3, #280). Without it, or with the operator
   * switch off, a runtime assistant cannot be enabled or run.
   */
  runtime?: PersonalRuntimeAvailability;
}

const RUNTIME_OFF: PersonalRuntimeStanding = { state: 'off', payer: null, accountLabel: null };

/** The plain error of a model the account cannot use (F-027 AST-11): `ASSISTANT_MODEL_UNAVAILABLE`, nothing changes. */
const modelUnavailable = (message: string) => new ConflictError(message, 'ASSISTANT_MODEL_UNAVAILABLE');

/**
 * The model a turn-on stores: the owner's pick when it is in the account's list; none (null, as before AST-11) when the
 * request names no model. The screens always name one: the preselected default of the list.
 */
function chosenAtTurnOn(account: ModelAccount, wanted: string | undefined): string | null {
  if (wanted === undefined) return null;
  if (!isModelId(wanted, account.engine ?? 'runtime') || !account.options.some((option) => option.id === wanted))
    throw modelUnavailable(`Your ${account.plan} doesn't offer that model. Nothing was turned on.`);
  return wanted;
}

/** The consent's payer line for a runtime assistant, from the CLI's reported method only (F-022 "Payer and data"). */
function runtimePayerLabel(standing: PersonalRuntimeStanding) {
  switch (standing.payer) {
    case 'claude_plan': return 'Your Claude plan';
    case 'anthropic_console': return 'Your Anthropic Console organization';
    case 'chatgpt_plan': return 'Your ChatGPT plan';
    case 'openai_api': return 'Your OpenAI API organization';
    default: return standing.client === 'codex' ? 'Your ChatGPT or OpenAI account' : 'Your Claude account';
  }
}

export function createPersonalRunUseCases({ uow, connections, providerEnabled, toolTurns = 1, runtime }: PersonalRunDeps) {
  const runtimeStanding = async (owner: string, client?: PersonalRuntimeClient) => (runtime ? await runtime.standing(owner, client).catch(() => RUNTIME_OFF) : RUNTIME_OFF);
  /** Why a runtime assistant cannot run now, or null when it can. */
  const runtimeProblem = (standing: PersonalRuntimeStanding): PersonalAssistantUnavailableReason | null =>
    standing.state === 'off' ? 'runtime_off' : standing.state === 'signed_in' ? null : 'runtime_sign_in';
  async function status(ports: PersonalRunPorts, owner: string): Promise<PersonalAssistantStatus> {
    const named = await ports.runs.enablement(owner);
    const connection = providerEnabled ? await connections.resolve(owner, named?.connectionId ?? undefined) : null;
    const onChosen = connection && connectionOnModel(connection, named?.engine === 'server' ? named.assistantModel : null);
    const usable = onChosen && onChosen.status === 'active' && onChosen.ownerUserId === owner ? onChosen : null;
    // The disclosure names the caller's own connection: its provider, model and price (F-020).
    const withTools = toolTurns > 1 && !!usable && connectionCallsTools(usable);
    const disclosure = {
      consentVersion: PERSONAL_RUN_CONSENT_VERSION, provider: usable?.provider ?? null, model: usable?.model ?? null,
      price: usable?.price ? { ...usable.price } : null, maxRunMicros: usable ? runReservationMicros(usable.price, withTools) : null,
      maxInputTokens: personalRunMaxInputTokens(withTools), maxOutputTokens: PERSONAL_RUN_LIMITS.maxOutputTokens,
      dataSent: 'project_place_excerpts',
    } as const;
    // Whether the owner has any active connection: with `connection_changed` the consented one is
    // gone but another exists, so setup must not also say that no key is connected.
    const other = !usable && providerEnabled && named ? await connections.resolve(owner) : null;
    const owns = Boolean(usable) || (other?.status === 'active' && other.ownerUserId === owner);
    // A runtime assistant's standing is its consented CLI's; before consent, the CLI it would consent to.
    const standing = await runtimeStanding(owner, named?.engine === 'runtime' ? runtimeClientOf(named.consentProvider) : undefined);
    const setup = {
      provider: providerEnabled ? 'on' as const : 'off' as const,
      connection: owns ? 'active' as const : 'none' as const,
      runtime: { state: standing.state, payer: standing.payer, accountLabel: standing.accountLabel, client: standing.state === 'off' ? null : standing.client ?? 'claude_code' },
    };
    const enablement = await ports.runs.enablement(owner);
    if (!enablement) return { state: 'not_enabled', unavailableReason: null, enablement: null, setup, today: null, disclosure };
    const spend = await ports.runs.spendToday(owner, enablement.timeZone);
    const today = { chargedMicros: spend.chargedMicros, reservedMicros: spend.reservedMicros, capCents: enablement.dailyCapCents, resetsAt: iso(spend.resetsAt) };
    const view = enablementView(enablement);
    if (enablement.status === 'paused') return { state: 'paused', unavailableReason: null, enablement: view, setup, today, disclosure };
    if (enablement.engine === 'runtime') {
      // The owner's own Claude Code: no money is reserved; the cap is runs per day (F-022 "Caps").
      const problem = runtimeProblem(standing);
      if (problem) return { state: 'unavailable', unavailableReason: problem, enablement: view, setup, today, disclosure };
      const runs = ports.runs.runtimeRunsToday ? await ports.runs.runtimeRunsToday(owner, enablement.timeZone) : 0;
      return { state: runs >= RUNTIME_RUN_LIMITS.runsPerDay ? 'capped' : 'ready', unavailableReason: null, enablement: view, setup, today, disclosure };
    }
    const usableNow = await usableConnection(connections, providerEnabled, enablement, toolTurns);
    if (usableNow.problem) return { state: 'unavailable', unavailableReason: usableNow.problem, enablement: view, setup, today, disclosure };
    const capped = spend.chargedMicros + spend.reservedMicros + usableNow.reservedMicros > centsToMicros(enablement.dailyCapCents);
    return { state: capped ? 'capped' : 'ready', unavailableReason: null, enablement: view, setup, today, disclosure };
  }

  /**
   * What the owner may choose on their account now (F-027 AST-11). With an assistant: the engine it was turned on with, and
   * an empty list when that account is signed out or its connection is gone. Before: the plan they are signed in to, else
   * their newest API key connection, else nothing. Never another person's.
   */
  async function modelAccount(owner: string, enablement: EnablementRecord | null, connectionId?: string): Promise<{ account: ModelAccount; connection: PersonalConnection | null }> {
    if (enablement?.engine === 'runtime') {
      const client = runtimeClientOf(enablement.consentProvider);
      const account = runtimeModelAccount(client);
      return { account: (await runtimeStanding(owner, client)).state === 'signed_in' ? account : { ...account, options: [] }, connection: null };
    }
    if (enablement) {
      const connection = providerEnabled && enablement.connectionId ? await connections.resolve(owner, enablement.connectionId) : null;
      const usable = connection && connection.status === 'active' && connection.ownerUserId === owner ? connection : null;
      return { account: usable ? apiModelAccount(usable) : { ...NO_MODEL_ACCOUNT, engine: 'server', account: 'api_key', plan: "API key's provider" }, connection: usable };
    }
    // The API key way names its connection (the owner may have several); the plan way is the one signed in.
    const standing = connectionId ? null : await runtimeStanding(owner);
    if (standing?.state === 'signed_in') return { account: runtimeModelAccount(standing.client ?? 'claude_code'), connection: null };
    const connection = providerEnabled ? await connections.resolve(owner, connectionId) : null;
    if (connection && connection.status === 'active' && connection.ownerUserId === owner) return { account: apiModelAccount(connection), connection };
    return { account: NO_MODEL_ACCOUNT, connection: null };
  }

  async function lockedEnablement(ports: PersonalRunPorts, owner: string) {
    const enablement = await ports.runs.enablement(owner, { lock: true });
    if (!enablement) throw new ConflictError('Your assistant is not enabled', 'PERSONAL_RUN_NOT_ENABLED');
    return enablement;
  }

  /**
   * The shared path of invoke, continue and retry. Order matters: identity claims, then the
   * place, then the caller's own enablement, connection, agent, in-flight rule and cap. Nothing
   * is written unless every check passes.
   */
  async function start(ports: PersonalRunPorts, principal: Principal, conversationId: string, request: NormalizedInvoke, retryOfRunId: string | null) {
    const owner = ownerOf(principal);
    const place = isId(conversationId) ? await ports.runs.locateConversation(conversationId.toLowerCase()) : null;
    if (!place) throw new NotFoundError('Conversation', 'CONVERSATION_NOT_FOUND');
    try {
      // The answer is posted to the conversation: like a message, it needs project write access.
      await ports.access.requireProject(principal, 'write', place.projectId, { lock: true });
    } catch (error) {
      if (error instanceof NotFoundError) throw new NotFoundError('Conversation', 'CONVERSATION_NOT_FOUND');
      throw error;
    }
    // The owner's row lock serializes this owner's invocations: same-key retries, the
    // one-in-flight rule and the cap reservation cannot race.
    const enablement = await ports.runs.enablement(owner, { lock: true });
    refuseForeignIds(request.claimed, owner, enablement, place.workspaceId);
    const existing = await ports.runs.runByClientId(owner, request.clientRunId);
    if (existing) {
      if (existing.requestFingerprint !== request.fingerprint || existing.conversationId !== conversationId.toLowerCase() || existing.retryOfRunId !== retryOfRunId)
        throw new ConflictError('This clientRunId was used for another run', 'IDEMPOTENCY_CONFLICT');
      return { run: existing, created: false };
    }
    if (request.continuesRunId) {
      const earlier = await ports.runs.findRun(request.continuesRunId);
      if (!earlier || earlier.ownerUserId !== owner || earlier.conversationId !== conversationId.toLowerCase()) throw runNotFound();
      if (earlier.answerBody === null) throw new ConflictError('Only a committed answer can be continued', 'ASSISTANT_RUN_NOT_CONTINUABLE');
    }
    if (request.target && !(await ports.access.canReadSketch(principal, request.target.sketchId))) throw new NotFoundError('Thought', 'THOUGHT_NOT_FOUND');
    if (!enablement) throw new ConflictError('Your assistant is not enabled', 'PERSONAL_RUN_NOT_ENABLED');
    if (enablement.status === 'paused') throw new ConflictError('Your assistant is paused', 'PERSONAL_RUN_PAUSED');
    const onRuntime = enablement.engine === 'runtime';
    const runtimeClient = onRuntime ? runtimeClientOf(enablement.consentProvider) : null;
    const problem = onRuntime ? runtimeProblem(await runtimeStanding(owner, runtimeClient ?? undefined)) : null;
    if (problem) throw unavailable(problem);
    const usableNow = onRuntime ? null : await usableConnection(connections, providerEnabled, enablement, toolTurns);
    if (usableNow?.problem) throw unavailable(usableNow.problem);
    const agentId = enablement.agents.find((agent) => agent.workspaceId === place.workspaceId)?.agentId;
    if (!agentId || !(await ports.access.canInvoke(principal, agentId, { lock: true })))
      throw new ConflictError('Choose your assistant for this workspace first', 'PERSONAL_RUN_NO_AGENT');
    const agent = { kind: 'agent' as const, id: agentId };
    if (!(await ports.access.canUseProject(agent, 'read', place.projectId, { lock: true })))
      throw new ConflictError('Your assistant has no access to this project', 'PERSONAL_RUN_NO_PROJECT_ACCESS');
    const taskFence = await ports.runs.prepareTaskUse(place.projectId, conversationId.toLowerCase());
    // A run a crashed worker left behind must not block the owner forever (the job expires after 5 minutes).
    for (const ended of await ports.runs.endStale(owner, STALE_AFTER_SECONDS)) await announce(ports, ended);
    if (await ports.runs.inFlightCount(owner) >= 2) throw new ConflictError('Your assistant is already working on a request', 'PERSONAL_RUN_IN_FLIGHT');
    let reservation: { reservedMicros: number; provider: PersonalConnection['provider']; model: string };
    if (!usableNow) {
      // F-022 "Caps": a runtime run reserves no money; it counts against the owner's runs per day.
      if (ports.runs.runtimeRunsToday && await ports.runs.runtimeRunsToday(owner, enablement.timeZone) >= RUNTIME_RUN_LIMITS.runsPerDay) throw new PersonalRunCappedError();
      const vendor = runtimeVendor(runtimeClient);
      // The model is fixed when the request is sent (F-027 AST-11): a later change never reaches this run. With none chosen
      // the run is recorded under the engine's label and starts the CLI with no model flag, as before.
      const chosen = enablement.assistantModel;
      reservation = { reservedMicros: 0, provider: vendor.provider, model: chosen && chosen !== ASSISTANT_PLAN_DEFAULT ? chosen : vendor.model };
    } else {
      const spend = await ports.runs.spendToday(owner, enablement.timeZone);
      // PROV-3: the run reserves its largest possible cost at the connection's price.
      const { reservedMicros, connection } = usableNow;
      if (spend.chargedMicros + spend.reservedMicros + reservedMicros > centsToMicros(enablement.dailyCapCents)) throw new PersonalRunCappedError();
      reservation = { reservedMicros, provider: connection.provider, model: connection.model };
    }
    const run = await ports.runs.insertRun({
      id: randomUUID(), workspaceId: place.workspaceId, projectId: place.projectId, conversationId: conversationId.toLowerCase(),
      ownerUserId: owner, agentId, connectionId: enablement.connectionId, clientRunId: request.clientRunId,
      requestFingerprint: request.fingerprint, kind: request.kind, prompt: request.prompt,
      targetSketchId: request.target?.sketchId ?? null, targetThoughtId: request.target?.thoughtId ?? null,
      continuesRunId: request.continuesRunId, retryOfRunId, ...reservation, engine: enablement.engine,
    });
    await ports.queue.enqueue(run.id);
    await taskFence.mark();
    // Only the owner learns that the run exists (O-008 §4 "Progress").
    await announce(ports, run);
    return { run, created: true };
  }

  async function ownRun(ports: PersonalRunPorts, principal: Principal, runId: unknown, lock = false) {
    const owner = ownerOf(principal);
    if (!isId(runId)) throw runNotFound();
    const run = await ports.runs.findRun(runId.toLowerCase(), { lock });
    if (!run || run.ownerUserId !== owner) throw runNotFound();
    return run;
  }

  /**
   * F-027 A8: starts the owner's scheduled or morning-summary run on the same path as a request: the owner's enablement
   * (pause, removal), the connection or the signed-in CLI, the assistant's and the owner's current access to the project and
   * the daily caps are all checked, and the run, its reservation and its dispatch job commit with the caller's transaction.
   * Nothing falls back to another account; a run that cannot start says why and writes nothing.
   */
  async function startBackground(ports: PersonalRunPorts, spec: BackgroundRunSpec): Promise<BackgroundStart> {
    const skipped = (line: string): BackgroundStart => ({ started: false, outcome: 'skipped', line });
    const owner = spec.ownerUserId;
    const principal: Principal = { kind: 'human', id: owner };
    const place = await ports.runs.locateConversation(spec.conversationId);
    if (!place || place.projectId !== spec.projectId) return skipped('Skipped: this project has no conversation yet');
    // The assistant changes things as the owner's: the owner must still be able to write here.
    if (!(await ports.access.canUseProject(principal, 'write', spec.projectId, { lock: true }))) return skipped('Skipped: you no longer have access to this project');
    const existing = await ports.runs.runByClientId(owner, spec.clientRunId);
    if (existing) return { started: true, run: existing, created: false };
    const enablement = await ports.runs.enablement(owner, { lock: true });
    if (!enablement) return skipped('Skipped: your assistant is off');
    if (enablement.status === 'paused') return skipped('Skipped: your assistant is paused');
    const onRuntime = enablement.engine === 'runtime';
    const runtimeClient = onRuntime ? runtimeClientOf(enablement.consentProvider) : null;
    if (onRuntime) {
      const problem = runtimeProblem(await runtimeStanding(owner, runtimeClient ?? undefined));
      if (problem === 'runtime_sign_in') return { started: false, outcome: 'failed', line: `Sign in to ${runtimeClient === 'codex' ? 'ChatGPT' : 'Claude'} again` };
      if (problem) return skipped(SERVER_PROBLEM_LINE[problem]);
    }
    const usableNow = onRuntime ? null : await usableConnection(connections, providerEnabled, enablement, toolTurns);
    if (usableNow?.problem) return skipped(SERVER_PROBLEM_LINE[usableNow.problem]);
    const agentId = enablement.agents.find((agent) => agent.workspaceId === place.workspaceId)?.agentId;
    if (!agentId || !(await ports.access.canInvoke(principal, agentId, { lock: true }))) return skipped('Skipped: your assistant is not available');
    if (!(await ports.access.canUseProject({ kind: 'agent', id: agentId }, 'read', place.projectId, { lock: true }))) return skipped('Skipped: I\'m not in this project');
    const taskFence = await ports.runs.prepareTaskUse(place.projectId, spec.conversationId);
    for (const ended of await ports.runs.endStale(owner, STALE_AFTER_SECONDS)) await announce(ports, ended);
    let reservation: { reservedMicros: number; provider: PersonalConnection['provider']; model: string };
    if (!usableNow) {
      if (ports.runs.runtimeRunsToday && await ports.runs.runtimeRunsToday(owner, enablement.timeZone) >= RUNTIME_RUN_LIMITS.runsPerDay) return skipped('Skipped: daily limit');
      const vendor = runtimeVendor(runtimeClient);
      const chosen = enablement.assistantModel;
      reservation = { reservedMicros: 0, provider: vendor.provider, model: chosen && chosen !== ASSISTANT_PLAN_DEFAULT ? chosen : vendor.model };
    } else {
      const spend = await ports.runs.spendToday(owner, enablement.timeZone);
      if (spend.chargedMicros + spend.reservedMicros + usableNow.reservedMicros > centsToMicros(enablement.dailyCapCents)) return skipped('Skipped: daily limit');
      reservation = { reservedMicros: usableNow.reservedMicros, provider: usableNow.connection.provider, model: usableNow.connection.model };
    }
    const run = await ports.runs.insertRun({
      id: randomUUID(), workspaceId: place.workspaceId, projectId: place.projectId, conversationId: spec.conversationId, ownerUserId: owner, agentId,
      connectionId: enablement.connectionId, clientRunId: spec.clientRunId, requestFingerprint: `background:${spec.kind}:${spec.clientRunId}`, kind: spec.kind,
      prompt: spec.prompt, targetSketchId: null, targetThoughtId: null, continuesRunId: null, retryOfRunId: null, ...reservation, engine: enablement.engine, silent: spec.silent,
      // A schedule is the owner's own stored request: it waits behind their own requests and says what it is (AST-6 "Queue").
      authority: 'owner_schedule', backgroundLabel: spec.label.trim().slice(0, 80) || 'Schedule',
    });
    await ports.queue.enqueue(run.id);
    await taskFence.mark();
    await announce(ports, run);
    return { started: true, run, created: true };
  }

  return {
    startBackground,
    status: (principal: Principal) => uow.run((ports) => status(ports, ownerOf(principal))),

    /** The caller's own assistant model and what they may choose (F-027 AST-11). */
    model: (principal: Principal, connectionId?: string): Promise<AssistantModelChoice> => {
      const owner = ownerOf(principal);
      return uow.run(async (ports) => {
        const enablement = await ports.runs.enablement(owner);
        return modelChoice((await modelAccount(owner, enablement, connectionId)).account, enablement?.assistantModel ?? null, !!enablement);
      });
    },

    /**
     * Changes the assistant's one model (AST-11). Only a model in the account's list is accepted; anything else is a plain
     * error and the previous model stays. The change reaches the next request: a request already sent keeps the model it
     * recorded.
     */
    async chooseModel(principal: Principal, command: ChangeAssistantModelCommand): Promise<AssistantModelChoice> {
      const owner = ownerOf(principal);
      const wanted: unknown = command?.model;
      return uow.run(async (ports) => {
        const enablement = await lockedEnablement(ports, owner);
        const { account, connection } = await modelAccount(owner, enablement);
        const before = modelChoice(account, enablement.assistantModel, true);
        const still = ` It is still ${modelNameOf(before)}.`;
        if (!account.options.length) {
          throw modelUnavailable(account.engine === 'runtime' ? `Sign in to ${account.company ?? 'your account'} again to change the model.${still}`
            : `Connect your API key again to change the model.${still}`);
        }
        const option = typeof wanted === 'string' && isModelId(wanted, account.engine ?? 'runtime') ? account.options.find((item) => item.id === wanted) : undefined;
        if (!option) throw modelUnavailable(`Your ${account.plan} doesn't offer that model.${still}`);
        if (account.engine === 'server' && connection) {
          const priced = connectionOnModel(connection, option.id);
          if (!priced?.price) throw modelUnavailable(`Flux doesn't know the price of that model yet.${still}`);
          const largest = runReservationMicros(priced.price, toolTurns > 1 && connectionCallsTools(priced));
          if (largest === null || largest > centsToMicros(enablement.perRunCents))
            throw modelUnavailable(`One request to ${assistantModelName(option.id)} can cost more than your per-request limit.${still}`);
        }
        if (option.id === before.current) return before;
        await ports.runs.updateEnablement(owner, { assistantModel: option.id });
        return modelChoice(account, option.id, true);
      });
    },

    /** Needs the owner's usable key connection; the consent snapshots its payer. */
    async enable(principal: Principal, command: EnablePersonalRunsCommand): Promise<PersonalAssistantStatus> {
      const owner = ownerOf(principal);
      const input = normalizeEnable(command);
      return uow.run(async (ports) => {
        await ports.assistants?.lockOwner(owner);
        const { workspaceId } = await ports.access.requireInvoke(principal, input.agentId, { lock: true });
        if (await ports.runs.enablement(owner, { lock: true })) throw new ConflictError('Your assistant is already enabled', 'PERSONAL_RUN_ALREADY_ENABLED');
        if (input.engine === 'runtime') {
          // The owner's own signed-in Claude Code or Codex (F-022 AIM-3, T6): its consent names the plan as
          // payer and the CLI's vendor as where the place's content goes, so the runs use that CLI only.
          // No API key connection is used or needed.
          const standing = await runtimeStanding(owner);
          if (standing.state === 'off') throw new ConflictError('Subscription sign-in is off on this Flux server', 'PERSONAL_RUN_RUNTIME_OFF');
          if (standing.state !== 'signed_in') throw new ConflictError('Sign in to Claude or ChatGPT in Settings first', 'PERSONAL_RUN_RUNTIME_SIGN_IN');
          const vendor = runtimeVendor(standing.client);
          const account = runtimeModelAccount(standing.client ?? 'claude_code');
          const model = chosenAtTurnOn(account, input.model);
          const created = await ports.runs.insertEnablement({
            ownerUserId: owner, connectionId: null, consentVersion: PERSONAL_RUNTIME_CONSENT_VERSION, consentProvider: vendor.provider, consentModel: vendor.model,
            assistantModel: model,
            consentPayerOrganization: runtimePayerLabel(standing), consentPayerWorkspace: standing.accountLabel ?? vendor.name,
            perRunCents: input.perRunCents, dailyCapCents: input.dailyCapCents, timeZone: input.timeZone, engine: 'runtime',
          });
          if (!created) throw new ConflictError('Your assistant is already enabled', 'PERSONAL_RUN_ALREADY_ENABLED');
          await ports.runs.selectAgent(owner, workspaceId, input.agentId);
          await ports.assistants?.ensure(owner, workspaceId, input.agentId);
          return status(ports, owner);
        }
        // The owner chooses which of their connections the assistant uses; without a choice, their newest.
        const connection = await connections.resolve(owner, input.connectionId ?? undefined);
        if (!connection || connection.status !== 'active' || connection.ownerUserId !== owner)
          throw new ConflictError('Connect your own AI key before enabling your assistant', 'PERSONAL_RUN_CONNECTION_REQUIRED');
        // PROV-3: a connection without a known price cannot be enabled; a model whose largest
        // request exceeds the chosen per-run ceiling would never run.
        // The model the owner chose, at its price (F-027 AST-11): the connection's own, or another of its provider in Flux's table.
        const model = chosenAtTurnOn(apiModelAccount(connection), input.model);
        const priced = connectionOnModel(connection, model);
        if (!priced) throw modelUnavailable(`Flux doesn't know the price of that model yet. Nothing was turned on.`);
        const reservation = runReservationMicros(priced.price, toolTurns > 1 && connectionCallsTools(priced));
        if (reservation === null) throw new ConflictError('Your AI connection has no known price', 'PERSONAL_RUN_PRICE_UNKNOWN');
        if (reservation > centsToMicros(input.perRunCents))
          throw new ConflictError('One request to this model can cost more than your per-request limit', 'PERSONAL_RUN_COST_OVER_LIMIT');
        const created = await ports.runs.insertEnablement({
          ownerUserId: owner, connectionId: connection.id, consentVersion: PERSONAL_RUN_CONSENT_VERSION,
          consentProvider: connection.provider, consentModel: connection.model, assistantModel: model,
          consentPayerOrganization: connection.payer.organization, consentPayerWorkspace: connection.payer.workspace,
          perRunCents: input.perRunCents, dailyCapCents: input.dailyCapCents, timeZone: input.timeZone,
        });
        if (!created) throw new ConflictError('Your assistant is already enabled', 'PERSONAL_RUN_ALREADY_ENABLED');
        await ports.runs.selectAgent(owner, workspaceId, input.agentId);
        await ports.assistants?.ensure(owner, workspaceId, input.agentId);
        return status(ports, owner);
      });
    },

    async update(principal: Principal, command: UpdatePersonalRunsCommand, expected?: number): Promise<PersonalAssistantStatus> {
      const owner = ownerOf(principal);
      const changes = normalizeUpdate(command);
      const version = expectedVersion(expected ?? command.expectedVersion);
      return uow.run(async (ports) => {
        const current = await lockedEnablement(ports, owner);
        if (current.version !== version) throw new VersionConflictError(current.version, enablementView(current));
        if ((changes.perRunCents ?? current.perRunCents) > (changes.dailyCapCents ?? current.dailyCapCents))
          throw new InvalidInputError('perRunCents cannot exceed dailyCapCents');
        await ports.runs.updateEnablement(owner, changes);
        return status(ports, owner);
      });
    },

    async selectAgent(principal: Principal, command: SelectPersonalAgentCommand): Promise<PersonalAssistantStatus> {
      const owner = ownerOf(principal);
      const agentId = id(command?.agentId, 'agentId');
      return uow.run(async (ports) => {
        await ports.assistants?.lockOwner(owner);
        const { workspaceId } = await ports.access.requireInvoke(principal, agentId, { lock: true });
        await lockedEnablement(ports, owner);
        await ports.runs.selectAgent(owner, workspaceId, agentId);
        await ports.assistants?.ensure(owner, workspaceId, agentId);
        await ports.runs.updateEnablement(owner, {});
        return status(ports, owner);
      });
    },

    /** Pausing ends queued work at zero cost; a dispatching run commits nothing (commit recheck). */
    async pause(principal: Principal): Promise<PersonalAssistantStatus> {
      const owner = ownerOf(principal);
      return uow.run(async (ports) => {
        const current = await lockedEnablement(ports, owner);
        if (current.status !== 'paused') await ports.runs.updateEnablement(owner, { status: 'paused' });
        for (const ended of await ports.runs.endUndispatched(owner, 'paused')) await announce(ports, ended);
        return status(ports, owner);
      });
    },

    async resume(principal: Principal): Promise<PersonalAssistantStatus> {
      const owner = ownerOf(principal);
      return uow.run(async (ports) => {
        const current = await lockedEnablement(ports, owner);
        if (current.status !== 'active') await ports.runs.updateEnablement(owner, { status: 'active' });
        return status(ports, owner);
      });
    },

    /** Deletes the enablement and its consent; queued work ends at zero cost. */
    async remove(principal: Principal): Promise<void> {
      const owner = ownerOf(principal);
      await uow.run(async (ports) => {
        await ports.assistants?.lockOwner(owner);
        await lockedEnablement(ports, owner);
        for (const ended of await ports.runs.endUndispatched(owner, 'revoked')) await announce(ports, ended);
        await ports.assistants?.remove(owner);
        await ports.runs.deleteEnablement(owner);
      });
    },

    async invoke(principal: Principal, conversationId: string, command: InvokeAssistantRunCommand): Promise<{ run: AssistantRun; created: boolean }> {
      ownerOf(principal);
      const request = normalizeInvoke(command);
      return uow.run(async (ports) => {
        const started = await start(ports, principal, conversationId, request, null);
        return { run: await runView(ports, started.run), created: started.created };
      });
    },

    /** A new, separately capped run with the retried run's request. */
    async retry(principal: Principal, runId: string, command: RetryAssistantRunCommand): Promise<{ run: AssistantRun; created: boolean }> {
      return uow.run(async (ports) => {
        const earlier = await ownRun(ports, principal, runId);
        if (IN_FLIGHT.has(earlier.status)) throw new ConflictError('The run is still in progress', 'ASSISTANT_RUN_NOT_RETRYABLE');
        const started = await start(ports, principal, earlier.conversationId, retryRequest(earlier, command?.clientRunId), earlier.id);
        return { run: await runView(ports, started.run), created: started.created };
      });
    },

    /**
     * Before dispatch the stop is certain and free: the run ends and its reservation is released.
     * During dispatch the worker aborts the request as best effort and keeps the reservation until
     * the charge is known. After a stop nothing is committed.
     */
    async stop(principal: Principal, runId: string): Promise<AssistantRun> {
      return uow.run(async (ports) => {
        const run = await ownRun(ports, principal, runId, true);
        if (run.status === 'queued' || run.status === 'reading') {
          return runView(ports, await updateAndAnnounce(ports, run.id, {
            status: 'stopped', stopRequestedAt: new Date(), costState: 'released', chargedMicros: 0, completedAt: new Date(),
          }));
        }
        if (run.status === 'dispatching' && !run.stopRequestedAt) return runView(ports, await updateAndAnnounce(ports, run.id, { stopRequestedAt: new Date() }));
        return runView(ports, run);
      });
    },

    get: (principal: Principal, runId: string) => uow.run(async (ports) => runView(ports, await ownRun(ports, principal, runId))),

    async listOwn(principal: Principal, query?: PageQuery): Promise<Page<AssistantRun>> {
      const owner = ownerOf(principal);
      const window = page(query);
      return uow.run(async (ports) => {
        const { items, total } = await ports.runs.listOwnRuns(owner, window);
        return { items: await Promise.all(items.map((item) => runView(ports, item))), total, ...window };
      });
    },

    /** Committed answers of a conversation for anyone who can read its project now. */
    async listAnswers(principal: Principal, conversationId: string, query?: PageQuery): Promise<Page<AssistantAnswer>> {
      const window = page(query);
      return uow.run(async (ports) => {
        const place = isId(conversationId) ? await ports.runs.locateConversation(conversationId.toLowerCase()) : null;
        if (!place) throw new NotFoundError('Conversation', 'CONVERSATION_NOT_FOUND');
        try {
          await ports.access.requireProject(principal, 'read', place.projectId);
        } catch (error) {
          if (error instanceof NotFoundError) throw new NotFoundError('Conversation', 'CONVERSATION_NOT_FOUND');
          throw error;
        }
        const { items, total } = await ports.runs.listAnswers(conversationId.toLowerCase(), window);
        const answers = await Promise.all(items.map((item) => answerView(ports, item)));
        return { items: answers.filter((answer): answer is AssistantAnswer => answer !== null), total, ...window };
      });
    },
  };
}

export type PersonalRunUseCases = ReturnType<typeof createPersonalRunUseCases>;

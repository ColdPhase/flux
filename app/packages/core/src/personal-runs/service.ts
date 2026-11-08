import { budgetLine } from '../assistant/job-result.js';
import type { AgentSetup } from '../assistant/ports.js';
import { randomUUID } from 'node:crypto';
import {
  AGENT_LIMITS,
  ASSISTANT_PLAN_MODELS,
  assistantModelName,
  type AddAgentMemoryCommand,
  type AgentMemory,
  type AgentMemoryItem,
  type AiConnectionRef,
  type AssistantAnswer,
  type AssistantModelChoice,
  type AssistantRun,
  type AssistantRunBehind,
  type AssistantModelPick as ModelPick,
  type CreateMyAgentCommand,
  type EditAgentMemoryCommand,
  type InvokeAssistantRunCommand,
  type Page,
  type PageQuery,
  type PersonalAssistantStatus,
  type PersonalAssistantUnavailableReason,
  type PersonalRunEnablement,
  type RetryAssistantRunCommand,
  type MyAgent,
  type UpdateMyAgentCommand,
} from '@flux/contracts';
import {
  ConflictError, ForbiddenError, InvalidInputError, NotFoundError, ServiceUnavailableError,
} from '../access/errors.js';
import type { Principal } from '../principal.js';
import { isId, page } from '../work/validation.js';
import type {
  EnablementRecord, KeySpend, NewRun, PersonalConnection, PersonalConnectionLookup, PersonalRunPorts, PersonalRunUnitOfWork,
  PersonalRuntimeAvailability, PersonalRuntimeClient, PersonalRuntimeStanding, RunRecord,
} from './ports.js';
import {
  apiModelAccount, CODEX_RUNTIME_MODEL, connectionOnModel, defaultPick, isModelId, modelChoice, modelNameOf, RUNTIME_MODEL, runtimeModelAccount, type ConnectionModels,
} from './model.js';
import { announce, updateAndAnnounce } from './progress.js';
import {
  budgetedReservationMicros, centsToMicros, connectionRef, memoryText, normalizeAgentChange, normalizeEnable, normalizeInvoke, retryRequest, runReservationMicros,
  type NormalizedInvoke,
} from './validation.js';

// Personal assistant runs (issue #68; Connect AI #854, no Flux limits #843): the owner's assistant, invoke, stop, retry and
// the reads. Everything resolves the owner from the authenticated principal; a body never selects an owner, agent or
// connection. The assistant runs on a model of one of the owner's connections (a Claude plan, a ChatGPT plan or an API
// key) and never falls back to another. Flux sets no limit of its own: an API key keeps one daily budget, priced per
// request before it is sent; a request that finds the budget used, or a plan at its limit, pauses and resumes by itself.
// Only the owner can read, stop or retry a run (others 404).

const IN_FLIGHT = new Set(['queued', 'reading', 'dispatching']);
/**
 * A technical safety bound on the owner's requests waiting at once (#843), so a runaway client cannot queue without end.
 * Nobody meets it in normal use; paused requests (waiting for a limit to reset) are not counted.
 */
export const MAX_WAITING_REQUESTS = 20;
/** What Flux's own tick asks for when a schedule or the morning summary is due (F-027 A8). */
export interface BackgroundRunSpec {
  ownerUserId: string;
  projectId: string;
  /** Where the run is anchored: the conversation a schedule posts in, or any conversation of the project for a silent run. */
  conversationId: string;
  kind: 'scheduled' | 'morning_summary' | 'reaction';
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

/** The same reasons a run on a task cannot start, said by the agent (AG-5: "I can't start …"). */
const TASK_PROBLEM_LINE: Record<PersonalAssistantUnavailableReason, string> = {
  provider_off: 'I can\'t start: AI is switched off on this Flux.', no_connection: 'I can\'t start: no AI account is connected.',
  connection_changed: 'I can\'t start: your AI account changed.', price_unknown: 'I can\'t start: your AI account has no known price.',
  runtime_off: 'I can\'t start: subscription sign-in is off on this Flux.', runtime_sign_in: 'I can\'t start: sign in again.',
};
/** What the server asks for when an agent takes a task (#856). */
export interface TaskRunSpec {
  ownerUserId: string;
  agentId: string;
  workId: string;
  projectId: string;
  /** The task's discussion, where the run is anchored. */
  conversationId: string;
  /** The task as data: its number and title. */
  prompt: string;
  /** Deterministic per owner assignment, so a repeated start returns the same run. */
  clientRunId: string;
  /** `task_answer` (#841): the run answers another agent's question, reads only, and uses only what every person of the task can see. */
  kind?: 'task' | 'task_answer';
  askedByRunId?: string;
  /** How many questions in a row led to this run; the exchange stops at its bound. */
  exchangeTurn?: number;
  /** With `task_answer`: the task's people. Each must still be able to read the space, or nothing is answered. */
  audience?: readonly string[];
}
export type TaskStart = { started: true; run: RunRecord; created: boolean } | { started: false; line: string };

const SERVER_PROBLEM_LINE: Record<PersonalAssistantUnavailableReason, string> = {
  provider_off: 'Skipped: AI is switched off on this Flux', no_connection: 'Skipped: no AI account is connected', connection_changed: 'Skipped: your AI account changed',
  price_unknown: 'Skipped: your AI account has no known price',
  runtime_off: 'Skipped: subscription sign-in is off on this Flux', runtime_sign_in: 'Skipped: sign in again',
};
/** The provenance model of a runtime answer when no model id reached the CLI (its own default). */
export { RUNTIME_MODEL, CODEX_RUNTIME_MODEL };
/** Where a runtime run's content goes and how it is labelled: the vendor of the owner's CLI. */
export const runtimeVendor = (client: PersonalRuntimeClient | null | undefined) => (client === 'codex'
  ? { provider: 'openai' as const, model: CODEX_RUNTIME_MODEL, name: 'Codex' } : { provider: 'anthropic' as const, model: RUNTIME_MODEL, name: 'Claude Code' });
/** The CLI of a plan assistant, from the provider its connection names. */
export const runtimeClientOf = (provider: string | null | undefined): PersonalRuntimeClient => (provider === 'openai' ? 'codex' : 'claude_code');
/** The plan connection of a CLI, as Connect AI names it (#854). */
const planRef = (client: PersonalRuntimeClient): AiConnectionRef => (client === 'codex' ? 'chatgpt_plan' : 'claude_plan');
const clientOfPlan = (ref: AiConnectionRef): PersonalRuntimeClient | null => (ref === 'claude_plan' ? 'claude_code' : ref === 'chatgpt_plan' ? 'codex' : null);
/** A run untouched this long was left by a crashed worker (the job expires an hour after the run's own clock, #843). */
export const STALE_AFTER_SECONDS = 75 * 60;
const iso = (date: Date) => date.toISOString();

export function ownerOf(principal: Principal): string {
  if (principal.kind !== 'human' || !principal.id) throw new InvalidInputError('A signed-in person is required');
  return principal.id;
}

export const assistantLabel = (name: string) => `${name}'s assistant`;
const runNotFound = () => new NotFoundError('Assistant run', 'ASSISTANT_RUN_NOT_FOUND');

/** The connection an assistant's model belongs to. */
export const enablementConnection = (record: Pick<EnablementRecord, 'engine' | 'connectionId' | 'provider'>): AiConnectionRef =>
  record.engine === 'runtime' ? planRef(runtimeClientOf(record.provider)) : record.connectionId ?? '';

/** The model in force: the stored one, or its connection's default. */
function modelOf(record: EnablementRecord): string {
  if (record.assistantModel) return record.assistantModel;
  return record.engine === 'runtime' ? ASSISTANT_PLAN_MODELS[runtimeClientOf(record.provider)].default : '';
}

function enablementView(record: EnablementRecord): PersonalRunEnablement {
  return {
    ownerUserId: record.ownerUserId, agentId: record.agentId, workspaceId: record.workspaceId, connection: enablementConnection(record), engine: record.engine,
    model: modelOf(record), version: record.version, createdAt: iso(record.createdAt), updatedAt: iso(record.updatedAt),
  };
}

/** The answer as the place's audience sees it: no cost, budget, connection or hidden source. */
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
    resumesAt: record.status === 'queued' && record.resumeAt ? iso(record.resumeAt) : null,
    cost: { state: record.costState, reservedMicros: record.reservedMicros, chargedMicros: record.chargedMicros, inputTokens: record.inputTokens, outputTokens: record.outputTokens },
    answer: await answerView(ports, record),
    authority: record.authority, backgroundLabel: record.backgroundLabel,
    behind: record.status === 'queued' && !record.resumeAt ? await behindView(ports, record) : null,
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
 * The owner's usable API key on the assistant's model, or why it cannot be used now: the key the model belongs to and no
 * other; without a known price its daily budget cannot hold. There is never another connection to fall back to.
 */
export async function usableConnection(connections: PersonalConnectionLookup, providerEnabled: boolean, enablement: EnablementRecord):
  Promise<{ problem: PersonalAssistantUnavailableReason } | { problem: null; connection: PersonalConnection }> {
  if (!providerEnabled) return { problem: 'provider_off' };
  const named = enablement.connectionId ? await connections.resolve(enablement.ownerUserId, enablement.connectionId) : null;
  // On the model the owner chose (F-027 AST-11): the key's own, or another of its provider with a table price.
  const connection = named && connectionOnModel(named, enablement.assistantModel);
  if (named && !connection) return { problem: 'price_unknown' };
  if (!connection || connection.status !== 'active' || connection.ownerUserId !== enablement.ownerUserId || connection.id !== enablement.connectionId) {
    // The key is gone: the assistant waits until its owner picks another model (C-3). Say whether another connection exists.
    const others = await connections.list(enablement.ownerUserId);
    return { problem: others.length ? 'connection_changed' : 'no_connection' };
  }
  if (runReservationMicros(connection.price, false) === null) return { problem: 'price_unknown' };
  return { problem: null, connection };
}

/**
 * What a run on the key reserves now against its one daily budget (#854): its turns × the largest request, never above
 * what is left today. `paused`: not even one request fits; the request waits for the key's next day. A new request is
 * admitted against what was already charged (`admit`): the owner's lane runs one request at a time, so the reservation of
 * the request working now must not pause the one waiting behind it. The worker reserves when it starts the request.
 */
export async function reserveOnKey(ports: PersonalRunPorts, connection: PersonalConnection, tools: boolean, turns: number, exceptRunId?: string, admit = false):
  Promise<{ reservedMicros: number; largestRequestMicros: number | null } | { paused: Date }> {
  const spend: KeySpend | null = await ports.runs.keySpend(connection, exceptRunId);
  if (!spend) return { paused: new Date(Date.now() + 24 * 3600_000) };
  const left = centsToMicros(spend.budgetCents) - spend.chargedMicros - (admit ? 0 : spend.reservedMicros);
  const reserved = budgetedReservationMicros(connection.price, tools, left, turns);
  if (reserved === null || reserved === 'budget') return { paused: spend.resetsAt };
  return { reservedMicros: admit ? 0 : reserved, largestRequestMicros: runReservationMicros(connection.price, tools) };
}

function unavailable(reason: PersonalAssistantUnavailableReason) {
  const error = new ServiceUnavailableError('Your assistant is unavailable. Human work continues; no other payer is used.', 'PERSONAL_RUN_UNAVAILABLE');
  error.details = { reason };
  return error;
}

/** A body that names another owner, agent or connection is refused before anything is read or reserved. */
function refuseForeignIds(claimed: NormalizedInvoke['claimed'], owner: string, enablement: EnablementRecord | null) {
  const agentId = enablement?.agentId ?? null;
  const foreign = (claimed.ownerId !== null && claimed.ownerId !== owner)
    || (claimed.agentId !== null && claimed.agentId.toLowerCase() !== agentId)
    || (claimed.connectionId !== null && (!enablement?.connectionId || claimed.connectionId.toLowerCase() !== enablement.connectionId));
  if (foreign) throw new ForbiddenError('A run always uses your own assistant and connection', 'PERSONAL_RUN_NOT_OWNER');
}

/** A lookup with no keys: every API-key assistant fails closed with an explicit state. There is no fallback. */
export const noPersonalConnections: PersonalConnectionLookup = { resolve: async () => null, list: async () => [] };

export interface PersonalRunDeps {
  uow: PersonalRunUnitOfWork;
  connections: PersonalConnectionLookup;
  /** The instance operator's provider switch (O-008 §6); false fails every API-key run closed. */
  providerEnabled: boolean;
  /** The owner's own Claude Code and Codex in the agent runtime (F-022 AIM-3). Without it no plan can be used. */
  runtime?: PersonalRuntimeAvailability;
}

const RUNTIME_OFF: PersonalRuntimeStanding = { state: 'off', payer: null, accountLabel: null };

/** The plain error of a model the account cannot use (F-027 AST-11): `ASSISTANT_MODEL_UNAVAILABLE`, nothing changes. */
const modelUnavailable = (message: string) => new ConflictError(message, 'ASSISTANT_MODEL_UNAVAILABLE');

/** Stop was pressed by `by` (the owner or the space admin, decided by the caller): before dispatch the run ends at once and for free. */
export async function stopRunBy(ports: PersonalRunPorts, runId: string, by: string): Promise<RunRecord | null> {
  const run = await ports.runs.findRun(runId, { lock: true });
  if (!run) return null;
  if (run.status === 'queued' || run.status === 'reading') {
    return updateAndAnnounce(ports, run.id, { status: 'stopped', stopRequestedAt: new Date(), stopRequestedBy: by, costState: 'released', chargedMicros: 0, completedAt: new Date() });
  }
  if (run.status === 'dispatching' && !run.stopRequestedAt) return updateAndAnnounce(ports, run.id, { stopRequestedAt: new Date(), stopRequestedBy: by });
  return run;
}

export function createPersonalRunUseCases({ uow, connections, providerEnabled, runtime }: PersonalRunDeps) {
  const runtimeStanding = async (owner: string, client?: PersonalRuntimeClient) => (runtime ? await runtime.standing(owner, client).catch(() => RUNTIME_OFF) : RUNTIME_OFF);
  /** Why a runtime assistant cannot run now, or null when it can. */
  const runtimeProblem = (standing: PersonalRuntimeStanding): PersonalAssistantUnavailableReason | null =>
    standing.state === 'off' ? 'runtime_off' : standing.state === 'signed_in' ? null : 'runtime_sign_in';

  /** Every connection of the owner a model can be picked from now (#854): the signed-in plans and the usable keys. */
  async function ownConnections(owner: string): Promise<ConnectionModels[]> {
    const found: ConnectionModels[] = [];
    for (const client of ['claude_code', 'codex'] as const) {
      const standing = await runtimeStanding(owner, client);
      if (standing.state !== 'signed_in' || (standing.client && standing.client !== client)) continue;
      const account = runtimeModelAccount(client);
      found.push({ ref: planRef(client), label: account.plan, account, connection: null, since: standing.signedInAt?.getTime() ?? 0 });
    }
    if (providerEnabled) {
      for (const key of await connections.list(owner)) {
        if (key.status !== 'active' || key.ownerUserId !== owner || runReservationMicros(key.price, false) === null) continue;
        found.push({ ref: key.id, label: key.name, account: apiModelAccount(key), connection: key, since: key.createdAt?.getTime() ?? 0 });
      }
    }
    return found;
  }

  /** The model of one of the owner's connections, or the plain refusal (AST-11): only a model in that connection's list. */
  async function pick(owner: string, connectionWanted: unknown, modelWanted: unknown, still = ''): Promise<{ item: ConnectionModels; model: string }> {
    const ref = connectionRef(connectionWanted);
    // A model that is not even an id is simply one the connection does not offer (the plain refusal below).
    const model = typeof modelWanted === 'string' ? modelWanted : '';
    const item = (await ownConnections(owner)).find((connection) => connection.ref === ref);
    if (!item) {
      const client = clientOfPlan(ref);
      throw modelUnavailable(client ? `Sign in to ${ASSISTANT_PLAN_MODELS[client].company} first.${still}` : `Connect that API key first.${still}`);
    }
    const option = isModelId(model, item.account.engine ?? 'runtime') ? item.account.options.find((entry) => entry.id === model) : undefined;
    if (!option) throw modelUnavailable(`Your ${item.connection ? 'API key' : item.label} doesn't offer that model.${still}`);
    if (item.connection) {
      const priced = connectionOnModel(item.connection, option.id);
      if (!priced?.price) throw modelUnavailable(`Flux doesn't know the price of ${assistantModelName(option.id)} yet, so its daily budget can't hold.${still}`);
      // A budget below one request would wait for a day that never comes.
      if (runReservationMicros(priced.price, true)! > centsToMicros(item.connection.dailyBudgetCents))
        throw modelUnavailable(`One request on ${assistantModelName(option.id)} can cost more than this key's daily budget. Raise the budget in Connect AI.${still}`);
    }
    return { item, model: option.id };
  }

  /** The engine, key and provider of a picked model's connection. */
  function placement(item: ConnectionModels, model: string): Pick<AgentSetup, 'engine' | 'apiKeyId' | 'provider' | 'model'> {
    if (item.connection) return { engine: 'server', apiKeyId: item.connection.id, provider: item.connection.provider, model };
    return { engine: 'runtime', apiKeyId: null, provider: runtimeVendor(clientOfPlan(item.ref)).provider, model };
  }

  /** The model of a new agent: the one named, else Connect AI's default (the connection made first, at its default model). */
  async function modelFor(owner: string, connectionWanted: unknown, modelWanted: unknown, still: string) {
    if (connectionWanted === undefined && modelWanted === undefined) {
      const first = defaultPick(await ownConnections(owner));
      if (!first) throw modelUnavailable(`Connect AI first.${still}`);
      return pick(owner, first.connection, first.model, still);
    }
    return pick(owner, connectionWanted, modelWanted, still);
  }

  /** The agents of a person, read and changed only by them (F-036 AG-1): the identity port exists on the API, not in the worker. */
  function agentsOf(ports: PersonalRunPorts) {
    if (!ports.assistants) throw new ServiceUnavailableError('Agents can be changed from the API only', 'AGENTS_UNAVAILABLE');
    return ports.assistants;
  }
  const agentNotFound = () => new NotFoundError('Agent', 'AGENT_NOT_FOUND');

  async function status(ports: PersonalRunPorts, owner: string): Promise<PersonalAssistantStatus> {
    const enablement = await ports.runs.enablement(owner);
    const keys = providerEnabled ? await connections.list(owner) : [];
    // A plan assistant's standing is its own CLI's; otherwise the owner's most recently signed-in CLI.
    const standing = await runtimeStanding(owner, enablement?.engine === 'runtime' ? runtimeClientOf(enablement.provider) : undefined);
    const setup = {
      provider: providerEnabled ? 'on' as const : 'off' as const,
      connection: keys.some((key) => key.status === 'active' && key.ownerUserId === owner) ? 'active' as const : 'none' as const,
      runtime: { state: standing.state, payer: standing.payer, accountLabel: standing.accountLabel, client: standing.state === 'off' ? null : standing.client ?? 'claude_code' },
    };
    if (!enablement) return { state: 'not_enabled', unavailableReason: null, enablement: null, setup, today: null };
    const view = enablementView(enablement);
    if (enablement.engine === 'runtime') {
      // A plan: its limits are the provider's, never Flux's (#843).
      const problem = runtimeProblem(standing);
      return { state: problem ? 'unavailable' : 'ready', unavailableReason: problem, enablement: view, setup, today: null };
    }
    const key = providerEnabled && enablement.connectionId ? await connections.resolve(owner, enablement.connectionId) : null;
    const spend = key ? await ports.runs.keySpend(key) : null;
    const today = spend ? { chargedMicros: spend.chargedMicros, reservedMicros: spend.reservedMicros, budgetCents: spend.budgetCents, resetsAt: iso(spend.resetsAt) } : null;
    const usableNow = await usableConnection(connections, providerEnabled, enablement);
    if (usableNow.problem) return { state: 'unavailable', unavailableReason: usableNow.problem, enablement: view, setup, today };
    const one = runReservationMicros(usableNow.connection.price, false) ?? 0;
    const capped = !!spend && spend.chargedMicros + one > centsToMicros(spend.budgetCents);
    return { state: capped ? 'capped' : 'ready', unavailableReason: null, enablement: view, setup, today };
  }

  async function lockedEnablement(ports: PersonalRunPorts, owner: string, agentId?: string) {
    const enablement = await ports.runs.enablement(owner, { lock: true, ...(agentId ? { agentId } : {}) });
    if (!enablement) throw new ConflictError('You have no agent yet', 'PERSONAL_RUN_NOT_ENABLED');
    return enablement;
  }

  /** Requests of the owner that are working or waiting their turn; a request paused by a limit does not count. */
  const waitingRequests = (ports: PersonalRunPorts, owner: string) => ports.runs.inFlightCount(owner);

  /**
   * Where a new run goes and what it holds: on a plan nothing is reserved (its limits are the provider's); on an API key
   * the run reserves against the key's daily budget, or waits for the key's next day when today's budget is used.
   */
  async function admit(ports: PersonalRunPorts, owner: string, enablement: EnablementRecord):
    Promise<{ ok: true; fields: Pick<NewRun, 'reservedMicros' | 'provider' | 'model'> & Pick<NewRun, 'resumeAt' | 'endReason'> } | { ok: false; problem: PersonalAssistantUnavailableReason; client: PersonalRuntimeClient | null }> {
    if (enablement.engine === 'runtime') {
      const client = runtimeClientOf(enablement.provider);
      const problem = runtimeProblem(await runtimeStanding(owner, client));
      if (problem) return { ok: false, problem, client };
      const vendor = runtimeVendor(client);
      // The model is fixed when the request is sent (F-027 AST-11): a later change never reaches this run.
      return { ok: true, fields: { reservedMicros: 0, provider: vendor.provider, model: modelOf(enablement) } };
    }
    const usableNow = await usableConnection(connections, providerEnabled, enablement);
    if (usableNow.problem) return { ok: false, problem: usableNow.problem, client: null };
    const { connection } = usableNow;
    const held = await reserveOnKey(ports, connection, false, 1, undefined, true);
    // Paused until the key's next day; otherwise it reserves when the worker starts it (its turn in the owner's lane).
    if ('paused' in held) return { ok: true, fields: { reservedMicros: 0, provider: connection.provider, model: connection.model, resumeAt: held.paused, endReason: 'budget' } };
    return { ok: true, fields: { reservedMicros: 0, provider: connection.provider, model: connection.model } };
  }

  /**
   * The shared path of invoke, continue and retry. Order matters: identity claims, then the place, then the caller's own
   * enablement, connection, agent and the key's daily budget. Nothing is written unless every check passes; a request
   * that finds the budget used is written paused, to start by itself when the key's next day begins.
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
    // AG-10: no run, and no replay of an earlier one, while AI is off in this space.
    const { epoch: aiEpoch } = await ports.access.requireSpaceAi(place.projectId, { lock: true });
    // The owner's row lock serializes this owner's invocations: same-key retries and the budget reservation cannot race.
    const enablement = await ports.runs.enablement(owner, { lock: true, workspaceId: place.workspaceId });
    refuseForeignIds(request.claimed, owner, enablement);
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
    if (!enablement) throw new ConflictError('You have no agent to answer yet. Make one in Settings › AI', 'PERSONAL_RUN_NOT_ENABLED');
    const agentId = enablement.agentId;
    if (!(await ports.access.canInvoke(principal, agentId, { lock: true })))
      throw new ConflictError('Your agent is not available', 'PERSONAL_RUN_NO_AGENT');
    const agent = { kind: 'agent' as const, id: agentId };
    if (!(await ports.access.canUseProject(agent, 'read', place.projectId, { lock: true })))
      throw new ConflictError('Your assistant has no access to this project', 'PERSONAL_RUN_NO_PROJECT_ACCESS');
    const taskFence = await ports.runs.prepareTaskUse(place.projectId, conversationId.toLowerCase());
    // A run a crashed worker left behind must not block the owner forever.
    for (const ended of await ports.runs.endStale(owner, STALE_AFTER_SECONDS)) await announce(ports, ended);
    if (await waitingRequests(ports, owner) >= MAX_WAITING_REQUESTS) throw new ConflictError('Your assistant is already working on many requests', 'PERSONAL_RUN_IN_FLIGHT');
    const admitted = await admit(ports, owner, enablement);
    if (!admitted.ok) throw unavailable(admitted.problem);
    const run = await ports.runs.insertRun({
      id: randomUUID(), workspaceId: place.workspaceId, projectId: place.projectId, conversationId: conversationId.toLowerCase(),
      ownerUserId: owner, agentId, connectionId: enablement.connectionId, clientRunId: request.clientRunId,
      requestFingerprint: request.fingerprint, kind: request.kind, prompt: request.prompt,
      targetSketchId: request.target?.sketchId ?? null, targetThoughtId: request.target?.thoughtId ?? null,
      continuesRunId: request.continuesRunId, retryOfRunId, ...admitted.fields, engine: enablement.engine, aiEpoch,
    });
    // A paused request starts by itself at its resume time (the worker's queue tick); any other starts now.
    if (!run.resumeAt) await ports.queue.enqueue(run.id);
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
   * the key's daily budget are all checked, and the run, its reservation and its dispatch job commit with the caller's
   * transaction. Flux sets no background runs a day (#843). Nothing falls back to another account; a run that cannot
   * start says why and writes nothing.
   */
  async function startBackground(ports: PersonalRunPorts, spec: BackgroundRunSpec): Promise<BackgroundStart> {
    const skipped = (line: string): BackgroundStart => ({ started: false, outcome: 'skipped', line });
    const owner = spec.ownerUserId;
    const principal: Principal = { kind: 'human', id: owner };
    const place = await ports.runs.locateConversation(spec.conversationId);
    if (!place || place.projectId !== spec.projectId) return skipped('Skipped: this project has no conversation yet');
    // AG-10: nothing starts in a space whose AI is off (the tick does not fire there; this is the backstop).
    const ai = await ports.access.spaceAi(place.projectId, { lock: true });
    if (ai.state !== 'allowed') return skipped('Skipped: AI is off in this space');
    // The assistant changes things as the owner's: the owner must still be able to write here.
    if (!(await ports.access.canUseProject(principal, 'write', spec.projectId, { lock: true }))) return skipped('Skipped: you no longer have access to this project');
    const existing = await ports.runs.runByClientId(owner, spec.clientRunId);
    if (existing) return { started: true, run: existing, created: false };
    const enablement = await ports.runs.enablement(owner, { lock: true, workspaceId: place.workspaceId });
    if (!enablement) return skipped('Skipped: you have no agent');
    const agentId = enablement.agentId;
    if (!(await ports.access.canInvoke(principal, agentId, { lock: true }))) return skipped('Skipped: your assistant is not available');
    if (!(await ports.access.canUseProject({ kind: 'agent', id: agentId }, 'read', place.projectId, { lock: true }))) return skipped('Skipped: I\'m not in this project');
    const admitted = await admit(ports, owner, enablement);
    if (!admitted.ok) {
      if (admitted.problem === 'runtime_sign_in') return { started: false, outcome: 'failed', line: `Sign in to ${admitted.client === 'codex' ? 'ChatGPT' : 'Claude'} again` };
      return skipped(SERVER_PROBLEM_LINE[admitted.problem]);
    }
    // A background firing does not wait for the key's next day: the next firing is its next chance.
    if (admitted.fields.resumeAt) return skipped(budgetLine);
    const taskFence = await ports.runs.prepareTaskUse(place.projectId, spec.conversationId);
    for (const ended of await ports.runs.endStale(owner, STALE_AFTER_SECONDS)) await announce(ports, ended);
    const run = await ports.runs.insertRun({
      id: randomUUID(), workspaceId: place.workspaceId, projectId: place.projectId, conversationId: spec.conversationId, ownerUserId: owner, agentId,
      connectionId: enablement.connectionId, clientRunId: spec.clientRunId, requestFingerprint: `background:${spec.kind}:${spec.clientRunId}`, kind: spec.kind,
      prompt: spec.prompt, targetSketchId: null, targetThoughtId: null, continuesRunId: null, retryOfRunId: null, ...admitted.fields, engine: enablement.engine, silent: spec.silent,
      aiEpoch: ai.epoch,
      // A schedule is the owner's own stored request: it waits behind their own requests and says what it is (AST-6 "Queue").
      authority: spec.kind === 'reaction' ? 'owner_reaction' : 'owner_schedule', backgroundLabel: spec.label.trim().slice(0, 80) || 'Schedule',
    });
    await ports.queue.enqueue(run.id);
    await taskFence.mark();
    await announce(ports, run);
    return { started: true, run, created: true };
  }

  /**
   * #856 (F-036 AG-5): starts the run of an agent on a task its owner holds, on the same path as the owner's own request: the
   * space's AI switch, the owner's and the agent's current rights, the assistant's standing, the connection and the key's daily
   * budget are all checked, and the run and its dispatch job commit with the caller's transaction. It is anchored in the task's
   * discussion. A run that cannot start says why in plain words and writes nothing.
   */
  async function startTask(ports: PersonalRunPorts, spec: TaskRunSpec): Promise<TaskStart> {
    const refused = (line: string): TaskStart => ({ started: false, line });
    const owner = spec.ownerUserId;
    const principal: Principal = { kind: 'human', id: owner };
    const place = await ports.runs.locateConversation(spec.conversationId);
    if (!place || place.projectId !== spec.projectId) return refused('I can\'t start: this task has no discussion yet.');
    const ai = await ports.access.spaceAi(place.projectId, { lock: true });
    if (ai.state !== 'allowed') return refused('I can\'t start: AI is off in this space.');
    // The agent works as the owner: the owner must still be able to write here, and the agent to read.
    if (!(await ports.access.canUseProject(principal, 'write', spec.projectId, { lock: true }))) return refused('I can\'t start: you no longer have access to this space.');
    const existing = await ports.runs.runByClientId(owner, spec.clientRunId);
    if (existing) return { started: true, run: existing, created: false };
    const kind = spec.kind ?? 'task';
    // An answer uses only what every person of the task can see: if one of them can no longer read the space, nothing is answered.
    if (kind === 'task_answer') for (const person of spec.audience ?? [])
      if (!(await ports.access.canUseProject({ kind: 'human', id: person }, 'read', spec.projectId, { lock: true }))) return refused('I can\'t answer: not everyone in this task can read this space.');
    // The agent's own setup (F-036 AG-1) is locked first, the task graph after it (`prepareTaskUse`), as everywhere else.
    const enablement = await ports.runs.enablement(owner, { lock: true, agentId: spec.agentId });
    if (!enablement || enablement.workspaceId !== place.workspaceId || !(await ports.access.canInvoke(principal, spec.agentId, { lock: true })))
      return refused('I can\'t start: I\'m not one of your agents here.');
    if (!(await ports.access.canUseProject({ kind: 'agent', id: spec.agentId }, 'read', spec.projectId, { lock: true }))) return refused('I can\'t start: I\'m not in this space.');
    const taskFence = await ports.runs.prepareTaskUse(place.projectId, spec.conversationId);
    for (const ended of await ports.runs.endStale(owner, STALE_AFTER_SECONDS)) await announce(ports, ended);
    if (await waitingRequests(ports, owner) >= MAX_WAITING_REQUESTS) return refused('I can\'t start: I\'m already working on many requests.');
    const admitted = await admit(ports, owner, enablement);
    if (!admitted.ok) return refused(admitted.problem === 'runtime_sign_in' ? `I can't start: sign in to ${admitted.client === 'codex' ? 'ChatGPT' : 'Claude'} again.` : TASK_PROBLEM_LINE[admitted.problem]);
    const run = await ports.runs.insertRun({
      id: randomUUID(), workspaceId: place.workspaceId, projectId: place.projectId, conversationId: spec.conversationId, ownerUserId: owner, agentId: spec.agentId,
      connectionId: enablement.connectionId, clientRunId: spec.clientRunId, requestFingerprint: `${kind}:${spec.workId}:${spec.clientRunId}`, kind,
      prompt: spec.prompt, targetSketchId: null, targetThoughtId: null, continuesRunId: null, retryOfRunId: null, ...admitted.fields, engine: enablement.engine,
      aiEpoch: ai.epoch, workId: spec.workId, ...(spec.askedByRunId ? { askedByRunId: spec.askedByRunId } : {}), exchangeTurn: spec.exchangeTurn ?? 0,
    });
    // A request paused until the key's next day starts by itself then (the worker's queue tick); any other starts now.
    if (!run.resumeAt) await ports.queue.enqueue(run.id);
    await taskFence.mark();
    await announce(ports, run);
    return { started: true, run, created: true };
  }

  return {
    startBackground,
    startTask,
    status: (principal: Principal) => uow.run((ports) => status(ports, ownerOf(principal))),

    /** What the caller may choose for an agent's model, grouped by connection (#854); `current` is their first agent's. */
    model: (principal: Principal): Promise<AssistantModelChoice> => {
      const owner = ownerOf(principal);
      return uow.run(async (ports) => {
        const enablement = await ports.runs.enablement(owner);
        const current: ModelPick | null = enablement ? { connection: enablementConnection(enablement), model: modelOf(enablement) } : null;
        return modelChoice(await ownConnections(owner), current, !!enablement);
      });
    },

    /**
     * Changes an agent's one model (AST-11, #857), from any of the owner's connections (#854): picking a model of another
     * connection moves the agent to it. Only a model in that connection's list is accepted; anything else is a plain error and
     * the previous model stays. A request already sent keeps the model it recorded. Without `agentId`: their first agent.
     */
    async chooseModel(principal: Principal, command: ModelPick & { agentId?: string }): Promise<AssistantModelChoice> {
      const owner = ownerOf(principal);
      if (!command || typeof command !== 'object') throw new InvalidInputError('Choose a model of one of your connections');
      return uow.run(async (ports) => {
        // The owner's assistant lock first, as a change of a key's budget takes it: one of the two goes first, and the other sees it (#915).
        await ports.assistants?.lockOwner(owner);
        const enablement = await lockedEnablement(ports, owner, command.agentId);
        const still = ` It is still ${modelNameOf({ model: modelOf(enablement) })}.`;
        const chosen = await pick(owner, command.connection, command.model, still);
        const next = placement(chosen.item, chosen.model);
        const unchanged = next.engine === enablement.engine && next.apiKeyId === enablement.connectionId && next.provider === enablement.provider
          && next.model === modelOf(enablement);
        if (!unchanged) await agentsOf(ports).change(enablement.agentId, next);
        return modelChoice(await ownConnections(owner), { connection: chosen.item.ref, model: chosen.model }, true);
      });
    },

    /**
     * Gives an agent identity of the owner its AI setup (#857): a model of one of their connections (Connect AI's default when
     * none is named), saved instructions and a colour. There is nothing else to agree to or set (#854).
     */
    async enable(principal: Principal, command: CreateMyAgentCommand): Promise<MyAgent> {
      const owner = ownerOf(principal);
      const input = normalizeEnable(command);
      return uow.run(async (ports) => {
        const agents = agentsOf(ports);
        await agents.lockOwner(owner);
        const { workspaceId } = await ports.access.requireInvoke(principal, input.agentId, { lock: true });
        if (await agents.get(owner, input.agentId)) throw new ConflictError('This agent is already set up', 'PERSONAL_RUN_ALREADY_ENABLED');
        const chosen = await modelFor(owner, input.connection, input.model, ' Nothing was turned on.');
        return agents.ensure(owner, workspaceId, input.agentId, { ...placement(chosen.item, chosen.model), instructions: input.instructions, colour: input.colour });
      });
    },

    /** The caller's own agents, the first being Assistant. */
    async listAgents(principal: Principal): Promise<MyAgent[]> {
      const owner = ownerOf(principal);
      return uow.run((ports) => agentsOf(ports).list(owner));
    },

    async getAgent(principal: Principal, agentId: unknown): Promise<MyAgent> {
      const owner = ownerOf(principal);
      if (!isId(agentId)) throw agentNotFound();
      return uow.run(async (ports) => (await agentsOf(ports).get(owner, agentId.toLowerCase())) ?? Promise.reject(agentNotFound()));
    },

    /** Changes the fields given: name, instructions, colour, or model with its connection. Only the owner, only their own. */
    async updateAgent(principal: Principal, agentId: unknown, command: UpdateMyAgentCommand): Promise<MyAgent> {
      const owner = ownerOf(principal);
      if (!isId(agentId)) throw agentNotFound();
      const change = normalizeAgentChange(command);
      return uow.run(async (ports) => {
        const agents = agentsOf(ports);
        await agents.lockOwner(owner);
        const current = await agents.get(owner, agentId.toLowerCase());
        if (!current) throw agentNotFound();
        if (change.name !== undefined && change.name !== current.name) await agents.rename(current.id, change.name);
        if (change.model) {
          const chosen = await pick(owner, change.model.connection, change.model.model, ` It is still ${modelNameOf(current.model)}.`);
          await agents.change(current.id, placement(chosen.item, chosen.model));
        }
        if (change.instructions !== undefined || change.colour !== undefined)
          await agents.change(current.id, { ...(change.instructions !== undefined ? { instructions: change.instructions } : {}), ...(change.colour ? { colour: change.colour } : {}) });
        return (await agents.get(owner, current.id))!;
      });
    },

    /** Deletes an agent (the caller's first one when none is named): queued work ends at zero cost and its tasks go back to the caller. */
    async remove(principal: Principal, agentId?: string): Promise<void> {
      const owner = ownerOf(principal);
      await uow.run(async (ports) => {
        const agents = agentsOf(ports);
        await agents.lockOwner(owner);
        // A named agent that is not the caller's is not found (never a clue that it exists); without one, the caller's first agent goes.
        if (agentId !== undefined && (!isId(agentId) || !(await agents.get(owner, agentId.toLowerCase())))) throw agentNotFound();
        const target = await lockedEnablement(ports, owner, agentId?.toLowerCase());
        for (const ended of await ports.runs.endUndispatched(owner, 'revoked', target.agentId)) await announce(ports, ended);
        await agents.remove(owner, target.agentId);
      });
    },

    /** What an agent remembers (F-036 AG-1). Only its owner reads or changes it. */
    memory: {
      async list(principal: Principal, agentId: unknown): Promise<AgentMemory> {
        const owner = ownerOf(principal);
        if (!isId(agentId)) throw agentNotFound();
        return uow.run(async (ports) => {
          const agents = agentsOf(ports);
          if (!(await agents.get(owner, agentId.toLowerCase()))) throw agentNotFound();
          return { items: await agents.memory.list(agentId.toLowerCase()) };
        });
      },
      /** The owner adds an item by hand; `source` says where it came from ("From your conversation" when they said "remember that …"). */
      async add(principal: Principal, agentId: unknown, command: AddAgentMemoryCommand, source = 'Added by you'): Promise<AgentMemoryItem> {
        const owner = ownerOf(principal);
        if (!isId(agentId)) throw agentNotFound();
        const body = memoryText(command?.body);
        return uow.run(async (ports) => {
          const agents = agentsOf(ports);
          await agents.lockOwner(owner);
          const agent = await agents.get(owner, agentId.toLowerCase());
          if (!agent) throw agentNotFound();
          if (await agents.memory.count(agent.id) >= AGENT_LIMITS.memoryItems) throw new ConflictError(`${agent.name} remembers ${AGENT_LIMITS.memoryItems} things already. Delete one first.`, 'AGENT_MEMORY_FULL');
          return agents.memory.add(owner, agent.id, agent.workspaceId, body, source);
        });
      },
      async edit(principal: Principal, agentId: unknown, itemId: unknown, command: EditAgentMemoryCommand): Promise<AgentMemoryItem> {
        const owner = ownerOf(principal);
        if (!isId(agentId) || !isId(itemId)) throw agentNotFound();
        const body = memoryText(command?.body);
        return uow.run(async (ports) => {
          const agents = agentsOf(ports);
          if (!(await agents.get(owner, agentId.toLowerCase()))) throw agentNotFound();
          return (await agents.memory.edit(agentId.toLowerCase(), itemId.toLowerCase(), body)) ?? Promise.reject(new NotFoundError('Remembered item', 'AGENT_MEMORY_NOT_FOUND'));
        });
      },
      async remove(principal: Principal, agentId: unknown, itemId: unknown): Promise<void> {
        const owner = ownerOf(principal);
        if (!isId(agentId) || !isId(itemId)) throw agentNotFound();
        await uow.run(async (ports) => {
          const agents = agentsOf(ports);
          if (!(await agents.get(owner, agentId.toLowerCase()))) throw agentNotFound();
          if (!(await agents.memory.remove(agentId.toLowerCase(), itemId.toLowerCase()))) throw new NotFoundError('Remembered item', 'AGENT_MEMORY_NOT_FOUND');
        });
      },
    },

    async invoke(principal: Principal, conversationId: string, command: InvokeAssistantRunCommand): Promise<{ run: AssistantRun; created: boolean }> {
      ownerOf(principal);
      const request = normalizeInvoke(command);
      return uow.run(async (ports) => {
        const started = await start(ports, principal, conversationId, request, null);
        return { run: await runView(ports, started.run), created: started.created };
      });
    },

    /** A new run with the retried run's request. */
    async retry(principal: Principal, runId: string, command: RetryAssistantRunCommand): Promise<{ run: AssistantRun; created: boolean }> {
      return uow.run(async (ports) => {
        const earlier = await ownRun(ports, principal, runId);
        // A run on a task is tried again from the task (#856): it is bound to that task and its owner assignment.
        if (earlier.kind === 'task') throw new ConflictError('Try again from the task', 'ASSISTANT_RUN_NOT_RETRYABLE');
        if (IN_FLIGHT.has(earlier.status)) throw new ConflictError('The run is still in progress', 'ASSISTANT_RUN_NOT_RETRYABLE');
        const started = await start(ports, principal, earlier.conversationId, retryRequest(earlier, command?.clientRunId), earlier.id);
        return { run: await runView(ports, started.run), created: started.created };
      });
    },

    /**
     * Before dispatch the stop is certain and free: the run ends and its reservation is released (a paused request
     * included). During dispatch the worker aborts the request as best effort and keeps the reservation until the charge
     * is known. After a stop nothing is committed.
     */
    async stop(principal: Principal, runId: string): Promise<AssistantRun> {
      return uow.run(async (ports) => {
        const run = await ownRun(ports, principal, runId, true);
        const by = ownerOf(principal);
        if (run.status === 'queued' || run.status === 'reading') {
          return runView(ports, await updateAndAnnounce(ports, run.id, {
            status: 'stopped', stopRequestedAt: new Date(), stopRequestedBy: by, costState: 'released', chargedMicros: 0, completedAt: new Date(),
          }));
        }
        if (run.status === 'dispatching' && !run.stopRequestedAt) return runView(ports, await updateAndAnnounce(ports, run.id, { stopRequestedAt: new Date(), stopRequestedBy: by }));
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

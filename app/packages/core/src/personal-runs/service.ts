import { randomUUID } from 'node:crypto';
import {
  PERSONAL_RUN_CONSENT_VERSION,
  PERSONAL_RUN_LIMITS,
  type AssistantAnswer,
  type AssistantRun,
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
  EnablementRecord, PersonalConnection, PersonalConnectionLookup, PersonalRunPorts, PersonalRunUnitOfWork, RunRecord,
} from './ports.js';
import { announce, updateAndAnnounce } from './progress.js';
import { centsToMicros, normalizeEnable, normalizeInvoke, normalizeUpdate, retryRequest, runReservationMicros, type NormalizedInvoke } from './validation.js';

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
    perRunCents: record.perRunCents, dailyCapCents: record.dailyCapCents, timeZone: record.timeZone, status: record.status,
    agents: record.agents.map((agent) => ({ ...agent })), version: record.version,
    createdAt: iso(record.createdAt), updatedAt: iso(record.updatedAt),
  };
}

/** The answer as the place's audience sees it: no cost, cap, connection or hidden source. */
export async function answerView(ports: PersonalRunPorts, record: RunRecord): Promise<AssistantAnswer | null> {
  if (record.answerBody === null || !record.committedAt) return null;
  const names = await ports.runs.names([record.ownerUserId]);
  const name = names.get(record.ownerUserId) ?? 'Former member';
  const proposal = await ports.runs.proposalOfRun(record.id);
  return {
    runId: record.id, conversationId: record.conversationId, projectId: record.projectId,
    audience: { kind: 'project', projectId: record.projectId },
    assistant: { ownerUserId: record.ownerUserId, label: assistantLabel(name) },
    askedBy: { id: record.ownerUserId, name },
    request: { kind: record.kind, prompt: record.prompt }, body: record.answerBody, truncated: record.answerTruncated,
    provenance: { provider: record.provider, model: record.model }, sources: record.answerSources.map((source) => ({ ...source })),
    proposalId: proposal?.id ?? null, committedAt: iso(record.committedAt),
  };
}

export async function runView(ports: PersonalRunPorts, record: RunRecord): Promise<AssistantRun> {
  return {
    id: record.id, clientRunId: record.clientRunId, workspaceId: record.workspaceId, projectId: record.projectId,
    conversationId: record.conversationId, kind: record.kind, prompt: record.prompt,
    target: record.targetSketchId && record.targetThoughtId ? { type: 'thought', sketchId: record.targetSketchId, thoughtId: record.targetThoughtId } : null,
    continuesRunId: record.continuesRunId, retryOfRunId: record.retryOfRunId, status: record.status,
    stoppedAtStage: record.stoppedAtStage, stopRequested: record.stopRequestedAt !== null,
    cost: { state: record.costState, reservedMicros: record.reservedMicros, chargedMicros: record.chargedMicros, inputTokens: record.inputTokens, outputTokens: record.outputTokens },
    answer: await answerView(ports, record),
    createdAt: iso(record.createdAt), dispatchedAt: record.dispatchedAt ? iso(record.dispatchedAt) : null,
    completedAt: record.completedAt ? iso(record.completedAt) : null,
  };
}

/**
 * The owner's usable connection and what one run on it reserves (F-020 PROV-3), or why it cannot
 * be used now: no price means nothing can be reserved, and a model whose largest request costs more
 * than the owner's per-run ceiling is never started. There is never another connection to fall back to.
 */
export async function usableConnection(connections: PersonalConnectionLookup, providerEnabled: boolean, enablement: EnablementRecord):
  Promise<{ problem: PersonalAssistantUnavailableReason } | { problem: null; connection: PersonalConnection; reservedMicros: number }> {
  if (!providerEnabled) return { problem: 'provider_off' };
  // The connection the consent names, and no other (PROV-1): removing it stops the assistant.
  const connection = enablement.connectionId ? await connections.resolve(enablement.ownerUserId, enablement.connectionId) : null;
  if (!connection || connection.status !== 'active' || connection.ownerUserId !== enablement.ownerUserId) return { problem: 'no_connection' };
  // The consent was given for one connection; a replaced key needs a new consent.
  if (connection.id !== enablement.connectionId) return { problem: 'connection_changed' };
  const reservedMicros = runReservationMicros(connection.price);
  if (reservedMicros === null) return { problem: 'price_unknown' };
  if (reservedMicros > centsToMicros(enablement.perRunCents)) return { problem: 'run_cost_over_limit' };
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
}

export function createPersonalRunUseCases({ uow, connections, providerEnabled }: PersonalRunDeps) {
  async function status(ports: PersonalRunPorts, owner: string): Promise<PersonalAssistantStatus> {
    const named = await ports.runs.enablement(owner);
    const connection = providerEnabled ? await connections.resolve(owner, named?.connectionId ?? undefined) : null;
    const usable = connection && connection.status === 'active' && connection.ownerUserId === owner ? connection : null;
    // The disclosure names the caller's own connection: its provider, model and price (F-020).
    const disclosure = {
      consentVersion: PERSONAL_RUN_CONSENT_VERSION, provider: usable?.provider ?? null, model: usable?.model ?? null,
      price: usable?.price ? { ...usable.price } : null, maxRunMicros: usable ? runReservationMicros(usable.price) : null,
      maxInputTokens: PERSONAL_RUN_LIMITS.maxInputTokens, maxOutputTokens: PERSONAL_RUN_LIMITS.maxOutputTokens,
      dataSent: 'project_place_excerpts',
    } as const;
    const setup = {
      provider: providerEnabled ? 'on' as const : 'off' as const,
      connection: usable ? 'active' as const : 'none' as const,
    };
    const enablement = await ports.runs.enablement(owner);
    if (!enablement) return { state: 'not_enabled', unavailableReason: null, enablement: null, setup, today: null, disclosure };
    const spend = await ports.runs.spendToday(owner, enablement.timeZone);
    const today = { chargedMicros: spend.chargedMicros, reservedMicros: spend.reservedMicros, capCents: enablement.dailyCapCents, resetsAt: iso(spend.resetsAt) };
    const view = enablementView(enablement);
    if (enablement.status === 'paused') return { state: 'paused', unavailableReason: null, enablement: view, setup, today, disclosure };
    const usableNow = await usableConnection(connections, providerEnabled, enablement);
    if (usableNow.problem) return { state: 'unavailable', unavailableReason: usableNow.problem, enablement: view, setup, today, disclosure };
    const capped = spend.chargedMicros + spend.reservedMicros + usableNow.reservedMicros > centsToMicros(enablement.dailyCapCents);
    return { state: capped ? 'capped' : 'ready', unavailableReason: null, enablement: view, setup, today, disclosure };
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
    const usableNow = await usableConnection(connections, providerEnabled, enablement);
    if (usableNow.problem) throw unavailable(usableNow.problem);
    const agentId = enablement.agents.find((agent) => agent.workspaceId === place.workspaceId)?.agentId;
    if (!agentId || !(await ports.access.canInvoke(principal, agentId, { lock: true })))
      throw new ConflictError('Choose your assistant for this workspace first', 'PERSONAL_RUN_NO_AGENT');
    const agent = { kind: 'agent' as const, id: agentId };
    if (!(await ports.access.canUseProject(agent, 'read', place.projectId, { lock: true })))
      throw new ConflictError('Your assistant has no access to this project', 'PERSONAL_RUN_NO_PROJECT_ACCESS');
    // A run a crashed worker left behind must not block the owner forever (the job expires after 5 minutes).
    for (const ended of await ports.runs.endStale(owner, STALE_AFTER_SECONDS)) await announce(ports, ended);
    if (await ports.runs.hasRunInFlight(owner)) throw new ConflictError('Your assistant is already working on a request', 'PERSONAL_RUN_IN_FLIGHT');
    const spend = await ports.runs.spendToday(owner, enablement.timeZone);
    // PROV-3: the run reserves its largest possible cost at the connection's price.
    const { reservedMicros, connection } = usableNow;
    if (spend.chargedMicros + spend.reservedMicros + reservedMicros > centsToMicros(enablement.dailyCapCents)) throw new PersonalRunCappedError();
    const run = await ports.runs.insertRun({
      id: randomUUID(), workspaceId: place.workspaceId, projectId: place.projectId, conversationId: conversationId.toLowerCase(),
      ownerUserId: owner, agentId, connectionId: enablement.connectionId, clientRunId: request.clientRunId,
      requestFingerprint: request.fingerprint, kind: request.kind, prompt: request.prompt,
      targetSketchId: request.target?.sketchId ?? null, targetThoughtId: request.target?.thoughtId ?? null,
      continuesRunId: request.continuesRunId, retryOfRunId, reservedMicros, provider: connection.provider, model: connection.model,
    });
    await ports.queue.enqueue(run.id);
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

  return {
    status: (principal: Principal) => uow.run((ports) => status(ports, ownerOf(principal))),

    /** Needs the owner's usable key connection; the consent snapshots its payer. */
    async enable(principal: Principal, command: EnablePersonalRunsCommand): Promise<PersonalAssistantStatus> {
      const owner = ownerOf(principal);
      const input = normalizeEnable(command);
      return uow.run(async (ports) => {
        const { workspaceId } = await ports.access.requireInvoke(principal, input.agentId, { lock: true });
        if (await ports.runs.enablement(owner, { lock: true })) throw new ConflictError('Your assistant is already enabled', 'PERSONAL_RUN_ALREADY_ENABLED');
        // The owner chooses which of their connections the assistant uses; without a choice, their newest.
        const connection = await connections.resolve(owner, input.connectionId ?? undefined);
        if (!connection || connection.status !== 'active' || connection.ownerUserId !== owner)
          throw new ConflictError('Connect your own AI key before enabling your assistant', 'PERSONAL_RUN_CONNECTION_REQUIRED');
        // PROV-3: a connection without a known price cannot be enabled; a model whose largest
        // request exceeds the chosen per-run ceiling would never run.
        const reservation = runReservationMicros(connection.price);
        if (reservation === null) throw new ConflictError('Your AI connection has no known price', 'PERSONAL_RUN_PRICE_UNKNOWN');
        if (reservation > centsToMicros(input.perRunCents))
          throw new ConflictError('One request to this model can cost more than your per-request limit', 'PERSONAL_RUN_COST_OVER_LIMIT');
        const created = await ports.runs.insertEnablement({
          ownerUserId: owner, connectionId: connection.id, consentVersion: PERSONAL_RUN_CONSENT_VERSION,
          consentProvider: connection.provider, consentModel: connection.model,
          consentPayerOrganization: connection.payer.organization, consentPayerWorkspace: connection.payer.workspace,
          perRunCents: input.perRunCents, dailyCapCents: input.dailyCapCents, timeZone: input.timeZone,
        });
        if (!created) throw new ConflictError('Your assistant is already enabled', 'PERSONAL_RUN_ALREADY_ENABLED');
        await ports.runs.selectAgent(owner, workspaceId, input.agentId);
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
        const { workspaceId } = await ports.access.requireInvoke(principal, agentId, { lock: true });
        await lockedEnablement(ports, owner);
        await ports.runs.selectAgent(owner, workspaceId, agentId);
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
        await lockedEnablement(ports, owner);
        for (const ended of await ports.runs.endUndispatched(owner, 'revoked')) await announce(ports, ended);
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

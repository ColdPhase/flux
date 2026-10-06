import { workRows } from '@flux/db';
import type { FastifyError, FastifyInstance } from 'fastify';
import { AI_BASE_URL_MAX_LENGTH, AI_MODEL_LISTS_PATH, AI_PRICE_MAX_MICROS_PER_MTOK, AI_PROVIDER_KINDS, backgroundComparisonRuntimePath, backgroundComputeUsagePath,
  proactiveComparisonOutcomePath, proactiveComparisonOutcomesPath, proactiveComparisonProposalsPath, WORK_LIMITS, type AiModelListQuery,
  type BackgroundComparisonRuntime, type ConnectBackgroundComputeCommand, type UpdateBackgroundComputeConnectionCommand, type CreateProactiveComparisonRule } from '@flux/contracts';
import { backgroundConnectionRepository, comparisonProposalView, proactiveOutboxRows, proactiveRuleRows, sealBackgroundKey } from '@flux/db';
import { backgroundConnectionUseCases, baseUrlSyntaxProblem, ConflictError, DomainError, enforce, evaluateProject, InvalidInputError,
  isUuid, normalizeBaseUrl, NotFoundError, proactiveRuleUseCases, VersionConflictError, visibleProposal, type Database } from '@flux/core';
import type { SessionResolver } from '../identity/index.js';
import { taskUseDomainError } from '../work/task-use-errors.js';
import { nativeWorkInTransaction } from '../work/adapters.js';
import { comparisonOutcomeAccess, comparisonOutcomes } from './outcome-adapter.js';
import { aiConnectionServerComposition, type AiConnectionServerComposition } from './ai-composition.js';

interface Options {
  db: Database; sessions: SessionResolver; backgroundMasterKey: Buffer | null; ai?: AiConnectionServerComposition;
  /** `FLUX_BACKGROUND_COMPARISONS=on` (ServerConfig): the worker runs comparisons, so owners may enable their rules (#58). */
  comparisonsEnabled: boolean;
}

/** The comparison rule use cases over the request's transaction, with the operator's switch (#58). */
export function comparisonRuleUseCases(db: Database, runtimeAvailable: boolean) {
  return proactiveRuleUseCases({ run: (action) => db.transaction(async (tx) => action({
    access: { async requireProject(principal, projectId, mode) {
      const result = enforce(await evaluateProject(principal, mode === 'write' ? 'project.write' : 'project.read', projectId, tx,
        { lock: mode === 'write' }), 'project');
      return { workspaceId: result.project!.workspaceId };
    } },
    rules: proactiveRuleRows(tx),
  })) }, { runtimeAvailable });
}

const microsPerMTok = { type: 'integer', minimum: 0, maximum: AI_PRICE_MAX_MICROS_PER_MTOK };

export async function proactiveComparisonRoutes(app: FastifyInstance, { db, sessions, backgroundMasterKey, ai = aiConnectionServerComposition(process.env),
  comparisonsEnabled }: Options) {
  const outcomes = comparisonOutcomes(db);
  const connections = backgroundConnectionUseCases(backgroundConnectionRepository(db), {
    seal(plainKey, ownerUserId, connectionId) {
      if (!backgroundMasterKey) throw new ConflictError('Background key custody is unavailable on this instance', 'BACKGROUND_KEY_CUSTODY_UNAVAILABLE');
      return sealBackgroundKey(plainKey, ownerUserId, connectionId, backgroundMasterKey);
    },
  }, ai.providers);
  const rules = comparisonRuleUseCases(db, comparisonsEnabled);
  // Lets the settings page offer "Enable rule" only where the worker runs comparisons (#58).
  app.get(backgroundComparisonRuntimePath, async (request): Promise<BackgroundComparisonRuntime> => {
    await sessions.requirePrincipal(request);
    return { status: comparisonsEnabled ? 'available' : 'unavailable' };
  });
  app.setErrorHandler((error: FastifyError | DomainError, _request, reply) => {
    error = taskUseDomainError(error) as typeof error;
    if (error instanceof DomainError) return reply.code(error.status).send({ error: error.message, code: error.code, ...error.details });
    if ((error as FastifyError).statusCode === 401) return reply.code(401).send({ error: 'Authentication required', code: 'UNAUTHENTICATED' });
    throw error;
  });
  app.post<{ Body: ConnectBackgroundComputeCommand }>('/api/v1/background-compute-connections', {
    schema: { body: { type: 'object', additionalProperties: false,
      required: ['provider', 'model', 'apiKey', 'payerOrganization', 'providerWorkspace', 'workspaceScopedKeyConfirmed',
        'payerAuthorityConfirmed', 'providerBillingAcknowledged', 'projectDataDisclosureAcknowledged',
        'maxRunsPerDay', 'periodDays', 'periodBudgetCents', 'perRunCents'],
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 80 },
        useForBackground: { type: 'boolean' },
        provider: { type: 'string', enum: [...AI_PROVIDER_KINDS] },
        model: { type: 'string', minLength: 1, maxLength: 200 },
        baseUrl: { type: 'string', minLength: 1, maxLength: AI_BASE_URL_MAX_LENGTH },
        price: { type: 'object', additionalProperties: false, required: ['inputMicrosPerMTok', 'outputMicrosPerMTok'],
          properties: { inputMicrosPerMTok: microsPerMTok, outputMicrosPerMTok: microsPerMTok } },
        apiKey: { type: 'string', minLength: 8, maxLength: 512 },
        payerOrganization: { type: 'string', minLength: 2, maxLength: 120 },
        providerWorkspace: { type: 'string', minLength: 2, maxLength: 120 },
        workspaceScopedKeyConfirmed: { const: true }, payerAuthorityConfirmed: { const: true },
        providerBillingAcknowledged: { const: true }, projectDataDisclosureAcknowledged: { const: true },
        maxRunsPerDay: { type: 'integer', minimum: 1, maximum: 3 }, periodDays: { const: 30 },
        periodBudgetCents: { type: 'integer', minimum: 5, maximum: 1000 },
        perRunCents: { type: 'integer', minimum: 5, maximum: 50 },
      } } },
  }, async (request, reply) => reply.code(201).send(await connections.connect(
    (await sessions.requirePrincipal(request)).principal, request.body)));
  // PROV-1: all of the owner's own connections; never another person's.
  app.get('/api/v1/background-compute-connections', async (request) => connections.list(
    (await sessions.requirePrincipal(request)).principal));
  // The connection background comparisons use (kept for earlier clients).
  app.get('/api/v1/background-compute-connections/current', async (request) => connections.current(
    (await sessions.requirePrincipal(request)).principal));
  app.patch<{ Params: { connectionId: string }; Body: UpdateBackgroundComputeConnectionCommand }>('/api/v1/background-compute-connections/:connectionId', {
    schema: { body: { type: 'object', additionalProperties: false, minProperties: 1, properties: {
      name: { type: 'string', minLength: 1, maxLength: 80 }, usedForBackground: { const: true } } } },
  }, async (request) => connections.update((await sessions.requirePrincipal(request)).principal, request.params.connectionId, request.body));
  // A provider's models, listed by this server without a key and through the endpoint guard (PROV-1).
  app.post<{ Body: AiModelListQuery }>(AI_MODEL_LISTS_PATH, {
    schema: { body: { type: 'object', additionalProperties: false, required: ['provider'], properties: {
      provider: { type: 'string', enum: [...AI_PROVIDER_KINDS] },
      baseUrl: { type: 'string', minLength: 1, maxLength: AI_BASE_URL_MAX_LENGTH } } } },
  }, async (request) => {
    await sessions.requirePrincipal(request);
    const { provider, baseUrl } = request.body;
    if (provider === 'openai_compatible') {
      const problem = baseUrlSyntaxProblem(baseUrl);
      if (problem) throw new InvalidInputError(problem, 'AI_BASE_URL_INVALID');
    } else if (baseUrl !== undefined) throw new InvalidInputError('A named provider always uses its own public API address', 'AI_BASE_URL_INVALID');
    return ai.listModels(provider, provider === 'openai_compatible' ? normalizeBaseUrl(baseUrl!) : null);
  });
  app.delete<{ Params: { connectionId: string } }>('/api/v1/background-compute-connections/:connectionId', async (request, reply) => {
    await connections.revoke((await sessions.requirePrincipal(request)).principal, request.params.connectionId);
    return reply.code(204).send();
  });
  app.post<{ Params: { projectId: string }; Body: CreateProactiveComparisonRule }>('/api/v1/projects/:projectId/proactive-comparison-rules',
    async (request, reply) => reply.code(201).send(await rules.create(
      (await sessions.requirePrincipal(request)).principal, request.params.projectId, request.body)));
  app.get<{ Params: { projectId: string } }>('/api/v1/projects/:projectId/proactive-comparison-rules',
    async (request) => rules.list((await sessions.requirePrincipal(request)).principal, request.params.projectId));
  app.get<{ Params: { projectId: string } }>(proactiveComparisonProposalsPath(':projectId'),
    async (request) => db.transaction(async (tx) => {
      const principal = (await sessions.requirePrincipal(request)).principal;
      enforce(await evaluateProject(principal, 'project.read', request.params.projectId, tx, { lock: true }), 'project');
      const access = comparisonOutcomeAccess(tx);
      const proposals = await proactiveOutboxRows(tx).listProposals(request.params.projectId);
      return Promise.all(proposals.map((proposal) => visibleProposal(access, principal, proposal)));
    }));
  app.get<{ Params: { projectId: string }; Querystring: { limit?: number; offset?: number } }>(
    proactiveComparisonOutcomesPath(':projectId'), { schema: { querystring: { type: 'object', additionalProperties: false,
      properties: { limit: { type: 'integer', minimum: 1, maximum: 100 }, offset: { type: 'integer', minimum: 0, maximum: 10000 } } } } },
    async (request) => outcomes.list((await sessions.requirePrincipal(request)).principal, request.params.projectId,
      request.query.limit, request.query.offset));
  app.patch<{ Params: { outcomeId: string }; Body: { expectedVersion: number; status: 'dismissed' } }>(
    proactiveComparisonOutcomePath(':outcomeId'), { schema: { body: { type: 'object', additionalProperties: false,
      required: ['expectedVersion', 'status'], properties: { expectedVersion: { type: 'integer', minimum: 1 }, status: { const: 'dismissed' } } } } },
    async (request) => outcomes.dismiss((await sessions.requirePrincipal(request)).principal,
      request.params.outcomeId, request.body.expectedVersion));
  app.get(backgroundComputeUsagePath, { schema: { querystring: { type: 'object', additionalProperties: false } } },
    async (request) => outcomes.usage((await sessions.requirePrincipal(request)).principal));
  app.patch<{ Params: { proposalId: string }; Body: { expectedVersion: number; fact?: string;
    interpretation?: string; suggestedAction?: string; status?: 'dismissed' } }>(
    '/api/v1/proactive-comparison-proposals/:proposalId', async (request) => db.transaction(async (tx) => {
      const principal = (await sessions.requirePrincipal(request)).principal;
      if (principal.kind !== 'human') throw new InvalidInputError('A signed-in person must review the proposal');
      if (!isUuid(request.params.proposalId)) throw new NotFoundError('Proposal');
      const body = request.body;
      if (!body || !Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1
        || (!body.status && body.fact === undefined && body.interpretation === undefined && body.suggestedAction === undefined))
        throw new InvalidInputError('A proposal change and expected version are required');
      if (body.status !== undefined && body.status !== 'dismissed') throw new InvalidInputError('Invalid proposal status');
      for (const value of [body.fact, body.interpretation, body.suggestedAction]) {
        if (value !== undefined && (typeof value !== 'string' || !value.trim() || value.trim().length > 10_000))
          throw new InvalidInputError('Proposal text must be 1–10000 characters');
      }
      // The suggested next step becomes the outcome of work created from the proposal, so it keeps that limit.
      if (typeof body.suggestedAction === 'string' && body.suggestedAction.trim().length > WORK_LIMITS.outcome)
        throw new InvalidInputError(`The suggested next step must be at most ${WORK_LIMITS.outcome} characters`);
      const rows = proactiveOutboxRows(tx);
      const located = await rows.proposal(request.params.proposalId);
      if (!located) throw new NotFoundError('Proposal');
      enforce(await evaluateProject(principal, 'project.write', located.projectId, tx, { lock: true }), 'project');
      const current = await rows.lockProposal(request.params.proposalId);
      if (!current) throw new NotFoundError('Proposal');
      enforce(await evaluateProject(principal, 'project.write', current.projectId, tx, { lock: true }), 'project');
      if (current.version !== body.expectedVersion) throw new VersionConflictError(current.version, { version: current.version });
      if (current.status !== 'proposed') throw new ConflictError('The proposal has already been reviewed', 'PROPOSAL_REVIEWED');
      const revised = await rows.reviseProposal(current.id, { fact: body.fact?.trim(), interpretation: body.interpretation?.trim(),
        suggestedAction: body.suggestedAction?.trim(), status: body.status, editedByUserId: principal.id });
      if (!revised) throw new NotFoundError('Proposal');
      // The stored citations keep their history; the response shows what this reader can open now, like the reads.
      return visibleProposal(comparisonOutcomeAccess(tx), principal, revised);
    }));
  app.post<{ Params: { proposalId: string }; Body: { expectedVersion: number; title: string } }>(
    '/api/v1/proactive-comparison-proposals/:proposalId/use', async (request) => db.transaction(async (tx) => {
      const principal = (await sessions.requirePrincipal(request)).principal;
      if (principal.kind !== 'human') throw new InvalidInputError('A signed-in person must use the proposal');
      if (!isUuid(request.params.proposalId)) throw new NotFoundError('Proposal');
      const body = request.body;
      if (!body || !Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1
        || typeof body.title !== 'string' || !body.title.trim() || body.title.trim().length > 200)
        throw new InvalidInputError('A work title and expected version are required');
      const rows = proactiveOutboxRows(tx);
      const located = await rows.proposal(request.params.proposalId);
      if (!located) throw new NotFoundError('Proposal');
      enforce(await evaluateProject(principal, 'project.write', located.projectId, tx, { lock: true }), 'project');
      const current = await rows.lockProposal(request.params.proposalId);
      if (!current) throw new NotFoundError('Proposal');
      enforce(await evaluateProject(principal, 'project.write', current.projectId, tx, { lock: true }), 'project');
      if (current.version !== body.expectedVersion) throw new VersionConflictError(current.version, { version: current.version });
      if (current.status !== 'proposed') throw new ConflictError('The proposal has already been reviewed', 'PROPOSAL_REVIEWED');
      const access = comparisonOutcomeAccess(tx);
      // The work links the citations this reader can open now, like the proposal they used. A cited
      // source deleted since the proposal is not linked and does not make the proposal unusable.
      const { sources: cited } = await visibleProposal(access, principal, comparisonProposalView(current));
      const sourceRefs = cited.reduce<Array<{ type: 'material'; id: string; version: number } | { type: 'message'; id: string }>>(
        (refs, source) => {
          if (source.type === 'material') refs.push({ type: 'material', id: source.id, version: source.version });
          if (source.type === 'message') refs.push({ type: 'message', id: source.id });
          return refs;
        }, []);
      const native = nativeWorkInTransaction(tx);
      const created = await native.createWork(principal, current.projectId, {
        title: body.title.trim(), outcome: current.suggestedAction,
        sources: sourceRefs,
        related: cited.flatMap((source) => source.type === 'result' || source.type === 'work' || source.type === 'thought'
          ? [{ type: source.type, id: source.id }] : []),
      }, { proposalId: current.id });
      const used = await rows.reviseProposal(current.id, { status: 'used', usedWorkId: created.id, editedByUserId: principal.id });
      if (!used) throw new NotFoundError('Proposal');
      const stored = await workRows(tx).findWork(created.id);
      await workRows(tx).recordCreationBaseline(stored!, current.id);
      const result = { proposal: await visibleProposal(access, principal, used), work: await native.getWork(principal, created.id) };
      await native.flushEvents();
      return result;
    }));
  app.patch<{ Params: { ruleId: string }; Body: { expectedVersion: number; status: 'enabled' | 'paused' | 'revoked' } }>(
    '/api/v1/proactive-comparison-rules/:ruleId', async (request) => rules.setStatus(
      (await sessions.requirePrincipal(request)).principal, request.params.ruleId, request.body?.expectedVersion, request.body?.status));
}

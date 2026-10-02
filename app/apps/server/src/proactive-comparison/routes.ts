import type { FastifyError, FastifyInstance } from 'fastify';
import { backgroundComputeUsagePath, proactiveComparisonOutcomePath, proactiveComparisonOutcomesPath,
  proactiveComparisonProposalsPath, WORK_LIMITS, type ConnectBackgroundComputeCommand, type CreateProactiveComparisonRule } from '@flux/contracts';
import { backgroundConnectionRepository, comparisonProposalView, proactiveOutboxRows, proactiveRuleRows, sealBackgroundKey } from '@flux/db';
import { backgroundConnectionUseCases, ConflictError, DomainError, enforce, evaluateProject, InvalidInputError,
  isUuid, NotFoundError, proactiveRuleUseCases, VersionConflictError, visibleProposal, type Database } from '@flux/core';
import type { SessionResolver } from '../identity/index.js';
import { workUseCases } from '../work/adapters.js';
import { comparisonOutcomeAccess, comparisonOutcomes } from './outcome-adapter.js';

interface Options { db: Database; sessions: SessionResolver; backgroundMasterKey: Buffer | null }

export async function proactiveComparisonRoutes(app: FastifyInstance, { db, sessions, backgroundMasterKey }: Options) {
  const outcomes = comparisonOutcomes(db);
  const connections = backgroundConnectionUseCases(backgroundConnectionRepository(db), {
    seal(plainKey, ownerUserId, connectionId) {
      if (!backgroundMasterKey) throw new ConflictError('Background key custody is unavailable on this instance', 'BACKGROUND_KEY_CUSTODY_UNAVAILABLE');
      return sealBackgroundKey(plainKey, ownerUserId, connectionId, backgroundMasterKey);
    },
  });
  const rules = proactiveRuleUseCases({ run: (action) => db.transaction(async (tx) => action({
    access: { async requireProject(principal, projectId, mode) {
      const result = enforce(await evaluateProject(principal, mode === 'write' ? 'project.write' : 'project.read', projectId, tx,
        { lock: mode === 'write' }), 'project');
      return { workspaceId: result.project!.workspaceId };
    } },
    rules: proactiveRuleRows(tx),
  })) });
  app.setErrorHandler((error: FastifyError | DomainError, _request, reply) => {
    if (error instanceof DomainError) return reply.code(error.status).send({ error: error.message, code: error.code, ...error.details });
    if ((error as FastifyError).statusCode === 401) return reply.code(401).send({ error: 'Authentication required', code: 'UNAUTHENTICATED' });
    throw error;
  });
  app.post<{ Body: ConnectBackgroundComputeCommand }>('/api/v1/background-compute-connections', {
    schema: { body: { type: 'object', additionalProperties: false,
      required: ['apiKey', 'payerOrganization', 'providerWorkspace', 'workspaceScopedKeyConfirmed',
        'payerAuthorityConfirmed', 'providerBillingAcknowledged', 'projectDataDisclosureAcknowledged',
        'maxRunsPerDay', 'periodDays', 'periodBudgetCents', 'perRunCents'],
      properties: {
        apiKey: { type: 'string', minLength: 24, maxLength: 263 },
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
  app.get('/api/v1/background-compute-connections/current', async (request) => connections.current(
    (await sessions.requirePrincipal(request)).principal));
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
      const created = await workUseCases(tx).createWork(principal, current.projectId, {
        title: body.title.trim(), outcome: current.suggestedAction,
        sources: sourceRefs,
        related: cited.flatMap((source) => source.type === 'result' || source.type === 'work' || source.type === 'thought'
          ? [{ type: source.type, id: source.id }] : []),
      });
      const used = await rows.reviseProposal(current.id, { status: 'used', usedWorkId: created.id, editedByUserId: principal.id });
      if (!used) throw new NotFoundError('Proposal');
      return { proposal: await visibleProposal(access, principal, used), work: created };
    }));
  app.patch<{ Params: { ruleId: string }; Body: { expectedVersion: number; status: 'enabled' | 'paused' | 'revoked' } }>(
    '/api/v1/proactive-comparison-rules/:ruleId', async (request) => rules.setStatus(
      (await sessions.requirePrincipal(request)).principal, request.params.ruleId, request.body?.expectedVersion, request.body?.status));
}

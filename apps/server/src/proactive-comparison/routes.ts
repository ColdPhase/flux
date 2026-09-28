import type { FastifyError, FastifyInstance } from 'fastify';
import { proactiveComparisonProposalsPath, type ConnectBackgroundComputeCommand, type CreateProactiveComparisonRule } from '@flux/contracts';
import { backgroundConnectionRepository, proactiveOutboxRows, proactiveRuleRows, sealBackgroundKey } from '@flux/db';
import { backgroundConnectionUseCases, ConflictError, DomainError, enforce, evaluateProject, proactiveRuleUseCases, type Database } from '@flux/core';
import type { SessionResolver } from '../identity/index.js';

interface Options { db: Database; sessions: SessionResolver; backgroundMasterKey: Buffer | null }

export async function proactiveComparisonRoutes(app: FastifyInstance, { db, sessions, backgroundMasterKey }: Options) {
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
      return proactiveOutboxRows(tx).listProposals(request.params.projectId);
    }));
  app.patch<{ Params: { ruleId: string }; Body: { expectedVersion: number; status: 'enabled' | 'paused' | 'revoked' } }>(
    '/api/v1/proactive-comparison-rules/:ruleId', async (request) => rules.setStatus(
      (await sessions.requirePrincipal(request)).principal, request.params.ruleId, request.body?.expectedVersion, request.body?.status));
}

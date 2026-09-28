import type { FastifyError, FastifyInstance } from 'fastify';
import type { CreateProactiveComparisonRule } from '@flux/contracts';
import { proactiveRuleRows } from '@flux/db';
import { DomainError, enforce, evaluateProject, proactiveRuleUseCases, type Database } from '@flux/core';
import type { SessionResolver } from '../identity/index.js';

interface Options { db: Database; sessions: SessionResolver }

export async function proactiveComparisonRoutes(app: FastifyInstance, { db, sessions }: Options) {
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
  app.post<{ Params: { projectId: string }; Body: CreateProactiveComparisonRule }>('/api/v1/projects/:projectId/proactive-comparison-rules',
    async (request, reply) => reply.code(201).send(await rules.create(
      (await sessions.requirePrincipal(request)).principal, request.params.projectId, request.body)));
  app.get<{ Params: { projectId: string } }>('/api/v1/projects/:projectId/proactive-comparison-rules',
    async (request) => rules.list((await sessions.requirePrincipal(request)).principal, request.params.projectId));
  app.patch<{ Params: { ruleId: string }; Body: { expectedVersion: number; status: 'enabled' | 'paused' | 'revoked' } }>(
    '/api/v1/proactive-comparison-rules/:ruleId', async (request) => rules.setStatus(
      (await sessions.requirePrincipal(request)).principal, request.params.ruleId, request.body?.expectedVersion, request.body?.status));
}

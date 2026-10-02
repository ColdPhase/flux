import type { FastifyError, FastifyInstance } from 'fastify';
import { projectAgentRepository } from '@flux/db';
import { DomainError, enforce, evaluateProject, projectAgentUseCases, type Database } from '@flux/core';
import type { SessionResolver } from '../identity/index.js';

interface Options { db: Database; sessions: SessionResolver }

/** `GET /api/v1/projects/:projectId/agents`: the Agents view of one project (UI116-2, #136). */
export async function projectAgentRoutes(app: FastifyInstance, { db, sessions }: Options) {
  const agents = projectAgentUseCases(projectAgentRepository(db, {
    async authorizeRead(reader, projectId, tx) {
      enforce(await evaluateProject(reader, 'project.read', projectId, tx), 'project');
    },
    async allows(principal, action, projectId, tx) {
      return (await evaluateProject(principal, action, projectId, tx)).allowed;
    },
  }));
  app.setErrorHandler((error: FastifyError | DomainError, _request, reply) => {
    if (error instanceof DomainError) return reply.code(error.status).send({ error: error.message, code: error.code });
    if ((error as FastifyError).statusCode === 401)
      return reply.code(401).send({ error: 'Authentication required', code: 'UNAUTHENTICATED' });
    throw error;
  });
  app.get<{ Params: { projectId: string } }>('/api/v1/projects/:projectId/agents', async (request) =>
    agents.list((await sessions.requirePrincipal(request)).principal, request.params.projectId));
}

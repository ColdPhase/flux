import type { FastifyError, FastifyInstance } from 'fastify';
import type { PageQuery } from '@flux/contracts';
import { agentProposalRepository } from '@flux/db';
import { agentProposalUseCases, DomainError, enforce, evaluateProject, recordEvent, type Database } from '@flux/core';
import type { SessionResolver } from '../identity/index.js';

interface Options { db: Database; sessions: SessionResolver }

/** The human review surface uses the same current project policy as conversations. */
export async function agentProposalRoutes(app: FastifyInstance, { db, sessions }: Options) {
  const store = agentProposalUseCases(agentProposalRepository(db, {
    async authorizeWrite(principal, projectId, tx) {
      const checked = enforce(await evaluateProject(principal, 'project.write', projectId, tx, { lock: true }), 'project');
      return { workspaceId: checked.project!.workspaceId };
    },
    async authorizeRead(principal, projectId, tx) {
      enforce(await evaluateProject(principal, 'project.read', projectId, tx, { lock: true }), 'project');
    },
    async recordCreated(principal, workspaceId, projectId, tx) {
      await recordEvent(tx, principal, workspaceId, 'project.proposal_created.v1', projectId, {});
    },
  }));
  app.setErrorHandler((error: FastifyError | DomainError, _request, reply) => {
    if (error instanceof DomainError) return reply.code(error.status).send({ error: error.message, code: error.code });
    if ((error as FastifyError).statusCode === 401)
      return reply.code(401).send({ error: 'Authentication required', code: 'UNAUTHENTICATED' });
    throw error;
  });
  app.get<{ Params: { projectId: string }; Querystring: PageQuery }>('/api/v1/projects/:projectId/agent-proposals',
    { schema: { querystring: { type: 'object', additionalProperties: false,
      properties: { limit: { type: 'integer' }, offset: { type: 'integer' } } } } },
    async (request) => store.listForPerson((await sessions.requirePrincipal(request)).principal, request.params.projectId, request.query));
}

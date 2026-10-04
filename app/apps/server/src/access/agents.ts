import type { FastifyInstance } from 'fastify';
import { AGENTS_PATH, WORKSPACES_PATH, type CreateAgentCommand } from '@flux/contracts';
import { createAgent, listAgents, revokeAgent } from '@flux/core';
import { bodyId, requires } from '../http/commands.js';
import { nameSchema } from '../http/schemas.js';
import type { AccessContext } from './context.js';

/** Agent identities in a workspace (#85): list, create and revoke. */
export function agentRoutes(app: FastifyInstance, { db, principal, command, workspaceScope }: AccessContext) {
  app.get<{ Params: { workspaceId: string } }>(`${WORKSPACES_PATH}/:workspaceId/agents`, async (request) =>
    listAgents(await principal(request), request.params.workspaceId, db));
  app.post<{ Params: { workspaceId: string }; Body: CreateAgentCommand }>(`${WORKSPACES_PATH}/:workspaceId/agents`, {
    schema: { body: { type: 'object', required: ['name', 'owner'], additionalProperties: false, properties: { name: nameSchema, owner: { type: 'string', enum: ['self', 'workspace'] } } } },
  }, async (request, reply) => command(request, reply, {
    operation: `POST ${WORKSPACES_PATH}/:workspaceId/agents`, scope: workspaceScope(request.params.workspaceId), status: 201,
    run: (actor, conn) => createAgent(actor, request.params.workspaceId, request.body, conn),
    replay: requires('agent', 'agent.read', bodyId),
  }));
  app.delete<{ Params: { agentId: string } }>(`${AGENTS_PATH}/:agentId`, async (request) =>
    revokeAgent(await principal(request), request.params.agentId, db));
}

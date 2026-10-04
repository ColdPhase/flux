import type { FastifyInstance } from 'fastify';
import { WORKSPACES_PATH, type AddMemberCommand, type ChangeRoleCommand, type CreateWorkspaceCommand } from '@flux/contracts';
import { addMember, assertAuthorized, changeRole, createWorkspace, getWorkspace, listMembers, listWorkspaces, removeMember } from '@flux/core';
import { bodyId, requires } from '../http/commands.js';
import { nameSchema } from '../http/schemas.js';
import type { AccessContext } from './context.js';

const roleSchema = { type: 'string', enum: ['owner', 'admin', 'member', 'guest'] } as const;

/** Workspaces and their membership (#85): list, create, read, members, roles and leaving. */
export function workspaceRoutes(app: FastifyInstance, { db, principal, command, runCommand, sendCommand, workspaceScope, workspaceChange }: AccessContext) {
  app.get(WORKSPACES_PATH, async (request) => listWorkspaces(await principal(request), db));
  app.post<{ Body: CreateWorkspaceCommand }>(WORKSPACES_PATH, {
    schema: { body: { type: 'object', required: ['name'], additionalProperties: false, properties: { name: nameSchema } } },
  }, async (request, reply) => command(request, reply, {
    operation: `POST ${WORKSPACES_PATH}`, scope: null, status: 201,
    run: (actor, conn) => createWorkspace(actor, request.body, conn),
    replay: requires('workspace', 'workspace.read', bodyId),
  }));
  app.get<{ Params: { workspaceId: string } }>(`${WORKSPACES_PATH}/:workspaceId`, async (request) =>
    getWorkspace(await principal(request), request.params.workspaceId, db));

  app.get<{ Params: { workspaceId: string } }>(`${WORKSPACES_PATH}/:workspaceId/members`, async (request) =>
    listMembers(await principal(request), request.params.workspaceId, db));
  app.post<{ Params: { workspaceId: string }; Body: AddMemberCommand }>(`${WORKSPACES_PATH}/:workspaceId/members`, {
    schema: { body: { type: 'object', required: ['role'], additionalProperties: false, properties: { userId: { type: 'string' }, email: { type: 'string' }, role: roleSchema } } },
  }, async (request, reply) => command(request, reply, {
    operation: `POST ${WORKSPACES_PATH}/:workspaceId/members`, scope: workspaceScope(request.params.workspaceId), status: 201,
    run: (actor, conn) => addMember(actor, request.params.workspaceId, request.body, conn),
    replay: requires('workspace', 'workspace.read_members', () => request.params.workspaceId),
  }));
  app.patch<{ Params: { workspaceId: string; userId: string }; Body: ChangeRoleCommand }>(`${WORKSPACES_PATH}/:workspaceId/members/:userId`, {
    schema: { body: { type: 'object', required: ['role'], additionalProperties: false, properties: { role: roleSchema } } },
  }, async (request, reply) => {
    await assertAuthorized(await principal(request), 'workspace.manage_members', workspaceScope(request.params.workspaceId), db);
    const result = await workspaceChange(request.params.workspaceId, (conn) => runCommand(request, {
      operation: `PATCH ${WORKSPACES_PATH}/:workspaceId/members/:userId`, scope: workspaceScope(request.params.workspaceId),
      run: (actor, conn) => changeRole(actor, request.params.workspaceId, request.params.userId, request.body, conn),
      replay: requires('workspace', 'workspace.read_members', () => request.params.workspaceId),
    }, conn));
    return sendCommand(reply, result);
  });
  app.delete<{ Params: { workspaceId: string; userId: string } }>(`${WORKSPACES_PATH}/:workspaceId/members/:userId`, async (request, reply) => {
    const actor = await principal(request);
    await assertAuthorized(actor, actor.kind === 'human' && actor.id === request.params.userId
      ? 'workspace.read' : 'workspace.manage_members', workspaceScope(request.params.workspaceId), db);
    await workspaceChange(request.params.workspaceId, (conn) => removeMember(actor, request.params.workspaceId, request.params.userId, conn));
    return reply.code(204).send();
  });
}

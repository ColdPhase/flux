import type { FastifyInstance } from 'fastify';
import { WORKSPACES_PATH, type AddMemberCommand, type ChangeRoleCommand, type CreateWorkspaceCommand, type RenameWorkspaceCommand } from '@flux/contracts';
import { addMember, assertAuthorized, changeRole, createWorkspace, getWorkspace, listMembers, listRemovedPeople, listWorkspaces, removeMember, renameWorkspace, restoreMember } from '@flux/core';
import { accessPorts, accessReader } from '@flux/db';
import { bodyId, requires } from '../http/commands.js';
import { nameSchema } from '../http/schemas.js';
import type { AccessContext } from './context.js';

const roleSchema = { type: 'string', enum: ['owner', 'admin', 'member', 'guest'] } as const;

/**
 * The company and its people (#85, F-037): list, read, rename, members, roles and leaving. Setup makes the one company
 * (core `joinCompany`); `POST /workspaces` exists only on a test deployment, which keeps isolated workspaces.
 */
export function workspaceRoutes(app: FastifyInstance, { db, principal, command, runCommand, sendCommand, workspaceScope, workspaceChange, verifiedEmailMembers, readOptions }: AccessContext,
  options: { testDeployment?: boolean } = {}) {
  app.get(WORKSPACES_PATH, async (request) => listWorkspaces(await principal(request), db, accessPorts, readOptions()));
  if (options.testDeployment) {
    app.post<{ Body: CreateWorkspaceCommand }>(WORKSPACES_PATH, {
      schema: { body: { type: 'object', required: ['name'], additionalProperties: false, properties: { name: nameSchema } } },
    }, async (request, reply) => command(request, reply, {
      operation: `POST ${WORKSPACES_PATH}`, scope: 'account', status: 201,
      run: (actor, conn) => createWorkspace(actor, request.body, conn, accessPorts),
      replay: requires('workspace', 'workspace.read', bodyId),
    }));
  }
  app.get<{ Params: { workspaceId: string } }>(`${WORKSPACES_PATH}/:workspaceId`, async (request) =>
    getWorkspace(await principal(request), request.params.workspaceId, db, accessPorts, readOptions()));
  app.patch<{ Params: { workspaceId: string }; Body: RenameWorkspaceCommand }>(`${WORKSPACES_PATH}/:workspaceId`, {
    schema: { body: { type: 'object', required: ['name'], additionalProperties: false, properties: { name: nameSchema } } },
  }, async (request, reply) => command(request, reply, {
    operation: `PATCH ${WORKSPACES_PATH}/:workspaceId`, scope: workspaceScope(request.params.workspaceId),
    run: (actor, conn) => renameWorkspace(actor, request.params.workspaceId, request.body, conn, accessPorts, readOptions()),
    replay: requires('workspace', 'workspace.read', () => request.params.workspaceId),
  }));

  app.get<{ Params: { workspaceId: string } }>(`${WORKSPACES_PATH}/:workspaceId/members`, async (request) =>
    listMembers(await principal(request), request.params.workspaceId, db, accessPorts));
  app.post<{ Params: { workspaceId: string }; Body: AddMemberCommand }>(`${WORKSPACES_PATH}/:workspaceId/members`, {
    schema: { body: { type: 'object', required: ['role'], additionalProperties: false, properties: { userId: { type: 'string' }, email: { type: 'string' }, role: roleSchema } } },
  }, async (request, reply) => command(request, reply, {
    operation: `POST ${WORKSPACES_PATH}/:workspaceId/members`, scope: workspaceScope(request.params.workspaceId), status: 201,
    run: (actor, conn) => addMember(actor, request.params.workspaceId, request.body, conn, accessPorts, { verifiedEmailOnly: verifiedEmailMembers }),
    replay: requires('workspace', 'workspace.read_members', () => request.params.workspaceId),
  }));
  app.patch<{ Params: { workspaceId: string; userId: string }; Body: ChangeRoleCommand }>(`${WORKSPACES_PATH}/:workspaceId/members/:userId`, {
    schema: { body: { type: 'object', required: ['role'], additionalProperties: false, properties: { role: roleSchema } } },
  }, async (request, reply) => {
    await assertAuthorized(await principal(request), 'workspace.manage_members', workspaceScope(request.params.workspaceId), accessReader(db));
    const result = await workspaceChange(request.params.workspaceId, (conn) => runCommand(request, {
      operation: `PATCH ${WORKSPACES_PATH}/:workspaceId/members/:userId`, scope: workspaceScope(request.params.workspaceId),
      run: (actor, conn) => changeRole(actor, request.params.workspaceId, request.params.userId, request.body, conn, accessPorts),
      replay: requires('workspace', 'workspace.read_members', () => request.params.workspaceId),
    }, conn));
    return sendCommand(reply, result);
  });
  // Who left or was removed; Restore brings them back as a member (Hubert, 2026-11-05).
  app.get<{ Params: { workspaceId: string } }>(`${WORKSPACES_PATH}/:workspaceId/removed-people`, async (request) =>
    listRemovedPeople(await principal(request), request.params.workspaceId, db, accessPorts));
  app.post<{ Params: { workspaceId: string; userId: string } }>(`${WORKSPACES_PATH}/:workspaceId/removed-people/:userId/restore`, async (request, reply) => {
    const actor = await principal(request);
    // Authorize first, like the routes above: an id that is no company at all answers 404, not a failed query.
    await assertAuthorized(actor, 'workspace.manage_members', workspaceScope(request.params.workspaceId), accessReader(db));
    return reply.code(201).send(await workspaceChange(request.params.workspaceId, (conn) => restoreMember(actor, request.params.workspaceId, request.params.userId, conn, accessPorts)));
  });
  app.delete<{ Params: { workspaceId: string; userId: string } }>(`${WORKSPACES_PATH}/:workspaceId/members/:userId`, async (request, reply) => {
    const actor = await principal(request);
    await assertAuthorized(actor, actor.kind === 'human' && actor.id === request.params.userId
      ? 'workspace.read' : 'workspace.manage_members', workspaceScope(request.params.workspaceId), accessReader(db));
    await workspaceChange(request.params.workspaceId, (conn) => removeMember(actor, request.params.workspaceId, request.params.userId, conn, accessPorts));
    return reply.code(204).send();
  });
}

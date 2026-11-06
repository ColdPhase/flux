import type { FastifyInstance } from 'fastify';
import { fromDrizzle, type PgBoss } from 'pg-boss';
import { sql } from 'drizzle-orm';
import { WORKSPACE_AI_SWEEP_JOB, WORKSPACES_PATH, type AddMemberCommand, type ChangeRoleCommand, type CreateWorkspaceCommand,
  type RenameWorkspaceCommand, type SetWorkspaceAiPolicyCommand, type SetWorkspaceAiPolicyResult } from '@flux/contracts';
import { addMember, assertAuthorized, changeRole, createWorkspace, getWorkspace, listMembers, listRemovedPeople, listWorkspaces, removeMember, renameWorkspace, restoreMember,
  setWorkspaceAiPolicy, sweepWorkspaceAi, WorkspaceAiSweepIncomplete, type WorkspaceAiSweepQueue } from '@flux/core';
import { accessPorts, accessReader } from '@flux/db';
import { bodyId, expectedVersion, requires } from '../http/commands.js';
import { nameSchema, versionSchema } from '../http/schemas.js';
import type { AccessContext } from './context.js';

const roleSchema = { type: 'string', enum: ['owner', 'admin', 'member', 'guest'] } as const;

/**
 * The company and its people (#85, F-037): list, read, rename, members, roles and leaving. Setup makes the one company
 * (core `joinCompany`); `POST /workspaces` exists only on a test deployment, which keeps isolated workspaces.
 */
export function workspaceRoutes(app: FastifyInstance, { db, principal, command, runCommand, sendCommand, workspaceScope, workspaceChange, verifiedEmailMembers, readOptions }: AccessContext,
  boss: Pick<PgBoss, 'send'>, options: { testDeployment?: boolean } = {}) {
  /** F-029 (S2): the sweep job commits with the flip, in its transaction. */
  const sweepQueue: WorkspaceAiSweepQueue = async (tx, job) => {
    await boss.send(WORKSPACE_AI_SWEEP_JOB, job, { db: fromDrizzle(tx as Parameters<typeof fromDrizzle>[0], sql), retryLimit: 5, retryDelay: 5 });
  };
  // F-029 (S2): an owner or admin turns AI off or on for the whole workspace. The flip commits first; the sweep then runs here at
  // once (and again from the worker's job), so it never shares a transaction with the flip.
  app.put<{ Params: { workspaceId: string }; Body: SetWorkspaceAiPolicyCommand }>(`${WORKSPACES_PATH}/:workspaceId/ai-policy`, {
    schema: { body: { type: 'object', required: ['state'], additionalProperties: false,
      properties: { state: { type: 'string', enum: ['allowed', 'blocked'] }, expectedVersion: versionSchema } } },
  }, async (request, reply) => {
    const response = await runCommand(request, {
      operation: `PUT ${WORKSPACES_PATH}/:workspaceId/ai-policy`, scope: workspaceScope(request.params.workspaceId),
      run: async (actor, conn) => {
        const { sweep, ...result } = await setWorkspaceAiPolicy(actor, request.params.workspaceId,
          { ...request.body, expectedVersion: expectedVersion(request) }, conn, accessPorts, sweepQueue);
        return { ...result, sweep };
      },
      etag: (body) => { const version = (body as SetWorkspaceAiPolicyResult | null)?.ai.version; return typeof version === 'number' ? `"${version}"` : null; },
      replay: requires('workspace', 'workspace.manage_ai', () => request.params.workspaceId),
    });
    const { sweep, ...body } = (response.body ?? {}) as SetWorkspaceAiPolicyResult & { sweep?: { workspaceId: string; epoch: number } | null };
    let stopped = body.stopped ?? null;
    if (sweep && !response.replayed) {
      try { stopped = await sweepWorkspaceAi(sweep, db, accessPorts); }
      catch (error) {
        // Each step is its own transaction: what committed is reported, the rest is repeated by the worker's job.
        if (error instanceof WorkspaceAiSweepIncomplete) stopped = error.swept;
        request.log.error({ error }, 'The inline AI sweep did not finish; the worker job repeats it');
      }
    }
    return sendCommand(reply, { ...response, body: { ...body, stopped } });
  });
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

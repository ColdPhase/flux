import type { FastifyInstance } from 'fastify';
import { fromDrizzle, type PgBoss } from 'pg-boss';
import { sql } from 'drizzle-orm';
import { WORKSPACE_AI_SWEEP_JOB, WORKSPACES_PATH, type AddMemberCommand, type ChangeRoleCommand, type CreateWorkspaceCommand,
  type SetWorkspaceAiPolicyCommand, type SetWorkspaceAiPolicyResult } from '@flux/contracts';
import { addMember, assertAuthorized, changeRole, createWorkspace, getWorkspace, listMembers, listWorkspaces, removeMember, setWorkspaceAiPolicy,
  sweepWorkspaceAi, WorkspaceAiSweepIncomplete, type WorkspaceAiSweepQueue } from '@flux/core';
import { bodyId, expectedVersion, requires } from '../http/commands.js';
import { nameSchema, versionSchema } from '../http/schemas.js';
import type { AccessContext } from './context.js';

const roleSchema = { type: 'string', enum: ['owner', 'admin', 'member', 'guest'] } as const;

/** Workspaces and their membership (#85): list, create, read, members, roles and leaving. */
export function workspaceRoutes(app: FastifyInstance, { db, principal, command, runCommand, sendCommand, workspaceScope, workspaceChange, verifiedEmailMembers }: AccessContext,
  boss: Pick<PgBoss, 'send'>) {
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
          { ...request.body, expectedVersion: expectedVersion(request) }, conn, sweepQueue);
        return { ...result, sweep };
      },
      etag: (body) => { const version = (body as SetWorkspaceAiPolicyResult | null)?.ai.version; return typeof version === 'number' ? `"${version}"` : null; },
      replay: requires('workspace', 'workspace.manage_ai', () => request.params.workspaceId),
    });
    const { sweep, ...body } = (response.body ?? {}) as SetWorkspaceAiPolicyResult & { sweep?: { workspaceId: string; epoch: number } | null };
    let stopped = body.stopped ?? null;
    if (sweep && !response.replayed) {
      try { stopped = await sweepWorkspaceAi(sweep, db); }
      catch (error) {
        // Each step is its own transaction: what committed is reported, the rest is repeated by the worker's job.
        if (error instanceof WorkspaceAiSweepIncomplete) stopped = error.swept;
        request.log.error({ error }, 'The inline AI sweep did not finish; the worker job repeats it');
      }
    }
    return sendCommand(reply, { ...response, body: { ...body, stopped } });
  });
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
    run: (actor, conn) => addMember(actor, request.params.workspaceId, request.body, conn, { verifiedEmailOnly: verifiedEmailMembers }),
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

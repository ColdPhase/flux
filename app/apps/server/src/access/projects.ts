import type { FastifyInstance } from 'fastify';
import { fromDrizzle, type PgBoss } from 'pg-boss';
import { sql } from 'drizzle-orm';
import { PROJECTS_PATH, SPACE_AI_SWEEP_JOB, WORKSPACES_PATH, type CreateProjectCommand, type GrantProjectCommand, type PageQuery,
  type RenameProjectCommand, type SetSpaceAiCommand, type SetSpaceAiResult } from '@flux/contracts';
import {
  assertAuthorized,
  createProject,
  deleteProject,
  getProject,
  grantProject,
  leaveProject,
  listProjectGrants,
  listSpacePeople,
  listProjects,
  renameProject,
  revokeProjectGrant,
  setSpaceAi,
  sweepSpaceAi,
  SpaceAiSweepIncomplete,
  type SpaceAiSweepQueue,
} from '@flux/core';
import { accessPorts, accessReader, afterDeadlock, personTimeZones } from '@flux/db';
import { bodyId, requires } from '../http/commands.js';
import { nameSchema, pageQuery } from '../http/schemas.js';
import type { AccessContext } from './context.js';

/**
 * Projects, which people call spaces, and their grants (#85, F-037): list, create, read, rename, delete, leave, the AI switch,
 * grants, people and revocation.
 */
export function projectRoutes(app: FastifyInstance, { db, principal, command, runCommand, sendCommand, workspaceScope, projectScope, projectChange }: AccessContext,
  boss: Pick<PgBoss, 'send'>) {
  /** AG-10: the sweep job commits with the flip, in its transaction. */
  const sweepQueue: SpaceAiSweepQueue = async (tx, job) => {
    await boss.send(SPACE_AI_SWEEP_JOB, job, { db: fromDrizzle(tx as Parameters<typeof fromDrizzle>[0], sql), retryLimit: 5, retryDelay: 5 });
  };
  app.get<{ Params: { workspaceId: string }; Querystring: PageQuery }>(`${WORKSPACES_PATH}/:workspaceId/projects`, { schema: { querystring: pageQuery } }, async (request) =>
    listProjects(await principal(request), request.params.workspaceId, request.query, db, accessPorts));
  app.post<{ Params: { workspaceId: string }; Body: CreateProjectCommand }>(`${WORKSPACES_PATH}/:workspaceId/projects`, {
    schema: { body: { type: 'object', required: ['name'], additionalProperties: false, properties: { name: nameSchema, visibility: { type: 'string', enum: ['workspace', 'restricted'] },
      ai: { type: 'boolean' }, people: { type: 'array', maxItems: 200, items: { type: 'string', minLength: 1 } } } } },
  }, async (request, reply) => command(request, reply, {
    operation: `POST ${WORKSPACES_PATH}/:workspaceId/projects`, scope: workspaceScope(request.params.workspaceId), status: 201,
    run: (actor, conn) => createProject(actor, request.params.workspaceId, request.body, conn, accessPorts),
    replay: requires('project', 'project.read', bodyId),
  }));
  app.get<{ Params: { projectId: string } }>(`${PROJECTS_PATH}/:projectId`, async (request) =>
    getProject(await principal(request), request.params.projectId, db, accessPorts));
  app.patch<{ Params: { projectId: string }; Body: RenameProjectCommand }>(`${PROJECTS_PATH}/:projectId`, {
    schema: { body: { type: 'object', required: ['name'], additionalProperties: false, properties: { name: nameSchema } } },
  }, async (request, reply) => command(request, reply, {
    operation: `PATCH ${PROJECTS_PATH}/:projectId`, scope: projectScope(request.params.projectId),
    run: (actor, conn) => renameProject(actor, request.params.projectId, request.body, conn, accessPorts),
    replay: requires('project', 'project.manage', () => request.params.projectId),
  }));
  // Erases the space and everything in it (a space admin, or a company owner or admin). The media fence ends its live calls first.
  app.delete<{ Params: { projectId: string } }>(`${PROJECTS_PATH}/:projectId`, async (request, reply) => {
    const actor = await principal(request);
    await assertAuthorized(actor, 'project.manage', projectScope(request.params.projectId), accessReader(db));
    // The cascade locks the space's messages in the database's own order, while a notice batch holds a message `FOR SHARE` in event order:
    // if PostgreSQL cancels this delete to break a deadlock between them, nothing was kept and the delete runs once more (#1052).
    await afterDeadlock(() => projectChange(request.params.projectId, (conn) => deleteProject(actor, request.params.projectId, conn, accessPorts)));
    return reply.code(204).send();
  });
  app.post<{ Params: { projectId: string } }>(`${PROJECTS_PATH}/:projectId/leave`, async (request, reply) => {
    const actor = await principal(request);
    await assertAuthorized(actor, 'project.read', projectScope(request.params.projectId), accessReader(db));
    await projectChange(request.params.projectId, (conn) => leaveProject(actor, request.params.projectId, conn, accessPorts));
    return reply.code(204).send();
  });
  // AG-10: a space admin, or a company owner or admin, turns AI off or on in the space. The flip commits first; the sweep then
  // runs here at once (and again from the worker's job), so it never shares a transaction with the flip.
  app.put<{ Params: { projectId: string }; Body: SetSpaceAiCommand }>(`${PROJECTS_PATH}/:projectId/ai-policy`, {
    schema: { body: { type: 'object', required: ['state'], additionalProperties: false, properties: { state: { type: 'string', enum: ['allowed', 'blocked'] } } } },
  }, async (request, reply) => {
    const response = await runCommand(request, {
      operation: `PUT ${PROJECTS_PATH}/:projectId/ai-policy`, scope: projectScope(request.params.projectId),
      run: async (actor, conn) => {
        const { sweep, ...result } = await setSpaceAi(actor, request.params.projectId, request.body, conn, accessPorts, sweepQueue);
        return { ...result, sweep };
      },
      replay: requires('project', 'project.manage', () => request.params.projectId),
    });
    const { sweep, ...body } = (response.body ?? {}) as SetSpaceAiResult & { sweep?: { projectId: string; epoch: number } | null };
    let stopped = body.stopped ?? null;
    if (sweep && !response.replayed) {
      try { stopped = await sweepSpaceAi(sweep, db, accessPorts); }
      catch (error) {
        // Each step is its own transaction: what committed is reported, the rest is repeated by the worker's job.
        if (error instanceof SpaceAiSweepIncomplete) stopped = error.swept;
        request.log.error({ error }, 'The inline AI sweep did not finish; the worker job repeats it');
      }
    }
    return sendCommand(reply, { ...response, body: { ...body, stopped } });
  });
  app.get<{ Params: { projectId: string } }>(`${PROJECTS_PATH}/:projectId/grants`, async (request) =>
    listProjectGrants(await principal(request), request.params.projectId, db, accessPorts));
  // Each person's last-active time comes rounded, the days counted in the reader's own zone (C-58); who may read the list decides who sees it.
  app.get<{ Params: { projectId: string } }>(`${PROJECTS_PATH}/:projectId/people`, async (request) => {
    const reader = await principal(request);
    return listSpacePeople(reader, request.params.projectId, db, accessPorts, { lastActive: { timeZone: await personTimeZones(db).get(reader.id) } });
  });
  app.post<{ Params: { projectId: string }; Body: GrantProjectCommand }>(`${PROJECTS_PATH}/:projectId/grants`, {
    schema: {
      body: {
        type: 'object', required: ['principal', 'role'], additionalProperties: false,
        properties: {
          principal: { type: 'object', required: ['kind', 'id'], additionalProperties: false, properties: { kind: { type: 'string', enum: ['human'] }, id: { type: 'string', minLength: 1 } } },
          role: { type: 'string', enum: ['manager', 'contributor'] },
        },
      },
    },
  }, async (request, reply) => {
    await assertAuthorized(await principal(request), 'project.manage', projectScope(request.params.projectId), accessReader(db));
    const result = await projectChange(request.params.projectId, (conn) => runCommand(request, {
      operation: `POST ${PROJECTS_PATH}/:projectId/grants`, scope: projectScope(request.params.projectId), status: 201,
      run: (actor, conn) => grantProject(actor, request.params.projectId, request.body, conn, accessPorts),
      replay: requires('project', 'project.manage', () => request.params.projectId),
    }, conn));
    return sendCommand(reply, result);
  });
  app.delete<{ Params: { projectId: string; grantId: string } }>(`${PROJECTS_PATH}/:projectId/grants/:grantId`, async (request, reply) => {
    const actor = await principal(request);
    await assertAuthorized(actor, 'project.manage', projectScope(request.params.projectId), accessReader(db));
    await projectChange(request.params.projectId, (conn) => revokeProjectGrant(actor, request.params.projectId, request.params.grantId, conn, accessPorts));
    return reply.code(204).send();
  });
}

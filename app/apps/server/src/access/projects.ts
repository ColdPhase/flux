import type { FastifyInstance } from 'fastify';
import { PROJECTS_PATH, PROJECT_GOAL_MAX, WORKSPACES_PATH, type CreateProjectCommand, type GrantProjectCommand, type PageQuery, type UpdateProjectCommand } from '@flux/contracts';
import {
  assertAuthorized,
  createProject,
  getProject,
  grantProject,
  listProjectGrants,
  listProjectPeople,
  listProjects,
  revokeProjectGrant,
  updateProjectGoal,
} from '@flux/core';
import { bodyId, expectedVersion, requires, versionEtag } from '../http/commands.js';
import { nameSchema, pageQuery, versionSchema } from '../http/schemas.js';
import type { AccessContext } from './context.js';

/** Projects and their grants (#85): list, create, read, grants, people and revocation. */
export function projectRoutes(app: FastifyInstance, { db, principal, command, runCommand, sendCommand, workspaceScope, projectScope, projectChange }: AccessContext) {
  app.get<{ Params: { workspaceId: string }; Querystring: PageQuery }>(`${WORKSPACES_PATH}/:workspaceId/projects`, { schema: { querystring: pageQuery } }, async (request) =>
    listProjects(await principal(request), request.params.workspaceId, request.query, db));
  app.post<{ Params: { workspaceId: string }; Body: CreateProjectCommand }>(`${WORKSPACES_PATH}/:workspaceId/projects`, {
    schema: { body: { type: 'object', required: ['name'], additionalProperties: false, properties: { name: nameSchema, visibility: { type: 'string', enum: ['workspace', 'restricted'] } } } },
  }, async (request, reply) => command(request, reply, {
    operation: `POST ${WORKSPACES_PATH}/:workspaceId/projects`, scope: workspaceScope(request.params.workspaceId), status: 201,
    run: (actor, conn) => createProject(actor, request.params.workspaceId, request.body, conn),
    replay: requires('project', 'project.read', bodyId),
  }));
  app.get<{ Params: { projectId: string } }>(`${PROJECTS_PATH}/:projectId`, async (request, reply) => {
    const project = await getProject(await principal(request), request.params.projectId, db);
    return reply.header('etag', versionEtag(project)).send(project);
  });
  // The project's goal (#272 FF-6): one line, set or cleared by people who can edit the project.
  app.patch<{ Params: { projectId: string }; Body: UpdateProjectCommand & { expectedVersion?: number } }>(`${PROJECTS_PATH}/:projectId`, {
    schema: { body: { type: 'object', required: ['goal'], additionalProperties: false, properties: {
      goal: { anyOf: [{ type: 'string', maxLength: PROJECT_GOAL_MAX * 4 }, { type: 'null' }] }, expectedVersion: versionSchema } } },
  }, async (request, reply) => command(request, reply, {
    operation: `PATCH ${PROJECTS_PATH}/:projectId`, scope: projectScope(request.params.projectId), etag: true,
    run: (actor, conn) => updateProjectGoal(actor, request.params.projectId, { goal: request.body.goal, expectedVersion: expectedVersion(request) }, conn),
    replay: requires('project', 'project.read', () => request.params.projectId),
  }));
  app.get<{ Params: { projectId: string } }>(`${PROJECTS_PATH}/:projectId/grants`, async (request) =>
    listProjectGrants(await principal(request), request.params.projectId, db));
  app.get<{ Params: { projectId: string } }>(`${PROJECTS_PATH}/:projectId/people`, async (request) =>
    listProjectPeople(await principal(request), request.params.projectId, db));
  app.post<{ Params: { projectId: string }; Body: GrantProjectCommand }>(`${PROJECTS_PATH}/:projectId/grants`, {
    schema: {
      body: {
        type: 'object', required: ['principal', 'role'], additionalProperties: false,
        properties: {
          principal: { type: 'object', required: ['kind', 'id'], additionalProperties: false, properties: { kind: { type: 'string', enum: ['human', 'agent'] }, id: { type: 'string', minLength: 1 } } },
          role: { type: 'string', enum: ['contributor', 'viewer', 'denied'] },
        },
      },
    },
  }, async (request, reply) => {
    await assertAuthorized(await principal(request), 'project.manage', projectScope(request.params.projectId), db);
    const result = await projectChange(request.params.projectId, (conn) => runCommand(request, {
      operation: `POST ${PROJECTS_PATH}/:projectId/grants`, scope: projectScope(request.params.projectId), status: 201,
      run: (actor, conn) => grantProject(actor, request.params.projectId, request.body, conn),
      replay: requires('project', 'project.manage', () => request.params.projectId),
    }, conn));
    return sendCommand(reply, result);
  });
  app.delete<{ Params: { projectId: string; grantId: string } }>(`${PROJECTS_PATH}/:projectId/grants/:grantId`, async (request, reply) => {
    const actor = await principal(request);
    await assertAuthorized(actor, 'project.manage', projectScope(request.params.projectId), db);
    await projectChange(request.params.projectId, (conn) => revokeProjectGrant(actor, request.params.projectId, request.params.grantId, conn));
    return reply.code(204).send();
  });
}

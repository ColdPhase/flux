import type { FastifyInstance } from 'fastify';
import { PROJECT_TEMPLATES, PROJECT_VIEWS, PROJECTS_PATH, WORKSPACES_PATH, type AddProjectViewCommand, type CreateProjectCommand, type GrantProjectCommand, type PageQuery } from '@flux/contracts';
import {
  addProjectView,
  assertAuthorized,
  createProject,
  getProject,
  grantProject,
  listProjectGrants,
  listProjectPeople,
  listProjects,
  revokeProjectGrant,
} from '@flux/core';
import { bodyId, requires } from '../http/commands.js';
import { nameSchema, pageQuery } from '../http/schemas.js';
import type { AccessContext } from './context.js';

/** Projects and their grants (#85): list, create, read, grants, people and revocation. */
export function projectRoutes(app: FastifyInstance, { db, principal, command, runCommand, sendCommand, workspaceScope, projectScope, projectChange }: AccessContext) {
  app.get<{ Params: { workspaceId: string }; Querystring: PageQuery }>(`${WORKSPACES_PATH}/:workspaceId/projects`, { schema: { querystring: pageQuery } }, async (request) =>
    listProjects(await principal(request), request.params.workspaceId, request.query, db));
  app.post<{ Params: { workspaceId: string }; Body: CreateProjectCommand }>(`${WORKSPACES_PATH}/:workspaceId/projects`, {
    schema: { body: { type: 'object', required: ['name'], additionalProperties: false, properties: { name: nameSchema, visibility: { type: 'string', enum: ['workspace', 'restricted'] }, template: { type: 'string', enum: [...PROJECT_TEMPLATES] } } } },
  }, async (request, reply) => command(request, reply, {
    operation: `POST ${WORKSPACES_PATH}/:workspaceId/projects`, scope: workspaceScope(request.params.workspaceId), status: 201,
    run: (actor, conn) => createProject(actor, request.params.workspaceId, request.body, conn),
    replay: requires('project', 'project.read', bodyId),
  }));
  app.post<{ Params: { projectId: string }; Body: AddProjectViewCommand }>(`${PROJECTS_PATH}/:projectId/views`, {
    schema: { body: { type: 'object', required: ['view'], additionalProperties: false, properties: { view: { type: 'string', enum: [...PROJECT_VIEWS] } } } },
  }, async (request, reply) => command(request, reply, {
    operation: `POST ${PROJECTS_PATH}/:projectId/views`, scope: projectScope(request.params.projectId), status: 200,
    run: (actor, conn) => addProjectView(actor, request.params.projectId, request.body, conn),
    replay: requires('project', 'project.write', () => request.params.projectId),
  }));
  app.get<{ Params: { projectId: string } }>(`${PROJECTS_PATH}/:projectId`, async (request) =>
    getProject(await principal(request), request.params.projectId, db));
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
